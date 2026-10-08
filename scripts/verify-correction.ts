/**
 * Verification harness for the generic context-aware ASR repair engine.
 *
 * Run: `npx tsx scripts/verify-correction.ts`
 *
 * Pure functions only — no audio, no network, no Electron. Mirrors the style of
 * the other `verify-*.ts` harnesses in this folder.
 */
import {
  correctTranscript,
  normalizeFormatting,
  type CorrectionInput,
} from "../src/lib/transcriptCorrection";
import { buildCandidateContext } from "../src/lib/transcriptVocabulary";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    failures.push(
      `${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`,
    );
  }
}

function ctx(...terms: string[]) {
  return { terms };
}

function run(input: CorrectionInput) {
  return correctTranscript(input);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. KNOWN CONTEXT — corrections
// ─────────────────────────────────────────────────────────────────────────────
check(
  "known: spring wood -> Spring Boot",
  run({ rawText: "What is spring wood?", candidateContext: ctx("Spring Boot") }).correctedText,
  "What is Spring Boot?",
);
check(
  "known: spring wood reports changed",
  run({ rawText: "What is spring wood?", candidateContext: ctx("Spring Boot") }).changed,
  true,
);
check(
  "known: raw transcript preserved",
  run({ rawText: "What is spring wood?", candidateContext: ctx("Spring Boot") }).rawText,
  "What is spring wood?",
);

check(
  "project: crick auction -> CricAuctionHub",
  run({
    rawText: "Tell me about your project, crick auction.",
    candidateContext: ctx("CricAuctionHub"),
  }).correctedText,
  "Tell me about your project, CricAuctionHub.",
);

check(
  "db: mongo db -> MongoDB",
  run({ rawText: "What is mongo db?" }).correctedText,
  "What is MongoDB?",
);

// ─────────────────────────────────────────────────────────────────────────────
// 2. UNKNOWN CONTEXT — the answer is NOT in the candidate context
// ─────────────────────────────────────────────────────────────────────────────
// The candidate context must not contain Kubernetes, yet the generic evidence
// must still be able to recover it. (Absence must never *block* a correction.)
const kube = run({ rawText: "What is cooper netties?", candidateContext: ctx("React", "Node.js") });
check(
  "unknown: cooper netties (Kubernetes absent from context) recovers Kubernetes",
  kube.correctedText,
  "What is Kubernetes?",
);
check(
  "unknown: no 'Kubernetes' in the context used",
  kube.correctedText.includes("Kubernetes"),
  true,
);

// ─────────────────────────────────────────────────────────────────────────────
// 3. NEGATIVE — must NOT over-correct
// ─────────────────────────────────────────────────────────────────────────────
check(
  "negative: spring water stays (common phrase)",
  run({ rawText: "What is spring water?", candidateContext: ctx("Spring Boot") }).correctedText,
  "What is spring water?",
);
check(
  "negative: how is spring water collected stays",
  run({
    rawText: "How is spring water collected?",
    candidateContext: ctx("Spring Boot"),
  }).correctedText,
  "How is spring water collected?",
);
check(
  "negative: capital of Japan stays",
  run({ rawText: "What is the capital of Japan?", candidateContext: ctx("Spring Boot") }).changed,
  false,
);
check(
  "negative: World Wide Web stays",
  run({ rawText: "Who invented the World Wide Web?", candidateContext: ctx("MongoDB") }).changed,
  false,
);
check(
  "negative: spring water changed flag",
  run({ rawText: "What is spring water?", candidateContext: ctx("Spring Boot") }).changed,
  false,
);

// ─────────────────────────────────────────────────────────────────────────────
// 4. AMBIGUOUS — do not force a correction
// ─────────────────────────────────────────────────────────────────────────────
check(
  "ambiguous: Tell me about Java stays",
  run({ rawText: "Tell me about Java.", candidateContext: ctx("React") }).changed,
  false,
);
// "React native" must not be collapsed into "React" — a different term is
// never acceptable here, and the plain casing difference is not worth forcing.
check(
  "ambiguous: React native is not collapsed to React",
  run({ rawText: "What is React native?", candidateContext: ctx("React") }).correctedText,
  "What is React native?",
);

// ─────────────────────────────────────────────────────────────────────────────
// 5. PHONETIC — noisy ASR-like inputs
// ─────────────────────────────────────────────────────────────────────────────
const PHONETIC: Array<[string, string, string[]]> = [
  ["What is spring boat?", "What is Spring Boot?", []],
  ["What is mongo dee?", "What is MongoDB?", []],
  ["What is post gray SQL?", "What is PostgreSQL?", []],
  ["Tell me about rabbit Q.", "Tell me about RabbitMQ.", []],
  ["Tell me about crick auction.", "Tell me about CricAuctionHub.", ["CricAuctionHub"]],
];
for (const [raw, expected, terms] of PHONETIC) {
  check(
    `phonetic: "${raw}"`,
    run({ rawText: raw, candidateContext: ctx(...terms) }).correctedText,
    expected,
  );
}
// Kubernetes spoken correctly must not be touched.
check(
  "phonetic: correct Kubernetes stays",
  run({ rawText: "What is Kubernetes?" }).changed,
  false,
);

// ─────────────────────────────────────────────────────────────────────────────
// 6. IDEMPOTENCY + NO-CORRECTION STABILITY
// ─────────────────────────────────────────────────────────────────────────────
const once = correctTranscript({
  rawText: "What is spring wood?",
  candidateContext: ctx("Spring Boot"),
});
const twice = correctTranscript({
  rawText: once.correctedText,
  candidateContext: ctx("Spring Boot"),
});
check("idempotent: second pass changes nothing", twice.correctedText, once.correctedText);
check("idempotent: second pass changed=false", twice.changed, false);

const clean = correctTranscript({ rawText: "What is Spring Boot?", candidateContext: ctx("Spring Boot") });
check("stable: clean transcript unchanged", clean.correctedText, "What is Spring Boot?");
check("stable: clean transcript changed=false", clean.changed, false);

// ─────────────────────────────────────────────────────────────────────────────
// 7. EDGE CASES — never crash, always return a usable object
// ─────────────────────────────────────────────────────────────────────────────
const EDGE = ["", "   ", "?!...", "ok", "a", "the", "??", "Wha...", "uh uh uh"];
for (const raw of EDGE) {
  let result: ReturnType<typeof run> | null = null;
  try {
    result = run({ rawText: raw });
  } catch (err) {
    fail++;
    failures.push(`edge: "${raw}" threw ${String(err)}`);
  }
  if (result) {
    check(`edge: "${raw}" rawText preserved`, result.rawText, raw);
  }
}

// Empty / non-alphabetic input must be a no-op.
check("edge: blank changed=false", run({ rawText: "   " }).changed, false);
check("edge: punctuation only changed=false", run({ rawText: "?!..." }).changed, false);

// ─────────────────────────────────────────────────────────────────────────────
// 8. ASR ALTERNATIVES — feed the engine's own hypotheses
// ─────────────────────────────────────────────────────────────────────────────
const withAlt = run({
  rawText: "What is cooper netties?",
  asrMetadata: { engine: "test", alternatives: ["What is Kubernetes?"] },
});
check("alternatives: n-best used", withAlt.correctedText, "What is Kubernetes?");

// ─────────────────────────────────────────────────────────────────────────────
// 9. FORMATTING NORMALIZATION is structural only
// ─────────────────────────────────────────────────────────────────────────────
check("formatting: collapses whitespace", normalizeFormatting("What   is  this ?"), "What is this?");
check("formatting: no semantic rewrite", normalizeFormatting("spring wood"), "spring wood");

// ─────────────────────────────────────────────────────────────────────────────
// 10. FINAL TEST SET — clean sentences must survive untouched (§61)
// ─────────────────────────────────────────────────────────────────────────────
const CLEAN = [
  "What is Spring Boot?",
  "Tell me about your CricAuctionHub project.",
  "What is dependency injection in Spring Boot?",
  "What is Kubernetes?",
  "What is the capital of Japan?",
  "And why?",
  "Suppose the application suddenly receives thousands of requests at the same time, how would you scale the backend?",
  "Okay, so suppose you have deployed the application and suddenly one of your services starts returning five hundred errors, how would you debug that?",
  "Explain how authentication works with JWT in a React frontend and Node.js backend.",
];
for (const raw of CLEAN) {
  const r = run({
    rawText: raw,
    candidateContext: ctx("Spring Boot", "CricAuctionHub", "MongoDB", "React"),
  });
  check(`clean stays unchanged: "${raw.slice(0, 40)}…"`, r.changed, false);
  check(`clean text preserved: "${raw.slice(0, 40)}…"`, r.correctedText, raw);
}

// Multiple corrections in one sentence.
check(
  "two corrections in one sentence",
  run({ rawText: "What is spring wood and mongo db?", candidateContext: ctx("Spring Boot") })
    .correctedText,
  "What is Spring Boot and MongoDB?",
);

// Unknown, weak evidence must PRESERVE the raw transcript (never guess).
check(
  "unknown weak evidence preserves raw",
  run({ rawText: "Blorp the quux plinth." }).changed,
  false,
);

// ─────────────────────────────────────────────────────────────────────────────
// 11. WER — corrected transcript must improve on raw (§53/§54)
// ─────────────────────────────────────────────────────────────────────────────
function wer(reference: string, hypothesis: string): number {
  const a = reference.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  const b = hypothesis.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    const curr = [j];
    for (let i = 1; i <= a.length; i++) {
      curr[i] = Math.min(
        prev[i] + 1,
        curr[i - 1] + 1,
        prev[i - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return a.length === 0 ? (b.length === 0 ? 0 : 1) : prev[a.length] / a.length;
}

const CORPUS: Array<{ ref: string; raw: string; terms: string[] }> = [
  { ref: "What is Spring Boot?", raw: "What is spring wood?", terms: ["Spring Boot"] },
  { ref: "What is Kubernetes?", raw: "What is cooper netties?", terms: [] },
  { ref: "What is MongoDB?", raw: "What is mongo db?", terms: [] },
  { ref: "What is PostgreSQL?", raw: "What is post gray SQL?", terms: [] },
  { ref: "Tell me about CricAuctionHub.", raw: "Tell me about crick auction.", terms: ["CricAuctionHub"] },
  { ref: "Tell me about RabbitMQ.", raw: "Tell me about rabbit Q.", terms: [] },
  { ref: "What is Spring Boot?", raw: "What is spring boat?", terms: ["Spring Boot"] },
];

let baseErrors = 0;
let correctedErrors = 0;
for (const row of CORPUS) {
  const out = run({ rawText: row.raw, candidateContext: ctx(...row.terms) }).correctedText;
  baseErrors += wer(row.ref, row.raw);
  correctedErrors += wer(row.ref, out);
}
check(
  `WER improves (raw ${(baseErrors / CORPUS.length).toFixed(3)} → corrected ${(correctedErrors / CORPUS.length).toFixed(3)})`,
  correctedErrors < baseErrors,
  true,
);
check("WER corrected is zero on the labeled corpus", correctedErrors, 0);

// ─────────────────────────────────────────────────────────────────────────────
// 12. PERFORMANCE — realistic interview sentence under budget
// ─────────────────────────────────────────────────────────────────────────────
const PERF_SENTENCE =
  "Suppose the application suddenly receives thousands of requests at the same time, how would you scale the backend?";
const perfStart = Date.now();
for (let i = 0; i < 200; i++) {
  run({ rawText: PERF_SENTENCE, candidateContext: ctx("Spring Boot", "MongoDB", "React") });
}
const perCall = (Date.now() - perfStart) / 200;
// Well under any perceptible delay for a live interview assistant; the manual
// hotkey is the real latency budget and this stage is a few milliseconds.
check(`perf: <= 15ms/transcript (actual ${perCall.toFixed(2)}ms)`, perCall <= 15, true);

// ─────────────────────────────────────────────────────────────────────────────
// 13. REGRESSION — the exact real-world false corrections (Phase 3)
// ─────────────────────────────────────────────────────────────────────────────
// A candidate profile that contains the offending terms. Context may BOOST a
// genuine match but must never be able to manufacture one.
const PROFILE = buildCandidateContext({
  resumeText:
    "EXPERIENCE\nSenior Software Engineer, Authentication platform. Spring Boot, Docker, Kubernetes, Microservices, MongoDB, Redis, Kafka, RabbitMQ, Terraform, REST API.",
});

// TEST 1 — "Explain docker" must NOT become "EXPERIENCE".
check(
  "TEST 1: 'Explain docker' is preserved (not EXPERIENCE)",
  run({ rawText: "Explain docker", candidateContext: PROFILE }).correctedText,
  "Explain docker",
);
check(
  "TEST 1b: 'Explain docker' reports no correction",
  run({ rawText: "Explain docker", candidateContext: PROFILE }).changed,
  false,
);

// TEST 2 — the deployment scenario must NOT become "...starts Authentication...".
const SCENARIO =
  "Your payment service starts failing immediately after a deployment. What would you check first?";
check(
  "TEST 2: payment-deployment scenario is preserved (not Authentication)",
  run({ rawText: SCENARIO, candidateContext: PROFILE }).correctedText,
  SCENARIO,
);

// TEST 3 — the strong normalization must still happen.
check(
  "TEST 3: 'What is rest api?' -> 'What is REST API?'",
  run({ rawText: "What is rest api?", candidateContext: PROFILE }).correctedText,
  "What is REST API?",
);

// TEST 4-9 — clean questions stay clean even with a loaded profile.
const CLEAN_WITH_PROFILE = [
  ["TEST 4", "What is Spring Boot?"],
  ["TEST 5", "Explain Docker."],
  ["TEST 6", "What is Kubernetes?"],
  ["TEST 7", "Why do we use MongoDB?"],
  ["TEST 8", "What is the difference between TCP and UDP?"],
  ["TEST 9", "Tell me about your project architecture."],
  ["TEST 10", "Your payment service starts failing immediately after deployment."],
];
for (const [name, raw] of CLEAN_WITH_PROFILE) {
  check(
    `${name}: "${raw.slice(0, 46)}…" unchanged`,
    run({ rawText: raw, candidateContext: PROFILE }).changed,
    false,
  );
  check(
    `${name}b: "${raw.slice(0, 46)}…" text preserved`,
    run({ rawText: raw, candidateContext: PROFILE }).correctedText,
    raw,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. PROPERTY / SAFETY — context can never act as a whitelist (Phase 4)
// ─────────────────────────────────────────────────────────────────────────────
// For every (span, soleContextTerm) pair below the only "evidence" is that the
// term exists in the candidate's profile. The engine must keep the raw text.
const CONTEXT_ONLY: Array<[string, string]> = [
  ["Explain docker", "EXPERIENCE"],
  ["starts failing immediately", "Authentication"],
  ["payment service", "Microservices"],
  ["Tell me about your project.", "Spring Boot"],
  ["How do you handle errors?", "Kubernetes"],
  ["deploy the application", "Terraform"],
];
for (const [raw, term] of CONTEXT_ONLY) {
  check(
    `safety: context alone cannot replace "${raw}" with ${term}`,
    run({ rawText: raw, candidateContext: ctx(term) }).correctedText,
    raw,
  );
}

// Weak phonetic + weak lexical + strong context must be rejected.
check(
  "safety: weak phonetic/lexical + strong context is rejected",
  run({ rawText: "failing immediately", candidateContext: ctx("Authentication") }).changed,
  false,
);
check(
  "safety: strong evidence still wins with the same profile",
  run({ rawText: "What is cooper netties?", candidateContext: PROFILE }).correctedText,
  "What is Kubernetes?",
);

// Ordinary English vocabulary is never swapped for a profile term.
const ORDINARY = [
  "We should start the work tomorrow.",
  "Can you explain the main difference?",
  "The service starts returning errors after a while.",
  "Please describe your previous role.",
];
for (const raw of ORDINARY) {
  check(
    `safety: ordinary English preserved: "${raw.slice(0, 40)}…"`,
    run({ rawText: raw, candidateContext: PROFILE }).correctedText,
    raw,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. UNKNOWN TOPICS — the engine must be topic-independent (Phase 5)
// ─────────────────────────────────────────────────────────────────────────────
const UNKNOWN = [
  "What is the capital of Japan?",
  "What is the difference between TCP and UDP?",
  "Who invented the World Wide Web?",
  "What is Terraform used for?",
  "What is Kubernetes?",
  "Can you explain the architecture?",
  "What is a REST API?",
  "What is the capital of France?",
  "How does photosynthesis work?",
];
for (const raw of UNKNOWN) {
  // With a profile full of RESUME terms — non-resume topics must be untouched.
  const r = run({ rawText: raw, candidateContext: PROFILE });
  check(
    `unknown topic preserved: "${raw}"`,
    r.changed,
    false,
  );
  check(
    `unknown topic text preserved: "${raw}"`,
    r.correctedText,
    raw,
  );
}
// "What is a REST API?" is already stylized and must survive as-is.
check(
  "unknown: stylized 'REST API' already-correct stays",
  run({ rawText: "What is a REST API?", candidateContext: PROFILE }).correctedText,
  "What is a REST API?",
);

// ─────────────────────────────────────────────────────────────────────────────
// 16. REAL-WORLD ASR REGRESSION (Phase 17)
// ─────────────────────────────────────────────────────────────────────────────
// Sixteen correctly-spelled spoken questions. The contract is simple: if the
// RAW transcript is already correct, the CORRECTED transcript must stay the
// same. A profile loaded with resume terms is used to prove context cannot
// pull any of them off-course.
const SPOKEN = [
  "What is Spring Boot?",
  "Explain Docker.",
  "What is a REST API?",
  "What is dependency injection in Spring Boot?",
  "What is the difference between RabbitMQ and Kafka?",
  "How does JWT authentication work?",
  "What is the difference between horizontal scaling and vertical scaling?",
  "What is the role of Redis in a backend application?",
  "Suppose your application suddenly receives thousands of requests at the same time. How would you scale the backend?",
  "One of your microservices is returning 500 errors in production. How would you investigate the issue?",
  "Your payment service starts failing immediately after deployment. What would you check first?",
  "Why did you choose MongoDB instead of a relational database?",
  "What is Kubernetes?",
  "What is Terraform used for?",
  "What is the capital of Japan?",
  "What is the difference between TCP and UDP?",
];
for (const raw of SPOKEN) {
  const r = run({ rawText: raw, candidateContext: PROFILE });
  check(`spoken (already correct) unchanged: "${raw.slice(0, 52)}…"`, r.changed, false);
  check(`spoken (already correct) preserved: "${raw.slice(0, 52)}…"`, r.correctedText, raw);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
