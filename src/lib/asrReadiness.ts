import type { PrimaryAsr } from "./primaryAsr";
import type { ParakeetModelState } from "./parakeetModelClient";

/**
 * Whether the Start button and the start hotkey may run.
 *
 * ── Why this is its own function ────────────────────────────────────────────
 * Readiness must follow the PRIMARY engine. Moonshine and Parakeet each own the
 * truth about themselves — Moonshine via its worker's `ready` message, Parakeet
 * via its model-load result — and NEITHER may gate on the other. Coupling both
 * to Moonshine's loader is exactly what left the Live Interview UI stuck on
 * "Initializing AI engine…": under Parakeet primary, Moonshine is deliberately
 * never loaded, so its `ready` never arrives and a shared readiness flag stays
 * false forever.
 */
export function isInterviewStartReady(
  primaryAsr: PrimaryAsr | string,
  moonshineReady: boolean,
  parakeetStartAllowed: boolean,
): boolean {
  return primaryAsr === "parakeet" ? parakeetStartAllowed : moonshineReady;
}

/**
 * Whether the Parakeet model was probed on mount, without loading it.
 *
 * The model is expensive (~7 s, several hundred MB) and is loaded on Start
 * Interview — never at app launch. What the UI needs before that is only
 * INSTALLATION state, and that is a four-file size check in the main process.
 * A status check must never load the model; this predicate is what keeps the
 * probe and the load separate.
 */
export function shouldProbeParakeetModel(primaryAsr: PrimaryAsr | string): boolean {
  return primaryAsr === "parakeet";
}

/**
 * What the UI knows about the Parakeet model.
 *
 * Distinct from "loaded", deliberately. Two different questions are being asked
 * of the same engine and conflating them is what produced a UI that hung
 * forever: `installed` is a cheap disk check, `ready` is the load.
 *
 *  • unknown     — not checked yet.
 *  • checking    — a probe is in flight.
 *  • installed   — files present and complete; not loaded yet.
 *  • missing     — not downloaded.
 *  • corrupt     — present but the wrong size; must be re-downloaded.
 *  • downloading — the in-app download is running.
 *  • loading     — the model is being loaded (Start Interview).
 *  • ready       — loaded, and transcribing.
 *  • failed      — a load was attempted and failed.
 */
export type ParakeetUiState =
  | "unknown"
  | "checking"
  | "installed"
  | "missing"
  | "corrupt"
  | "downloading"
  | "loading"
  | "ready"
  | "failed";

/** Translate a main-process model state into the UI state above. */
export function parakeetUiStateFromModelState(
  state: Pick<ParakeetModelState, "status" | "message"> | null | undefined,
): ParakeetUiState {
  if (!state) return "unknown";
  switch (state.status) {
    case "ready":
      return "installed";
    case "downloading":
    case "verifying":
      return "downloading";
    case "missing":
      // The manager reports a wrong-sized install as `missing` plus a reason,
      // so the corrupt case has to be read out of the message.
      return /corrupt/i.test(state.message ?? "") ? "corrupt" : "missing";
    case "error":
      return "failed";
    default:
      return "unknown";
  }
}

/**
 * Whether Start may run in this Parakeet state.
 *
 * Capture never actually depends on the model: a segment that arrives while the
 * model is still loading is queued, and one that arrives when the model cannot
 * load at all is handed to the local Moonshine fallback. So the ONLY states that
 * must block Start are the two where the model is genuinely expected to arrive
 * on its own.
 *
 * A model that is missing, corrupt or failed does NOT block Start — blocking it
 * there is what produced a permanently disabled button with a "Loading…"
 * caption and no way forward except going to Settings.
 */
export function isParakeetStartAllowed(state: ParakeetUiState): boolean {
  return state === "installed"
    || state === "ready"
    || state === "missing"
    || state === "corrupt"
    || state === "failed";
}

/** Whether the model is known to be unable to transcribe, so nothing will change. */
export function isParakeetUnavailable(state: ParakeetUiState): boolean {
  return state === "missing" || state === "corrupt" || state === "failed";
}

/** What a finished phrase should do with a Parakeet-primary session. */
export type ParakeetSegmentDisposition = "decode" | "queue" | "fallback";

/**
 * Where a captured segment goes, given what is known about the model.
 *
 *  • ready       — decode it now.
 *  • loading / installed / unknown / checking — hold it; Start loads the model
 *    and the queue drains then. Queuing beats falling back because Moonshine's
 *    load is ~22 s against Parakeet's ~7 s, so a queue that drains is faster
 *    than a fallback that has to compile first.
 *  • missing / corrupt / failed / downloading — Parakeet is not going to
 *    transcribe this segment, so it goes to the local Moonshine fallback now.
 *    Queueing here is what kept segments in a buffer that nothing would ever
 *    drain, losing the question.
 */
export function parakeetSegmentDisposition(state: ParakeetUiState): ParakeetSegmentDisposition {
  if (state === "ready") return "decode";
  if (isParakeetUnavailable(state) || state === "downloading") return "fallback";
  return "queue";
}

/**
 * The one-line explanation for a state that needs the user's attention.
 *
 * Never mentions a transcript, audio or a key.
 */
export function describeParakeetUiState(state: ParakeetUiState): string | null {
  switch (state) {
    case "missing":
      return "The local speech model is not downloaded, so Parakeet cannot transcribe. Download it, or use Moonshine — either way the interview audio stays on this machine.";
    case "corrupt":
      return "The installed speech model is incomplete (the file sizes do not match), so Parakeet cannot transcribe. Download it again, or use Moonshine. Either way the interview audio stays on this machine.";
    case "failed":
      return "The speech model failed to start, so Parakeet cannot transcribe. Retry, or use Moonshine. Either way the interview audio stays on this machine.";
    default:
      return null;
  }
}
