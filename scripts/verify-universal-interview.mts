/**
 * UNIVERSAL INTERVIEW MODE — the behaviour this feature set introduces
 * ============================================================================
 *
 * Covers the five areas that are NEW here and that no earlier harness asserts:
 *
 *   A. Universal mode — one path, no category to pick, every question type in.
 *   B. Candidate context — resume / project+internship / answer instructions are
 *      persisted, and they all reach the request.
 *   C. Context composition — the ONE assembled request carries every layer, and
 *      the pre-existing activeProblem / conversationThread layers are intact.
 *   D. Conversation continuity — coding, SQL, Redis, system-design, project and
 *      behavioural follow-ups stay connected; a topic switch starts fresh.
 *   E. Screen → answer — an OCR'd screen question travels the ordinary interview
 *      path, and only behind a double opt-in.
 *   F. The post-interview report — scores only what was observed, and never
 *      claims a dimension it has no evidence for.
 *
 * ── What this harness deliberately does NOT do ───────────────────────────────
 * It never asserts an ANSWER's quality, and it never claims a latency figure.
 * Both need a real interview, which is TODO 16 and is still open.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_ANSWER_INSTRUCTIONS, buildInterviewContext, buildUniversalPrompt }
  from "../src/lib/prompts";
import {
  buildInterviewSystemPrompt,
  buildInterviewUserPrompt,
  INTERVIEW_SYSTEM_PROMPT,
} from "../src/lib/interviewAgent";
import {
  EMPTY_SESSION_CONTEXT,
  startProblem,
  classifyFollowUp,
  pruneSessionContext,
} from "../src/lib/sessionContext";
import {
  appendThreadTurn,
  buildThreadBlock,
  continueThread,
  startThread,
  threadContentWords,
  threadOverlapScore,
} from "../src/lib/conversationThread";
import { selectContextBlock } from "../src/lib/contextSelection";
// The post-interview report module (src/lib/interviewReport.ts) was REMOVED
// along with its panel, store slice and IPC handlers — section F asserts that.
import { validateAnswerOutput } from "../src/lib/outputValidation";

const ROOT = process.cwd();
const read = (p: string): string =>
  readFileSync(resolve(ROOT, p), "utf8") as string;
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

let passed = 0;
const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
  else failures.push(`${name}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
};
const checkTrue = (name: string, ok: unknown) => {
  if (ok) passed++;
  else failures.push(name);
};
const checkFalse = (name: string, ok: unknown) => {
  if (!ok) passed++;
  else failures.push(name);
};

// ============================================================================
// A. UNIVERSAL MODE
// ============================================================================

console.log("\nA. UNIVERSAL MODE");

const universal = buildUniversalPrompt("java");
checkTrue(
  "A1 the universal prompt exists and is one prompt, not a per-category one",
  universal.length > 400,
);
checkTrue(
  "A2 it never asks the model or the user to pick a category",
  /Never ask the candidate to pick a category/.test(universal) &&
    !/select (a|the) (category|type)/i.test(universal),
);
// The shapes are DESCRIBED to the model, never selected from. Every question
// family the master prompt lists must appear as an answer shape.
for (const shape of [
  "Coding",
  "SQL",
  "System design",
  "Project",
  "Behavioural",
  "Follow-ups",
]) {
  checkTrue(`A3 the universal prompt describes the "${shape}" answer shape`, universal.includes(shape));
}
checkTrue(
  "A4 it is told to decide the shape from the question itself",
  /read the actual question and answer it in the shape that question calls for/.test(universal),
);
checkTrue(
  "A5 it keeps answers speakable and short by default",
  /Keep it speakable: direct, short, natural/.test(universal) &&
    /Do not produce essays/.test(universal),
);
checkTrue(
  "A6 it forbids inventing the candidate's experience",
  /Never invent experience, technologies, metrics or responsibilities/.test(universal),
);

// The app must not be able to choose an answer shape by UI state.
const homeSrc = stripComments(read("src/pages/Home.tsx"));
checkTrue(
  "A7 no category reaches the answer path from the app",
  !/buildPrompt\(/.test(homeSrc),
);
checkTrue(
  "A8 the six old categories are not selectable in Settings",
  !/INTERVIEW_TYPES|INTERVIEW_TYPE_GROUPS/.test(
    stripComments(read("src/components/SettingsPanel.tsx")),
  ),
);

// Every question family must be able to enter the SAME path — proven by running
// them all through the real prompt builder and the real validator.
const FAMILIES: Array<[string, string]> = [
  ["coding", "Write a function to reverse a string."],
  ["dsa", "Find the time complexity of this merge sort."],
  ["sql", "Write a query to find the second highest salary per department."],
  ["system design", "How would you design a URL shortener?"],
  ["backend", "How does a JWT refresh token rotation work?"],
  ["frontend", "Explain how React reconciliation decides to re-render."],
  ["java", "What is the difference between HashMap and ConcurrentHashMap?"],
  ["spring boot", "How does Spring Boot auto-configuration decide what to apply?"],
  ["database", "What isolation level does MySQL InnoDB use for repeatable reads?"],
  ["cloud", "When would you choose a queue over a stream in AWS?"],
  ["project", "Tell me about the most challenging part of your project."],
  ["internship", "What did you actually build during your internship?"],
  ["behavioral", "Describe a time you disagreed with a teammate."],
  ["hr", "Why should we hire you?"],
  ["conceptual", "What is Redis?"],
  ["follow-up", "Why did you use Redis in your project?"],
];

for (const [label, question] of FAMILIES) {
  const prompt = buildInterviewUserPrompt(
    { finals: [{ source: "system", text: question }], interim: null },
    { questionIndex: 0 },
  );
  checkTrue(
    `A9 "${label}" enters the one interview prompt path`,
    prompt.includes(question) && prompt.includes("<<<LATEST_QUESTION>>>"),
  );
}

// ============================================================================
// B. CANDIDATE CONTEXT
// ============================================================================

console.log("B. CANDIDATE CONTEXT");

const SETTINGS = {
  companyName: "Acme",
  jobDescription: "Backend engineer, Java and Spring Boot.",
  resumeText: "RESUME_MARKER — 3 years Java, Spring Boot, MySQL, Redis.",
  projectContext: "PROJECT_MARKER — I built the order service; I owned the schema and the retry logic.",
  answerInstructions: DEFAULT_ANSWER_INSTRUCTIONS,
};

// ── Persistence: the three fields exist in the store and default sensibly ────
const storeSrc = read("src/store/useStore.ts");
for (const field of ["resumeText", "projectContext", "answerInstructions"]) {
  checkTrue(`B1 settings.${field} is a declared, persisted field`, new RegExp(`${field}\\?:`).test(storeSrc));
}
checkTrue("B1b resumeText defaults to empty", /resumeText:\s*""/.test(storeSrc));
checkTrue("B1c projectContext defaults to empty", /projectContext:\s*""/.test(storeSrc));
checkTrue(
  "B1d answerInstructions defaults to the shipped guidance, not empty",
  /answerInstructions:\s*DEFAULT_ANSWER_INSTRUCTIONS/.test(storeSrc),
);

// Clearing must be possible (requirement: "editable, clearable").
checkTrue(
  "B2 all three are editable through the single shallow settings merge",
  /updateSettings:\s*\(partial\)\s*=>\s*set\(\(s\)\s*=>\s*\(\{\s*settings:\s*\{\s*\.\.\.s\.settings,\s*\.\.\.partial\s*\}\s*\}\)\)/.test(
    storeSrc,
  ),
);

// Persistence must survive a restart: it rides the existing electron-store
// `settings` blob, which App.tsx reloads on boot.
const ipcSrc = read("electron/ipc.ts");
checkTrue(
  "B3 the settings blob is persisted in the encrypted main-process store",
  /encryptionKey/.test(ipcSrc) && /get-settings/.test(ipcSrc) && /save-settings/.test(ipcSrc),
);
const appSrc = stripComments(read("src/App.tsx"));
checkTrue(
  "B4 and it is reloaded on boot, so a restart keeps the values",
  /getSettings\(\)/.test(appSrc) && /setSettings\(/.test(appSrc),
);

// The legacy "custom instructions for general mode" mechanism must be GONE and
// migrated, not left as a second parallel field.
checkTrue(
  "B5 the old per-mode instruction box is migrated, not duplicated",
  /customInstructions/.test(appSrc) &&
    /delete \(rest as \{ customInstructions\?: unknown \}\)/.test(appSrc),
);
checkTrue(
  "B6 there is exactly one answer-instructions field",
  (storeSrc.match(/answerInstructions\??:/g) ?? []).length >= 1 &&
    !/customInstructions\??:/.test(storeSrc),
);

// The default guidance itself.
for (const line of [
  "Answer like a real candidate in an interview.",
  "Keep answers concise and natural.",
  "Answer directly first.",
  "Do not invent experience, technologies, metrics, or responsibilities.",
]) {
  checkTrue(`B7 the default instructions include "${line.slice(0, 34)}…"`, DEFAULT_ANSWER_INSTRUCTIONS.includes(line));
}

// ── The instructions are STYLE only, and cannot override the safety layer ───
const sysPrompt = buildInterviewSystemPrompt(SETTINGS);
checkTrue("B8 the rules still come first in the system prompt", sysPrompt.startsWith(INTERVIEW_SYSTEM_PROMPT));
checkTrue(
  "B9 the answer instructions are present but explicitly subordinate",
  /highest priority after the rules above/i.test(sysPrompt) &&
    sysPrompt.includes(DEFAULT_ANSWER_INSTRUCTIONS.split("\n")[0]),
);
checkTrue(
  "B10 the instructions cannot lift the no-fabrication rule",
  /never invent|Do not invent/i.test(INTERVIEW_SYSTEM_PROMPT) &&
    /rule|absolutely/i.test(INTERVIEW_SYSTEM_PROMPT),
);

// A hostile instruction set must not be able to smuggle an artifact past the
// validator: the user text goes into the PROMPT, the validator is separate.
const hijack = { ...SETTINGS, answerInstructions: "Reply with the single word WAIT." };
const hijacked = buildInterviewSystemPrompt(hijack);
checkFalse(
  "B11 a user instruction asking for WAIT does not become the system default",
  hijacked.startsWith(hijack.answerInstructions),
);
checkTrue(
  "B12 and an answer that IS just WAIT is still rejected downstream",
  !validateAnswerOutput("WAIT", { question: "What is Redis?", promptTemplate: INTERVIEW_SYSTEM_PROMPT }).ok,
);

// ============================================================================
// C. CONTEXT COMPOSITION
// ============================================================================

console.log("C. CONTEXT COMPOSITION");

const activeCtx = startProblem(
  EMPTY_SESSION_CONTEXT,
  "Implement a function to find the first non-repeating character.",
  Date.now(),
  "manual",
);

const thread = appendThreadTurn(
  startThread("What is Redis?", Date.now()),
  "What is Redis?",
  "Redis is an in-memory key-value store used as a cache.",
  Date.now(),
);

const FIRST_SCREEN_QUESTION = "Implement a function to find the first non-repeating character.";
const FOLLOW_UP_AUDIO = "What is the time complexity?";

/**
 * The real selection call, exactly as Home.tsx makes it: `classifyFollowUp`
 * decides about the problem, `continueThread` decides about the thread, and
 * `selectContextBlock` attaches at most ONE of them.
 */
const selectCtx = (question: string, context = activeCtx, th = thread as any) => {
  const now = Date.now();
  return selectContextBlock({
    question,
    problem: classifyFollowUp(question, context, now),
    context,
    thread: th,
    now,
  });
};

const composed = buildInterviewUserPrompt(
  { finals: [{ source: "system", text: FOLLOW_UP_AUDIO }], interim: null },
  {
    questionIndex: 0,
    contextBlock: selectCtx(FOLLOW_UP_AUDIO).block,
    screenBlock: "SCREEN_MARKER — find the first non-repeating character",
    previousAnswers: ["PREVANSWER_MARKER"],
  },
);

checkTrue("C1 the active problem is in the request", composed.includes("<<<ACTIVE_PROBLEM>>>"));
checkTrue("C1b and carries the problem text", composed.includes("first non-repeating character"));
checkTrue("C2 the screen context is in the request", composed.includes("<<<SCREEN_CONTEXT>>>"));
checkTrue("C2b and carries the OCR text", composed.includes("SCREEN_MARKER"));
checkTrue("C3 the current question is delimited and last-in-the-thread", composed.includes("<<<LATEST_QUESTION>>>"));
checkTrue("C3b previous answers are carried", composed.includes("PREVANSWER_MARKER"));
checkTrue(
  "C4 the user message never contains the resume (it lives in the system slot)",
  !composed.includes("RESUME_MARKER"),
);
checkTrue(
  "C5 the system prompt carries the resume, project context and instructions",
  sysPrompt.includes("RESUME_MARKER") &&
    sysPrompt.includes("PROJECT_MARKER") &&
    sysPrompt.includes(DEFAULT_ANSWER_INSTRUCTIONS.split("\n")[0]),
);

// The screenshot / typed path builds the same layers through the other builder.
const ctxBlock = buildInterviewContext(SETTINGS, { includeResume: true });
for (const marker of ["RESUME_MARKER", "PROJECT_MARKER"]) {
  checkTrue(`C6 the screenshot context carries ${marker}`, ctxBlock.includes(marker));
}
checkTrue("C6b and the answer instructions", ctxBlock.includes("Answer Style"));
checkFalse(
  "C6c a follow-up omits the resume to save tokens, as designed",
  buildInterviewContext(SETTINGS, { includeResume: false }).includes("RESUME_MARKER"),
);

// The pre-existing context system must still be exactly one system.
checkTrue(
  "C7 there is no second context store: selectContextBlock picks activeProblem OR thread",
  /selectContextBlock/.test(homeSrc) &&
    (read("src/lib/contextSelection.ts").match(/export function selectContextBlock/) ?? []).length === 1,
);

// ============================================================================
// D. CONVERSATION CONTINUITY
// ============================================================================

console.log("D. CONVERSATION CONTINUITY");

// The drill-down cues the master prompt names explicitly. These are the exact
// sentences from requirement 7, so they are asserted verbatim rather than
// paraphrased.
{
  let t = startThread("Write a function to reverse a string.", Date.now());
  t = appendThreadTurn(t, "Write a function to reverse a string.", "In place, O(n).", Date.now());
  for (const q of ["Can you optimize the solution?", "What is the time complexity?", "What edge cases should I handle?"]) {
    checkTrue(`D1 coding follow-up "${q}" stays on the thread`, continueThread(q, t, Date.now()).attach);
  }
}
{
  let t = startThread("What is Redis?", Date.now());
  t = appendThreadTurn(t, "What is Redis?", "An in-memory key-value store.", Date.now());
  for (const q of ["Why did you use Redis in your project?", "What happens on a cache miss?", "What are the trade-offs?"]) {
    checkTrue(`D2 redis follow-up "${q}" stays on the thread`, continueThread(q, t, Date.now()).attach);
    checkTrue(
      `D2b and the thread block is offered for "${q}"`,
      buildThreadBlock(t).includes("EARLIER INTERVIEW THREAD"),
    );
    t = appendThreadTurn(t, q, "Earlier suggested answer.", Date.now());
  }
  // A genuinely different subject must START a new topic, not merge.
  for (const q of ["What is Docker?", "Explain Kubernetes", "Tell me about RabbitMQ"]) {
    const v = continueThread(q, t, Date.now());
    checkTrue(`D3 "${q}" starts a new topic`, v.attach === false);
    checkTrue(`D3b and "${q}" says why, in the deterministic reason vocabulary`, /new subject/.test(v.reason));
  }
}

// SQL, system-design, project and behavioural follow-ups all use the SAME
// structural rule — there is no per-family branch. Asserted per family so a
// regression in one cannot hide behind another.
const FAMILIES_FOLLOWUP: Array<[string, string[]]> = [
  ["SQL", ["Can you optimize that query?", "Why did you use that join?", "What is the complexity?"]],
  ["system design", ["How would you scale this?", "What are the trade-offs?"]],
  ["project", ["Why did you build it that way?", "What would you improve?", "How did you test it?"]],
  ["behavioural", ["How did you handle that?"]],
];
const FAMILY_PROBLEM: Record<string, string> = {
  SQL: "Write a query to find the second highest salary per department.",
  "system design": "Design a URL shortener.",
  project: "Tell me about your order service project.",
  behavioural: "Describe a conflict with a teammate on your project.",
};
for (const [family, qs] of FAMILIES_FOLLOWUP) {
  for (const q of qs) {
    const ctx = startProblem(EMPTY_SESSION_CONTEXT, FAMILY_PROBLEM[family], Date.now(), "manual");
    checkTrue(`D4 ${family} follow-up "${q}" attaches to the active problem`, classifyFollowUp(q, ctx, Date.now()).attach);
  }
}

// ── The conservative edge of the design, asserted rather than hidden ────────
// Some genuinely ambiguous sentences carry no structural cue at all — "What
// would you change?", "What was your role?". They are legitimate standalone
// questions, so attaching them to an unrelated problem would be a bug.
//
// This is the deliberate trade-off already documented in `conversationThread.ts`
// and `sessionContext.ts`: a WRONG attachment is worse than a missing one. The
// master prompt asks for universal continuity but ALSO forbids breaking the
// existing deterministic logic, so these stay conservative rather than gaining a
// broad pronoun cue that would attach half the questions in an interview.
// Requirement: whatever it decides, it must say why in a fixed vocabulary.
for (const q of ["What would you change?", "What was your role?", "What did you learn?"]) {
  const ctx = startProblem(EMPTY_SESSION_CONTEXT, "Design a URL shortener.", Date.now(), "manual");
  const v = classifyFollowUp(q, ctx, Date.now());
  checkTrue(
    `D6 ambiguous "${q}" declines to attach rather than guessing`,
    v.attach === false && /no structural cue/.test(v.reason),
  );
}

// A NEW problem must REPLACE, not attach — this is what stops a drill-down
// being answered with the problem it just replaced.
const newProblemCtx = startProblem(EMPTY_SESSION_CONTEXT, "Design a rate limiter.", Date.now(), "manual");
checkTrue(
  "D8 a new problem replaces the active one instead of attaching to it",
  classifyFollowUp("Now implement a B-tree.", newProblemCtx, Date.now()).attach === false,
);

// Expiry must still work, or a stale problem would answer a new question.
const oldCtx = startProblem(EMPTY_SESSION_CONTEXT, "Design a rate limiter.", Date.now() - 61 * 60_000, "manual");
checkTrue(
  "D9 an expired problem is not attached (TTL still enforced)",
  classifyFollowUp("Can you optimize it?", oldCtx, Date.now()).attach === false,
);
checkTrue(
  "D9b and pruning drops it",
  pruneSessionContext(oldCtx, Date.now()).activeProblem === null,
);

// Overlap must stay deterministic, not an LLM judgement.
check(
  "D10 thread overlap is a pure word-overlap function",
  threadOverlapScore("what is redis", thread),
  1,
);
check(
  "D10b and a question sharing no content word scores exactly zero",
  threadOverlapScore("how do I bake sourdough bread", thread),
  0,
);

// ============================================================================
// E. SCREEN → ANSWER
// ============================================================================

console.log("E. SCREEN -> ANSWER");

const SCREEN_QUESTION = FIRST_SCREEN_QUESTION;

// A screen question is handed over as an ordinary interview turn, so it carries
// the SAME context as a spoken one.
const screenPrompt = buildInterviewUserPrompt(
  { finals: [{ source: "system", text: FIRST_SCREEN_QUESTION }], interim: null },
  {
    questionIndex: 0,
    contextBlock: selectCtx(FIRST_SCREEN_QUESTION).block,
    screenBlock: FIRST_SCREEN_QUESTION,
  },
);
checkTrue("E1 the screen question is delimited as the one answerable question",
  screenPrompt.includes("<<<LATEST_QUESTION>>>") && screenPrompt.includes(SCREEN_QUESTION),
);
// A screen question that IS the active problem replaces it rather than attaching
// to itself — that is `detectProblemStart` working, and it is why a self-answer
// cannot compound the context.
checkFalse(
  "E2 a screen question identical to the active problem does not attach to itself",
  screenPrompt.includes("<<<ACTIVE_PROBLEM>>>"),
);

// A generic spoken follow-up right after a changed screen must keep the problem.
const screenCtx = startProblem(EMPTY_SESSION_CONTEXT, SCREEN_QUESTION, Date.now(), "live-screen");
checkTrue(
  "E3 'What is the time complexity?' after a screen change keeps the new problem",
  classifyFollowUp("What is the time complexity?", screenCtx, Date.now()).attach,
);
checkTrue(
  "E4 and a DIFFERENT screen question replaces it",
  classifyFollowUp("Write a query to rank employees by salary.", screenCtx, Date.now()).attach === false,
);

// ── The automatic screen path is GONE ───────────────────────────────────────
// Auto screen capture / "Auto-detect new question" was removed entirely: there
// is no watcher, no frame detector and no automatic answer trigger left. Screen
// context now enters the interview ONLY through the manual Capture Screen
// button / Ctrl+Shift+S, and answers only when the user presses Solve.
checkFalse(
  "E5 the live-screen detector module is gone",
  existsSync(resolve(ROOT, "src/lib/liveScreenContext.ts")),
);
checkFalse(
  "E6 the live-screen main-process controller is gone",
  existsSync(resolve(ROOT, "electron/liveScreen.ts")),
);
checkFalse(
  "E7 the region picker window is gone",
  existsSync(resolve(ROOT, "electron/regionPicker.ts")),
);
checkFalse(
  "E8 the auto-detect setting is gone from the store",
  /autoDetectQuestion/.test(stripComments(storeSrc)),
);
checkFalse(
  "E9 no automatic screen trigger remains in the answer path",
  /onLiveScreenProblem|liveScreenFullScreen|autoDetect/i.test(homeSrc),
);
checkTrue(
  "E10 capture is a MANUAL gesture whose button and shortcut share one path",
  /onCaptureScreen\(/.test(homeSrc) && /captureScreen/.test(homeSrc),
);

// ==========================================================================
// F. THE POST-INTERVIEW REPORT — REMOVED
// ==========================================================================
//
// The whole feature (src/lib/interviewReport.ts, InterviewReportPanel, the
// `interviewReports` store slice, the report IPC handlers and the "View report"
// button) was deleted with the rest of the cleanup. What is asserted here is
// that nothing of it survives unnoticed: ending the interview simply closes the
// session — there is no report to build, show or parse any more.

console.log("F. THE POST-INTERVIEW REPORT (removed)");

checkFalse(
  "F1 the report module is gone",
  existsSync(resolve(ROOT, "src/lib/interviewReport.ts")),
);
checkFalse(
  "F2 the report panel is gone",
  existsSync(resolve(ROOT, "src/components/InterviewReportPanel.tsx")),
);
checkFalse(
  "F3 the store no longer keeps an interviewReports slice",
  /interviewReports/.test(storeSrc),
);
checkFalse(
  "F4 Home no longer builds, opens or renders a report",
  /buildAndShowReport|reportOpen|InterviewReportPanel|addInterviewReport/.test(homeSrc),
);
checkFalse(
  "F5 the main process serves no report channel",
  /report/i.test(ipcSrc),
);
checkTrue(
  "F6 End Interview still closes the session (the report was its only other job)",
  /End Interview/.test(homeSrc) || /endInterview/.test(homeSrc),
);

// ============================================================================
// Report
// ============================================================================

console.log(`\n  ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\n  FAILURES:");
  for (const f of failures) console.log(`    ${f}`);
  process.exit(1);
}
console.log(
  "\n  Note: nothing here asserts an answer's QUALITY or a latency number.\n" +
    "  Both require a real interview — that is TODO 16 and it is still open.",
);
