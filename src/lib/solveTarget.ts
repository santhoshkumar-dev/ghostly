/**
 * Which question a Solve press is answering.
 *
 * ── Why this is not decided inline ─────────────────────────────────────────
 * Ctrl+Enter is ONE action with two legitimate inputs: the interviewer's
 * spoken question, and the screenshot sitting in the strip. Which one wins is a
 * product decision, and getting it wrong is what produced the reported
 * "screenshot taken, no answer received" failure:
 *
 *   The interview panel being OPEN was enough to route the press down the
 *   live-audio path. With the transcript gate saying "wait" — no speech, an
 *   incomplete utterance, a conversational aside — the run returned the WAIT
 *   notice and the accumulated screenshot was never sent to any provider. Solve
 *   therefore required an audio submission it did not need, which is exactly
 *   what it is not supposed to do.
 *
 * So the rule is explicit and lives here: a screenshot is a question in its own
 * right, and Solve must answer it whenever there is no answerable spoken
 * question to answer instead.
 *
 * ── An explicit capture outranks the transcript ─────────────────────────────
 * Capture Screen (or Ctrl+Shift+S) is a deliberate user action meaning "answer
 * THIS", so it sets an ARM on the screenshot (see the store's
 * `screenshotArmed`). While that arm is set, Solve answers the screenshot even
 * though a live question exists, and a later, purely-spoken question is
 * unaffected because the arm is consumed by the run that used it.
 *
 * The arm is NOT a timestamp comparison. ASR commits an utterance only after it
 * has decoded, so the interviewer's last sentence routinely lands in the
 * transcript AFTER the user pressed Capture. "Which input is newer" therefore
 * hands Solve to a sentence that was already on screen when the capture
 * happened — the exact "screenshot taken, audio won, no answer" failure this
 * module exists to prevent. An explicit capture is a user ACTION, not a
 * timestamp, and it is recorded as one.
 */

/** A screenshot entry is only usable if it is a non-empty string. */
export function isUsableScreenshot(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Every screenshot the run may send, with payload-less entries discarded. */
export function usableScreenshots(screenshots: readonly unknown[]): string[] {
  return screenshots.filter(isUsableScreenshot);
}

/**
 * The newest screenshot actually worth attaching to a run.
 *
 * `screenshots[length - 1]` was used before. A single payload-less entry at the
 * end of the list therefore suppressed the image entirely, and the provider was
 * asked to read a picture that was never transmitted.
 */
export function lastUsableScreenshot(
  screenshots: readonly unknown[],
): string | undefined {
  for (let i = screenshots.length - 1; i >= 0; i--) {
    const candidate = screenshots[i];
    if (isUsableScreenshot(candidate)) return candidate;
  }
  return undefined;
}

export type SolveTarget = "interview" | "screenshot";

export interface SolveTargetDecision {
  target: SolveTarget;
  /** Closed vocabulary, safe to log. Never question or answer text. */
  reason:
    | "interview question wins"
    | "the screenshot was captured explicitly and is not yet solved"
    | "no live question — solving the screenshot"
    | "screenshot solve is not possible";
}

export interface SolveTargetInput {
  /** Was there a transcript to gate at all (i.e. is the panel open)? */
  hasTurn: boolean;
  /** Did the local question gate accept the transcript? */
  gateSaysAnswer: boolean;
  /** How many screenshots are actually attachable. */
  usableScreenshots: number;
  /**
   * True when the user explicitly captured a screenshot that no Solve has
   * consumed yet. This is the "answer what I just captured" signal, and it
   * outranks a live question while it is set.
   */
  screenshotArmed?: boolean;
}

/**
 * Decide what a Solve press answers.
 *
 * ── The explicit-capture rule ──────────────────────────────────────────────
 * Capture Screen → Solve must solve the SCREENSHOT, even when a live
 * transcript exists whose gate still says "answer". The old rule — "an
 * answerable interview question always wins" — is exactly the reported
 * failure: screenshot exists → Solve → interview target wins → screenshot
 * ignored → no answer.
 *
 * The arm, not a timestamp, decides it. The user pressed Capture, which is an
 * explicit instruction, and it stands until a Solve run consumes it. If the
 * interviewer happens to keep speaking (or ASR merely COMMITS their earlier
 * sentence) after that press, the transcript is still not what the user asked
 * to solve — see the module header for why comparing instants gets this wrong.
 *
 * With no arm set, the rule is unchanged: a live question wins; otherwise an
 * existing screenshot is the fallback, and with neither there is nothing to
 * solve.
 */
export function decideSolveTarget(
  input: SolveTargetInput,
): SolveTargetDecision {
  const canSolveScreenshot = input.usableScreenshots > 0;
  const hasLiveQuestion = input.hasTurn && input.gateSaysAnswer;

  // An explicit capture the user has not yet solved outranks the transcript.
  if (canSolveScreenshot && input.screenshotArmed) {
    return {
      target: "screenshot",
      reason: "the screenshot was captured explicitly and is not yet solved",
    };
  }

  if (hasLiveQuestion) {
    return { target: "interview", reason: "interview question wins" };
  }
  if (canSolveScreenshot) {
    return {
      target: "screenshot",
      reason: "no live question — solving the screenshot",
    };
  }
  return {
    target: "interview",
    reason: "screenshot solve is not possible",
  };
}
