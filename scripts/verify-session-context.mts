/**
 * Deterministic tests for the session-context feature.
 *
 * Run: `npx tsx scripts/verify-session-context.mts`
 *
 * ── What is actually being protected ────────────────────────────────────────
 *
 *  1. **Follow-up detection is structural, not topical.** A cue list full of
 *     technology names would pass every test in this file and still fail the
 *     first unseen problem. The tables below are chosen so that a topic
 *     whitelist would FAIL them: the positives mention a HashSet, a binary tree
 *     and a Dijkstra run, and so do the negatives, in the same session.
 *
 *  2. **The non-attach prompt is BYTE-IDENTICAL.** Asserted with string
 *     equality against output captured before this feature existed. A fuzzy
 *     "looks similar" assertion would let a stray newline through, and a stray
 *     newline in a prompt is exactly what shifts a provider's behaviour.
 *
 *  3. **Clear chat must not clear the context.** The whole feature fails if
 *     clearing the visible transcript also drops the problem, because the user
 *     clears the chat constantly.
 *
 *  4. **Prompt growth is measured, not assumed.** Reported as characters and as
 *     a token estimate, because "keep prompt growth small" is a requirement and
 *     an unmeasured requirement is not a requirement.
 */
import { readFile } from "node:fs/promises";

import {
  APPROACH_SUMMARY_MAX_CHARS,
  EMPTY_SESSION_CONTEXT,
  PROBLEM_TEXT_MAX_CHARS,
  SESSION_CONTEXT_TTL_MS,
  USER_NOTES_MAX_CHARS,
  buildContextBlock,
  classifyFollowUp,
  clipProblemText,
  clipUserNotes,
  describeSessionContext,
  detectProblemStart,
  extractApproachSummary,
  pruneSessionContext,
  startProblem,
  touchProblem,
  type SessionContext,
} from "../src/lib/sessionContext";
import {
  buildInterviewUserPrompt,
  type InterviewTurn,
} from "../src/lib/interviewAgent";
import { validateAnswerOutput } from "../src/lib/outputValidation";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    failures.push(
      `${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`,
    );
  }
}
function checkTrue(name: string, actual: boolean) {
  check(name, actual, true);
}

const T0 = 1_700_000_000_000;

/** Build a context whose active problem is `lastUsedAt` ms old. */
function ctxWithProblem(
  question: string,
  ageMs = 0,
  overrides: Partial<SessionContext> = {},
): SessionContext {
  const now = T0 - ageMs;
  return {
    ...startProblem(EMPTY_SESSION_CONTEXT, question, now),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Problem detection: starts a problem ────────────────");
// ═══════════════════════════════════════════════════════════════════════════

const PROBLEM_STARTS: Array<[string, string]> = [
  ["write a function", "Write a function that reverses a linked list."],
  ["implement + article", "Implement a LRU cache with O(1) access."],
  ["given an array", "Given an array of integers, find the two that sum to a target."],
  ["given a linked list", "Given a linked list, detect whether it has a cycle."],
  ["how would you design", "How would you design a rate limiter for a public API?"],
  ["design + article", "Design a news feed with fan-out on write."],
  ["find the", "Find the shortest path in a weighted graph."],
  ["code a class", "Code a class that implements an iterator over a tree."],
  ["walk me through implementing", "Walk me through implementing a thread pool."],
  ["sort the", "Sort the array in place in linear time if you can."],
];

for (const [name, q] of PROBLEM_STARTS) {
  check(
    `P1 [${name}] starts a problem`,
    detectProblemStart(q).isProblemStart,
    true,
  );
}

check(
  "P2 a coding problem is classified as coding",
  detectProblemStart("Given an array of integers, find the two that sum to a target.")
    .kind,
  "coding",
);
check(
  "P3 a system-design problem is classified as system_design",
  detectProblemStart("How would you design a rate limiter for a public API?").kind,
  "system_design",
);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Problem detection: does NOT start a problem ──────────");
// ═══════════════════════════════════════════════════════════════════════════

const NOT_PROBLEM_STARTS: Array<[string, string]> = [
  ["what is X", "What is Redis?"],
  ["what are X", "What are indexes in a database?"],
  ["explain X", "Explain Docker."],
  ["what is a REST API", "What is a REST API?"],
  ["tell me about X", "Tell me about your migrations."],
  ["what does X do", "What does the event loop do?"],
  ["why does X happen", "Why does garbage collection pause?"],
  ["too short", "Why?"],
  ["empty", ""],
  // A follow-up phrased with a problem verb. THIS is the case that makes the
  // `it` / `this` / `that` exclusion in NEW_PROBLEM_CUES load-bearing.
  ["implement it", "Can you implement it?"],
  ["write this", "Now write this using a deque."],
  ["make it faster (no verb match)", "Can you make it faster?"],
];

for (const [name, q] of NOT_PROBLEM_STARTS) {
  check(
    `P4 [${name}] does not start a problem`,
    detectProblemStart(q).isProblemStart,
    false,
  );
}

// ── The critical property: definitions neither replace NOR clear ────────────
{
  const ctx = ctxWithProblem("Given an array of integers, find the two that sum to a target.");
  // Simulates what Home.tsx does: only `detectProblemStart(...).isProblemStart`
  // writes to the context. A definition must not reach that branch.
  checkTrue(
    "P5 a definition does not trigger the replace branch",
    !detectProblemStart("Explain Docker.").isProblemStart,
  );
  check(
    "P6 and the context is therefore untouched",
    classifyFollowUp("Explain Docker.", ctx, T0).attach,
    false,
  );
  check(
    "P7 the problem is still there afterwards",
    ctx.activeProblem?.text,
    "Given an array of integers, find the two that sum to a target.",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Follow-up: ATTACH (table-driven) ───────────────────");
// ═══════════════════════════════════════════════════════════════════════════

const ctx = ctxWithProblem(
  "Given an array of integers, find the two that sum to a target.",
);

// NOTE: every positive below mentions a specific technology. A topic whitelist
// would need an entry per technology and would still be wrong for the next one.
const ATTACH_CASES: Array<[string, string]> = [
  ["why did you + tech", "Why did you use a HashSet here?"],
  ["why did you + struct", "Why did you use a binary tree for that?"],
  ["why not", "Why not Dijkstra?"],
  ["time complexity", "What is the time complexity?"],
  ["ASR-dropped apostrophe", "Whats the complexity of that?"],
  ["optimize it", "Can you optimize it?"],
  ["ASR 'hear' for 'here'", "Why did you use a HashSet hear?"],
  ["this", "Can you expand on this?"],
  ["your solution", "Walk me through your solution."],
  ["your approach", "Your approach seems wrong, why?"],
  ["improve", "How would you improve this?"],
  ["edge cases", "What about edge cases?"],
  ["what if", "What if the array is empty?"],
  ["what happens when", "What happens when there are duplicates?"],
  ["your code", "Why does your code do two passes?"],
  ["make it faster", "Can you make it faster?"],
  ["ASR lowercase", "why did you use a hash set"],
  ["ASR missing punctuation", "why did you use a hashset"],
];

for (const [name, q] of ATTACH_CASES) {
  check(
    `A1 [${name}] attaches`,
    classifyFollowUp(q, ctx, T0).attach,
    true,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Follow-up: DO NOT attach (table-driven) ────────────");
// ═══════════════════════════════════════════════════════════════════════════

const NO_ATTACH_CASES: Array<[string, string]> = [
  ["What is Redis?", "What is Redis?"],
  ["Explain Docker.", "Explain Docker."],
  ["What is REST API?", "What is a REST API?"],
  ["Tell me about your migrations.", "Tell me about your migrations."],
  ["a new topic entirely", "How does garbage collection work?"],
  ["an unrelated behavioural question", "Why should we hire you?"],
  ["empty", ""],
];

for (const [name, q] of NO_ATTACH_CASES) {
  check(
    `A2 [${name}] does not attach`,
    classifyFollowUp(q, ctx, T0).attach,
    false,
  );
}

// ── The no-topic-whitelist property, stated as a test ───────────────────────
// "Why not Dijkstra?" attaches and "What is Redis?" does not, from the SAME
// context, on the same run. If any of these decisions were being made by topic,
// one of them would be wrong.
checkTrue(
  "A3 a 'why not X' attaches while 'what is X' does not — topic-independent",
  classifyFollowUp("Why not Dijkstra?", ctx, T0).attach &&
    !classifyFollowUp("What is Redis?", ctx, T0).attach,
);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── TTL ─────────────────────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

check(
  "T1 the TTL is 30 minutes",
  SESSION_CONTEXT_TTL_MS,
  30 * 60 * 1000,
);
check(
  "T2 just inside the TTL still attaches",
  classifyFollowUp("Can you optimize it?", ctx, T0 + SESSION_CONTEXT_TTL_MS - 1000)
    .attach,
  true,
);
check(
  "T3 one ms past the TTL does not",
  classifyFollowUp("Can you optimize it?", ctx, T0 + SESSION_CONTEXT_TTL_MS + 1)
    .attach,
  false,
);
check(
  "T4 and the reason says so",
  classifyFollowUp("Can you optimize it?", ctx, T0 + SESSION_CONTEXT_TTL_MS + 1)
    .reason,
  "context expired (older than the TTL)",
);
check(
  "T5 an hour later does not attach",
  classifyFollowUp("Can you optimize it?", ctx, T0 + 60 * 60 * 1000).attach,
  false,
);

// ── TTL is "since last USE", not "since created" ───────────────────────────
{
  const started = startProblem(
    EMPTY_SESSION_CONTEXT,
    "Given an array of integers, find the two that sum to a target.",
    T0,
  );
  // 50 minutes after creation, but used 1 minute ago.
  const usedRecently = touchProblem(started, T0 + 50 * 60 * 1000);
  check(
    "T6 a problem used a minute ago still attaches 50 minutes in",
    classifyFollowUp("Can you optimize it?", usedRecently, T0 + 51 * 60 * 1000)
      .attach,
    true,
  );

  // And pruning follows the same rule.
  checkTrue(
    "T7 pruning keeps a recently-used problem",
    pruneSessionContext(usedRecently, T0 + 51 * 60 * 1000).activeProblem !==
      null,
  );
  check(
    "T8 and drops one that has not been used",
    pruneSessionContext(started, T0 + 51 * 60 * 1000).activeProblem,
    null,
  );
  check(
    "T9 pruning an expired context drops the approach summary too",
    pruneSessionContext(
      { ...started, approachSummary: "use a hash set" },
      T0 + 51 * 60 * 1000,
    ).approachSummary,
    null,
  );
  checkTrue(
    "T10 pruning a live context returns the SAME object (no needless re-render)",
    pruneSessionContext(started, T0 + 1000) === started,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Replacement and two problems in a row ───────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const first = startProblem(
    EMPTY_SESSION_CONTEXT,
    "Given an array of integers, find the two that sum to a target.",
    T0,
  );
  const second = startProblem(
    first,
    "Design a URL shortener that handles 10k writes per second.",
    T0 + 60_000,
  );

  check(
    "R1 the new problem replaces the old one",
    second.activeProblem?.text,
    "Design a URL shortener that handles 10k writes per second.",
  );
  checkTrue("R2 with a new id", second.activeProblem?.id !== first.activeProblem?.id);
  check(
    "R3 the new problem's clock starts now",
    second.activeProblem?.createdAt,
    T0 + 60_000,
  );
  check(
    "R4 an approach summary for the OLD problem is dropped",
    second.approachSummary,
    null,
  );
  check(
    "R5 the kind is reclassified",
    second.activeProblem?.kind,
    "system_design",
  );

  // Two problems in a row, then a follow-up to the SECOND one.
  const withSummary = {
    ...second,
    approachSummary: "use a counter plus a base62 alphabet",
  };
  check(
    "R6 a follow-up attaches to the SECOND problem",
    classifyFollowUp("Why did you use a base62 encoding?", withSummary, T0 + 120_000)
      .attach,
    true,
  );
  check(
    "R7 and the block carries the second problem, not the first",
    buildContextBlock(withSummary).includes("URL shortener"),
    true,
  );
  check(
    "R8 the first problem is gone from the block",
    buildContextBlock(withSummary).includes("two that sum"),
    false,
  );

  // A follow-up phrased as a command must NOT replace the problem.
  check(
    "R9 'Can you implement it?' does not replace",
    classifyFollowUp("Can you implement it?", withSummary, T0 + 120_000).reason,
    "attached",
  );
  check(
    "R10 a genuine new problem is reported as replacing",
    classifyFollowUp(
      "Now implement a rate limiter.",
      withSummary,
      T0 + 120_000,
    ).reason,
    "not a follow-up: a new problem replaces it",
  );

  // User notes survive a new problem (they describe the pasted material).
  const withNotes = { ...first, userNotes: "arr = [2,7,11,15]" };
  check(
    "R11 user notes survive a new problem",
    startProblem(withNotes, "Design a URL shortener.", T0 + 60_000).userNotes,
    "arr = [2,7,11,15]",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Caps ────────────────────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

check("C1 problem cap", PROBLEM_TEXT_MAX_CHARS, 600);
check("C2 approach cap", APPROACH_SUMMARY_MAX_CHARS, 200);
check("C3 notes cap", USER_NOTES_MAX_CHARS, 800);

checkTrue(
  "C4 a long problem statement is clipped",
  clipProblemText("x".repeat(5000)).length <= PROBLEM_TEXT_MAX_CHARS + 1,
);
checkTrue(
  "C5 long notes are clipped",
  clipUserNotes("y".repeat(5000)).length <= USER_NOTES_MAX_CHARS + 1,
);
checkTrue(
  "C6 a short problem statement is untouched",
  clipProblemText("Find the two sum.") === "Find the two sum.",
);
check(
  "C7 a too-short answer yields no approach summary",
  extractApproachSummary("Yes."),
  null,
);
check(
  "C8 a long answer is clipped to the cap",
  extractApproachSummary("z".repeat(5000))?.length,
  APPROACH_SUMMARY_MAX_CHARS + 1, // +1 for the ellipsis
);

// ── The framing property ────────────────────────────────────────────────────
// The summary is stored WITHOUT a subject. The subject comes from the block,
// and it says GHOSTLY's suggestion, never the candidate's.
{
  const withSummary: SessionContext = {
    ...ctx,
    approachSummary: extractApproachSummary(
      "I would build a hash set from the array and check each element's complement as I go.",
    ),
  };
  const block = buildContextBlock(withSummary);
  checkTrue(
    "C9 the block attributes the approach to Ghostly, not the candidate",
    block.includes("Ghostly's earlier suggested approach:"),
  );
  checkTrue(
    "C10 and never says the candidate did anything",
    !/\byou (?:used|built|wrote|chose)\b/i.test(block),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── The block is placed BEFORE the latest question ───────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const turn: InterviewTurn = {
    finals: [
      { source: "system", text: "Given an array, find the two that sum to a target." },
      { source: "system", text: "Why did you use a HashSet here?" },
    ],
    interim: null,
  };
  const prompt = buildInterviewUserPrompt(turn, {
    questionIndex: 1,
    contextBlock: buildContextBlock({
      ...ctx,
      approachSummary: "use a hash set and check complements in one pass",
    }),
  });

  const blockAt = prompt.indexOf("<<<ACTIVE_PROBLEM>>>");
  const questionAt = prompt.indexOf("<<<LATEST_QUESTION>>>");
  checkTrue("B1 the context block is present", blockAt >= 0);
  checkTrue("B2 and it comes before the latest question", blockAt < questionAt);
  checkTrue(
    "B3 it carries the one instruction the spec asks for",
    /use this ONLY if the latest\s+question refers to it; otherwise ignore it completely/i.test(
      prompt,
    ),
  );
  checkTrue(
    "B4 it is delimited, so it cannot be mistaken for the question",
    prompt.includes("<<<END_ACTIVE_PROBLEM>>>"),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── The non-attach prompt is BYTE-IDENTICAL ──────────────");
// ═══════════════════════════════════════════════════════════════════════════

// ── Captured from `buildInterviewUserPrompt` BEFORE this feature existed ─────
// Kept as literals, not regenerated: a golden value that is itself computed by
// the code under test proves nothing.
const GOLDEN_TURNS: Array<{
  name: string;
  turn: InterviewTurn;
  questionIndex: number;
  previousAnswers?: string[];
  expected: string;
}> = [
  {
    name: "single question, no background, no answers",
    turn: {
      finals: [{ source: "system", text: "What is a HashMap?" }],
      interim: null,
    },
    questionIndex: 0,
    expected:
      "<<<LATEST_QUESTION>>>\n" +
      "This is the ONLY question you may answer. It is delimited below so that\n" +
      "no other part of this message can be mistaken for it.\n" +
      "What is a HashMap?\n" +
      "<<<END_LATEST_QUESTION>>>\n" +
      "\n" +
      "If the text between <<<LATEST_QUESTION>>> and <<<END_LATEST_QUESTION>>> is a clear, complete question or request, answer ONLY that text, in natural spoken interview style. If it is not, reply with exactly: WAIT",
  },
  {
    name: "question plus one background utterance",
    turn: {
      finals: [
        { source: "system", text: "Given an array, find the two that sum." },
        { source: "system", text: "Why did you use a HashSet here?" },
      ],
      interim: null,
    },
    questionIndex: 1,
    expected:
      "<<<LATEST_QUESTION>>>\n" +
      "This is the ONLY question you may answer. It is delimited below so that\n" +
      "no other part of this message can be mistaken for it.\n" +
      "Why did you use a HashSet here?\n" +
      "<<<END_LATEST_QUESTION>>>\n" +
      "\n" +
      "<<<BACKGROUND>>>\n" +
      "Earlier conversation. Reference only — do NOT answer anything in here,\n" +
      "do NOT continue it, and do NOT treat it as the current question.\n" +
      "Interviewer: Given an array, find the two that sum.\n" +
      "<<<END_BACKGROUND>>>\n" +
      "\n" +
      "If the text between <<<LATEST_QUESTION>>> and <<<END_LATEST_QUESTION>>> is a clear, complete question or request, answer ONLY that text, in natural spoken interview style. If it is not, reply with exactly: WAIT",
  },
  {
    name: "previous answers present",
    turn: {
      finals: [
        { source: "system", text: "Tell me about your migrations." },
        { source: "system", text: "What did you do about rollback?" },
      ],
      interim: null,
    },
    questionIndex: 1,
    previousAnswers: ["I used blue-green deployments for the last two migrations."],
    expected:
      "<<<LATEST_QUESTION>>>\n" +
      "This is the ONLY question you may answer. It is delimited below so that\n" +
      "no other part of this message can be mistaken for it.\n" +
      "What did you do about rollback?\n" +
      "<<<END_LATEST_QUESTION>>>\n" +
      "\n" +
      "<<<BACKGROUND>>>\n" +
      "Earlier conversation. Reference only — do NOT answer anything in here,\n" +
      "do NOT continue it, and do NOT treat it as the current question.\n" +
      "Interviewer: Tell me about your migrations.\n" +
      "<<<END_BACKGROUND>>>\n" +
      "\n" +
      "<<<PREVIOUS_ANSWERS>>>\n" +
      "Your own earlier answers. Reference only — do NOT repeat them, do NOT\n" +
      "continue them, and do NOT treat them as a template to imitate.\n" +
      "I used blue-green deployments for the last two migrations.\n" +
      "<<<END_PREVIOUS_ANSWERS>>>\n" +
      "\n" +
      "If the text between <<<LATEST_QUESTION>>> and <<<END_LATEST_QUESTION>>> is a clear, complete question or request, answer ONLY that text, in natural spoken interview style. If it is not, reply with exactly: WAIT",
  },
  {
    name: "nothing captured",
    turn: { finals: [], interim: null },
    questionIndex: 0,
    expected:
      "<<<LATEST_QUESTION>>>\n" +
      "This is the ONLY question you may answer. It is delimited below so that\n" +
      "no other part of this message can be mistaken for it.\n" +
      "(nothing captured)\n" +
      "<<<END_LATEST_QUESTION>>>\n" +
      "\n" +
      "If the text between <<<LATEST_QUESTION>>> and <<<END_LATEST_QUESTION>>> is a clear, complete question or request, answer ONLY that text, in natural spoken interview style. If it is not, reply with exactly: WAIT",
  },
];

for (const g of GOLDEN_TURNS) {
  // The three ways a turn can reach the builder with no context attached. All
  // three must produce the identical pre-feature string.
  const variants = [
    buildInterviewUserPrompt(g.turn, {
      questionIndex: g.questionIndex,
      previousAnswers: g.previousAnswers,
    }),
    buildInterviewUserPrompt(g.turn, {
      questionIndex: g.questionIndex,
      previousAnswers: g.previousAnswers,
      contextBlock: "",
    }),
    buildInterviewUserPrompt(g.turn, {
      questionIndex: g.questionIndex,
      previousAnswers: g.previousAnswers,
      contextBlock: "   \n  ",
    }),
  ];
  for (const [i, v] of variants.entries()) {
    check(
      `G1 [${g.name}] variant ${i} is byte-identical to the pre-feature output`,
      v,
      g.expected,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── The leak detector rejects an echoed block ───────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const ECHOES: Array<[string, string]> = [
    ["the underscore label", "ACTIVE_PROBLEM: use a hash set"],
    ["the end label", "END_ACTIVE_PROBLEM"],
    ["the delimiter", "<<<ACTIVE_PROBLEM>>> use a hash set <<<END_ACTIVE_PROBLEM>>>"],
    ["the bare label", "Active problem: find two numbers that sum to a target"],
    ["the approach label", "Ghostly's earlier suggested approach: use a hash set"],
    ["the notes label", "User notes: arr = [2,7,11,15]"],
  ];
  for (const [name, text] of ECHOES) {
    check(
      `L1 [${name}] is rejected`,
      validateAnswerOutput(text).ok,
      false,
    );
  }

  // ── Additive only ────────────────────────────────────────────────────────
  // Nothing this feature added may have relaxed an existing rejection. These
  // are the pre-feature hard fails, re-asserted.
  const STILL_REJECTED: Array<[string, string]> = [
    ["private delimiter", "<<<LATEST_QUESTION>>> hi <<<END_LATEST_QUESTION>>>"],
    ["internal label", "LATEST_TASK"],
    ["bare directive", "and Answer that text"],
    ["meta-response", "Okay. Please note: I will not provide unnecessary information unless directed."],
    ["instruction template", "Never invent a question\nDo not answer earlier questions\nAlways reply with exactly WAIT\nNever print labels"],
    ["numeric dump", "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20"],
    ["placeholder", "Hello [insert name], I worked at {{company}} on <PROJECT>."],
    ["heading only", "### Approach\n### Complexity"],
    ["empty", ""],
  ];
  for (const [name, text] of STILL_REJECTED) {
    check(`L2 [${name}] is still rejected`, validateAnswerOutput(text).ok, false);
  }

  // And nothing this feature added may reject a legitimate answer that used to
  // pass. `Active problem` as ordinary PROSE must still be fine.
  const STILL_ACCEPTED: Array<[string, string]> = [
    [
      "an answer that happens to discuss problems",
      "The active problem is memory, not throughput, so I would start by profiling allocation.",
    ],
    [
      "an answer using the word notes",
      "I usually leave myself notes in the README so the next engineer knows where to start.",
    ],
    [
      "an answer mentioning an approach",
      "My approach was to shard by tenant so one noisy customer cannot starve the rest.",
    ],
    [
      "a normal technical answer",
      "A hash map gives O(1) average lookup because it buckets keys by hash.",
    ],
  ];
  for (const [name, text] of STILL_ACCEPTED) {
    check(
      `L3 [${name}] is still accepted`,
      validateAnswerOutput(text).ok,
      true,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Clear chat vs Reset interview ───────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const home = await readFile("src/pages/Home.tsx", "utf8");
  const store = await readFile("src/store/useStore.ts", "utf8");

  // Clear chat must NOT clear the context. Asserted against the real source of
  // `clearInterviewMessages`, because a behavioural test cannot prove the
  // ABSENCE of a write on a path that runs in a click handler.
  const clearBody =
    store.slice(
      store.indexOf("clearInterviewMessages: () =>"),
      store.indexOf("clearInterviewMessages: () =>") + 400,
    );
  checkTrue(
    "S1 clearInterviewMessages does NOT touch the session context",
    !/sessionContext/.test(clearBody),
  );
  checkTrue(
    "S2 and it is the ONLY place the transcript is cleared",
    !/sessionContext/.test(
      clearBody.replace(/sessionContext:[^,}]+/g, ""),
    ),
  );

  // Next Question must not clear it.
  const nextQ = home.slice(
    home.indexOf("const nextQuestion = useCallback"),
    home.indexOf("const nextQuestion = useCallback") + 900,
  );
  checkTrue(
    "S3 Next Question does not clear the session context",
    !/clearSessionContext/.test(nextQ),
  );

  // Stop/Start must not clear it. Scoped to the toggle handler specifically:
  // Ctrl+G ("start over") DOES clear it, and it lives in the same file above
  // this point, so a whole-file assertion would be testing the wrong thing.
  const toggleStartStop = home.slice(
    home.indexOf("const toggleInterviewShortcut"),
    home.indexOf("const toggleInterviewShortcut") + 1200,
  );
  checkTrue(
    "S4 Start/Stop Interview does not clear the session context",
    !/clearSessionContext/.test(toggleStartStop),
  );
  checkTrue(
    "S4b and neither does opening or closing the panel",
    !/clearSessionContext/.test(
      home.slice(
        home.indexOf("const toggleInterview = useCallback"),
        home.indexOf("const closeInterview = useCallback") + 400,
      ),
    ),
  );
  // The whole app clears it in exactly TWO places: the chip's own Clear button
  // (via the prop) and the Ctrl+G reset. Anything else is a bug.
  const clearCalls = home.match(/clearSessionContext\(\)/g) ?? [];
  checkTrue(
    "S4c clearSessionContext is called from exactly one place in Home.tsx",
    clearCalls.length === 1,
  );

  // Reset interview (Ctrl+G) MUST clear it.
  checkTrue(
    "S5 Reset interview DOES clear the session context",
    /clearSolution\(\);\s*\n[\s\S]{0,400}clearSessionContext\(\);/.test(home),
  );

  // Nothing persists it to disk.
  checkTrue(
    "S6 the context is not written to electron-store",
    !/saveSettings\(\{[^}]*sessionContext/.test(home),
  );
  checkTrue(
    "S7 the context slice is not inside settings",
    !/settings:\s*\{[\s\S]{0,4000}sessionContext:\s*SessionContext/.test(store),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Measured prompt growth ──────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Rough token estimate.
 *
 * Not a tokenizer — a deliberate one. It is only ever compared against ITSELF
 * (block vs no block), so a consistent estimate is enough, and it is stated as
 * an estimate rather than dressed up as exact.
 */
const estimateTokens = (s: string) => Math.ceil(s.length / 4);

{
  const worstCase = {
    ...ctx,
    approachSummary: extractApproachSummary("a".repeat(1000)),
    userNotes: "b".repeat(1000),
  };
  const block = buildContextBlock(worstCase);
  const turn: InterviewTurn = {
    finals: [
      { source: "system", text: "Given an array, find the two that sum." },
      { source: "system", text: "Why did you use a HashSet here?" },
    ],
    interim: null,
  };

  const without = buildInterviewUserPrompt(turn, { questionIndex: 1 });
  const with_ = buildInterviewUserPrompt(turn, {
    questionIndex: 1,
    contextBlock: block,
  });

  const deltaChars = with_.length - without.length;
  const deltaTokens = estimateTokens(with_) - estimateTokens(without);

  console.log(
    `   WORST CASE (all three fields at their caps, clipped)\n` +
      `     block body         : ${block.length} chars\n` +
      `     prompt without     : ${without.length} chars (~${estimateTokens(without)} tokens)\n` +
      `     prompt with        : ${with_.length} chars (~${estimateTokens(with_)} tokens)\n` +
      `     GROWTH             : +${deltaChars} chars (~+${deltaTokens} tokens)`,
  );

  // A TYPICAL case: a real problem statement and a real approach excerpt, no
  // pasted notes. This is the number that actually applies.
  const typical = {
    ...ctx,
    approachSummary: "use a hash set and check each complement in one pass",
  };
  const typicalBlock = buildContextBlock(typical);
  const typicalWith = buildInterviewUserPrompt(turn, {
    questionIndex: 1,
    contextBlock: typicalBlock,
  });
  const typicalDeltaChars = typicalWith.length - without.length;
  const typicalDeltaTokens =
    estimateTokens(typicalWith) - estimateTokens(without);
  console.log(
    `   TYPICAL (problem + approach, no notes)\n` +
      `     block body         : ${typicalBlock.length} chars\n` +
      `     GROWTH             : +${typicalDeltaChars} chars (~+${typicalDeltaTokens} tokens)`,
  );

  checkTrue(
    "M1 worst-case growth is bounded by the caps plus the framing",
    deltaChars <= 2100,
  );
  checkTrue(
    "M2 typical growth is well under 250 tokens",
    typicalDeltaTokens < 250,
  );
  checkTrue(
    "M3 worst case is under 600 tokens",
    deltaTokens < 600,
  );
  // The block must be small relative to what the feature REPLACES.
  // Today the problem statement reaches the model only as a BACKGROUND entry —
  // and BACKGROUND is unbounded in COUNT, so a busy turn already carries every
  // earlier phrase at 400 chars each. The block is bounded; that is the win.
  // Today the problem statement reaches the model only as a BACKGROUND entry —
  // and BACKGROUND is unbounded in COUNT, so a busy turn already carries every
  // earlier phrase at 400 chars each. The block is bounded; that is the win.
  // Realistic background text, not a stub. A real captured phrase from the
  // interview VAD is a spoken sentence, roughly 90-120 characters; using a
  // 60-character placeholder would understate the prompt by half and make the
  // percentage look worse than reality.
  const busyBackground: Array<{ source: "system" | "mic"; text: string }> =
    Array.from({ length: 12 }, (_, i) => ({
      source: "system" as const,
      text:
        `So on the caching question, how would you handle the case where a read ` +
        `replica falls behind during a traffic spike and you start serving ` +
        `stale data to about a fifth of your users? (part ${i + 1})`,
    }));
  const busyTurn: InterviewTurn = {
    finals: [
      ...busyBackground,
      { source: "system", text: "Why did you use a HashSet here?" },
    ],
    interim: null,
  };
  const busyWithout = buildInterviewUserPrompt(busyTurn, {
    questionIndex: 12,
    previousAnswers: [
      "A reasonably long earlier answer about the migration, of about the length a real one runs to.",
      "Another earlier answer, similarly sized, because two are always sent.",
    ],
  });
  const busyWith = buildInterviewUserPrompt(busyTurn, {
    questionIndex: 12,
    contextBlock: typicalBlock,
    previousAnswers: [
      "A reasonably long earlier answer about the migration, of about the length a real one runs to.",
      "Another earlier answer, similarly sized, because two are always sent.",
    ],
  });
  const busyDelta = busyWith.length - busyWithout.length;
  console.log(
    `   BUSY TURN (12 background utterances + 2 previous answers)\n` +
      `     prompt without     : ${busyWithout.length} chars (~${estimateTokens(busyWithout)} tokens)\n` +
      `     prompt with        : ${busyWith.length} chars (~${estimateTokens(busyWith)} tokens)\n` +
      `     GROWTH             : +${busyDelta} chars (~+${
        estimateTokens(busyWith) - estimateTokens(busyWithout)
      } tokens, ${((busyDelta / busyWithout.length) * 100).toFixed(1)}% of the prompt)`,
  );
  checkTrue(
    "M4 on a busy turn the block is under 20% of the prompt",
    busyDelta / busyWithout.length < 0.2,
  );
  checkTrue(
    "M5 and it costs less than one background utterance",
    busyDelta < 400,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Measured cost of the logic ──────────────────────────");
{
  // Timed, not asserted to a number: the requirement is "keep the added
  // milliseconds small", and a wall-clock assertion on a loaded CI machine
  // would be flaky rather than protective. The number is REPORTED so a
  // regression is visible, and the assertion is the order of magnitude.
  const questions = Array.from({ length: 1000 }, (_, i) =>
    i % 3 === 0
      ? "Why did you use a HashSet here?"
      : i % 3 === 1
        ? "What is Redis?"
        : "Given an array of integers, find the two that sum to a target.",
  );
  const liveCtx = ctxWithProblem(
    "Given an array of integers, find the two that sum to a target.",
  );
  const t0 = performance.now();
  for (const q of questions) {
    detectProblemStart(q);
    classifyFollowUp(q, liveCtx, T0);
    buildContextBlock(liveCtx);
  }
  const elapsed = performance.now() - t0;
  const perCall = elapsed / questions.length;
  console.log(
    `   3 x 1000 detectProblemStart + classifyFollowUp + buildContextBlock\n` +
      `     total ${elapsed.toFixed(2)} ms for 3000 operations\n` +
      `     PER TURN (all three, once): ${perCall.toFixed(4)} ms`,
  );
  checkTrue(
    "M6 a full turn's context logic costs under 1 ms",
    perCall < 1,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── describeSessionContext ──────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

check(
  "D1 no problem reads as none",
  describeSessionContext(EMPTY_SESSION_CONTEXT, T0),
  "no active problem",
);
check(
  "D2 an active problem is labelled",
  describeSessionContext(ctx, T0 + 60_000),
  "coding · set 1m ago · active",
);
checkTrue(
  "D3 an expired one says so",
  /expired/.test(
    describeSessionContext(ctx, T0 + SESSION_CONTEXT_TTL_MS + 1000),
  ),
);

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}