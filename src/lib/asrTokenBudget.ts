/**
 * The decode token budget for Moonshine — the single source of truth for how
 * many tokens a segment is allowed to produce.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `@huggingface/transformers` computes the budget itself, in
 * `src/pipelines.js` → `_call_moonshine`:
 *
 *     const max_new_tokens = Math.floor(aud.length / sampling_rate) * 6;
 *
 * Two defects in one line, both of which Ghostly was hitting on every short
 * segment:
 *
 *   1. `Math.floor(seconds) * 6` — at 16 kHz anything under 1.0 s floors to 0,
 *      and `generate({ max_new_tokens: 0 })` produces ZERO tokens. The
 *      pipeline then decodes an empty sequence and returns `text === ""`.
 *      This is not "the model was unsure", it is "the model was never allowed
 *      to emit anything". The symptom chain was: no first interim, empty
 *      finals, and finals truncated mid-sentence (a 1.4 s clip got 6 tokens,
 *      a hard 6 tokens ≈ "But if you want to").
 *   2. `prepareAudios()` (same file) does no padding and no length floor — it
 *      only wraps the input in a `Float32Array`. So there is no library-side
 *      protection against a sub-second buffer at all.
 *
 * The upstream comment cites the Moonshine paper's "heuristic limit of 6 output
 * tokens per second of audio to avoid repeated output sequences". That
 * heuristic is a *hallucination guard*, not a hard floor: the model needs room
 * to finish a word that started in the last 100 ms. So we keep the 6/s slope
 * and add a fixed margin above it, and we never let the budget reach zero.
 *
 * ── Why it is its own module ────────────────────────────────────────────────
 * `asr.worker.ts` runs inside a Web Worker and is not importable from a plain
 * Node/tsx test run. The formula is the part that must be unit-tested, so it
 * lives here as a pure function with no worker, DOM or transformers
 * dependency. The worker imports it; the test harness imports it.
 *
 * ── What this deliberately does NOT do ─────────────────────────────────────
 * No padding of short buffers, and no change to which segments are accepted.
 * Those are separate concerns (see `asr.worker.ts` for the minimum-duration
 * gate and `useInterviewAudio.ts` for the VAD's `MIN_SPEECH_SECONDS`).
 */

/** Moonshine's native input rate. The whole pipeline resamples to this. */
export const ASR_SAMPLE_RATE = 16000;

/**
 * The paper's heuristic slope: ~6 output tokens per second of audio, used to
 * stop the decoder looping on a repetitive segment. Kept as the *slope* of the
 * budget, never as a multiplier of a floored second count.
 */
export const TOKENS_PER_SECOND = 6;

/**
 * Fixed headroom above the heuristic slope.
 *
 * The 6/s heuristic deliberately sits close to real speech rate, so a segment
 * that ends mid-word (which is every segment — the VAD cuts on a pause, not a
 * word boundary) needs room for the trailing partial word to be emitted. 8
 * tokens is roughly one to two English words, which is enough to close out a
 * clipped word without meaningfully raising the hallucination risk that the
 * heuristic exists to control.
 */
export const TOKEN_MARGIN = 8;

/**
 * Absolute floor for the budget, independent of segment length.
 *
 * Guarantees `maxNewTokensFor` can never return 0 for any input, which is the
 * specific failure this whole file exists to prevent. A 0.3 s segment would
 * otherwise compute to `ceil(0.3 * 6) + 8 = 10`; this floor also covers
 * degenerate near-zero-length inputs that reach the worker through a bug.
 */
export const MIN_TOKEN_BUDGET = 16;

/**
 * Upper bound on the budget.
 *
 * Purely a runaway guard: the VAD already caps a phrase at
 * `MAX_PHRASE_SECONDS` (30 s), which is 188 tokens, so normal traffic never
 * approaches this. It bounds the damage if a very long buffer is ever sent.
 */
export const MAX_TOKEN_BUDGET = 512;

/**
 * The minimum duration Moonshine can be expected to decode meaningfully.
 *
 * 1.0 s is not an arbitrary round number — it is exactly the boundary at which
 * the library's own `Math.floor(seconds) * 6` first stops returning 0, and so
 * the first duration the library can decode at all. Anything shorter than this
 * has no working reference decode.
 */
export const MIN_DECODE_SECONDS = 1.0;

/** `MIN_DECODE_SECONDS` expressed in samples at {@link ASR_SAMPLE_RATE}. */
export const MIN_DECODE_SAMPLES = Math.round(
  MIN_DECODE_SECONDS * ASR_SAMPLE_RATE,
); // 16000

/**
 * Whether a buffer is long enough to be worth sending to the model at all.
 *
 * `MIN_DECODE_SAMPLES` (16000) is 10x the old `MIN_SAMPLES` (1600 = 0.1 s).
 * The old value was wrong by an order of magnitude: it admitted sub-second
 * buffers, which then hit the library's 0-token path and came back as empty
 * text. Those empty results were indistinguishable from "silence" downstream,
 * which is how short speech silently disappeared.
 */
export function isDecodableLength(sampleCount: number): boolean {
  return Number.isFinite(sampleCount) && sampleCount >= MIN_DECODE_SAMPLES;
}

/**
 * The `max_new_tokens` to decode a segment with.
 *
 * Deterministic and pure: same sample count in, same budget out, no clamping
 * surprises, and never 0.
 *
 *   budget = clamp(MIN_TOKEN_BUDGET, ceil(seconds * 6) + 8, MAX_TOKEN_BUDGET)
 *
 * `Math.ceil` rather than the library's `Math.floor` is the fix that matters:
 * ceiling is what makes a 1.4 s segment get 17 tokens (enough to finish a
 * sentence) instead of 6 (a hard mid-sentence cut), and it guarantees a
 * positive budget at every positive duration.
 *
 * @param sampleCount Length of the 16 kHz mono buffer.
 * @param sampleRate  Input rate; defaults to Moonshine's native 16 kHz.
 */
export function maxNewTokensFor(
  sampleCount: number,
  sampleRate: number = ASR_SAMPLE_RATE,
): number {
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) {
    return MIN_TOKEN_BUDGET;
  }
  const rate = Number.isFinite(sampleRate) && sampleRate > 0
    ? sampleRate
    : ASR_SAMPLE_RATE;
  const seconds = sampleCount / rate;
  const budget = Math.ceil(seconds * TOKENS_PER_SECOND) + TOKEN_MARGIN;
  return Math.min(MAX_TOKEN_BUDGET, Math.max(MIN_TOKEN_BUDGET, budget));
}

/** Duration of a 16 kHz buffer, in seconds. Diagnostics only. */
export function durationSecondsFor(
  sampleCount: number,
  sampleRate: number = ASR_SAMPLE_RATE,
): number {
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) return 0;
  const rate = Number.isFinite(sampleRate) && sampleRate > 0
    ? sampleRate
    : ASR_SAMPLE_RATE;
  return sampleCount / rate;
}
