/**
 * Which engine transcribes the interviewer.
 *
 * ── Why this is a setting and not a flag ─────────────────────────────────────
 * Moonshine was the only engine for the first five phases, so "Moonshine" was
 * never written down anywhere — it was the absence of a choice. Adding Parakeet
 * makes the choice explicit, and an explicit choice has to be persisted, or a
 * restart silently reverts it.
 *
 * `parakeet` is the default in code. It is the faster local engine (a batch
 * decoder that needs no ~22 s model load) and the one the interview path is
 * expected to use. Moonshine is NOT removed: it stays the local FALLBACK for
 * any segment Parakeet cannot decode, and an explicit `"moonshine"` selection
 * is preserved verbatim.
 *
 * A stored settings blob with no `primaryAsr` key resolves to Parakeet. That is
 * still upgrade-safe: when Parakeet's model is not installed, the Parakeet path
 * falls back to the local Moonshine model, so nobody is left with no engine.
 */
export type PrimaryAsr = "moonshine" | "parakeet";

/** The value a missing/invalid `primaryAsr` resolves to. */
export const DEFAULT_PRIMARY_ASR: PrimaryAsr = "parakeet";

/**
 * Coerce whatever came out of storage into a valid engine.
 *
 * The settings blob is user-writable on disk, so an unknown string must not be
 * allowed to reach a branch that expects two engines. Anything unrecognised
 * resolves to the default rather than throwing: a corrupt settings file must not
 * be able to stop the app from starting.
 *
 * An EXPLICIT `"moonshine"` is preserved: the default changed to Parakeet, but a
 * user who deliberately keeps Moonshine must not be silently switched. Only
 * `"moonshine"` counts as a choice; everything else resolves to the default.
 */
export function normalizePrimaryAsr(value: unknown): PrimaryAsr {
  return value === "moonshine" ? "moonshine" : DEFAULT_PRIMARY_ASR;
}

/**
 * Parakeet failures that must fall back to Moonshine for THAT segment.
 *
 * Deliberately enumerated rather than "anything that isn't ok", because the two
 * categories mean opposite things:
 *
 *   • Recoverable — the segment simply did not get a transcript. Retrying it on
 *     Moonshine costs one local decode and loses nothing. `model_missing`,
 *     `timeout` and `crashed` are all recoverable: the model may be installed
 *     later, or a restart may fix the child process.
 *
 *   • NOT recoverable — the request itself was wrong. `invalid_audio` and
 *     `too_long` are properties of the BUFFER, so Moonshine would reject it for
 *     exactly the same reason and the fallback would only add a second useless
 *     decode.
 *
 * `empty` is NOT here. An empty result is not a failure: it is a successful
 * decode of audio that contained no speech the model recognised, and Moonshine
 * running over the same silence tends to hallucinate rather than recover.
 */
export const PARAKEET_FALLBACK_CODES = [
  "model_missing",
  "timeout",
  "crashed",
  "restart_exhausted",
  "busy",
  "shutdown",
  "malformed",
] as const;

export type ParakeetFallbackCode = (typeof PARAKEET_FALLBACK_CODES)[number];

/** Whether a Parakeet failure code should hand the segment to Moonshine. */
export function shouldFallbackToMoonshine(code: unknown): boolean {
  return (PARAKEET_FALLBACK_CODES as readonly string[]).includes(String(code));
}

/**
 * The `parakeetUnavailable` condition: Parakeet genuinely cannot serve, as
 * opposed to serving an empty transcript.
 *
 * This is the ONLY condition that may load the Moonshine fallback. It is a
 * property of the MODEL/PROCESS (missing, timed out, crashed, unrestartable,
 * busy, shut down, malformed reply) — never of the decoded text. A successful
 * decode that returns `""` is explicitly NOT unavailability (see
 * `PARAKEET_EMPTY_FALLBACK`), and buffer rejections (`invalid_audio`,
 * `too_long`) are not either: Moonshine would reject the same buffer.
 */
export function isParakeetUnavailable(code: unknown): boolean {
  return shouldFallbackToMoonshine(code);
}

/**
 * Available system RAM below which a Moonshine fallback load is REFUSED.
 *
 * Measured context: the Parakeet child holds ~700–800 MB RSS, and production
 * logs showed available RAM as low as ~288 MB while fallback loads were still
 * being kicked off per empty phrase. Moonshine's own load is hundreds of MB,
 * so starting it under this floor risks pushing the machine into severe memory
 * pressure (and the 15–20 s transcript lag that comes with it). Below the
 * floor the segment resolves as an empty final and Parakeet stays primary.
 */
export const MIN_FALLBACK_AVAILABLE_MB = 1200;

/**
 * Human-readable one-liner for the fallback log line.
 *
 * Codes only. The message can reach the on-screen log while an interview is
 * running, so it must not carry a transcript, an audio buffer or a path.
 */
export function describeParakeetFallback(code: unknown): string {
  switch (code) {
    case "model_missing":
      return "speech model is not installed";
    case "timeout":
      return "the model did not answer in time";
    case "crashed":
      return "the speech model process stopped";
    case "restart_exhausted":
      return "the speech model could not be restarted";
    case "busy":
      return "the speech model is already starting";
    case "shutdown":
      return "the speech model was released mid-interview";
    case "malformed":
      return "the speech model sent an unreadable reply";
    case "disabled":
      return "local Parakeet is switched off";
    case "invalid_audio":
    case "too_long":
      return "the segment was rejected before it reached the model";
    default:
      return "the speech model failed";
  }
}
