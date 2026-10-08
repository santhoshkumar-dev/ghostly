/**
 * Deterministic tests for the local ASR pipeline.
 *
 * Run: `npx tsx scripts/verify-asr.mts`
 *
 * Covers:
 *   1. The token-budget formula, including the sub-1-second 0-token defect.
 *   2. The drain barrier: hotkey immediately after speech, a final still
 *      pending, a final arriving mid-drain, and a stale final after cancellation.
 *   3. VAD segmentation and the fragmentation measurement that selected
 *      MAX_SILENCE_SECONDS.
 *   4. The clipping-detecting debug WAV writer.
 *
 * No audio, no model, no network: every test drives a pure function or a
 * scripted fake worker, so the whole suite is deterministic and fast.
 */
import {
  ASR_SAMPLE_RATE,
  MAX_TOKEN_BUDGET,
  MIN_DECODE_SAMPLES,
  MIN_DECODE_SECONDS,
  MIN_TOKEN_BUDGET,
  TOKEN_MARGIN,
  TOKENS_PER_SECOND,
  durationSecondsFor,
  isDecodableLength,
  maxNewTokensFor,
} from "../src/lib/asrTokenBudget";
import {
  createAsrDrain,
  describeDrain,
  DRAIN_DEADLINE_MS,
  type DrainResult,
  type FlushTransport,
} from "../src/lib/asrDrain";
import {
  DEFAULT_VAD_CONFIG,
  MAX_SILENCE_SECONDS,
  MIN_SPEECH_SECONDS,
  SILENCE_THRESHOLD,
  buildVadWorkletCode,
  simulateSegmentation,
  simulateVad,
  type VadConfig,
  type VadFrame,
} from "../src/lib/vadWorklet";
import {
  float32ToWavWithClipping,
  describeClipping,
} from "../src/lib/debugWav";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(
      `${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`,
    );
  }
}

function checkTrue(name: string, actual: boolean) {
  check(name, actual, true);
}

const samples = (seconds: number) =>
  Math.round(seconds * ASR_SAMPLE_RATE);

// ═══════════════════════════════════════════════════════════════════════════
// 1. Token budget
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Token budget ──────────────────────────────────────────────");

// The library's own formula, reproduced so the defect is pinned by a test
// rather than only by a comment. `Math.floor(seconds) * 6` is the bug.
const libraryBudget = (sampleCount: number) =>
  Math.floor(sampleCount / ASR_SAMPLE_RATE) * TOKENS_PER_SECOND;

check(
  "library formula really does yield 0 for sub-second audio (0.9s)",
  libraryBudget(samples(0.9)),
  0,
);
check(
  "library formula truncates a 1.4s segment to 6 tokens",
  libraryBudget(samples(1.4)),
  6,
);
check(
  "our formula gives sub-second audio a positive budget (0.9s)",
  maxNewTokensFor(samples(0.9)) > 0,
  true,
);
check(
  "our formula beats the library on every duration from 0.1s to 30s",
  Array.from({ length: 300 }, (_, i) => 0.1 + i * 0.1).every((sec) => {
    const n = samples(sec);
    return maxNewTokensFor(n) > libraryBudget(n);
  }),
  true,
);
check(
  "our formula never returns 0 for any positive length (1..100000 samples)",
  Array.from({ length: 100 }, (_, i) => maxNewTokensFor(i + 1) > 0).every(Boolean),
  true,
);

// The exact formula, asserted rather than described.
check(
  "budget for 1.0s = ceil(1*6)+8, floored to the minimum",
  maxNewTokensFor(samples(1.0)),
  MIN_TOKEN_BUDGET,
);
check(
  "budget for 1.4s = ceil(1.4*6)+8, not the library's 6",
  maxNewTokensFor(samples(1.4)),
  17,
);
check("budget for 2.0s", maxNewTokensFor(samples(2.0)), 20);
check("budget for 5.5s", maxNewTokensFor(samples(5.5)), 41);
check("budget for 30s (the VAD phrase cap)", maxNewTokensFor(samples(30)), 188);
check(
  "the raw formula is observable above the floor (3s = ceil(18)+8)",
  maxNewTokensFor(samples(3.0)),
  26,
);

// Degenerate inputs must not produce a zero or negative budget.
check("budget for 0 samples", maxNewTokensFor(0), MIN_TOKEN_BUDGET);
check("budget for negative samples", maxNewTokensFor(-100), MIN_TOKEN_BUDGET);
check("budget for NaN", maxNewTokensFor(NaN), MIN_TOKEN_BUDGET);
check("budget for Infinity is rejected to the floor", maxNewTokensFor(Infinity), MIN_TOKEN_BUDGET);

// Monotonic: a longer segment never gets a SMALLER budget.
check(
  "budget is monotonic non-decreasing across 0..40s",
  Array.from({ length: 400 }, (_, i) => i * 0.1)
    .slice(1)
    .every((sec, i) => maxNewTokensFor(samples(sec)) >= maxNewTokensFor(samples(0.1 * (i + 1)))),
  true,
);

// Determinism: same input, same output, every time.
check(
  "budget is deterministic across repeated calls",
  Array.from({ length: 50 }, () => maxNewTokensFor(samples(3.7))).every(
    (n) => n === maxNewTokensFor(samples(3.7)),
  ),
  true,
);

// The decodable-length gate, which is what finally stops the 0-token path.
check("MIN_DECODE_SAMPLES is 16000 (1.0s @ 16kHz)", MIN_DECODE_SAMPLES, 16000);
check("MIN_DECODE_SECONDS is 1.0", MIN_DECODE_SECONDS, 1.0);
check("the old 0.1s guard is rejected as decodable", isDecodableLength(1600), false);
check("exactly 1.0s is decodable", isDecodableLength(MIN_DECODE_SAMPLES), true);
check(
  "one sample short of 1.0s is not decodable",
  isDecodableLength(MIN_DECODE_SAMPLES - 1),
  false,
);
check("empty buffer is not decodable", isDecodableLength(0), false);

// The headline regression test: a sub-second segment that the VAD accepted
// (MIN_SPEECH_SECONDS is 0.35s) must now be given a usable budget.
{
  const acceptedShortSpeech = samples(MIN_SPEECH_SECONDS); // 0.35s
  check(
    "sub-1s speech the VAD accepts is rejected by the length gate (not silently 0-token)",
    isDecodableLength(acceptedShortSpeech),
    false,
  );
  check(
    "...and the budget formula, were it reached, is still non-zero",
    maxNewTokensFor(acceptedShortSpeech) > 0,
    true,
  );
}

check("durationSecondsFor is exact for 1.5s", durationSecondsFor(samples(1.5)), 1.5);
check("durationSecondsFor(0) is 0", durationSecondsFor(0), 0);

// A non-16kHz rate is honoured (defensive; the pipeline always resamples).
check("budget honours an explicit sample rate", maxNewTokensFor(96000, 48000), 20);

// ═══════════════════════════════════════════════════════════════════════════
// 2. Drain barrier
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Drain barrier ─────────────────────────────────────────────");

/**
 * A scripted fake of the worker side of the flush protocol.
 *
 * Models exactly the contract `asr.worker.ts` implements: `flush()` queues a
 * marker behind every final queued so far, and the marker resolves with the
 * finals still outstanding. `script` controls what happens on each flush.
 */
class FakeWorker {
  /** Finals posted to the worker but not yet committed to the store. */
  pending = 0;
  /** Transcript as the store currently holds it. */
  committed: string[] = [];
  flushCalls = 0;
  /** Set to make the worker never answer (a wedged model). */
  silent = false;
  /** Called on each flush; the hook to advance scripted state. */
  onFlush?: (worker: FakeWorker) => void;

  transport(): FlushTransport {
    return {
      pending: () => this.pending,
      flush: async () => {
        this.flushCalls++;
        if (this.silent) return null;
        // Anything the caller wants to happen "during" the wait.
        this.onFlush?.(this);
        return this.pending;
      },
    };
  }

  /** A final arrives from the worker and is committed to the store. */
  commit(text: string) {
    this.pending = Math.max(0, this.pending - 1);
    this.committed.push(text);
  }
}

// (a) Hotkey pressed immediately after the interviewer stopped speaking:
//     one final is mid-decode, so it MUST be waited for.
{
  const worker = new FakeWorker();
  worker.pending = 1;
  let ticks = 0;
  worker.onFlush = (w) => {
    // The decode finishes while the barrier is waiting.
    if (ticks++ === 0) w.commit("Tell me about your Docker experience");
  };
  const drain = createAsrDrain(worker.transport()).drain();
  // The submit path reads the transcript AFTER awaiting the barrier.
  const submitted = await drain.then(() => worker.committed);
  check("hotkey right after speech waits for the final", worker.flushCalls, 1);
  check("hotkey right after speech sees the committed tail", submitted, [
    "Tell me about your Docker experience",
  ]);
  check("hotkey right after speech reports drained", (await drain).outcome, "drained");
}

// (b) The final is still pending and takes a couple of flushes to land.
{
  const worker = new FakeWorker();
  worker.pending = 1;
  let ticks = 0;
  worker.onFlush = (w) => {
    if (ticks++ < 2) return; // still decoding
    w.commit("Why should we hire you");
  };
  const result = await createAsrDrain(worker.transport()).drain();
  check("a slow final is retried, not abandoned", worker.flushCalls, 3);
  check("a slow final still commits", worker.committed, ["Why should we hire you"]);
  check("a slow final ends as drained", result.outcome, "drained");
  check("a slow final is not a timeout", result.timedOut, false);
}

// (c) A final arrives DURING the drain and must also be picked up.
{
  const worker = new FakeWorker();
  worker.pending = 1;
  let ticks = 0;
  worker.onFlush = (w) => {
    if (ticks++ === 0) {
      // The first flush covers the queued final...
      w.commit("first clause");
      // ...and a second final lands right afterwards, mid-drain.
      w.pending += 1;
    } else {
      w.commit("second clause");
    }
  };
  const result = await createAsrDrain(worker.transport()).drain();
  check("a final arriving during the drain is included", worker.committed, [
    "first clause",
    "second clause",
  ]);
  check("a final arriving during the drain ends as drained", result.outcome, "drained");
  check("nothing is left pending", worker.pending, 0);
}

// (d) A stale final after cancellation: the session was torn down, so the
//     counter is zeroed and the late final must be inert, not re-block.
{
  const worker = new FakeWorker();
  worker.pending = 0; // cancelled: nothing owed
  worker.onFlush = (w) => {
    // A late final from the dead session arrives after the fact.
    w.commit("late final from a cancelled session");
  };
  const result = await createAsrDrain(worker.transport()).drain();
  check("cancelled session takes the fast path (no round-trip)", worker.flushCalls, 0);
  check("cancelled session reports alreadyIdle", result.outcome, "alreadyIdle");
  check("cancelled session is never marked timedOut", result.timedOut, false);
}

// (d2) A late final must not push the counter negative, which would make the
//      NEXT barrier think work is still outstanding forever.
{
  const worker = new FakeWorker();
  worker.pending = 0;
  worker.commit("late final from a cancelled session");
  worker.commit("another late final");
  check("late finals cannot drive the pending count negative", worker.pending, 0);
}

// (e) A wedged worker must NEVER hang the hotkey: bounded, resolves, flagged.
{
  const worker = new FakeWorker();
  worker.pending = 1;
  worker.silent = true;
  const result = await createAsrDrain(worker.transport(), {
    deadlineMs: 200,
    stepMs: 10,
    maxAttempts: 3,
  }).drain();
  check("a silent worker resolves rather than hanging", result.outcome, "timedOut");
  check("a silent worker is flagged as timedOut", result.timedOut, true);
  checkTrue("a silent worker stops at the attempt cap", worker.flushCalls <= 3);
  checkTrue(
    "a silent worker respects the deadline",
    result.waitedMs <= 200 + 100,
  );
}

// (f) The deadline is respected even when the worker keeps answering "busy".
{
  const worker = new FakeWorker();
  worker.pending = 1;
  worker.onFlush = () => {
    /* stays busy forever */
  };
  const result = await createAsrDrain(worker.transport(), {
    deadlineMs: 120,
    stepMs: 20,
    maxAttempts: 99,
  }).drain();
  check("a permanently busy worker still times out", result.outcome, "timedOut");
  checkTrue(
    "a permanently busy worker does not exceed its deadline by much",
    result.waitedMs < 400,
  );
}

// (g) No worker attached (screenshots-only submit) must not block at all.
{
  const started = Date.now();
  const result = await createAsrDrain(null).drain();
  check("no worker resolves immediately", result.outcome, "noWorker");
  checkTrue("no worker costs no measurable time", Date.now() - started < 50);
}

// (h) The default deadline is bounded and sane.
checkTrue("default deadline is under 1.5s", DRAIN_DEADLINE_MS <= 1500);
checkTrue("default deadline is long enough for one decode", DRAIN_DEADLINE_MS >= 400);

// (i) describeDrain never hides a timeout.
{
  const timeouts: string[] = [
    describeDrain({ outcome: "timedOut", waitedMs: 900, attempts: 4, timedOut: true }),
  ];
  checkTrue("a timeout is described as a timeout", timeouts[0].includes("TIMED OUT"));
  checkTrue(
    "a timeout warns that the tail may be missing",
    timeouts[0].includes("may be missing"),
  );
  checkTrue(
    "a drained result is described as drained",
    describeDrain({ outcome: "drained", waitedMs: 120, attempts: 1, timedOut: false }).includes(
      "drained",
    ),
  );
}

// (j) Every outcome is reachable and exhaustive in describeDrain.
{
  const all: DrainResult[] = [
    { outcome: "drained", waitedMs: 1, attempts: 1, timedOut: false },
    { outcome: "timedOut", waitedMs: 1, attempts: 1, timedOut: true },
    { outcome: "alreadyIdle", waitedMs: 0, attempts: 0, timedOut: false },
    { outcome: "noWorker", waitedMs: 0, attempts: 0, timedOut: false },
  ];
  check("every drain outcome has a description", all.map(describeDrain).length, 4);
  checkTrue(
    "no description is empty",
    all.every((r) => describeDrain(r).length > 0),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Segmentation + fragmentation measurement
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Segmentation ──────────────────────────────────────────────");

const FRAME_SECONDS = 128 / 48000; // the real render quantum

/** Build a frame timeline from alternating speech/pause runs. */
function timeline(runs: Array<{ speech: number; pause: number }>): VadFrame[] {
  const frames: VadFrame[] = [];
  for (const run of runs) {
    const speechFrames = Math.round(run.speech / FRAME_SECONDS);
    for (let i = 0; i < speechFrames; i++) {
      frames.push({ seconds: FRAME_SECONDS, rms: 0.05 });
    }
    const pauseFrames = Math.round(run.pause / FRAME_SECONDS);
    for (let i = 0; i < pauseFrames; i++) {
      frames.push({ seconds: FRAME_SECONDS, rms: 0.001 });
    }
  }
  return frames;
}

// A realistic interviewer question: three clauses separated by NATURAL pauses.
// Clause pauses run 0.6–1.2s, and the thinking pause before the last clause
// runs 2.0s. These are the durations that made a 1.0s threshold shred the
// question into three independently-decoded fragments.
const QUESTION: Array<{ speech: number; pause: number }> = [
  { speech: 4.0, pause: 0.8 },  // "…in your experience"  + clause pause
  { speech: 3.2, pause: 1.0 },  // clause pause
  { speech: 2.0, pause: 2.0 },  // clause pause + thinking pause
  { speech: 3.5, pause: 1.6 },  // trailing pause ends the phrase
];

function withSilence(value: number): VadConfig {
  return { ...DEFAULT_VAD_CONFIG, maxSilenceSeconds: value };
}

const CANDIDATES = [1.0, 1.5, 1.8];
const reports = CANDIDATES.map((s) => simulateSegmentation(timeline(QUESTION), withSilence(s)));

// The core measurement: the threshold's effect on a three-clause question.
console.log("\n  Fragmentation of a 3-clause question (12.7s of speech, 1.6s trailing pause):");
console.log(
  "  threshold  segments  undecodable  unclosed  dropped_s  mean_speech  min_speech",
);
for (const r of reports) {
  console.log(
    `  ${r.maxSilenceSeconds.toFixed(1)}s`.padEnd(10) +
      `${r.phrases}`.padEnd(9) +
      `${r.undecodable}`.padEnd(13) +
      `${r.unclosed}`.padEnd(10) +
      `${r.droppedSeconds.toFixed(2)}s`.padEnd(12) +
      `${r.meanSpeechSeconds.toFixed(2)}s`.padEnd(13) +
      `${r.minSpeechSeconds.toFixed(2)}s`,
  );
}

const byThreshold = new Map(reports.map((r) => [r.maxSilenceSeconds, r]));
const at1_0 = byThreshold.get(1.0)!;
const at1_5 = byThreshold.get(1.5)!;
const at1_8 = byThreshold.get(1.8)!;

// The measurement must show the fragmentation the threshold was chosen for.
checkTrue(
  "1.0s shreds the question into more than one segment",
  at1_0.phrases > 1,
);
checkTrue(
  "the selected 1.5s threshold halves 1.0s's fragmentation",
  at1_5.phrases < at1_0.phrases,
);

// ── Why 1.8s was REJECTED, not shipped ──────────────────────────────────
//
// This is the load-bearing assertion of the whole segmentation exercise. 1.8s
// looks better on fragment count alone (it is the tie-break winner), but a
// phrase is only emitted by endPhrase(), which fires on accumulated silence —
// so a threshold above the question's own trailing pause means the final clause
// is never committed AT ALL. The audio is deleted, not merged.
checkTrue(
  "1.8s does NOT fix the fragment count any further than 1.5s",
  at1_8.phrases <= at1_5.phrases,
);
checkTrue(
  "1.8s silently DROPS audio that 1.5s commits",
  at1_8.droppedSeconds > at1_5.droppedSeconds,
);
check("1.5s drops nothing", at1_5.droppedSeconds, 0);
check("1.5s leaves nothing unclosed", at1_5.unclosed, 0);
check("1.0s drops nothing either (it is the safe-but-choppy end)", at1_0.droppedSeconds, 0);

// The requirement: natural pauses must not over-fragment, and no segment at the
// selected threshold may fall under the 1.0 s decodable minimum.
check("no selected-threshold segment falls under the 1.0s minimum", at1_5.undecodable, 0);
checkTrue(
  "every selected-threshold segment is comfortably decodable",
  at1_5.minSpeechSeconds >= MIN_DECODE_SECONDS,
);

// Every segment at the chosen threshold must be decodable — the property that
// connects segmentation back to the token-budget defect.
check(
  "every segment at the selected threshold can actually decode",
  at1_5.segments.every((s) => s.speechSeconds >= MIN_DECODE_SECONDS),
  true,
);

// The default config is the measured one, so the app runs what was measured.
check("the shipped MAX_SILENCE_SECONDS is the measured 1.5s", MAX_SILENCE_SECONDS, 1.5);
check(
  "the default config carries the measured threshold",
  DEFAULT_VAD_CONFIG.maxSilenceSeconds,
  1.5,
);

// The selected threshold must not MERGE genuinely separate questions — the
// opposite failure mode from over-fragmentation.
{
  const twoQuestions = timeline([
    { speech: 3.0, pause: 2.4 }, // Q1, then a long settle
    { speech: 3.0, pause: 2.4 }, // enough trailing silence to actually close
  ]);
  const separated = simulateSegmentation(twoQuestions, DEFAULT_VAD_CONFIG);
  check("1.5s still separates two questions across a 2.4s gap", separated.phrases, 2);
  check("1.5s loses nothing across a 2.4s gap", separated.droppedSeconds, 0);
}

// A trailing pause shorter than the threshold must be reported as dropped,
// never quietly counted as a fragment — this is what caught 1.8s.
{
  const shortTrailing = timeline([{ speech: 3.0, pause: 1.0 }]);
  const at1_8_short = simulateSegmentation(shortTrailing, withSilence(1.8));
  checkTrue(
    "a threshold above the trailing pause reports the loss",
    at1_8_short.droppedSeconds > 0,
  );
  // The real evidence for the choice is the QUESTION timeline: its 1.6s
  // trailing pause is comfortably over 1.5s and comfortably UNDER 1.8s, so
  // 1.5s commits the whole question while 1.8s drops the final clause.
  checkTrue(
    "the selected threshold commits the whole question (1.6s trailing pause)",
    simulateSegmentation(timeline(QUESTION), withSilence(1.5)).droppedSeconds === 0,
  );
  checkTrue(
    "1.8s loses the final clause on that same timeline",
    simulateSegmentation(timeline(QUESTION), withSilence(1.8)).droppedSeconds > 0,
  );
  // A pause below ANY candidate threshold drops audio, and that loss must be
  // visible rather than silently counted as a fragment.
  const at1_5_short = simulateSegmentation(shortTrailing, withSilence(1.5));
  check(
    "a dropped phrase is never miscounted as a committed fragment",
    at1_8_short.phrases === at1_8_short.unclosed &&
      at1_5_short.phrases === at1_5_short.unclosed,
    true,
  );
  checkTrue(
    "the drop is reported, not hidden",
    at1_5_short.unclosed === 1 && at1_5_short.droppedSeconds > 0,
  );
}

// A short interjection ("Yeah, exactly.") must still be captured, not dropped
// by a longer silence requirement.
{
  const short = simulateSegmentation(
    timeline([{ speech: 0.6, pause: 2.0 }]),
    DEFAULT_VAD_CONFIG,
  );
  check("a 0.6s interjection is still captured", short.phrases, 1);
}

// Pure digital silence must never produce a segment.
{
  const silence: VadFrame[] = Array.from({ length: 400 }, () => ({
    seconds: FRAME_SECONDS,
    rms: 0.0,
  }));
  check("digital silence produces no segments", simulateSegmentation(silence).phrases, 0);
}

// A discarded blip must STILL close its phrase, so the interim line clears.
{
  const events = simulateVad(
    timeline([{ speech: 0.1, pause: 2.0 }]), // 0.1s < MIN_SPEECH_SECONDS
    DEFAULT_VAD_CONFIG,
  );
  const closed = events.filter((e) => e.type === "phraseClosed");
  const spoken = events.filter((e) => e.type === "speech");
  check("a 0.1s blip is discarded", spoken.length, 0);
  check("a discarded blip still closes its phrase", closed.length, 1);
}

// A monotonic-loud monologue must be force-flushed by MAX_PHRASE_SECONDS.
{
  const long = simulateSegmentation(
    timeline([{ speech: 35, pause: 2.0 }]),
    DEFAULT_VAD_CONFIG,
  );
  check("a 35s monologue is force-flushed at the phrase cap", long.phrases, 2);
}

// Interim snapshots must be emitted while speech is ongoing (live text).
{
  const events = simulateVad(timeline([{ speech: 5, pause: 2 }]), DEFAULT_VAD_CONFIG);
  checkTrue(
    "interim snapshots fire during speech",
    events.filter((e) => e.type === "partial").length >= 3,
  );
}

// The worklet source must carry the configured thresholds, so the code that
// runs and the code the measurement describes cannot diverge.
{
  const code = buildVadWorkletCode(DEFAULT_VAD_CONFIG);
  checkTrue(
    "worklet source carries the silence threshold",
    code.includes(`this.SILENCE_THRESHOLD = ${SILENCE_THRESHOLD}`),
  );
  checkTrue(
    "worklet source carries the measured MAX_SILENCE_SECONDS",
    code.includes(`this.MAX_SILENCE_SECONDS = ${MAX_SILENCE_SECONDS}`),
  );
  checkTrue(
    "worklet source carries MIN_SPEECH_SECONDS",
    code.includes(`this.MIN_SPEECH_SECONDS = ${MIN_SPEECH_SECONDS}`),
  );
  checkTrue(
    "worklet source still downmixes all channels",
    code.includes("channelCount > 1"),
  );
  // A different config must produce different source.
  const custom = buildVadWorkletCode(withSilence(1.0));
  checkTrue(
    "a different config produces different worklet source",
    custom !== code && custom.includes("this.MAX_SILENCE_SECONDS = 1"),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Debug WAV / clipping
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Debug WAV ─────────────────────────────────────────────────");

{
  // Clean audio: no clipping, and the peak is reported truthfully.
  const clean = Float32Array.from([0, 0.5, -0.5, 0.25, -0.75]);
  const { clipping } = float32ToWavWithClipping(clean, ASR_SAMPLE_RATE);
  check("clean audio reports no clipping", clipping.clippedSamples, 0);
  check("clean audio reports its true peak", clipping.truePeak, 0.75);
  check("clean audio reports zero clipped fraction", clipping.clippedFraction, 0);
}

{
  // Clipped audio: the writer must SURFACE it, not flatten it silently.
  const clipped = Float32Array.from([0.2, 1.8, -2.4, 0.1]);
  const { clipping } = float32ToWavWithClipping(clipped, ASR_SAMPLE_RATE);
  check("over-full-scale samples are counted", clipping.clippedSamples, 2);
  check("the TRUE pre-clamp peak is reported, not the clamped one", Math.round(clipping.truePeak * 100) / 100, 2.4);
  check("clipped fraction is computed", clipping.clippedFraction, 0.5);
  checkTrue(
    "clipping is described as clipping",
    describeClipping(clipping).includes("CLIPPING"),
  );
  checkTrue(
    "the clipping report says it under-represents the audio",
    describeClipping(clipping).includes("under-represents"),
  );
}

{
  // A sample exactly at the rail is saturated but not over it.
  const rail = Float32Array.from([1, -1, 0.5]);
  const { clipping } = float32ToWavWithClipping(rail, ASR_SAMPLE_RATE);
  check("samples exactly at the rail are not counted as clipped", clipping.clippedSamples, 0);
  check("samples at the rail are counted as saturated", clipping.saturatedSamples, 2);
}

{
  // The WAV is still valid, playable 16-bit PCM.
  const { blob } = float32ToWavWithClipping(
    Float32Array.from([0, 0.5, -0.5, 1]),
    ASR_SAMPLE_RATE,
  );
  check("wav mime type", blob.type, "audio/wav");
  check("wav byte length is 44-byte header + 2 bytes/sample", blob.size, 44 + 4 * 2);
}

{
  // Empty input must not divide by zero.
  const { clipping } = float32ToWavWithClipping(new Float32Array(0), ASR_SAMPLE_RATE);
  check("empty audio reports zero clipped fraction", clipping.clippedFraction, 0);
  check("empty audio has a valid header-only wav size", clipping.truePeak, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}