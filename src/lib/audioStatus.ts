/**
 * Live audio capture status + level, shared between the audio pipeline and the UI.
 *
 * ── Why this is NOT in the zustand store ────────────────────────────────────
 * The level meter updates ~20×/second from the VAD worklet. Routing that
 * through React state would re-render the overlay 20×/second. Instead:
 *
 *   • the *state* (LISTENING / SPEECH / …) is a discrete, rarely-changing value
 *     published through a tiny subscribe/getSnapshot store, so it re-renders
 *     only when it actually changes;
 *   • the *level* is written to a plain module variable and read imperatively
 *     by the meter component inside a `requestAnimationFrame` loop, which
 *     writes the bar's width straight to the DOM. Zero React renders.
 *
 * ── What the level represents ───────────────────────────────────────────────
 * The RMS of the **system audio (loopback) stream that feeds the interviewer
 * ASR path** — i.e. the exact signal the VAD segments and Moonshine decodes.
 * It is deliberately NOT the microphone: the mic is never used for the
 * interviewer transcript, so showing its level would be a lie.
 *
 * Raw RMS is never exposed to the UI; only a smoothed 0–100 mapping is.
 */

export type AudioStatusState =
  /** No capture session running. */
  | "idle"
  /** Capture stream exists and the signal is healthy. */
  | "listening"
  /** The VAD is currently inside a detected speech run. */
  | "speech"
  /** A final segment has been sent to the ASR and is being decoded. */
  | "transcribing"
  /** Stream is alive but the signal has been below the usable floor for a while. */
  | "no-audio"
  /** Track ended / device lost / capture source unavailable. */
  | "disconnected"
  /** Capture initialisation or reacquisition failed. */
  | "error";

export interface AudioStatusSnapshot {
  state: AudioStatusState;
  connected: boolean;
  /** Optional short detail for ERROR / DISCONNECTED, e.g. "device removed". */
  detail: string | null;
}

/** RMS below this counts as "no usable audio" (well under the VAD's own 0.008 gate). */
const SILENCE_FLOOR = 0.004;

/** How long the signal must sit below the floor before we say NO AUDIO. */
const SILENCE_TO_FLAG_MS = 2500;

/** React snapshot. Replaced ONLY when the discrete state changes. */
let snapshot: AudioStatusSnapshot = {
  state: "idle",
  connected: false,
  detail: null,
};

const listeners = new Set<() => void>();

/** Imperative, high-frequency values. Never triggers a React render. */
let smoothedLevel = 0;
let silentSince: number | null = null;
let currentState: AudioStatusState = "idle";

export function subscribeAudioStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAudioStatusSnapshot(): AudioStatusSnapshot {
  return snapshot;
}

/** Current meter value, 0–100. Read inside rAF; never causes a render. */
export function getAudioLevel(): number {
  return smoothedLevel;
}

/**
 * Set the discrete state. Emits only on an actual change, so a steady stream
 * of level updates never re-renders the overlay.
 */
export function setAudioStatus(
  state: AudioStatusState,
  detail: string | null = null,
): void {
  if (currentState === state && snapshot.detail === detail) return;
  currentState = state;
  snapshot = {
    state,
    connected: state !== "idle" && state !== "disconnected" && state !== "error",
    detail,
  };
  for (const listener of listeners) listener();
}

/** Reset everything — used when capture stops. */
export function resetAudioStatus(): void {
  smoothedLevel = 0;
  silentSince = null;
  setAudioStatus("idle", null);
}

/**
 * Map linear RMS to a perceptually reasonable 0–100 meter.
 * -60 dBFS → 0, 0 dBFS → 100, so quiet-but-real speech still shows movement.
 */
function rmsToLevel(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

/**
 * Pure decision function for the status machine.
 *
 * Split out from `pushAudioLevel` so the time-dependent branch (sustained
 * silence) can be tested deterministically instead of by waiting on a wall
 * clock. Everything here is a function of the arguments only.
 */
export function resolveAudioState(input: {
  rms: number;
  speaking: boolean;
  /** How long the signal has been continuously below the floor. */
  silentForMs: number;
  current: AudioStatusState;
}): AudioStatusState {
  // A lost device or a failed capture is sticky: a late level sample must not
  // paper over it by flipping back to LISTENING.
  if (input.current === "disconnected" || input.current === "error") {
    return input.current;
  }
  if (input.speaking) return "speech";
  if (
    input.rms < SILENCE_FLOOR &&
    input.silentForMs >= SILENCE_TO_FLAG_MS
  ) {
    // Normal silence is NOT an error — it is its own state.
    return "no-audio";
  }
  // Decoding a final; leave it to the hook to clear.
  if (input.current === "transcribing") return "transcribing";
  return "listening";
}

/**
 * Feed one level sample from the VAD worklet.
 *
 * @param rms      RMS of the system-loopback stream for this window.
 * @param speaking Whether the VAD is currently inside a speech run.
 */
export function pushAudioLevel(rms: number, speaking: boolean): void {
  const target = rmsToLevel(rms);

  // Fast attack, slow release: speech onsets register immediately while the bar
  // eases down afterwards, so it never flickers between words.
  const alpha = target > smoothedLevel ? 0.45 : 0.1;
  smoothedLevel += (target - smoothedLevel) * alpha;
  if (smoothedLevel < 0.5) smoothedLevel = 0;

  const now = Date.now();
  if (rms >= SILENCE_FLOOR) {
    silentSince = null;
  } else if (silentSince === null) {
    silentSince = now;
  }

  const next = resolveAudioState({
    rms,
    speaking,
    silentForMs: silentSince === null ? 0 : now - silentSince,
    current: currentState,
  });

  if (next === "speech") silentSince = null;
  // Only publish on an ACTUAL transition. Calling setAudioStatus with the
  // current state would overwrite a meaningful detail (e.g. "device removed")
  // with null, because that setter's default detail is null.
  if (next !== currentState) setAudioStatus(next);
}