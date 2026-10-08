/**
 * Force-endpoint on `Ctrl+Enter` — closing the race the drain barrier cannot.
 *
 * ── The bug this closes ────────────────────────────────────────────────────
 * `asrDrain.ts` waits for finals that are ALREADY in the worker's queue. A
 * phrase the VAD has not closed is not a final: it is a Float32Array still
 * sitting in the AudioWorklet's buffer, waiting for
 * `MAX_SILENCE_SECONDS` (1.5 s) of silence to accumulate. So pressing the
 * hotkey within 1.5 s of the interviewer's last word gives
 * `pendingFinalsRef === 0`, the barrier takes its fast path, returns
 * `alreadyIdle`, and the question is submitted with its tail missing — a
 * confidently wrong answer rather than a visible failure.
 *
 * This closes that race by asking the EXISTING VAD to close its open phrase
 * immediately, using the EXISTING worklet and the EXISTING decode path. No
 * second VAD, no second capture stream, no threshold changes.
 *
 * ── The rules, and why each one is a rule ──────────────────────────────────
 * 1. Only when a phrase is open AND the VAD currently reports silence. If the
 *    interviewer is mid-word, forcing would cut the word off.
 * 2. If the interviewer is speaking right now, do nothing — the gate already
 *    says "still speaking" and that stays authoritative.
 * 3. Parakeet primary only. Under Moonshine the handler is never invoked, so
 *    that path is unchanged.
 * 4. Numbers only in the log: whether it fired, the buffered milliseconds, the
 *    decode milliseconds. No audio, no transcript.
 */

/** Why the force did not fire. One of the closed set below. */
export type ForceSkipReason =
  | "setting-off"
  | "not-parakeet-primary"
  | "no-capture-session"
  | "no-phrase-open"
  | "interviewer-still-speaking";

export const FORCE_SKIP_REASONS: readonly ForceSkipReason[] = [
  "setting-off",
  "not-parakeet-primary",
  "no-capture-session",
  "no-phrase-open",
  "interviewer-still-speaking",
];

export interface ForceEndpointInput {
  /** `settings.forceEndpointOnHotkey !== false` — see the settings comment. */
  enabled: boolean;
  /** Parakeet is the primary ASR engine for this session. */
  parakeetPrimary: boolean;
  /** A capture session with a live VAD instance exists. */
  hasSession: boolean;
  /** The VAD currently holds buffered speech (`audioBuffer.length > 0`). */
  phraseOpen: boolean;
  /** The VAD saw a sub-threshold frame most recently — i.e. it is silent now. */
  currentlySilent: boolean;
  /** Seconds of speech accumulated in the open phrase, for the log. */
  speechSeconds: number;
}

export interface ForceEndpointDecision {
  /** True only when it is safe and useful to close the phrase. */
  fire: boolean;
  /** Always set: the reason it did not fire, or `"fire"`. */
  reason: ForceSkipReason | "fire";
  /** Speech seconds buffered at decision time. Always reported, never logged as text. */
  bufferedSeconds: number;
  /**
   * Below `MIN_SPEECH_SECONDS` the worklet would DISCARD the phrase anyway, so
   * forcing it would waste a decode and produce nothing.
   */
  discardedIfForced: boolean;
}

/** Mirrors `MIN_SPEECH_SECONDS` in `vadWorklet.ts`. */
export const FORCE_MIN_SPEECH_SECONDS = 0.35;

/**
 * The whole decision, as one pure function.
 *
 * Order is the specification: the cheapest and most fundamental gates first, so
 * the reported reason is always the FIRST reason the force did not happen, not
 * an artefact of evaluation order.
 */
export function decideForceEndpoint(input: ForceEndpointInput): ForceEndpointDecision {
  const bufferedSeconds = Number.isFinite(input.speechSeconds)
    ? Math.max(0, input.speechSeconds)
    : 0;
  const discardedIfForced = bufferedSeconds < FORCE_MIN_SPEECH_SECONDS;

  if (!input.enabled) return { fire: false, reason: "setting-off", bufferedSeconds, discardedIfForced };
  if (!input.parakeetPrimary) return { fire: false, reason: "not-parakeet-primary", bufferedSeconds, discardedIfForced };
  if (!input.hasSession) return { fire: false, reason: "no-capture-session", bufferedSeconds, discardedIfForced };
  if (!input.phraseOpen) return { fire: false, reason: "no-phrase-open", bufferedSeconds, discardedIfForced };
  if (!input.currentlySilent) return { fire: false, reason: "interviewer-still-speaking", bufferedSeconds, discardedIfForced };

  return { fire: true, reason: "fire", bufferedSeconds, discardedIfForced };
}

/** The one log line: numbers and a closed-vocabulary reason, nothing else. */
export function describeForceEndpoint(
  decision: ForceEndpointDecision,
  decodeMs: number | null,
): string {
  if (!decision.fire) {
    return `force-endpoint skipped reason=${decision.reason}`;
  }
  return (
    `force-endpoint fired bufferedMs=${Math.round(decision.bufferedSeconds * 1000)}` +
    ` decodeMs=${decodeMs === null ? "-" : Math.round(decodeMs)}`
  );
}

/** Shape of the worklet's reply to a `force-endpoint` request. */
export interface ForceEndpointReply {
  type: "forceEndpointResult";
  /** Whether the worklet actually closed a phrase. */
  fired: boolean;
  /** Speech seconds the worklet had buffered. */
  bufferedSeconds: number;
  /**
   * True when the worklet refused because the last frame was speech. The
   * renderer decides first; the worklet re-checks authoritatively and this is
   * how it reports disagreement.
   */
  speakingNow: boolean;
}