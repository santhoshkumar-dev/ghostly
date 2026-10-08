/**
 * The minimal retained context for a follow-up request.
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 * After a screenshot is solved, the OCR text is the active problem context and
 * every later follow-up must stay about it. The previous behaviour resent the
 * accumulated conversation: `sessionMessages.slice(-6)` as raw chat history on
 * the typed-follow-up path, plus the last two answers as `previousAnswers` on
 * the interview path. One measured follow-up reached ~12,335 input tokens and
 * exceeded Groq's input-token-per-minute limit (Groq documents input and output
 * token rate limits separately).
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * A follow-up request carries ONLY:
 *   1. the active screenshot/OCR problem context,
 *   2. the latest follow-up question (never truncated — it enters through its
 *      own prompt section, untouched by anything here),
 *   3. AT MOST the latest relevant answer.
 *
 * The combined retained context (problem text + retained answers) is capped at
 * {@link MAX_FOLLOWUP_CONTEXT_CHARS}, keeping the BEGINNING of the problem
 * statement rather than truncating the middle — the problem is what every
 * follow-up in the drill-down is about.
 *
 * No LLM call, no persistence: deterministic truncation only, so a failed or
 * missing summary can never block an answer.
 */

/**
 * Named maximum for the retained follow-up context (problem text + retained
 * answers), in characters.
 *
 * Start conservative — ~6000–8000 — and measure rather than assume. 8000 chars
 * ≈ 2000 tokens, which leaves comfortable room under a per-minute input budget
 * even with the prompt template and system message on top.
 */
export const MAX_FOLLOWUP_CONTEXT_CHARS = 8000;

/**
 * Trim to a character budget on a word boundary when possible.
 *
 * Keeps the BEGINNING (the problem statement / answer opening) rather than an
 * arbitrary middle slice. `max <= 0` yields an empty string so a budget that is
 * fully consumed cannot silently leak the whole text back in.
 */
export function truncateToCharLimit(text: string, max: number): string {
  if (max <= 0) return "";
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

/**
 * The previous-answer slice retained for a follow-up request: AT MOST the
 * latest relevant answer (a single entry), word-boundary truncated under
 * {@link MAX_FOLLOWUP_CONTEXT_CHARS}. Never the whole conversation.
 */
export function buildTruncatedFollowupAnswers(
  messages: { role: "user" | "assistant"; content: string }[],
): string[] {
  const latest = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.content.trim());
  if (!latest) return [];
  return [truncateToCharLimit(latest.content, MAX_FOLLOWUP_CONTEXT_CHARS)];
}

/**
 * Character budget for the problem/screen text of a follow-up request, given
 * the already-retained answers, so their SUM stays ≤
 * {@link MAX_FOLLOWUP_CONTEXT_CHARS}.
 */
export function followupContextBudget(retainedAnswers: string[]): number {
  const answerChars = retainedAnswers.reduce((n, a) => n + a.length, 0);
  return Math.max(0, MAX_FOLLOWUP_CONTEXT_CHARS - answerChars);
}
