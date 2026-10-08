/**
 * Verification harness for the conversationThread layer and context precedence.
 *
 * Run: `npx tsx scripts/verify-conversation-thread.ts`
 *
 * No audio, no network, no Electron, no model. Pure functions only.
 *
 * ── The two properties that matter most ─────────────────────────────────────
 *  1. The Redis chain attaches on turns 2, 3 and 4, and "What is Docker?"
 *     afterwards does NOT inherit it.
 *  2. When nothing attaches, the assembled prompt is BYTE-IDENTICAL to today's.
 *     That is asserted against the real `buildInterviewUserPrompt`, not a copy.
 */

import {
  INTERVIEW_SYSTEM_PROMPT,
  buildInterviewUserPrompt,
  type InterviewTurn,
} from "../src/lib/interviewAgent";
import { EMPTY_SESSION_CONTEXT, classifyFollowUp, startProblem } from "../src/lib/sessionContext";
import {
  EMPTY_THREAD,
  THREAD_ANSWER_HEAD_MAX_CHARS,
  THREAD_ANSWER_LABEL,
  THREAD_MAX_TURNS,
  THREAD_MIN_OVERLAP,
  THREAD_TTL_MS,
  appendThreadTurn,
  buildThreadBlock,
  continueThread,
  describeThread,
  extractAnswerHead,
  looksLikeNewSubject,
  startThread,
  stripLeadingFillers,
  threadContentWords,
  threadOverlapScore,
  type ConversationThread,
} from "../src/lib/conversationThread";
import {
  CONTEXT_BLOCK_MAX_CHARS,
  hasCodingCue,
  selectContextBlock,
} from "../src/lib/contextSelection";
import { validateAnswerOutput } from "../src/lib/outputValidation";

let pass = 0;
let fail = 0;
void fail; // summarised from `failures.length` below
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else failures.push(`  ${name}\n    expected: ${b}\n    actual:   ${a}`);
}
function checkTrue(name: string, cond: boolean) {
  check(name, cond, true);
}
function checkFalse(name: string, cond: boolean) {
  check(name, cond, false);
}

const T0 = 1_700_000_000_000;
const REDIS_A = "Redis is an in-memory key-value store. It keeps data in RAM so reads are fast.";

// ── 1. Leading filler stripping ─────────────────────────────────────────────

check("1a strips 'okay so'", stripLeadingFillers("Okay so why did you use Redis?"), "why did you use Redis?");
check("1b strips 'and then'", stripLeadingFillers("and then what is the flow?"), "what is the flow?");
check("1c strips a long run of fillers", stripLeadingFillers("okay, so, right, then what about it?"), "what about it?");
check("1d strips nothing when there is no filler", stripLeadingFillers("What is Redis?"), "What is Redis?");
check("1e does not strip a filler mid-sentence", stripLeadingFillers("Explain why you use it"), "Explain why you use it");
checkTrue("1f a filler-only string collapses to empty", stripLeadingFillers("okay so") === "");

// ── 2. Content words and the no-topic-list property ─────────────────────────

check("2a 'Why would you use Redis?' keeps Redis", threadContentWords("Why would you use Redis?"), ["would", "redis"].filter((w) => w === "redis"));
checkTrue("2b Redis is a content word", threadContentWords("Why would you use Redis?").includes("redis"));
checkTrue("2c Docker is a content word", threadContentWords("What is Docker?").includes("docker"));
checkTrue("2d Kubernetes is a content word", threadContentWords("Why use Kubernetes?").includes("kubernetes"));

{
  // Any technology in the function-word list would make that technology
  // invisible to overlap, silently turning the layer into a topic filter.
  const src = require("node:fs").readFileSync("src/lib/conversationThread.ts", "utf8") as string;
  const block = src.slice(
    src.indexOf("const THREAD_FUNCTION_WORDS"),
    src.indexOf("]);", src.indexOf("const THREAD_FUNCTION_WORDS")),
  );
  for (const tech of [
    "redis", "docker", "sql", "nosql", "mongodb", "cache", "api", "rest",
    "spring", "node", "react", "http", "index", "thread", "kubernetes",
    "hashmap", "hashset", "queue", "stack", "kafka", "postgres",
  ]) {
    checkFalse(`2e ${tech} is NOT in the function-word list`, block.includes(`"${tech}"`));
  }
}

// ── 3. answerHead extraction ────────────────────────────────────────────────

check("3a takes the first 1-2 sentences", extractAnswerHead("First one. Second one. Third one."), "First one. Second one.");
checkTrue(
  "3b caps at the character limit",
  (extractAnswerHead("x".repeat(500) + ". More.") ?? "").length <=
    THREAD_ANSWER_HEAD_MAX_CHARS + 1,
);
check("3c returns null for an empty answer", extractAnswerHead(""), null);
check("3d returns null for a too-short answer", extractAnswerHead("Yes."), null);
check("3e a short FIRST sentence from a long answer survives", extractAnswerHead("Yes. But here is the longer explanation of why that is."), "Yes. But here is the longer explanation of why that is.");
check("3f drops a leading markdown heading", extractAnswerHead("## Approach\n\nRedis is an in-memory store used for caching. It is fast."), "Redis is an in-memory store used for caching. It is fast.");
check("3g drops a code fence opener", extractAnswerHead("```\nRedis keeps data in memory. That makes reads fast."), "Redis keeps data in memory. That makes reads fast.");
checkTrue("3h is deterministic across calls", extractAnswerHead(REDIS_A) === extractAnswerHead(REDIS_A));
check("3i handles an answer with no terminator", extractAnswerHead("Redis keeps data in memory and is used for caching"), "Redis keeps data in memory and is used for caching");

// ── 4. THE REDIS CHAIN (Part 22, the required scenario) ─────────────────────

{
  let thread: ConversationThread | null = null;
  const now = T0;

  // Q1 "What is Redis?" — starts the thread, attaches nothing.
  const q1 = "What is Redis?";
  const v1 = continueThread(q1, thread, now);
  checkFalse("4a Q1 does not attach (no thread yet)", v1.attach);
  check("4b Q1 reason", v1.reason, "no thread");
  thread = startThread(q1, now);

  // Q2 "Why did you use Redis in your project?" — attaches.
  const q2 = "Why did you use Redis in your project?";
  const v2 = continueThread(q2, thread, now);
  checkTrue("4c Q2 attaches", v2.attach);
  check("4d Q2 reason", v2.reason, "attached: follow-up cue + topic overlap");

  // Q3 "What is the flow with Redis in your project?" — attaches.
  thread = appendThreadTurn(thread, q2, extractAnswerHead(REDIS_A), now);
  const q3 = "What is the flow with Redis in your project?";
  const v3 = continueThread(q3, thread, now);
  checkTrue("4e Q3 attaches", v3.attach);
  check("4f Q3 reason", v3.reason, "attached: follow-up cue + topic overlap");

  // The block must contain the earlier question AND the earlier answer head.
  thread = appendThreadTurn(thread, q3, "The flow is a read-through cache in front of the database.", now);
  const block = buildThreadBlock(thread);
  checkTrue("4g the block contains the earlier question", block.includes("Why did you use Redis in your project?"));
  checkTrue("4h the block contains the answerHead", block.includes("Redis is an in-memory key-value store."));
  checkTrue("4i the block labels it as a suggestion, not as what the candidate said",
    block.includes(THREAD_ANSWER_LABEL) && !/you said/i.test(block));
  checkTrue("4j the block says it is background only", /background only/i.test(block));
  checkTrue("4k the block does not claim the candidate said it",
    /not necessarily what the candidate said/i.test(block));

  // Q4 "What happens when the cache misses?" — continues the Redis thread.
  const q4 = "What happens when the cache misses?";
  const v4 = continueThread(q4, thread, now);
  checkTrue("4l Q4 attaches", v4.attach);
  checkTrue("4m Q4 attaches on a cue", v4.reason.startsWith("attached"));

  // Q5 "What is Docker?" — a new subject, must NOT attach the Redis thread.
  const q5 = "What is Docker?";
  const v5 = continueThread(q5, thread, now);
  checkFalse("4n Q5 (What is Docker?) does NOT attach", v5.attach);
  check("4o Q5 reason", v5.reason, "new subject: does not attach");

  // and it starts a NEW thread that no longer knows about Redis.
  const dockerThread = startThread(q5, now);
  checkFalse("4p the new thread's terms do not contain redis", dockerThread.topicTerms.includes("redis"));
  checkTrue("4q the new thread's terms contain docker", dockerThread.topicTerms.includes("docker"));
  const v6 = continueThread("and how is it used in your project?", dockerThread, now);
  checkTrue("4r the Docker thread then continues normally", v6.attach);
  checkFalse("4s and it does not mention redis anywhere", buildThreadBlock(dockerThread).toLowerCase().includes("redis"));
}

// ── 5. Unrelated thread must not attach (Part 22) ───────────────────────────

{
  const redis = appendThreadTurn(startThread("What is Redis?", T0), "Why did you use Redis?", null, T0);
  const v = continueThread("What is REST API?", redis, T0);
  checkFalse("5a an unrelated standalone question does not attach", v.attach);
  check("5b reason", v.reason, "new subject: does not attach");
}

// ── 6. Retention cap and TTL ────────────────────────────────────────────────

{
  let t = startThread("What is Redis?", T0);
  for (let i = 0; i < 6; i++) {
    t = appendThreadTurn(t, `Follow-up number ${i} about Redis?`, null, T0 + i);
  }
  check("6a turn count is capped", t.turns.length, THREAD_MAX_TURNS);
  check("6b the OLDEST turns were evicted", t.turns[0].question, "Follow-up number 3 about Redis?");
  checkTrue("6c updatedAt moves with each append", t.updatedAt === T0 + 5);
}

{
  const t = appendThreadTurn(startThread("What is Redis?", T0), "Why Redis?", null, T0);
  const fresh = continueThread("Why did you use Redis?", t, T0 + THREAD_TTL_MS - 1000);
  checkTrue("6d attaches just inside the TTL", fresh.attach);
  const stale = continueThread("Why did you use Redis?", t, T0 + THREAD_TTL_MS + 1000);
  checkFalse("6e does NOT attach past the TTL", stale.attach);
  check("6f reason names the TTL", stale.reason, "thread expired (older than the TTL)");
  check("6g no thread means no attach", continueThread("Why Redis?", EMPTY_THREAD, T0).reason, "no thread");
}

// ── 7. ASR-noisy variants (Part 22) ─────────────────────────────────────────

{
  const redis = startThread("What is Redis?", T0);
  const noisy: Array<[string, boolean]> = [
    ["why did you use red is in your project", true],
    ["what is the flow with reddis in your project", true],
    ["why would you use it here", true],
    ["so what happens when the cache misses", true],
    ["and what about the trade offs", true],
    ["can you use redis for that", true],
    // Unrelated, so must not attach.
    ["what is an index", false],
    ["how do you version an api without breaking clients", false],
  ];
  for (const [q, expected] of noisy) {
    const v = continueThread(q, redis, T0);
    check(`7 ${JSON.stringify(q)} → attach=${expected}`, v.attach, expected);
  }
}

// ── 8. Conservative behaviour: uncertain → do not attach ────────────────────

{
  const redis = startThread("What is Redis?", T0);
  const uncertain = continueThread("Right then.", redis, T0);
  checkFalse("8a a fragment does not attach", uncertain.attach);
  check("8b reason", uncertain.reason, "no cue and no overlap: not attached");

  const empty = continueThread("", redis, T0);
  checkFalse("8c an empty question does not attach", empty.attach);
}

// ── 9. Precedence (Part 23) ─────────────────────────────────────────────────

{
  // Both contexts exist: a duplicate-numbers problem and a Redis thread.
  let ctx = startProblem(EMPTY_SESSION_CONTEXT, "Given an array, find the duplicate numbers.", T0, "screenshot");
  const redis = appendThreadTurn(startThread("What is Redis?", T0), "Why did you use Redis?", null, T0);

  const pick = (question: string) => {
    const problem = classifyFollowUp(question, ctx, T0);
    return selectContextBlock({ question, problem, context: ctx, thread: redis, now: T0 });
  };

  const coding = pick("Why did you use a HashSet?");
  check("9a a coding follow-up chooses the active problem", coding.choice, "active-problem");

  const project = pick("What is the flow with Redis in your project?");
  check("9b a Redis follow-up chooses the thread", project.choice, "conversation-thread");

  const complexity = pick("What is the time complexity?");
  check("9c a complexity question chooses the active problem", complexity.choice, "active-problem");

  checkTrue("9d exactly one block is ever produced (problem)", !coding.block.includes("EARLIER INTERVIEW THREAD"));
  checkTrue("9e exactly one block is ever produced (thread)", !project.block.includes("Active problem"));
  checkTrue("9f the block is under the cap", coding.chars <= CONTEXT_BLOCK_MAX_CHARS);

  // A question with no evidence for either must attach nothing.
  const vague = pick("Thanks.");
  check("9g a vague question attaches nothing", vague.choice, "none");
  check("9h and produces an empty block", vague.block, "");

  checkTrue("9i hasCodingCue is true for the coding follow-up", hasCodingCue("Why did you use a HashSet?"));
  checkFalse("9j and false for the Redis follow-up", hasCodingCue("What is the flow with Redis in your project?"));
}

// ── 10. BYTE IDENTITY when nothing is attached (Part 25, mandatory) ─────────

{
  // The real builder, with and without a context block.
  const turn: InterviewTurn = {
    finals: [{ source: "mic", text: "What is Redis?" }],
    interim: null,
  };

  const withEmptyBlock = buildInterviewUserPrompt(turn, {
    questionIndex: 0,
    contextBlock: "",
  });
  const withNoOption = buildInterviewUserPrompt(turn, { questionIndex: 0 });
  const withUndefinedBlock = buildInterviewUserPrompt(turn, {
    questionIndex: 0,
    contextBlock: undefined,
  });

  checkTrue("10a an empty context block is byte-identical to no block at all",
    withEmptyBlock === withNoOption);
  checkTrue("10b an undefined context block is byte-identical too",
    withUndefinedBlock === withNoOption);
  checkFalse("10c and the empty case contains no context labels",
    /ACTIVE_PROBLEM|EARLIER INTERVIEW THREAD|Earlier suggested answer/i.test(withEmptyBlock));

  // A whitespace-only block must ALSO be identity. The guard is `?.trim()`,
  // not truthiness, precisely so that a stray "   " from a caller cannot open
  // an empty context section. Without the `.trim()` this check fails.
  const withBlankBlock = buildInterviewUserPrompt(turn, {
    questionIndex: 0,
    contextBlock: "   \n  ",
  });
  checkTrue("10c2 a whitespace-only context block is byte-identical too",
    withBlankBlock === withNoOption);

  // The selector's own "none" must feed the builder byte-identically.
  const none = selectContextBlock({
    question: "Thanks.",
    problem: { attach: false, reason: "no active problem" },
    context: EMPTY_SESSION_CONTEXT,
    thread: null,
    now: T0,
  });
  check("10d the selector produces an empty string when nothing attaches", none.block, "");
  const viaSelector = buildInterviewUserPrompt(turn, { questionIndex: 0, contextBlock: none.block });
  checkTrue("10e end-to-end: a no-context turn is byte-identical to today's prompt",
    viaSelector === withNoOption);

  // Attaching DOES add a block, and only one.
  const attached = buildInterviewUserPrompt(turn, {
    questionIndex: 0,
    contextBlock: buildThreadBlock(startThread("What is Redis?", T0)),
  });
  checkTrue("10f attaching adds the block", attached !== withNoOption);
  checkTrue("10g and the latest question is still present", attached.includes("What is Redis?"));
  checkTrue("10h and the block precedes the latest-question section",
    attached.indexOf("EARLIER INTERVIEW THREAD") < attached.indexOf("<<<LATEST_QUESTION>>>"));
}

// ── 11. Prompt-leak safety for the new labels (Part 24) ─────────────────────

{
  // The labels must not be mistaken for an answer by the artifact detector.
  const labels = [
    "EARLIER INTERVIEW THREAD (background only)",
    "Earlier suggested answer: Redis is an in-memory store.",
    "Active problem: Given an array, find the duplicate numbers.",
    "BACKGROUND CONTEXT:",
    "ACTIVE PROBLEM CONTEXT:",
  ];
  for (const text of labels) {
    const v = validateAnswerOutput(text, { promptTemplate: INTERVIEW_SYSTEM_PROMPT });
    // Each of these SHOULD be rejected if a model echoed it as its whole
    // answer, because they are our scaffolding, not prose.
    checkTrue(`11 the label is rejected if echoed as an answer: ${JSON.stringify(text.slice(0, 28))}`, v.ok === false);
  }

  // A bare "Q: ..." is deliberately NOT a leak label on its own: a legitimate
  // technical answer can contain one (a quoted query, a sample Q/A pair). Only
  // the pairing with our own header identifies scaffolding. The precise claim
  // is that the LEAK DETECTOR never fires on it — whatever else may reject it.
  const bareQ = validateAnswerOutput("Q: how do I index this?", {
    promptTemplate: INTERVIEW_SYSTEM_PROMPT,
  });
  checkFalse(
    "11 a bare 'Q:' line is never rejected as a session-context label",
    bareQ.reason === "prompt-label",
  );

  // And a real answer that merely CONTAINS the word "problem" is still accepted.
  const genuine = validateAnswerOutput(
    "The problem reduces to counting occurrences, so a hash map gives us constant-time lookups and a single pass.",
    { promptTemplate: INTERVIEW_SYSTEM_PROMPT },
  );
  checkTrue("11 real prose mentioning 'problem' is still accepted", genuine.ok === true);

  // The instruction must not name a technology or state a conclusion.
  const { THREAD_INSTRUCTION } = require("../src/lib/conversationThread") as { THREAD_INSTRUCTION: string };
  for (const tech of ["redis", "docker", "sql", "mongodb", "cache", "hashmap", "kubernetes"]) {
    checkFalse(`11 the thread instruction never names ${tech}`, THREAD_INSTRUCTION.toLowerCase().includes(tech));
  }
  checkTrue("11 the instruction forbids inventing project facts", /never invent project/i.test(THREAD_INSTRUCTION));
  checkTrue("11 the instruction keeps the latest question primary", /Answer ONLY the latest interviewer question/.test(THREAD_INSTRUCTION));
}

// ── 12. Prompt size measurement (Part 10B) ──────────────────────────────────

{
  const seq: InterviewTurn = {
    finals: [
      { source: "mic", text: "What is Redis?" },
      { source: "mic", text: "Why did you use Redis in your project?" },
      { source: "mic", text: "What is the flow with Redis in your project?" },
    ],
    interim: null,
  };

  const base = buildInterviewUserPrompt(seq, { questionIndex: 2, previousAnswers: [] });
  let t = startThread("What is Redis?", T0);
  t = appendThreadTurn(t, "Why did you use Redis in your project?", extractAnswerHead(REDIS_A), T0);
  t = appendThreadTurn(t, "What is the flow with Redis in your project?", extractAnswerHead("The flow is a read-through cache in front of the database."), T0);
  const block = buildThreadBlock(t);
  const withThread = buildInterviewUserPrompt(seq, { questionIndex: 2, contextBlock: block });

  const problemCtx = startProblem(EMPTY_SESSION_CONTEXT, "Given an array of integers, find the duplicate numbers.", T0, "screenshot");
  const problemBlock = selectContextBlock({
    question: "What is the time complexity?",
    problem: { attach: true, reason: "attached" },
    context: problemCtx,
    thread: null,
    now: T0,
  }).block;

  const chars = (s: string) => s.length;
  const est = (s: string) => Math.round(s.length / 4);

  console.log("");
  console.log("PROMPT SIZE — 3-question sequence");
  console.log(`  base prompt (today)          : ${chars(base)} chars, ~${est(base)} tokens`);
  console.log(`  + conversation thread block  : ${chars(withThread)} chars, ~${est(withThread)} tokens`);
  console.log(`    thread block itself        : ${chars(block)} chars, ~${est(block)} tokens`);
  console.log(`  active-problem block only    : ${chars(problemBlock)} chars, ~${est(problemBlock)} tokens`);
  console.log(`  context cap                  : ${CONTEXT_BLOCK_MAX_CHARS} chars`);
  console.log("");

  checkTrue("12a the thread block is non-empty", chars(block) > 0);
  checkTrue("12b the thread block is under the cap", chars(block) <= CONTEXT_BLOCK_MAX_CHARS);
  checkTrue("12c the problem block is under the cap", chars(problemBlock) <= CONTEXT_BLOCK_MAX_CHARS);
  checkTrue("12d the growth is bounded", chars(withThread) - chars(base) <= CONTEXT_BLOCK_MAX_CHARS);
}

// ── 13. describeThread never leaks the topic text into a log line ───────────

{
  const t = startThread("What is Redis?", T0);
  const d = describeThread(t);
  checkTrue("13a the chip shows the topic", d.includes("redis"));
  checkTrue("13b and the turn count", /1 turn/.test(d));
  check("13c no thread", describeThread(null), "no thread");
}

// ── 14. errors never block the answer path (Part 30) ────────────────────────

{
  const none = selectContextBlock({
    question: "Why did you use HashSet?",
    problem: { attach: true, reason: "attached" },
    context: EMPTY_SESSION_CONTEXT, // problem attached but context is empty
    thread: null,
    now: T0,
  });
  check("14a a verdict with no block yields none", none.choice, "none");
  check("14b with a reason that says so", none.reason, "problem verdict attached but the problem block was empty");
  check("14c and an empty block", none.block, "");
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.join("\n"));
  process.exit(1);
}
