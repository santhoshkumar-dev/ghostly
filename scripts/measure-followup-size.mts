/**
 * Measure the follow-up request payload BEFORE and AFTER the context cap.
 *
 * Run: `npx tsx scripts/measure-followup-size.mts`
 *
 * Reproduces the typed-follow-up path (the overlay's "Ask a follow-up question"
 * box → `runAIStream(..., followUpQuery)`) and the interview-branch prompt with
 * a realistic session: a screenshot-solved problem plus three follow-ups and
 * long code answers.
 *
 * "OLD" = the previous behaviour: `sessionMessages.slice(-6)` as raw chat
 * history (typed path) / the last two answers (interview path), with the FULL
 * screen text. "NEW" = the capped behaviour in `lib/followupContext.ts`.
 *
 * Numbers only — no question or answer text is printed.
 */

import {
  appendScreenText,
  buildInterviewContext,
} from "../src/lib/prompts";
import { buildInterviewUserPrompt } from "../src/lib/interviewAgent";
import {
  MAX_FOLLOWUP_CONTEXT_CHARS,
  buildTruncatedFollowupAnswers,
  followupContextBudget,
  truncateToCharLimit,
} from "../src/lib/followupContext";

// ── A realistic session ────────────────────────────────────────────────────

const SCREEN_TEXT = [
  "Two Sum",
  "Given an array of integers nums and an integer target, return indices of the",
  "two numbers such that they add up to target.",
  "You may assume that each input would have exactly one solution, and you may",
  "not use the same element twice.",
  "Example 1: Input: nums = [2,7,11,15], target = 9 → Output: [0,1]",
  "Example 2: Input: nums = [3,2,4], target = 6 → Output: [1,2]",
  "def two_sum(nums, target):",
  "    seen = {}",
  "    for i, n in enumerate(nums):",
  "        if target - n in seen:",
  "            return [seen[target - n], i]",
  "        seen[n] = i",
  "    return []",
].join("\n");

// Long, realistic answers (a code answer with explanation ≈ 2–3k chars).
const makeAnswer = (tag: string, len: number): string => {
  const base =
    `Approach for ${tag}: I use a hash map so each element's complement is a ` +
    `single O(1) lookup, giving one pass over the array. ` +
    "```python\ndef solve(xs):\n    seen = {}\n    for i, x in enumerate(xs):\n" +
    "        if x in seen:\n            return [seen[x], i]\n        seen[x] = i\n    return []\n```\n" +
    "Time O(n), space O(n). ".repeat(10);
  return base.length >= len ? base.slice(0, len) : base + "x".repeat(len - base.length);
};

type Msg = { role: "user" | "assistant"; content: string };

// 3 Q/A pairs, answers ~2400 chars each (typical code answer), like the chat
// before a follow-up is typed. This mirrors the measured problem: six full
// messages were resent on every follow-up.
const sessionMessages: Msg[] = [
  { role: "user", content: "Solve the problem on screen." },
  { role: "assistant", content: makeAnswer("answer1", 2400) },
  { role: "user", content: "Why did you choose this approach?" },
  { role: "assistant", content: makeAnswer("answer2", 2400) },
  { role: "user", content: "Can you optimize it?" },
  { role: "assistant", content: makeAnswer("answer3", 2400) },
];

const question = "What is the time complexity?";

const settings = {
  companyName: "Acme",
  jobDescription: "Backend intern. ".repeat(40), // ~600 chars
  projectContext: "Built a cache. ".repeat(30),
  answerInstructions: "Be concise.",
  language: "python" as const,
};

// ── OLD typed-follow-up payload ────────────────────────────────────────────

const oldPrompt =
  question +
  buildInterviewContext(settings, { includeResume: false }) +
  appendScreenText("", SCREEN_TEXT).slice(0); // full screen text
const oldHistory = sessionMessages.slice(-6); // previous behaviour
const oldTypedChars =
  oldPrompt.length + oldHistory.reduce((n, m) => n + m.content.length, 0);

// ── NEW typed-follow-up payload ────────────────────────────────────────────

const newAnswers = buildTruncatedFollowupAnswers(sessionMessages);
const newScreen = truncateToCharLimit(
  SCREEN_TEXT,
  followupContextBudget(newAnswers),
);
const newPrompt =
  question +
  buildInterviewContext(settings, { includeResume: false }) +
  appendScreenText("", newScreen);
const newTypedChars =
  newPrompt.length + newAnswers.reduce((n, a) => n + a.length, 0);

// ── Interview-branch prompt (panel/spoken follow-ups) ──────────────────────

const turn = {
  finals: [
    { source: "system" as const, text: "Solve the problem on screen." },
    { source: "mic" as const, text: question },
  ],
  interim: null,
};

const oldInterviewPrompt = buildInterviewUserPrompt(turn, {
  questionIndex: 1,
  previousAnswers: sessionMessages
    .filter((m) => m.role === "assistant")
    .slice(-2)
    .map((m) => m.content),
  screenBlock: SCREEN_TEXT,
});
const newInterviewPrompt = buildInterviewUserPrompt(turn, {
  questionIndex: 1,
  previousAnswers: newAnswers,
  screenBlock: newScreen,
});

// ── Report ─────────────────────────────────────────────────────────────────

const est = (chars: number) => Math.round(chars / 4);
const line = (label: string, chars: number) =>
  console.log(`  ${label.padEnd(46)} ${String(chars).padStart(6)} chars (~${est(chars)} tokens)`);

console.log("FOLLOW-UP REQUEST PAYLOAD (typed follow-up path)");
line("OLD prompt + 6-message history", oldTypedChars);
line("NEW prompt + latest answer only", newTypedChars);
console.log(
  `  reduction                                       ${Math.round(
    ((oldTypedChars - newTypedChars) / oldTypedChars) * 100,
  )}%`,
);

console.log("\nINTERVIEW-BRANCH PROMPT (panel / spoken follow-up)");
line("OLD (last 2 answers, full screen)", oldInterviewPrompt.length);
line("NEW (1 answer, budgeted screen)", newInterviewPrompt.length);

// ── Worst case: long code answers (the scenario that hit the limit) ────────
const longMessages: Msg[] = [
  { role: "user", content: "Solve the problem on screen." },
  { role: "assistant", content: makeAnswer("long1", 6000) },
  { role: "user", content: "Why did you choose this approach?" },
  { role: "assistant", content: makeAnswer("long2", 6000) },
  { role: "user", content: "Can you optimize it?" },
  { role: "assistant", content: makeAnswer("long3", 6000) },
];
const longOldChars =
  oldPrompt.length + longMessages.reduce((n, m) => n + m.content.length, 0);
const longNewAnswers = buildTruncatedFollowupAnswers(longMessages);
const longNewScreen = truncateToCharLimit(
  SCREEN_TEXT,
  followupContextBudget(longNewAnswers),
);
const longNewChars =
  question.length +
  buildInterviewContext(settings, { includeResume: false }).length +
  appendScreenText("", longNewScreen).length +
  longNewAnswers.reduce((n, a) => n + a.length, 0);

console.log("\nFOLLOW-UP REQUEST PAYLOAD (long 6k-char answers — the reported case)");
line("OLD prompt + 6-message history", longOldChars);
line("NEW prompt + latest answer only", longNewChars);
console.log(
  `  reduction                                       ${Math.round(
    ((longOldChars - longNewChars) / longOldChars) * 100,
  )}%`,
);

console.log("\nCONTEXT CAP");
line("retained screen + answers (new)", newScreen.length + newAnswers.reduce((n, a) => n + a.length, 0));
console.log(`  MAX_FOLLOWUP_CONTEXT_CHARS                        ${MAX_FOLLOWUP_CONTEXT_CHARS}`);

// ── Checks ─────────────────────────────────────────────────────────────────

const failures: string[] = [];
const check = (name: string, cond: boolean) => {
  if (cond) console.log(`  PASS ${name}`);
  else failures.push(name);
};

const retained =
  newScreen.length + newAnswers.reduce((n, a) => n + a.length, 0);
check(
  "retained context ≤ MAX_FOLLOWUP_CONTEXT_CHARS",
  retained <= MAX_FOLLOWUP_CONTEXT_CHARS,
);
check("latest question never truncated", newPrompt.startsWith(question));
check(
  "follow-ups 1-3 all carry the SAME problem",
  ["Why did you choose this approach?", "Can you optimize it?", "What is the space complexity?"].every(
    (q) => appendScreenText(q, newScreen).includes("Two Sum"),
  ),
);
check("old payload was larger", oldTypedChars > newTypedChars);
check(
  "new payload carries only ONE previous answer",
  newAnswers.length === 1,
);
check(
  "long-answer worst case: new payload stays bounded (≤ MAX + fixed prompt)",
  longNewChars <=
    MAX_FOLLOWUP_CONTEXT_CHARS +
      question.length +
      buildInterviewContext(settings, { includeResume: false }).length +
      200,
);
check(
  "long-answer worst case: old payload grew with history, new did not",
  longOldChars > longNewChars,
);

if (failures.length) {
  console.log("\nFAILURES:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("\n  all checks passed");
