/**
 * Bridge between the global Start/Stop Interview shortcut (owned by
 * `Home.tsx`) and the capture session (owned by `useInterviewAudio`, mounted
 * inside `InterviewModal`).
 *
 * This mirrors `lib/asrDrain.ts`: the audio hook PUBLISHES its start/stop
 * controls into this module-level slot and the hotkey CONSUMES them. Without
 * it the shortcut would have to re-parent the capture session to make the call
 * direct, which is a far larger change than the problem warrants.
 *
 * The slot is also how the shortcut avoids the panel-not-yet-mounted race:
 * when the panel is closed, `Home.tsx` opens it and calls `requestPendingStart()`
 * instead of starting directly. The hook consumes that request once its ASR
 * model is ready, so a single shortcut press is never dropped.
 */

export interface InterviewControls {
  /** Begin the existing interview lifecycle (system-loopback capture). */
  start: () => void;
  /** Stop it exactly as the panel's Stop button does. */
  stop: () => void;
  /** Whether capture is currently running. */
  isRecording: () => boolean;
  /** Whether a start would be accepted right now (model loaded). */
  canStart: () => boolean;
}

let active: InterviewControls | null = null;
let pendingStart = false;

/** Called by the capture hook on mount (and `null` on unmount). */
export function registerInterviewControls(
  controls: InterviewControls | null,
): void {
  active = controls;
}

export function getInterviewControls(): InterviewControls | null {
  return active;
}

/** Ask the (not-yet-mounted) capture hook to start as soon as it can. */
export function requestPendingStart(): void {
  pendingStart = true;
}

/** Read-and-clear the pending-start flag. */
export function consumePendingStart(): boolean {
  const wasPending = pendingStart;
  pendingStart = false;
  return wasPending;
}

/** What a Start/Stop shortcut press should do right now. */
export type ToggleOutcome = "stop" | "start" | "defer-start";

/**
 * Pure decision for the Start/Stop shortcut. Extracted so it can be tested
 * without a DOM or Electron:
 *   • capture running            → "stop"
 *   • idle and the model is ready → "start"
 *   • otherwise                  → "defer-start" (panel mounting / model loading)
 *
 * The caller is responsible for opening the panel when it is closed; this only
 * decides start vs stop vs defer, and never opens a second capture stream.
 */
export function planInterviewToggle(
  state: { isRecording: boolean; canStart: boolean } | null,
): ToggleOutcome {
  if (state?.isRecording) return "stop";
  if (state?.canStart) return "start";
  return "defer-start";
}
