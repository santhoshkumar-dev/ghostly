/**
 * The renderer-side Parakeet comparison client.
 *
 * ── What this is allowed to do ─────────────────────────────────────────────
 * Submit one already-captured 16 kHz `Float32Array` — the exact buffer Moonshine
 * received — and receive a transcript for the developer comparison table. That
 * is the whole surface.
 *
 * ── What it is NOT ─────────────────────────────────────────────────────────
 * AS A COMPARISON ENGINE, Parakeet is not a fallback for Moonshine: its
 * transcript goes to the isolated `asrComparisons` slice ONLY. It is never added
 * to `interviewMessages`, never passed to the question gate, never corrected
 * into the transcript, and never included in a prompt.
 *
 * AS A PRIMARY ENGINE (a separate, explicit setting — see `lib/primaryAsr.ts`),
 * the transcript it returns is the raw transcript and flows through exactly the
 * same downstream pipeline Moonshine uses. There is still no second pipeline and
 * no Parakeet-specific correction: the shape returned here is the shape the
 * normal `final` event has.
 *
 * The one thing this module will never do, in either mode, is send audio
 * anywhere. There is no code path from here to Groq or Deepgram; the fallback
 * for a failed segment is Moonshine, locally, or nothing.
 *
 * ── Never throws ───────────────────────────────────────────────────────────
 * Every failure path reports through `onError` (or returns a result object).
 * A comparison engine that can interrupt an interview would be worse than no
 * comparison at all, so no failure here is allowed to propagate into the
 * capture path that calls it.
 */

/** Lifecycle state of the model in the main process. */
export type ParakeetStatus =
  | "disabled"
  | "missing"
  | "loading"
  | "ready"
  | "error";

/**
 * Per-phase model-load timings, measured in the utility process.
 *
 * Present so "the load took 15s" can be split into spawn / native-addon require
 * / page-cache warm / ONNX session construction — four problems with four very
 * different fixes, all of which look identical from the outside.
 */
export interface ParakeetLoadBreakdown {
  /** Process fork → first line of the child executing. */
  spawn: number | null;
  /** `require("sherpa-onnx-node")` — the native addon off disk. */
  require: number | null;
  /** Stat + page-cache warm of the model files. */
  read: number | null;
  /** ONNX session creation and weight init. */
  construct: number | null;
  /** The child's own load: read + require + construct. */
  total: number;
  /** What the user actually waited for: spawn + total. */
  endToEnd: number;
  modelBytes: number | null;
}

export interface ParakeetTranscript {
  ok: boolean;
  text?: string;
  decodeMs?: number;
  loadMs?: number;
  breakdown?: ParakeetLoadBreakdown;
  rssMb?: number;
  rtf?: number;
  code?: string;
  message?: string;
  /** Whether the model is the primary engine or a comparison column. */
  mode?: "primary" | "comparison";
}

export interface ParakeetComparisonCallbacks {
  onResult: (result: ParakeetTranscript) => void;
  onError: (message: string) => void;
}

/**
 * Transcribe one segment and AWAIT the result.
 *
 * ── The difference from {@link runParakeetComparison} ────────────────────────
 * That one is fire-and-forget and exists to fill a diagnostics column, so it may
 * be slow. This one is on the critical path to the transcript: its result, or
 * its failure, decides whether the segment is committed and whether Moonshine
 * has to take over. It still never throws — a failure is a resolved
 * `{ok: false, code}`, because a rejection here would be an unhandled promise in
 * an audio callback with no caller to catch it.
 */
export async function transcribeWithParakeet(
  audio: Float32Array,
): Promise<ParakeetTranscript> {
  if (!bridge()) {
    return { ok: false, code: "disabled", message: "Parakeet bridge unavailable." };
  }
  if (audio.length === 0) {
    return { ok: false, code: "invalid_audio", message: "Empty segment." };
  }
  try {
    const response = await window.ghostly.parakeetTranscribe({
      samples: audio,
      sampleRate: 16000,
    });
    if (!response || typeof response !== "object") {
      return { ok: false, code: "malformed", message: "Unexpected response." };
    }
    return response;
  } catch {
    return { ok: false, code: "crashed", message: "Parakeet transcribe failed." };
  }
}

function bridge(): Window["ghostly"]["parakeetTranscribe"] | null {
  if (typeof window === "undefined") return null;
  return window.ghostly?.parakeetTranscribe ?? null;
}

/** Whether the main-process bridge exists at all (it may be absent in tests). */
export function isParakeetBridgeAvailable(): boolean {
  return typeof window !== "undefined" && !!window.ghostly?.parakeetStatus;
}

/**
 * Ask the main process for the model status. Never loads anything.
 *
 * Returns `"disabled"` when the dev setting is off or the app is packaged, so
 * the settings UI can honestly show "off" rather than "broken".
 */
export async function getParakeetStatus(): Promise<ParakeetStatus> {
  if (!isParakeetBridgeAvailable()) return "disabled";
  try {
    const result = await window.ghostly.parakeetStatus();
    return result?.status ?? "error";
  } catch {
    return "error";
  }
}

/**
 * Load the model. Called on Start Interview, NOT at app launch.
 *
 * Measured cold load is ~6 s and several hundred MB of RSS, so paying it at
 * launch — while nobody is transcribing — would be a real cost for every user
 * of a feature that is off by default.
 */
export async function loadParakeetModel(): Promise<ParakeetTranscript> {
  if (!isParakeetBridgeAvailable()) {
    return { ok: false, code: "disabled", message: "Parakeet bridge unavailable." };
  }
  try {
    return await window.ghostly.parakeetLoad();
  } catch {
    return { ok: false, code: "crashed", message: "Parakeet load failed." };
  }
}

/** Release the model. Called on Stop Interview. */
export async function unloadParakeetModel(): Promise<void> {
  if (!isParakeetBridgeAvailable()) return;
  try {
    await window.ghostly.parakeetUnload();
  } catch {
    /* unloading is best-effort; the idle timeout is the backstop */
  }
}

/** Dev diagnostics: counts and timings only, never audio or model contents. */
export async function getParakeetDiagnostics(): Promise<{
  status: string;
  loadMs: number | null;
  breakdown?: ParakeetLoadBreakdown | null;
  rssMb: number | null;
  decodeMs?: number | null;
  rtf?: number | null;
  /** Present so the UI can label the figures; never infer it client-side. */
  mode?: "primary" | "comparison";
  queued: number;
  inFlight: number;
  consecutiveFailures: number;
} | null> {
  if (!isParakeetBridgeAvailable()) return null;
  try {
    return await window.ghostly.parakeetDiagnostics();
  } catch {
    return null;
  }
}

/**
 * Transcribe one already-captured segment for comparison.
 *
 * Not awaited by callers: it must never delay the local engine. The audio is
 * the SAME buffer Moonshine gets, so the columns are comparable — the padding
 * the host applies is applied to a copy inside the host, never to this buffer.
 */
export async function runParakeetComparison(
  audio: Float32Array,
  callbacks: ParakeetComparisonCallbacks,
): Promise<void> {
  if (!bridge()) {
    callbacks.onError("Parakeet bridge unavailable.");
    return;
  }
  if (audio.length === 0) {
    callbacks.onError("Empty segment.");
    return;
  }

  let response: ParakeetTranscript;
  try {
    response = await window.ghostly.parakeetTranscribe({
      samples: audio,
      sampleRate: 16000,
    });
  } catch {
    // The handler is written never to throw; if something does, the comparison
    // is simply skipped.
    callbacks.onError("Parakeet comparison failed.");
    return;
  }

  if (!response || typeof response !== "object") {
    callbacks.onError("Parakeet returned an unexpected response.");
    return;
  }
  callbacks.onResult(response);
}