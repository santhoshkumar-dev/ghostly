import { pipeline, env } from "@huggingface/transformers";
import {
  ASR_SAMPLE_RATE,
  MIN_DECODE_SAMPLES,
  durationSecondsFor,
  isDecodableLength,
  maxNewTokensFor,
} from "./asrTokenBudget";

// Disable local models, fetch from HuggingFace CDN on first run, then cache
env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber: any = null;
let currentModel: string | null = null;

const log = (msg: string) => {
  // In dev, mirror to the renderer console so ASR progress is visible in the
  // terminal too (main.ts forwards renderer console output).
  if (import.meta.env.DEV) console.log(`[ASR] ${msg}`);
  postMessage({ type: "log", message: `[ASR] ${msg}` });
};

// ── Work scheduler ─────────────────────────────────────────────────────────
// Finals (the end of an utterance) must always run. Interim/partial snapshots
// are best-effort: only the newest one is kept, so a slow machine never builds
// a backlog of stale partial transcriptions (which is what made the old
// Whisper queue feel laggy during continuous speech).
type Task = () => Promise<void>;

/** A queued final, tagged with whether it is a flush marker (see below). */
interface QueuedTask {
  task: Task;
  /** A marker is a barrier, not work: it must not count as pending ASR. */
  isMarker: boolean;
}

const finals: QueuedTask[] = [];
let pendingPartial: Task | null = null;
let busy = false;
let runningIsMarker = false;

function pump() {
  if (busy) return;
  // Finals (and flush markers, which are queued as finals) take priority.
  const next = finals.shift();
  const task = next ? next.task : pendingPartial;
  if (!task) return;
  if (!next) pendingPartial = null;
  busy = true;
  runningIsMarker = next ? next.isMarker : false;
  Promise.resolve()
    .then(task)
    .catch((err) => log(`Task failed: ${err}`))
    .finally(() => {
      busy = false;
      runningIsMarker = false;
      pump();
    });
}

function enqueueFinal(task: Task) {
  finals.push({ task, isMarker: false });
  pump();
}

function enqueuePartial(task: Task) {
  pendingPartial = task; // overwrite any un-started partial
  pump();
}

// ── Drain barrier ──────────────────────────────────────────────────────────
//
// `Ctrl+Enter` reads the transcript synchronously from the store. Without a
// barrier it can fire while a final for the phrase the interviewer just
// finished is still sitting in `finals[]` — the last words of the question are
// then simply missing from what gets submitted.
//
// A `flush` message is enqueued as a FINAL task, so FIFO ordering guarantees
// every final queued *before* the flush has completed by the time the marker
// runs. It is deliberately a final, not a partial: partials are best-effort and
// get overwritten, so waiting on one could wait forever.
//
// The worker never blocks. It just reports when its queue reached the marker;
// the CALLER owns the deadline (see `asrDrain.ts`), so a wedged model can never
// hang the hotkey. A final that arrives *after* the marker is not covered by
// this one flush — the caller re-checks the count and flushes again.
/**
 * Real finals still owed to the renderer: queued work plus the one running,
 * EXCLUDING flush markers.
 *
 * A marker is bookkeeping, not work. Counting it would make an idle worker
 * report `pending >= 1` forever and the barrier could never take its fast path.
 */
function pendingFinalCount(): number {
  const queued = finals.reduce((n, item) => n + (item.isMarker ? 0 : 1), 0);
  return queued + (busy && !runningIsMarker ? 1 : 0);
}

function enqueueFlush(requestId: number) {
  finals.push({
    isMarker: true,
    task: async () => {
      postMessage({ type: "flushed", requestId });
    },
  });
  pump();
}

// ── Model loading ──────────────────────────────────────────────────────────

const progressCallback = (p: any) => {
  if (p.status === "progress" || p.status === "downloading") {
    postMessage({
      type: "progress",
      file: p.file ?? p.name ?? "",
      loaded: p.loaded ?? 0,
      total: p.total ?? 0,
      progress: p.progress ?? 0, // 0-100
    });
  }
};

/**
 * Probe for WebGPU with fp16 shader support *before* choosing weights.
 *
 * Verified on the dev machine: an adapter exists but reports "The device
 * (webgpu) does not support fp16", so merely having an adapter is not enough —
 * the fp16 weight path would fail. Checking `shader-f16` up front means we go
 * straight to the WASM/q8 path that actually works instead of throwing first.
 */
async function webgpuSupportsFp16(): Promise<boolean> {
  try {
    const gpu = (navigator as any).gpu;
    if (!gpu || typeof gpu.requestAdapter !== "function") return false;
    const adapter = await gpu.requestAdapter();
    if (!adapter) return false;
    const features = adapter.features;
    if (!features) return false;
    return typeof features.has === "function"
      ? features.has("shader-f16")
      : false;
  } catch {
    return false;
  }
}

/**
 * Moonshine is dramatically faster on WebGPU, so use fp16 weights there (the
 * native GPU format). Otherwise fall back to quantized WASM — "q8" is both
 * faster than fp32 on CPU and a much smaller first-run download.
 */
async function createTranscriber(model: string) {
  if (await webgpuSupportsFp16()) {
    try {
      const p = await pipeline("automatic-speech-recognition", model, {
        device: "webgpu",
        dtype: "fp16",
        progress_callback: progressCallback,
      });
      log("Backend: WebGPU (fp16)");
      return p;
    } catch (err) {
      log(
        `WebGPU init failed (${err instanceof Error ? err.message : err}) — falling back to WASM.`,
      );
    }
  } else {
    log("WebGPU fp16 unavailable — using WASM (q8).");
  }

  // Measured on the dev machine: q8/WASM loads in ~22s and transcribes a real
  // utterance in ~0.6s (0.23s for a 1s buffer) — comfortably faster than
  // real-time, so it comfortably keeps up with the 0.7s streaming cadence.
  const p = await pipeline("automatic-speech-recognition", model, {
    dtype: "q8",
    progress_callback: progressCallback,
  });
  log("Backend: WASM (q8)");
  return p;
}

async function loadModel(requestedModel: string) {
  if (transcriber && currentModel === requestedModel) {
    postMessage({ type: "ready" });
    return;
  }

  transcriber = null;
  currentModel = requestedModel;
  log(`Loading model: ${requestedModel}…`);
  const start = performance.now();
  try {
    transcriber = await createTranscriber(requestedModel);
    log(`Model ready in ${((performance.now() - start) / 1000).toFixed(1)}s`);
    postMessage({ type: "ready" });
  } catch (err) {
    log(`Failed to load model: ${err}`);
    postMessage({ type: "error" });
  }
}

// ── Transcription ──────────────────────────────────────────────────────────

/** Normalize whatever arrived across the worker boundary into a Float32Array. */
function toFloat32(audio: any): Float32Array | null {
  try {
    if (audio instanceof Float32Array) return audio;
    if (ArrayBuffer.isView(audio)) {
      return new Float32Array(audio.buffer, (audio as any).byteOffset, (audio as any).length);
    }
    if (Array.isArray(audio)) return Float32Array.from(audio);
    return new Float32Array(Object.values(audio));
  } catch {
    return null;
  }
}

/**
 * Minimum segment length, in samples @ 16 kHz.
 *
 * Re-exported from `asrTokenBudget` so the length gate and the token budget
 * can never drift apart: the budget formula is only meaningful for buffers that
 * passed this gate.
 */
const MIN_SAMPLES = MIN_DECODE_SAMPLES;

/** Root-mean-square amplitude, used only for diagnostics. */
function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

async function runTranscription(data: any, isPartial: boolean) {
  if (!transcriber) {
    log("No model loaded — dropping audio.");
    return;
  }

  const { audio, source, audioUrl, phraseId } = data;
  const float32 = toFloat32(audio);
  if (!float32 || !isDecodableLength(float32.length)) {
    if (!isPartial) {
      const got = float32?.length ?? 0;
      // A final is STILL posted for a rejected segment. The hook uses it to
      // clear the interim line for this phrase; swallowing it would leave
      // "the interviewer is still speaking" on screen forever.
      log(
        `Skipping ${source}: audio too short (${got} samples, need ${MIN_SAMPLES} = ${
          MIN_SAMPLES / ASR_SAMPLE_RATE
        }s @16kHz)`,
      );
      console.log(
        `[ASR] ignored too-short segment source=${source} samples=${got} required=${MIN_SAMPLES}`,
      );
      postMessage({
        type: "final",
        source,
        text: "",
        audioUrl,
        phraseId,
        // No decode happened, so there is no latency to report. Explicit null
        // rather than 0, which would read as "instant" in the comparison table.
        asrMs: null,
      });
    }
    return;
  }

  // ── Explicit decode budget ──────────────────────────────────────────────
  // Passed to `generate` so it OVERRIDES the library's own
  // `Math.floor(seconds) * 6` (see `asrTokenBudget.ts`). Without this the
  // budget is 0 for any sub-second buffer and truncated for anything under
  // ~1.5 s, which is what produced empty finals and cut-off sentences.
  const maxNewTokens = maxNewTokensFor(float32.length);
  const durationSeconds = durationSecondsFor(float32.length);

  const start = performance.now();
  const result = await transcriber(float32, { max_new_tokens: maxNewTokens });
  const elapsedMs = performance.now() - start;
  const elapsed = (elapsedMs / 1000).toFixed(2);

  let text = "";
  if (Array.isArray(result)) {
    text = result.map((r: any) => r.text ?? "").join(" ");
  } else if (result && typeof result.text === "string") {
    text = result.text;
  }
  text = text.trim();

  // Per-segment diagnostic. Reports what actually reached the model, so a bad
  // transcript can be traced back to a quiet/short/odd buffer instead of
  // guessing. Contains audio statistics and the transcript only — never keys
  // or resume content.
  // `maxNewTokens` is printed on every segment: if a transcript is ever
  // truncated again, the budget that produced it is right here in the log
  // rather than needing to be reconstructed.
  console.log(
    `[ASR] ${isPartial ? "partial" : "final"} source=${source} phraseId=${phraseId ?? 0} ` +
      `sampleRate=${ASR_SAMPLE_RATE} channels=1 samples=${float32.length} ` +
      `durationMs=${Math.round(durationSeconds * 1000)} rms=${rms(float32).toFixed(5)} ` +
      `maxNewTokens=${maxNewTokens} asrMs=${Math.round(elapsedMs)} ` +
      `chars=${text.length} text="${text.slice(0, 160)}"`,
  );

  // A non-empty decode on a long segment means the budget was hit — the paper
  // heuristic exists to stop the decoder looping, so hitting it is a signal
  // that the segment may have been cut, not that the model was verbose.
  if (!isPartial && durationSeconds * 6 >= maxNewTokens) {
    console.warn(
      `[ASR] segment hit its token budget (${maxNewTokens} tokens for ${durationSeconds.toFixed(
        2,
      )}s) — transcript may be truncated`,
    );
  }

  if (isPartial) {
    // Partial snapshots are only useful while they have something to show.
    if (text) postMessage({ type: "partial", source, text, phraseId });
    return;
  }

  log(`Transcribed ${source} in ${elapsed}s`);
  // A final is always posted (even when empty) so the hook can clear the
  // interim line for this phrase.
  //
  // `asrMs` is the DECODE time already measured above, carried out so
  // `asrComparisons` can hold a real Moonshine latency. Without it the
  // `moonshineMs` field existed but was permanently null, and any Moonshine
  // vs Parakeet latency comparison would have been fabricated. This is
  // reporting only: the decode itself, the token budget, and everything
  // downstream are untouched.
  postMessage({
    type: "final",
    source,
    text,
    audioUrl,
    phraseId,
    asrMs: Math.round(elapsedMs),
  });
}

self.addEventListener("message", (e) => {
  const { type, model } = e.data;

  if (type === "load") {
    enqueueFinal(() => loadModel(model || "onnx-community/moonshine-base-ONNX"));
  } else if (type === "transcribe") {
    enqueueFinal(() => runTranscription(e.data, false));
  } else if (type === "partial") {
    enqueuePartial(() => runTranscription(e.data, true));
  } else if (type === "flush") {
    // Queue the barrier behind every final received so far. `flushQueued` is
    // posted immediately (not after the marker) so the caller learns the depth
    // of the backlog without waiting for the decode it is about to wait for.
    const requestId = e.data.requestId ?? 0;
    enqueueFlush(requestId);
    postMessage({
      type: "flushQueued",
      requestId,
      pending: pendingFinalCount(),
    });
  }
});
