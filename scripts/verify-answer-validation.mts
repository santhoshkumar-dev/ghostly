/**
 * Deterministic tests for the strengthened answer-output gate.
 *
 * Run: `npx tsx scripts/verify-answer-validation.ts`
 *
 * Covers the observed prompt-leak / malformed-answer failures (spec TEST 1–10)
 * and the provider-integration contract: an invalid provider must be rejected
 * and must never become the winner, while a valid answer still wins exactly
 * once. No network access — providers are scripted fakes.
 */
import fs from "node:fs";
import {
  validateAnswerOutput,
  detectAnswerArtifact,
} from "../src/lib/outputValidation";
import { groqAnswerDirective } from "../src/lib/ai/groq";
import { isWaitResponse, INTERVIEW_SYSTEM_PROMPT } from "../src/lib/interviewAgent";
import {
  orchestrateAnswer,
  type AttemptSpec,
} from "../src/lib/ai/orchestrator";
import type { AIProvider, AIRequestOptions } from "../src/lib/ai/types";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
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

/** The exact validator the interview path uses (WAIT + output gate). */
function interviewValidate(text: string) {
  if (isWaitResponse(text)) return { ok: false, reason: "wait" };
  return validateAnswerOutput(text, {});
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Observed failures must be REJECTED
// ═══════════════════════════════════════════════════════════════════════════

const INSTRUCTION_BLOCK =
  "You are a live interview ANSWERING engine. Absolute rules: never invent a question, never answer an earlier question. If the latest utterance is incomplete reply with exactly: WAIT.";

const REJECT: Array<[string, string]> = [
  [
    "TEST 1 <<<ITEM_QUESTION>>> + instruction block",
    `<<<ITEM_QUESTION>>>\n${INSTRUCTION_BLOCK}\n<<<END_ITEM_QUESTION>>>`,
  ],
  [
    "TEST 2 <<<LATEST_TASK>>>…<<<END_LATEST_TASK>>>",
    "<<<LATEST_TASK>>>\nanswer the following task\n<<<END_LATEST_TASK>>>",
  ],
  [
    "TEST 3 instruction + numeric/token garbage",
    `${INSTRUCTION_BLOCK}\n12 480 91 7733 402 9981 63 71 88 90 12 34 56 78`,
  ],
  [
    "other observed markers",
    "<<<INITIAL_QUESTION>>>\n<<<INTERVIEW_QUESTION>>>\n<<<WHAT IS PROBLEMS>>>",
  ],
  [
    "bare internal label without delimiters",
    "LATEST_TASK END_LATEST_TASK ITEM_QUESTION",
  ],
  [
    "instruction-shaped rule list",
    "Never invent a question\nDo not answer earlier questions\nAlways reply with exactly WAIT\nNever print labels",
  ],
  [
    "numeric dump with no words",
    "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20",
  ],
  [
    "placeholder template",
    "Hello [insert name], I worked at {{company}} on <PROJECT> with YOUR_TEAM.",
  ],
  ["TEST 9 empty", ""],
  ["whitespace only", "   \n  "],
  ["punctuation only", ">>> <-> *** ---"],
];

for (const [label, bad] of REJECT) {
  check(`REJECT — ${label}`, interviewValidate(bad).ok, false);
  check(`artifact flag — ${label}`, detectAnswerArtifact(bad).artifact, true);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Legitimate answers must be ACCEPTED
// ═══════════════════════════════════════════════════════════════════════════

const ACCEPT: string[] = [
  "TEST 4 Simple Definition: Docker is a tool that packages applications into containers.",
  "TEST 5 Spring Boot is a framework built on top of the Spring Framework that simplifies application configuration.",
  "TEST 6 HTTP 500 errors can indicate a server-side failure.",
  "TEST 7 Use 3 replicas behind a load balancer.",
  "It's mainly used for dependency injection.",
  "Because the flag prevents the component from re-rendering.",
  "Yes.",
  "No.",
  "Correct",
  "We used Redis for the rate limiter and Postgres as the source of truth.",
  "Use HTTP 500 errors, retry three times, then fall back to the replica.",
  "The service returned a 500, so I checked the logs and found a null pointer.",
  "Kubernetes schedules containers onto nodes and restarts failed pods.",
  "Dependency injection lets a class receive its collaborators rather than building them.",
  "I would shard on user id, and use a read replica for the analytics queries.",
];

for (const good of ACCEPT) {
  check(`ACCEPT — ${good}`, interviewValidate(good).ok, true);
  check(`no artifact — ${good}`, detectAnswerArtifact(good).artifact, false);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2b. META-RESPONSE / refusal outputs must be REJECTED
//     (the observed `allam-2-7b` failures)
// ═══════════════════════════════════════════════════════════════════════════

const META_REJECT: Array<[string, string]> = [
  [
    "TEST M1 'Okay. Please note…'",
    "Okay. Please note: I will not provide unnecessary information unless directed.",
  ],
  ["TEST M2 'Please clarify this answer.'", "Please clarify this answer."],
  ["TEST M3 'Ask me the question.'", "Ask me the question."],
  ["TEST M4 'What is the question?'", "What is the question?"],
  ["TEST M5 '<<<QUESTION>>>'", "<<<QUESTION>>>"],
  ["TEST M6 '<<<LATEST_QUESTION>>>'", "<<<LATEST_QUESTION>>>"],
  [
    "TEST M7 'BACKGROUND DETAILS: …'",
    "BACKGROUND DETAILS: the candidate has five years of backend experience.",
  ],
  [
    "TEST M8 internal template echo",
    "You are a live interview ANSWERING engine. Never mention being an AI.",
  ],
];
for (const [label, bad] of META_REJECT) {
  check(`REJECT(meta) — ${label}`, interviewValidate(bad).ok, false);
  check(`artifact(meta) — ${label}`, detectAnswerArtifact(bad).artifact, true);
}

// The meta detector is structural, not a topic blacklist: real answers that
// happen to mention asking or clarifying must survive.
check(
  "meta detector ignores an answer that mentions asking",
  detectAnswerArtifact(
    "I would ask the interviewer about the SLA before choosing a design.",
  ).artifact,
  false,
);
check(
  "meta detector ignores 'To clarify' prose",
  detectAnswerArtifact("To clarify, MongoDB stores documents as BSON.").artifact,
  false,
);
check(
  "a normal answer is VALID",
  interviewValidate(
    "MongoDB is a NoSQL document database that is useful when you need flexible schemas and horizontal scaling.",
  ).ok,
  true,
);

// ═══════════════════════════════════════════════════════════════════════════
// 3. TEST 8 — WAIT, TEST 10 — template + a sentence that looks like an answer
// ═══════════════════════════════════════════════════════════════════════════

check("TEST 8 WAIT is rejected by the interview validator", interviewValidate("WAIT").ok, false);
check("TEST 8 isWaitResponse", isWaitResponse("WAIT"), true);

check(
  "TEST 10 template + one answer-looking sentence",
  interviewValidate(
    `${INSTRUCTION_BLOCK}\nDocker is a tool that packages applications into containers.`,
  ).ok,
  false,
);

// ═══════════════════════════════════════════════════════════════════════════
// 4. Artifact detector is structural, not a topic blacklist
// ═══════════════════════════════════════════════════════════════════════════

check(
  "the word 'question' alone is not an artifact",
  detectAnswerArtifact("The interviewer's question was about caching.").artifact,
  false,
);
check(
  "the word 'task' alone is not an artifact",
  detectAnswerArtifact("My main task was migrating the database.").artifact,
  false,
);
check(
  "a normal answer may contain question marks",
  detectAnswerArtifact("What is an index? It is a data structure that speeds up reads.").artifact,
  false,
);
check(
  "a JS unsigned-shift code answer is the documented tradeoff",
  detectAnswerArtifact("In JavaScript, x >>> 0 converts to an unsigned integer.").artifact,
  true,
);

// Template-echo check (spec §4) — only trips on a large structural overlap.
const TEMPLATE =
  "You are a live interview answering engine. Absolute rules. Never invent a question. If the utterance is unclear reply with exactly WAIT. Answer shaping. Output only the answer itself.";
check(
  "a long prompt echo is rejected",
  detectAnswerArtifact(
    "You are a live interview answering engine. Absolute rules. Never invent a question. If the utterance is unclear reply with exactly WAIT.",
    { promptTemplate: TEMPLATE },
  ).artifact,
  true,
);
check(
  "a normal answer does not trip the template-echo check",
  detectAnswerArtifact(
    "Dependency injection is a design pattern where a class receives its collaborators instead of constructing them itself, which makes testing much easier.",
    { promptTemplate: TEMPLATE },
  ).artifact,
  false,
);

// ═══════════════════════════════════════════════════════════════════════════
// 5. Provider integration — invalid output can never win
// ═══════════════════════════════════════════════════════════════════════════

interface Script {
  firstChunkAfterMs?: number;
  chunks?: string[];
  errorMessage?: string;
  failImmediately?: boolean;
}

function buildRegistry(scripts: Record<string, Script>) {
  const calls: string[] = [];
  const registry: Record<string, AIProvider> = {};
  for (const [name, script] of Object.entries(scripts)) {
    registry[name] = {
      name,
      listModels: () => [name],
      // eslint-disable-next-line require-yield
      async *streamSolution(_options: AIRequestOptions) {
        calls.push(name);
        if (script.failImmediately) throw new Error(script.errorMessage ?? "HTTP 500");
        if (script.firstChunkAfterMs) {
          await new Promise((r) => setTimeout(r, script.firstChunkAfterMs));
        }
        for (const c of script.chunks ?? [DEFAULT_ANSWER]) yield c;
      },
    };
  }
  return { registry, calls };
}

const DEFAULT_ANSWER =
  "Dependency injection is a design pattern where objects receive their collaborators rather than constructing them.";

function specs(...providers: string[]): AttemptSpec[] {
  return providers.map((provider) => ({
    provider: provider as AttemptSpec["provider"],
    model: `${provider}-model`,
    apiKey: `key-${provider}`,
  }));
}

async function run(scripts: Record<string, Script>, hedgeMs = 40) {
  const { registry, calls } = buildRegistry(scripts);
  const res = await orchestrateAnswer({
    attempts: specs("openrouter", "groq", "nvidia", "gemini"),
    prompt: "question",
    signal: new AbortController().signal,
    hedgeMs,
    validate: interviewValidate,
    resolveProvider: (name) => registry[name],
  });
  return { res, calls };
}

// ── 5a. OpenRouter leaks → rejected → Groq wins, leak never surfaces ──────
{
  const leak = "<<<LATEST_TASK>>>\nYou are a live interview ANSWERING engine. Never invent a question.\n<<<END_LATEST_TASK>>>";
  const { res, calls } = await run({
    openrouter: { firstChunkAfterMs: 5, chunks: [leak] },
    groq: { firstChunkAfterMs: 5 },
    nvidia: {},
    gemini: {},
  });
  check("5a OpenRouter and Groq both attempted", calls.slice(0, 2).sort(), ["groq", "openrouter"]);
  check("5a winner is Groq", res.provider, "groq");
  check("5a leaked text never surfaces", res.text.includes("LATEST_TASK"), false);
  check("5a winner text is the valid answer", res.text, DEFAULT_ANSWER);
}

// ── 5b. Groq leaks → rejected → fallback continues to nvidia ──────────────
{
  const leak = "12 34 56 78 90 11 22 33 44 55 66 77 88 99";
  const { res } = await run({
    openrouter: { failImmediately: true, errorMessage: "HTTP 500" },
    groq: { firstChunkAfterMs: 5, chunks: [leak] },
    nvidia: {},
    gemini: {},
  });
  check("5b winner is nvidia", res.provider, "nvidia");
  check("5b winner text is valid", res.text, DEFAULT_ANSWER);
  check(
    "5b Groq recorded as invalid",
    res.failures.some((f) => f.provider === "groq"),
    true,
  );
}

// ── 5c. Valid OpenRouter answer wins and Groq is never used ───────────────
{
  const { res, calls } = await run({
    openrouter: { firstChunkAfterMs: 5 },
    groq: { firstChunkAfterMs: 5 },
    nvidia: {},
    gemini: {},
  });
  check("5c OpenRouter wins", res.provider, "openrouter");
  check("5c Groq never started", calls.includes("groq"), false);
  check("5c exactly one winner", res.attemptsStarted.filter((a) => a.winner).length, 1);
}

// ── 5d. Valid Groq answer after an OpenRouter failure wins ────────────────
{
  const { res } = await run({
    openrouter: { failImmediately: true, errorMessage: "HTTP 503" },
    groq: { firstChunkAfterMs: 5 },
    nvidia: {},
    gemini: {},
  });
  check("5d Groq wins", res.provider, "groq");
  check("5d exactly one winner", res.attemptsStarted.filter((a) => a.winner).length, 1);
}

// ── 5e. Every provider leaks → no winner, empty authoritative text ────────
{
  const leak = "<<<ITEM_QUESTION>>>\nYou must reply with exactly WAIT.";
  const { res } = await run({
    openrouter: { firstChunkAfterMs: 5, chunks: [leak] },
    groq: { firstChunkAfterMs: 5, chunks: [leak] },
    nvidia: { firstChunkAfterMs: 5, chunks: [leak] },
    gemini: { firstChunkAfterMs: 5, chunks: [leak] },
  });
  check("5e no winner", res.provider, null);
  check("5e empty text", res.text, "");
  check("5e no leaked text anywhere", res.text.includes("ITEM_QUESTION"), false);
}

// ── 5f. Groq returns the observed meta refusal → invalid → fallback wins ──
{
  const meta =
    "Okay. Please note: I will not provide unnecessary information unless directed.";
  const { res, calls } = await run({
    openrouter: { failImmediately: true, errorMessage: "HTTP 500" },
    groq: { firstChunkAfterMs: 5, chunks: [meta] },
    nvidia: { firstChunkAfterMs: 5 },
    gemini: {},
  });
  const groqAttempt = res.attemptsStarted.find((a) => a.provider === "groq");
  check("5f Groq result is invalid (rejected)", groqAttempt?.outcome, "failed");
  check("5f Groq is NOT the winner", groqAttempt?.winner, false);
  check("5f Groq failure classified as artifact-meta",
    res.failures.find((f) => f.provider === "groq")?.reason, "artifact-meta");
  check("5f fallback continued to nvidia", calls.includes("nvidia"), true);
  check("5f nvidia wins", res.provider, "nvidia");
  check("5f meta text never surfaces", res.text, DEFAULT_ANSWER);
  check("5f exactly one winner", res.attemptsStarted.filter((a) => a.winner).length, 1);
}

// ── 5g. A normal Groq answer is valid and WINS ────────────────────────────
{
  const { res } = await run({
    openrouter: { failImmediately: true, errorMessage: "HTTP 500" },
    groq: { firstChunkAfterMs: 5 },
    nvidia: {},
    gemini: {},
  });
  const groqAttempt = res.attemptsStarted.find((a) => a.provider === "groq");
  check("5g Groq result is valid (success)", groqAttempt?.outcome, "success");
  check("5g Groq is the winner", groqAttempt?.winner, true);
  check("5g winner is Groq", res.provider, "groq");
  check("5g answer text preserved", res.text, DEFAULT_ANSWER);
}

// ── 5i. REGRESSION: "and Answer that text" must never win ────────────────
//
// Observed in the live run as turn 1791060167441-w9zhux, provider
// groq/allam-2-7b. The exact string is asserted, character for character,
// because a near-miss proves nothing about the bug that actually happened.
//
// Why every OTHER check missed it, recorded so the test is not "fixed" back:
//   • META_RESPONSE_RE only catches ASKING for the question; this ORDERS.
//   • TEMPLATE_LEAK_PHRASES holds the full Groq directive wording; the model
//     echoed a mangled fragment, so the exact-substring test missed.
//   • readsAsLabel is defeated by the word "that", which is a sentence marker,
//     so the label test correctly declines to fire.
{
  const OBSERVED = "and Answer that text";

  check(
    "5i REGRESSION: the exact observed string is rejected",
    interviewValidate(OBSERVED).ok,
    false,
  );
  check(
    "5i REGRESSION: rejected as a bare directive, not by accident",
    interviewValidate(OBSERVED).reason,
    "artifact-directive",
  );
  check(
    "5i REGRESSION: detectAnswerArtifact agrees",
    detectAnswerArtifact(OBSERVED).reason,
    "artifact-directive",
  );

  // Same rule, case and whitespace insensitively — the model is not going to
  // reproduce casing reliably.
  for (const variant of [
    "Answer that text",
    "and answer that text",
    "and Answer that Text.",
    "and  Answer   that   text",
  ]) {
    check(
      `5i variant rejected: ${JSON.stringify(variant)}`,
      validateAnswerOutput(variant).ok,
      false,
    );
  }

  // The rule generalises to the whole class: any bare imperative at the model
  // whose object is the conversation itself.
  for (const directive of [
    "Repeat the prompt",
    "Translate this text",
    "Summarize the passage",
    "Please answer that question",
    "Rewrite the above message",
  ]) {
    check(
      `5i directive rejected: ${JSON.stringify(directive)}`,
      validateAnswerOutput(directive).ok,
      false,
    );
  }

  // ── The other direction, which is the one that matters ───────────────
  // A STRUCTURAL rule is only acceptable if it cannot reject a real answer.
  // Every one of these contains a content word that is neither a speech-act verb
  // nor a conversation-reference noun, which is what makes them pass.
  for (const legit of [
    "I would answer that question by explaining how the parser works.",
    "Answer the question in the simplest way you can: it usually means the state is local to the request.",
    "We use an index to avoid a full table scan on every read.",
    "Yes.",
    "It's mainly used for dependency injection.",
    "That question is really about cache invalidation, so I'd start there.",
    "A hash map gives O(1) average lookup because it buckets keys by hash.",
    "And that is the only reason it fails.",
  ]) {
    check(
      `5i legitimate answer accepted: ${JSON.stringify(legit.slice(0, 40))}`,
      validateAnswerOutput(legit, {
        question: "Why do they use Java as their backend language?",
      }).ok,
      true,
    );
  }

  // It must not have become a topic blacklist: interview vocabulary has to
  // survive, including the words the rule itself keys on.
  for (const topical of [
    "The index question you asked about is exactly where a B-tree beats a hash map.",
    "We would repeat the migration on a staging cluster first.",
    "The answer is a queue with backpressure, not a bigger pool.",
  ]) {
    check(
      `5i topical answer accepted: ${JSON.stringify(topical.slice(0, 40))}`,
      validateAnswerOutput(topical).ok,
      true,
    );
  }

  // Through the REAL orchestrator: a provider returning the observed string must
  // not win, and the run must still be able to produce a valid answer.
  checkTrue(
    "5i orchestrator: the observed string never wins",
    await (async () => {
      const { registry } = buildRegistry({
        groq: { chunks: [OBSERVED] },
        gemini: {
          chunks: [
            "A hash map gives O(1) average lookup because it buckets keys by hash.",
          ],
        },
      });
      const run = await orchestrateAnswer({
        attempts: specs("groq", "gemini"),
        prompt: "p",
        signal: new AbortController().signal,
        validate: interviewValidate,
        resolveProvider: (name) => registry[name],
        log: () => {},
      });
      return run.provider === "gemini" && run.winner;
    })(),
  );

  checkTrue(
    "5i orchestrator: the observed string alone produces NO winner",
    await (async () => {
      const { registry } = buildRegistry({ groq: { chunks: [OBSERVED] } });
      const run = await orchestrateAnswer({
        attempts: specs("groq"),
        prompt: "p",
        signal: new AbortController().signal,
        validate: interviewValidate,
        resolveProvider: (name) => registry[name],
        log: () => {},
      });
      return !run.winner && run.text === "";
    })(),
  );
}

// ── 5h. The Groq-only answer directive is applied, and ONLY to Groq ───────
{
  const directive = groqAnswerDirective();
  checkTrue(
    "5h directive tells the model to answer directly",
    /answer that question directly and immediately/i.test(directive),
  );
  checkTrue(
    "5h directive forbids asking for the question",
    /do not ask for the question/i.test(directive),
  );
  const groqSrc = fs.readFileSync("src/lib/ai/groq.ts", "utf8");
  checkTrue(
    "5h Groq appends the directive to its system message",
    groqSrc.includes("groqAnswerDirective()") && groqSrc.includes("systemContent"),
  );
  const openrouterSrc = fs.readFileSync("src/lib/ai/openrouter.ts", "utf8");
  checkTrue(
    "5h OpenRouter is unchanged (no Groq directive)",
    !openrouterSrc.includes("groqAnswerDirective"),
  );
}

// ── 5i-bis. THE LIVE BUG: a mixed refusal that reached the UI ──────────────
//
// APPROXIMATION FROM SCREENSHOT. The user reported this text appearing in the
// interview panel; it is a hand transcription of what was on screen, not a
// paste of the exact string. The orchestrator's WINNER telemetry line
// (`orchestrator.ts`) deliberately logs NO answer text — only http/firstText/
// total/success/winner/reason — so the exact bytes are not recoverable from the
// logs. If the exact string is found, add it as an extra case below; the
// STRUCTURAL cases underneath are what actually protect the app, and they do
// not depend on this transcription.
//
// Why every pre-existing check passed it:
//   • isWaitResponse — WAIT is mid-sentence twice, never the whole output.
//   • META_RESPONSE_RE — needs a BARE determiner before "question", so
//     "provide a CLEAR question" fell through the qualifier gap.
//   • isBareDirective — bails above 12 tokens; this is ~21.
//   • isInstructionTemplate — needs >= 3 lines; this is one.
//   • isNumericArtifact / isTemplateEcho / isQuestionEcho / isNoProse — all
//     bail on shape or size thresholds this text satisfies.
{
  const BAD =
    "What is the difference between a Node 79 - Node.js8 WAIT then provide a clear question, and if a technical example or clarification, please WAIT";
  const QUESTION = "What is difference between SQL and NoSQL databases?";
  const opts = { question: QUESTION, promptTemplate: INTERVIEW_SYSTEM_PROMPT };

  checkTrue(
    "5i-bis the approximation is REJECTED",
    validateAnswerOutput(BAD, opts).ok === false,
  );
  check(
    "5i-bis and reported as the WAIT sentinel",
    validateAnswerOutput(BAD, opts).reason,
    "artifact-wait-sentinel",
  );
  checkTrue(
    "5i-bis isWaitResponse alone does NOT catch it (the actual bug)",
    isWaitResponse(BAD) === false,
  );
}

// ── 5j. WAIT sentinel as a standalone token ANYWHERE ───────────────────────
//
// Structural cases, independent of the screenshot transcription. Each is a
// normal-looking sentence with the sentinel embedded, which is the shape that
// got through.
{
  const q = "What is difference between SQL and NoSQL databases?";

  const WAIT_REJECT: Array<[string, string]> = [
    [
      "sql-nosql-wait-mid",
      "One is relational with a fixed schema. WAIT",
    ],
    [
      "trailing-wait",
      "One is relational with a fixed schema and joins, the other is schemaless. WAIT",
    ],
    [
      "wait-as-interjection-not-sentinel",
      "I would use the relational one. Wait, sorry, the other is better for flexible documents.",
    ],
    [
      "wait-lower-case-should-still-pass",
      "I would wait for replication to catch up before writing to the new primary, and explain why.",
    ],
    [
      "wait-as-verb-not-sentinel",
      "You wait on the future, and if replication lags you wait for the replica rather than writing to the primary.",
    ],
  ];

  for (const [id, text] of WAIT_REJECT) {
    const v = validateAnswerOutput(text, { question: q });
    // The lowercase / mixed-case cases are legitimate English and MUST be
    // accepted: only the upper-case sentinel is decisive.
    const shouldAccept =
      id.includes("lower-case") ||
      id.includes("as-verb") ||
      id.includes("interjection");
    checkTrue(
      `5j ${id}: ${shouldAccept ? "accepted" : "rejected"}`,
      shouldAccept ? v.ok === true : v.ok === false,
    );
    if (!shouldAccept) {
      check(`5j ${id}: reason`, v.reason, "artifact-wait-sentinel");
    }
  }

  // The sentinel is upper-case by contract; a case-insensitive rule would
  // reject correct prose. Assert the property that makes it safe.
  checkTrue(
    "5j case-sensitivity is load-bearing: lowercase 'wait' in prose is accepted",
    validateAnswerOutput(
      "I would wait for the index build to finish before measuring, because a half-built index gives a misleading plan.",
      { question: q },
    ).ok === true,
  );
}

// ── 5k. Instructions ABOUT the conversation ───────────────────────────────
{
  const q = "What is difference between SQL and NoSQL databases?";

  const INSTR_REJECT: string[] = [
    "Please provide a clear question.",
    "Provide a clear question and I will answer it.",
    "Give me a more specific question please.",
    "Please wait for the question.",
    "Kindly wait until the interviewer asks something.",
    "If you need a technical example or clarification, please wait.",
  ];

  for (const text of INSTR_REJECT) {
    const v = validateAnswerOutput(text, { question: q });
    checkTrue(`5k rejects: ${JSON.stringify(text.slice(0, 46))}`, v.ok === false);
    checkTrue(
      `5k reason is structural: ${JSON.stringify(text.slice(0, 30))}`,
      v.reason === "artifact-conversation-instruction" ||
        v.reason === "artifact-meta" ||
        v.reason === "no-prose" ||
        v.reason === "heading-only",
    );
  }

  // A legitimate answer that happens to discuss a question must survive.
  checkTrue(
    "5k an answer discussing 'a complete answer' is NOT rejected",
    validateAnswerOutput(
      "I'd give a complete answer by comparing the two side by side, since a table makes the tradeoff obvious.",
      { question: q },
    ).ok === true,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
