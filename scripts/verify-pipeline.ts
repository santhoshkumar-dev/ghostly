/**
 * TEMPORARY verification harness (deleted after the run).
 *
 * Covers the question gate, the transcript-quality layer, the output validator
 * and the new prompt structure. Pure functions only — no audio, no network.
 */
import {
  analyseUtterance,
  buildInterviewSystemPrompt,
  buildInterviewUserPrompt,
  evaluateInterviewTurn,
  isDuplicateSubmit,
  isWaitResponse,
  normalizeTurn,
  turnSignature,
  type InterviewTurn,
} from "../src/lib/interviewAgent";
import { assessTranscriptQuality } from "../src/lib/transcriptQuality";
import { validateAnswerOutput } from "../src/lib/outputValidation";
import { normalizeTechnicalTerms } from "../src/lib/normalization";
import {
  OPENROUTER_FREE_MODEL,
  isOpenRouterFreeModel,
  parseOpenRouterEvent,
} from "../src/lib/ai/openrouter";
import {
  getAudioLevel,
  pushAudioLevel,
  resetAudioStatus,
  resolveAudioState,
  setAudioStatus,
  getAudioStatusSnapshot,
} from "../src/lib/audioStatus";
import {
  INTERVIEW_PROVIDER_ORDER,
  OPTIONAL_PROVIDER_ORDER,
  ALL_INTERVIEW_PROVIDERS,
  primaryInterviewProvider,
  describeProviderChain,
  normalizeProviderOrder,
} from "../src/lib/providerDiagnostics";
import { isProviderName } from "../src/lib/ai";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

const turn = (text: string, interim?: string): InterviewTurn => ({
  finals: [{ source: "system", text }],
  interim: interim ? { source: "system", text: interim } : null,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. GATE — required legitimate interview questions must be ANSWERED
// ─────────────────────────────────────────────────────────────────────────────
const MUST_ANSWER = [
  "Can you explain the difference between SQL and NoSQL?",
  "What is the Virtual DOM?",
  "Why did you choose Java for this project?",
  "Tell me about your project.",
  "How would you design a URL shortener?",
  "Can you walk me through your authentication flow?",
  "Why should we hire you?",
  // topic-agnostic checks
  "What is a closure?",
  "How would you solve this problem?",
  "What is the time complexity?",
  "How does JWT authentication work?",
  "Explain your project architecture.",
  "What challenges did you face?",
  "And why?",
  "What would you change?",
  "Can you explain that further?",
  // short / declarative interview requests
  "Difference between SQL and NoSQL.",
  "Tell me about dependency injection.",
  "Your experience with React?",
  // short follow-ups must NOT be over-rejected
  "Tell me about yourself.",
  "Explain the CAP theorem.",
  "What is polymorphism?",
  "And why not?",
];

for (const q of MUST_ANSWER) {
  check(
    `gate answers: "${q}"`,
    evaluateInterviewTurn(turn(q)).action,
    "answer",
  );
}

// The interviewer speaking over the candidate's question => WAIT.
check(
  "interim present => wait",
  evaluateInterviewTurn(turn("What is the CAP theorem?", "and how does that")).action,
  "wait",
);

// ─────────────────────────────────────────────────────────────────────────────
// 2. GATE — must WAIT
// ─────────────────────────────────────────────────────────────────────────────
const MUST_WAIT = [
  "Okay... yes... right...",
  "thanks",
  "sounds good",
  "sure",
  "I have worked with Node.js and recently",
  "Can you explain",
  "Let me walk you through the problem",
  "I have seen this before in a similar system",
];

for (const q of MUST_WAIT) {
  check(`gate waits: "${q}"`, evaluateInterviewTurn(turn(q)).action, "wait");
}

check(
  "candidate speech => wait",
  evaluateInterviewTurn({
    finals: [
      { source: "system", text: "What is the CAP theorem?" },
      { source: "mic", text: "I would pick consistency here" },
    ],
    interim: null,
  }).action,
  "wait",
);

// ─────────────────────────────────────────────────────────────────────────────
// 3. TRANSCRIPT QUALITY — structural ASR artefacts must not become questions
// ─────────────────────────────────────────────────────────────────────────────
for (const junk of [
  "(no speech recognised)",
  "(no speech recognized)",
  "[BLANK_AUDIO]",
  "(silence)",
  "Mustam a land or mustam a land",
  "the the the the the the",
]) {
  check(
    `artefact rejected: "${junk}"`,
    assessTranscriptQuality(junk).ok,
    false,
  );
  check(
    `artefact => gate waits: "${junk}"`,
    evaluateInterviewTurn(turn(junk)).action,
    "wait",
  );
}

// Real questions must survive the artefact layer untouched.
for (const q of ["What is your trade on?", "Can you explain that again?"]) {
  check(`artefact layer allows: "${q}"`, assessTranscriptQuality(q).ok, true);
  check(
    `artefact layer keeps gate: "${q}"`,
    evaluateInterviewTurn(turn(q)).action,
    "answer",
  );
}

// A genuine repetition of two DIFFERENT phrases must not be flagged.
check(
  "different halves are not a doubled phrase",
  assessTranscriptQuality(
    "I worked at Google and I worked at Microsoft",
  ).ok,
  true,
);

// ─────────────────────────────────────────────────────────────────────────────
// 4. OUTPUT VALIDATOR — degenerate output rejected
// ─────────────────────────────────────────────────────────────────────────────
const REJECT: Array<[string, string]> = [
  ["Previously mentioned interview questions or requests", ""],
  ["# Latest interviewer utterance", "What is the CAP theorem?"],
  ["# Earlier conversation", "What is the CAP theorem?"],
  ["# Your earlier answers", "What is the CAP theorem?"],
  ["Now do the following: if the latest interviewer utterance", "Explain closures."],
  ["<<<LATEST_QUESTION>>>", "Explain closures."],
  ["<<<END_PREVIOUS_ANSWERS>>>", "Explain closures."],
  ["**Latest interviewer utterance**", "Explain closures."],
  ["## Analysis", "Explain closures."],
  ["---", "Explain closures."],
  ["CAP theorem", "Explain the CAP theorem."],
  ["   ", "Explain closures."],
  ["", "Explain closures."],
];

for (const [answer, question] of REJECT) {
  check(
    `validator rejects: "${answer}"`,
    validateAnswerOutput(answer, { question }).ok,
    false,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. OUTPUT VALIDATOR — legitimate short answers MUST survive
// ─────────────────────────────────────────────────────────────────────────────
const ACCEPT = [
  "Yes.",
  "No.",
  "Yes, I have.",
  "It's mainly used for dependency injection.",
  "Because it is immutable.",
  "Yes I have",
  "It's mainly used for dependency injection",
  "Yes",
  "No",
  "Correct",
  "Absolutely",
  "I would pick consistency and availability, and accept eventual consistency for the write path.",
  "It depends on the isolation level; under read committed you can still see phantoms.",
  "We used Redis for the rate limiter and Postgres as the source of truth.",
  "Because the interviewer changed the default output device mid-interview.",
  "Polymorphism lets you program to an interface rather than a concrete type.",
];

for (const answer of ACCEPT) {
  check(
    `validator accepts: "${answer}"`,
    validateAnswerOutput(answer, { question: "Why should we hire you?" }).ok,
    true,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. WAIT detection
// ─────────────────────────────────────────────────────────────────────────────
for (const w of ["WAIT", "wait", "WAIT.", "**WAIT**", '"WAIT"', "WAIT — no clear question"]) {
  check(`isWaitResponse: "${w}"`, isWaitResponse(w), true);
}
for (const w of ["Yes.", "No, it does not.", "Wait, let me think about that."]) {
  check(`isWaitResponse false: "${w}"`, isWaitResponse(w), false);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. NORMALIZATION — corrections only, still idempotent
// ─────────────────────────────────────────────────────────────────────────────
const NORMALIZE: Array<[string, string]> = [
  ["what is virtual down", "what is Virtual DOM"],
  ["post grass", "PostgreSQL"],
  ["spring boat", "Spring Boot"],
  ["mongo dee", "MongoDB"],
  ["node jay ess", "Node.js"],
  ["rest ape", "REST API"],
  ["use eh-fekt", "useEffect"],
  ["what is your trade on", "what is your trade on"],
  ["i rendered the component", "i rendered the component"],
  ["the state of hooks", "the state of hooks"],
];
for (const [raw, expected] of NORMALIZE) {
  check(`normalize: "${raw}"`, normalizeTechnicalTerms(raw), expected);
}
check(
  "normalize is idempotent",
  normalizeTechnicalTerms(normalizeTechnicalTerms("what is virtual down")),
  "what is Virtual DOM",
);

// ─────────────────────────────────────────────────────────────────────────────
// 8. PROMPT STRUCTURE — neutral delimiters, no Markdown headings
// ─────────────────────────────────────────────────────────────────────────────
const t: InterviewTurn = {
  finals: [
    { source: "system", text: "Can you explain the difference between SQL and NoSQL?" },
    { source: "mic", text: "I would start with consistency" },
    { source: "system", text: "Why is that?" },
  ],
  interim: null,
};
const userPrompt = buildInterviewUserPrompt(t, {
  questionIndex: 2,
  previousAnswers: ["SQL is relational, NoSQL is not."],
});

for (const marker of [
  "<<<LATEST_QUESTION>>>",
  "<<<END_LATEST_QUESTION>>>",
  "<<<BACKGROUND>>>",
  "<<<END_BACKGROUND>>>",
  "<<<PREVIOUS_ANSWERS>>>",
  "<<<END_PREVIOUS_ANSWERS>>>",
]) {
  check(`prompt has ${marker}`, userPrompt.includes(marker), true);
}
check(
  "prompt has no Markdown headings",
  /^#{1,6}\s/m.test(userPrompt),
  false,
);
check(
  "prompt does not leak candidate profile",
  buildInterviewUserPrompt(t, { questionIndex: 2 }).includes("## Company"),
  false,
);

const sys = buildInterviewSystemPrompt({ resumeText: "SECRET RESUME" });
check("system prompt carries the profile", sys.includes("SECRET RESUME"), true);
check("user prompt never carries the profile", userPrompt.includes("SECRET RESUME"), false);

// ─────────────────────────────────────────────────────────────────────────────
// 9. Turn merging, signature and duplicate guard
// ─────────────────────────────────────────────────────────────────────────────
const split: InterviewTurn = {
  finals: [
    { source: "system", text: "Can you explain" },
    { source: "system", text: "the CAP theorem" },
  ],
  interim: null,
};
check("fragments merge", normalizeTurn(split).finals.length, 1);

const followUp: InterviewTurn = {
  finals: [
    { source: "system", text: "What is the CAP theorem?" },
    { source: "system", text: "And why?" },
  ],
  interim: null,
};
check("follow-up stays separate", normalizeTurn(followUp).finals.length, 2);

check(
  "duplicate in-flight is blocked",
  isDuplicateSubmit({ signature: turnSignature(split), status: "in-flight" }, turnSignature(split)),
  true,
);
check(
  "duplicate ok is blocked",
  isDuplicateSubmit({ signature: turnSignature(split), status: "ok" }, turnSignature(split)),
  true,
);
check(
  "failed run is re-submittable",
  isDuplicateSubmit({ signature: turnSignature(split), status: "failed" }, turnSignature(split)),
  false,
);
check(
  "different turn is not a duplicate",
  isDuplicateSubmit({ signature: turnSignature(split), status: "ok" }, turnSignature(followUp)),
  false,
);

check("analyse: filler", analyseUtterance("okay").kind, "wait");
check("analyse: question", analyseUtterance("What is a closure?").kind, "question");

// ─────────────────────────────────────────────────────────────────────────────
// 10. SHORT IMPERATIVE REQUESTS (topic-agnostic, no whitelist, no min-word rule)
// ─────────────────────────────────────────────────────────────────────────────
const SHORT_REQUESTS = [
  "Explain Docker",
  "What is Docker?",
  "Explain Spring Boot",
  "Why Java?",
  "And why?",
  "Difference between SQL and NoSQL.",
  "Tell me about yourself.",
  "What about your project?",
  "Your experience with React?",
  // unexpected / unrelated topics must behave identically
  "What is the capital of Japan?",
  "Who invented the World Wide Web?",
  "Explain Kubernetes",
  "Describe your migration",
  "Tell me about a difficult bug.",
];
for (const q of SHORT_REQUESTS) {
  check(`gate answers short request: "${q}"`, evaluateInterviewTurn(turn(q)).action, "answer");
}

// Structural request verbs + a real question must NOT be treated as a topic list.
check(
  "unknown imperative verb is still WAIT (no request shape)",
  evaluateInterviewTurn(turn("Blorp the quux")).action,
  "wait",
);
// Resume questions with no technology keywords at all.
for (const q of [
  "Tell me about the second project on your resume.",
  "What did you personally contribute?",
  "How did you deploy it?",
  "What challenges did you face?",
]) {
  check(`gate answers resume question: "${q}"`, evaluateInterviewTurn(turn(q)).action, "answer");
}
// Genuine garbage that must NOT become a question.
for (const q of ["An external data.", "Hmm, international problem."]) {
  check(`gate waits on narration: "${q}"`, evaluateInterviewTurn(turn(q)).action, "wait");
}
// Mishearings that LOOK like questions must still be answered — the gate must
// not blacklist unfamiliar words to suppress them.
for (const q of [
  "What is spring wood?",
  "What is this tape being?",
  "Why did the rest appear?",
]) {
  check(`gate does not blacklist odd wording: "${q}"`, evaluateInterviewTurn(turn(q)).action, "answer");
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. PROVIDER ROUTING — OpenRouter free router + chain construction
// ─────────────────────────────────────────────────────────────────────────────
check("openrouter/free is the router id", OPENROUTER_FREE_MODEL, "openrouter/free");
check("free router detected", isOpenRouterFreeModel("openrouter/free"), true);
check("a fixed model is not the router", isOpenRouterFreeModel("openai/gpt-oss-120b"), false);

// OpenRouter reports the model it actually served in the top-level `model` field.
const freeChunk = parseOpenRouterEvent({
  model: "upstage/solar-pro-3:free",
  provider: "upstage",
  choices: [{ delta: { content: "hi" } }],
});
check("resolved model parsed", freeChunk.model, "upstage/solar-pro-3:free");
check("backend parsed", freeChunk.provider, "upstage");
check("content parsed", freeChunk.text, "hi");
check("no finish reason yet", freeChunk.finishReason, undefined);

const doneChunk = parseOpenRouterEvent({
  model: "upstage/solar-pro-3:free",
  choices: [{ delta: {}, finish_reason: "stop" }],
});
check("finish reason parsed", doneChunk.finishReason, "stop");

const errChunk = parseOpenRouterEvent({ error: { message: "no free model available" } });
check("inline error surfaced", errChunk.error, "no free model available");

// Chain construction must only include providers that actually have a key.
const buildChain = (
  order: string[],
  keys: Record<string, string>,
  models: Record<string, string>,
) =>
  order
    .filter((p) => (keys[p] ?? "").trim())
    .map((p) => ({
      provider: p,
      model: models[p],
      fallbackModels:
        p === "openrouter" && isOpenRouterFreeModel(models[p])
          ? []
          : [`${p}-alt`],
    }));

check(
  "chain includes only providers with keys",
  buildChain(
    ["openrouter", "groq", "gemini"],
    { openrouter: "k1", groq: "", gemini: "k3" },
    { openrouter: OPENROUTER_FREE_MODEL, groq: "llama-3.3-70b-versatile", gemini: "gemini-2.5-flash" },
  ).map((a) => a.provider),
  ["openrouter", "gemini"],
);
check(
  "openrouter is first when configured",
  buildChain(
    ["openrouter", "groq", "gemini"],
    { openrouter: "k1", groq: "k2", gemini: "k3" },
    { openrouter: OPENROUTER_FREE_MODEL, groq: "g", gemini: "gemini-2.5-flash" },
  ).map((a) => a.provider),
  ["openrouter", "groq", "gemini"],
);
check(
  "free router never gets a catalog-wide fallback",
  buildChain(["openrouter"], { openrouter: "k" }, { openrouter: OPENROUTER_FREE_MODEL })[0]
    .fallbackModels.length,
  0,
);
check(
  "a fixed model still gets a fallback",
  buildChain(["openrouter"], { openrouter: "k" }, { openrouter: "openai/gpt-oss-120b" })[0]
    .fallbackModels.length,
  1,
);

// ─────────────────────────────────────────────────────────────────────────────
// 12. AUDIO STATUS — state machine + smoothing (no raw RMS exposed)
// ─────────────────────────────────────────────────────────────────────────────
resetAudioStatus();
check("initial state is idle", getAudioStatusSnapshot().state, "idle");

// The time-dependent branch is tested through the pure resolver.
check(
  "sustained silence => no-audio",
  resolveAudioState({ rms: 0, speaking: false, silentForMs: 3000, current: "listening" }),
  "no-audio",
);
check(
  "brief silence stays listening",
  resolveAudioState({ rms: 0, speaking: false, silentForMs: 100, current: "listening" }),
  "listening",
);
check(
  "silence is never an error",
  resolveAudioState({ rms: 0, speaking: false, silentForMs: 3000, current: "listening" }) === "error",
  false,
);
check(
  "speech wins over silence timer",
  resolveAudioState({ rms: 0, speaking: true, silentForMs: 9000, current: "no-audio" }),
  "speech",
);
check(
  "transcribing is not clobbered by a level sample",
  resolveAudioState({ rms: 0.01, speaking: false, silentForMs: 0, current: "transcribing" }),
  "transcribing",
);
check(
  "disconnected is sticky",
  resolveAudioState({ rms: 0.2, speaking: true, silentForMs: 0, current: "disconnected" }),
  "disconnected",
);
check(
  "error is sticky",
  resolveAudioState({ rms: 0.2, speaking: true, silentForMs: 0, current: "error" }),
  "error",
);

// Live signal + meter.
resetAudioStatus();
check("initial state is idle", getAudioStatusSnapshot().state, "idle");
pushAudioLevel(0.05, true);
check("speech => speech state", getAudioStatusSnapshot().state, "speech");
check("level rose above zero", getAudioLevel() > 0, true);
pushAudioLevel(10, true);
check("level never exceeds 100", getAudioLevel() <= 100, true);
for (let i = 0; i < 400; i++) pushAudioLevel(0, false);
check("level never goes negative", getAudioLevel() >= 0, true);

// A disconnected capture must not be silently reset by later level samples.
setAudioStatus("disconnected", "device removed");
pushAudioLevel(0.3, true);
check("disconnect survives a late level sample", getAudioStatusSnapshot().state, "disconnected");
check("disconnect detail preserved", getAudioStatusSnapshot().detail, "device removed");

resetAudioStatus();

// ─────────────────────────────────────────────────────────────────────────────
// 13. THE INTERVIEW CHAIN — Gemini → OpenRouter, with Groq opt-in only.
//
// The Local Qwen fallback and NVIDIA NIM were REMOVED entirely (provider, model,
// IPC and UI), so the default chain is exactly two legs. Anything in the chain
// is waited on by every question, so nothing that 404s may be a default leg.
// ─────────────────────────────────────────────────────────────────────────────
check(
  "the default chain is Gemini, then OpenRouter",
  INTERVIEW_PROVIDER_ORDER,
  ["gemini", "openrouter"],
);
check(
  "Groq remains integrated as the ONLY optional provider",
  OPTIONAL_PROVIDER_ORDER,
  ["groq"],
);
check(
  "every provider is reported, default chain first",
  ALL_INTERVIEW_PROVIDERS,
  ["gemini", "openrouter", "groq"],
);
check("the declared primary is Gemini", primaryInterviewProvider(), "gemini");

// The removed providers must not merely be out of the chain — they must not
// exist in the registry at all, so no migration, panel or run can resurrect them.
check("local is not a provider any more", isProviderName("local"), false);
check("nvidia is not a provider any more", isProviderName("nvidia"), false);
check(
  "the removed providers are absent from the report",
  (ALL_INTERVIEW_PROVIDERS as string[]).filter((p) => p === "local" || p === "nvidia"),
  [],
);

check(
  "Groq is NOT in the default chain",
  INTERVIEW_PROVIDER_ORDER.includes("groq"),
  false,
);

// A store written by an older build, which force-added the optional providers.
// The migration in App.tsx strips them BEFORE normalising; the normalizer alone
// keeps whatever the user deliberately had.
check(
  "a chain with only default providers stays exactly as it is",
  normalizeProviderOrder(["gemini", "openrouter"], {
    gemini: "k",
    openrouter: "k",
  }),
  ["gemini", "openrouter"],
);
check(
  "an empty/absent saved order yields the bare default chain",
  normalizeProviderOrder(undefined, { gemini: "k" }),
  ["gemini", "openrouter"],
);
// A store written before the removal still contains local/nvidia. The
// normalizer must strip both, or an old install keeps waiting on dead legs.
check(
  "a legacy store containing local/nvidia is stripped of both",
  normalizeProviderOrder(["local", "nvidia", "gemini", "openrouter"], {
    gemini: "k",
    openrouter: "k",
  }),
  ["gemini", "openrouter"],
);

// A deliberate opt-in must survive a restart — that is what makes "optional"
// mean opt-in rather than "removed".
check(
  "an opted-in optional provider is preserved, after the default chain",
  normalizeProviderOrder(["groq", "gemini", "openrouter"], {
    gemini: "k",
    openrouter: "k",
    groq: "k",
  }),
  ["gemini", "openrouter", "groq"],
);
check(
  "an opted-in optional provider with no key is still preserved",
  normalizeProviderOrder(["groq", "gemini", "openrouter"], { gemini: "k" }),
  ["gemini", "openrouter", "groq"],
);

// An old store's order is rewritten so Gemini leads — a persisted OpenRouter-
// first chain must not keep steering the interview.
check(
  "a legacy OpenRouter-first chain is rewritten to Gemini-first",
  normalizeProviderOrder(["openrouter", "gemini"], {
    openrouter: "k-or",
    gemini: "k-gem",
  }),
  ["gemini", "openrouter"],
);

// Unknown providers are dropped; anything else valid the user had is kept.
check(
  "unknown providers dropped, known ones preserved",
  normalizeProviderOrder(["whisper", "openai", "gemini"], { gemini: "k" }),
  ["gemini", "openrouter", "openai"],
);

// ── Diagnostics must explain WHY a provider was skipped ───────────────────
const full = describeProviderChain({
  providerOrder: ["gemini", "openrouter"],
  models: {
    gemini: "gemini-2.5-flash",
    openrouter: OPENROUTER_FREE_MODEL,
    groq: "openai/gpt-oss-120b",
  },
  apiKeys: { gemini: "k", openrouter: "k", groq: "k" },
});

check(
  "configured chain is Gemini then OpenRouter",
  full.configured,
  "gemini(gemini-2.5-flash) → openrouter(openrouter/free)",
);
check(
  "resolved chain contains only providers with keys",
  full.resolved,
  "gemini(gemini-2.5-flash) → openrouter(openrouter/free)",
);
check("the reported primary is Gemini", full.primary, "gemini");
const byName = Object.fromEntries(full.status.map((s) => [s.provider, s]));
check("gemini ready", byName.gemini.availability, "ready");
check("openrouter ready", byName.openrouter.availability, "ready");
// Groq has a key but is out of the chain. That must be distinguishable from a
// provider that is merely missing a key, or the log will not explain the wait.
check("groq is OPTIONAL, not merely disabled", byName.groq.availability, "optional");
check(
  "optional reason is explicit",
  byName.groq.detail,
  "optional — add it in Settings to enable it",
);
// Three providers are reported: the two default-chain legs plus the optional
// one. The removed providers (local, nvidia) appear nowhere in this list.
check("every provider appears in the log lines", full.status.length, 3);
check(
  "optional providers are reported in the log",
  full.lines.some((l) => l.includes("GROQ") && l.includes("optional")),
  true,
);

// The required log line, verbatim.
check("the primary line is the documented one", full.lines[0], "[AI] primary provider=gemini");
check(
  "log states the configured chain",
  full.lines[1].startsWith("[AI] configured provider chain:"),
  true,
);
check(
  "log states the resolved chain",
  full.lines[2].startsWith("[AI] resolved interview provider chain:"),
  true,
);

// The primary must be a CONFIGURATION fact: with no keys at all it must still
// say Gemini, otherwise the user's next action is to add a key to the wrong
// provider.
{
  const noGeminiKey = describeProviderChain({
    providerOrder: ["gemini", "openrouter"],
    models: {},
    apiKeys: {},
  });
  check(
    "primary is still Gemini with no keys configured",
    noGeminiKey.primary,
    "gemini",
  );
  check(
    "and the required log line says so",
    noGeminiKey.lines[0],
    "[AI] primary provider=gemini",
  );
  check(
    "no keys => resolved chain says none",
    noGeminiKey.resolved,
    "(none — no provider has an API key)",
  );
  check(
    "a keyed-but-disabled default provider is missing-api-key, not optional",
    Object.fromEntries(
      noGeminiKey.status.map((s) => [s.provider, s.availability]),
    ).gemini,
    "missing-api-key",
  );
}

// A provider with a key but removed from the chain by the user (as opposed to
// never being default) is "not in the configured chain", not "optional".
const offChain = describeProviderChain({
  providerOrder: ["gemini"],
  models: {
    gemini: "gemini-2.5-flash",
    openrouter: OPENROUTER_FREE_MODEL,
    groq: "openai/gpt-oss-120b",
  },
  apiKeys: { gemini: "k", openrouter: "k", groq: "k" },
});
const offByName = Object.fromEntries(offChain.status.map((s) => [s.provider, s]));
check(
  "a default provider the user removed => not-in-chain",
  offByName.openrouter.availability,
  "not-in-chain",
);
check(
  "not-in-chain reason is explicit",
  offByName.openrouter.detail,
  "not in the configured chain",
);
check(
  "an optional provider is still 'optional' when out of the chain",
  offByName.groq.availability,
  "optional",
);

// ─────────────────────────────────────────────────────────────────────────────
// 14. THE REMOVED FEATURES CANNOT COME BACK THROUGH A HIDDEN STARTUP PATH
//
// Deleting a module is only half the job: a stale import in main.ts, a leftover
// bridge method or an auto-discovered model file would resurrect the feature at
// runtime while every source file "looks" deleted. So this checks the files,
// the startup wiring and the bridge — the three places a ghost feature hides.
// ─────────────────────────────────────────────────────────────────────────────
{
  const root = process.cwd();
  const read = (p: string) => readFileSync(path.join(root, p), "utf8");
  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const code = (p: string) => strip(read(p));

  // (a) Every deleted module stays deleted.
  const REMOVED = [
    "src/lib/ai/local.ts",
    "src/lib/ai/localBridge.ts",
    "src/lib/ai/nvidia.ts",
    "src/lib/ai/nvidiaBridge.ts",
    "src/lib/localModel.ts",
    "electron/localAi.ts",
    "electron/localModel.ts",
    "electron/nvidiaAi.ts",
    "electron/liveScreen.ts",
    "electron/regionPicker.ts",
    "src/lib/liveScreenContext.ts",
    "src/components/LiveScreenPanel.tsx",
    "src/lib/interviewReport.ts",
    "src/components/InterviewReportPanel.tsx",
    "src/components/InterviewContext.tsx",
    "src/components/SessionContextChip.tsx",
    "src/components/ScreenCapturePanel.tsx",
  ];
  check(
    "every removed source file is really gone",
    REMOVED.filter((p) => existsSync(path.join(root, p))),
    [],
  );

  // (b) No startup wiring references one of them (comments stripped first —
  //     the codebase deliberately documents what was removed).
  const boot = [
    "electron/main.ts",
    "electron/ipc.ts",
    "electron/preload.ts",
    "electron/hotkeys.ts",
  ]
    .map(code)
    .join("\n");
  check(
    "no startup path imports or calls a removed feature",
    boot.match(/localAi|localModel|nvidiaAi|liveScreen|regionPicker|disposeLocalAi|initLiveScreen/gi) ?? [],
    [],
  );
  check(
    "no discovery/download of a local LLM model at boot",
    /localModelStatus|modelDownload\(|llamaServer|gguf/i.test(boot),
    false,
  );

  // (c) The bridge exposes no way to reach them either.
  const preloadSrc = read("electron/preload.ts");
  check(
    "the renderer cannot call a removed channel",
    /localModelStatus|nvidiaStatus|liveScreenStatus|interviewReport|readReportInputs/.test(
      preloadSrc,
    ),
    false,
  );
  check(
    "but the ONE capture path still exists end to end",
    /ghostly:capture-fullscreen/.test(read("electron/ipc.ts")) &&
      /ghostly:capture-fullscreen/.test(preloadSrc) &&
      /ghostly:capture-screen/.test(read("electron/hotkeys.ts")) &&
      /ghostly:capture-screen/.test(preloadSrc),
    true,
  );

  // (d) A store written before the Gemini cleanup cannot keep a 404ing model.
  const appSrc = code("src/App.tsx");
  check(
    "the boot migration retires every Gemini id that answered 404",
    ["gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-1.5-pro"].every((id) =>
      appSrc.includes(`"${id}"`),
    ),
    true,
  );
  check(
    "the shipped Gemini default is an id verified against the live API",
    /gemini: "gemini-2\.5-flash"/.test(read("electron/ipc.ts")),
    true,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}