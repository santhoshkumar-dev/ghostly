/**
 * Choosing ONE context block per turn.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * `activeProblem` and `conversationThread` can both exist at once. A candidate
 * working on "find duplicate numbers" who is then asked about Redis has both.
 * Exactly ONE block may be attached, because attaching both would hand the model
 * two unrelated contexts with no way to tell which the question is about, and it
 * would answer by blending them.
 *
 * ── How the choice is made (deterministic, no model) ────────────────────────
 *  1. Only one side attaches → that side.
 *  2. Neither attaches → no block at all, and the prompt is byte-identical to
 *     today's (see `verify-context-selection.ts`).
 *  3. Both attach → score them:
 *       • A CODING-PROBLEM cue strongly favours `activeProblem`. This is
 *         deliberately not a tiebreak: "why did you use a HashSet?" is about the
 *         code the candidate is writing, and answering it from a Redis thread
 *         because Redis scored a marginally higher overlap would be actively
 *         wrong.
 *       • Otherwise the higher measured overlap wins, and a tie goes to
 *         `conversationThread`, because a thread only attaches when it matched
 *         its own cue or cleared the overlap threshold, whereas a problem
 *         attaches on a broader cue set.
 *
 * ── Character cap ───────────────────────────────────────────────────────────
 * The chosen block is capped after selection. The cap is a backstop for a
 * pathological problem statement, not the normal case; the measured sizes are
 * reported by `verify-context-selection.ts`.
 */

import {
  buildContextBlock,
  type FollowUpVerdict,
  type SessionContext,
} from "./sessionContext";
import {
  buildThreadBlock,
  continueThread,
  type ConversationThread,
  type ThreadVerdict,
} from "./conversationThread";

/**
 * Hard cap on the assembled context block, in characters.
 *
 * The two sources are already capped individually (600 for a problem, and the
 * thread by turn count and answer-head length). This bounds the SUM, which is
 * the number that actually reaches the prompt. Chosen to sit well under the
 * smallest measured problem statement while leaving a full 3-turn thread room.
 */
export const CONTEXT_BLOCK_MAX_CHARS = 1400;

export type ContextChoice = "active-problem" | "conversation-thread" | "none";

export interface ContextSelection {
  choice: ContextChoice;
  /** The block to send. Always `""` when `choice` is `"none"`. */
  block: string;
  /** Character count actually added to the prompt. */
  chars: number;
  /** Whether the block had to be truncated to fit {@link CONTEXT_BLOCK_MAX_CHARS}. */
  truncated: boolean;
  /** Why, in closed vocabulary — safe to log. */
  reason: string;
  /** The thread verdict, always reported, because it is the instrument. */
  threadVerdict: ThreadVerdict;
}

/**
 * Cues that mean the question is about the CODE the candidate is working on.
 *
 * Structural vocabulary about the work, never a technology or a topic. Used only
 * to favour `activeProblem` when both contexts could attach.
 */
const CODING_CUES: RegExp[] = [
  // Complexity and optimisation of the work in progress.
  /\b(?:time|space|computational)\s+complexity\b|\bcomplexity\b/i,
  /\boptimi[sz]e\b|\bfaster\b|\bmemory\b|\bextra\s+space\b|\bin[- ]place\b/i,
  // Referring to the candidate's own solution.
  /\b(?:your|the)\s+(?:solution|approach|code|implementation|algorithm|answer)\b/i,
  // Data-structure choices, the classic post-problem question.
  /\bwhy\s+(?:did|do)\s+you\s+(?:use|choose|pick)\b/i,
  // Edge cases of the stated problem.
  /\bedge\s+cases?\b|\blarge\s+input\b|\bduplicates?\b|\bbig\s*-?\s*o\b/i,
];

/** Whether the question is plainly about the active coding problem. */
export function hasCodingCue(question: string): boolean {
  return CODING_CUES.some((re) => re.test(question ?? ""));
}

/** Trim on a word boundary, with an ellipsis only when something was cut. */
function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

/**
 * Pick the single context block for this turn.
 *
 * @param question     The corrected latest question.
 * @param problem      The verdict already produced by `classifyFollowUp`.
 * @param context      The session context, used to render the problem block.
 * @param thread       The thread, or null.
 * @param now          Injected clock, so tests are deterministic.
 */
export function selectContextBlock(input: {
  question: string;
  problem: FollowUpVerdict;
  context: SessionContext;
  thread: ConversationThread | null;
  now: number;
}): ContextSelection {
  const { question, problem, context, thread, now } = input;

  const threadVerdict = continueThread(question, thread, now);
  const problemBlock = problem.attach ? buildContextBlock(context) : "";
  const threadBlock = threadVerdict.attach ? buildThreadBlock(thread) : "";

  const finish = (
    choice: ContextChoice,
    raw: string,
    reason: string,
  ): ContextSelection => {
    const clipped = raw.length > CONTEXT_BLOCK_MAX_CHARS
      ? clip(raw, CONTEXT_BLOCK_MAX_CHARS)
      : raw;
    return {
      choice,
      block: choice === "none" ? "" : clipped,
      chars: choice === "none" ? 0 : clipped.length,
      truncated: raw.length > CONTEXT_BLOCK_MAX_CHARS,
      reason,
      threadVerdict,
    };
  };

  const problemUsable = problem.attach && problemBlock.length > 0;
  const threadUsable = threadVerdict.attach && threadBlock.length > 0;

  if (!problemUsable && !threadUsable) {
    return finish(
      "none",
      "",
      problem.attach
        ? "problem verdict attached but the problem block was empty"
        : threadVerdict.attach
          ? "thread verdict attached but the thread block was empty"
          : "neither context attached",
    );
  }

  if (problemUsable && !threadUsable) {
    return finish("active-problem", problemBlock, "only the active problem attached");
  }

  if (threadUsable && !problemUsable) {
    return finish(
      "conversation-thread",
      threadBlock,
      "only the conversation thread attached",
    );
  }

  // ── Both could attach ─────────────────────────────────────────────────────
  // A coding cue is decisive rather than a tiebreak: the question is about the
  // work, and answering it from an unrelated thread would be wrong.
  if (hasCodingCue(question)) {
    return finish(
      "active-problem",
      problemBlock,
      "both attached; a coding cue favours the active problem",
    );
  }

  if (threadVerdict.overlap > 0 && threadVerdict.overlap >= 0.5) {
    return finish(
      "conversation-thread",
      threadBlock,
      "both attached; strong thread overlap favours the thread",
    );
  }

  // Default when both attach and nothing distinguishes them: the problem. It is
  // the context the candidate is actively working inside, and it was established
  // before the thread.
  return finish(
    "active-problem",
    problemBlock,
    "both attached; no distinguishing signal, favouring the active problem",
  );
}
