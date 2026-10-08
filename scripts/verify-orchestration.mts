/**
 * Deterministic tests for the manual-hotkey answer orchestrator.
 *
 * Run: `npx tsx scripts/verify-orchestration.ts`
 *
 * Uses scripted fake providers (via the `resolveProvider` seam) so every timing
 * behaviour — hedge firing, hard-failure fast path, winner selection, loser
 * cancellation — is exercised without any network access.
 */
import {
  orchestrateAnswer,
  MAX_CONCURRENT_PROVIDERS,
  OPENROUTER_HEDGE_MS,
  FIRST_TOKEN_TIMEOUT_MS,
  TOTAL_PROVIDER_TIMEOUT_MS,
  type AttemptSpec,
} from "../src/lib/ai/orchestrator";
import { validateAnswerOutput } from "../src/lib/outputValidation";
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

// ── Scripted provider ──────────────────────────────────────────────────────
interface Script {
  /** ms before the first chunk (and therefore before any useful text). */
  firstChunkAfterMs?: number;
  /** ms to linger AFTER the last chunk, before the stream ends. */
  tailAfterLastChunkMs?: number;
  /** Chunks to yield. Default: a clearly valid spoken answer. */
  chunks?: string[];
  /**
   * ms to wait BETWEEN chunks, so a stream can be made to take longer than
   * the total budget while still producing text the whole time — the exact
   * shape of the observed OpenRouter "HTTP 200 + streaming text + timeout"
   * failure.
   */
  chunkDelayMs?: number;
  /** Throw after this many ms instead of streaming. */
  errorAfterMs?: number;
  errorMessage?: string;
  resolvedModel?: string;
  backend?: string;
}

const VALID_ANSWER =
  "Dependency injection is a design pattern where objects receive their collaborators rather than constructing them.";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}

interface Registry {
  registry: Record<string, AIProvider>;
  calls: string[];
  peakConcurrency: number;
  running: number;
}

function buildRegistry(scripts: Record<string, Script>): Registry {
  const reg: Registry = {
    registry: {},
    calls: [],
    peakConcurrency: 0,
    running: 0,
  };

  for (const [name, script] of Object.entries(scripts)) {
    reg.registry[name] = {
      name,
      listModels: () => [name],
      async *streamSolution(options: AIRequestOptions) {
        reg.calls.push(name);
        reg.running++;
        reg.peakConcurrency = Math.max(reg.peakConcurrency, reg.running);
        const signal = options.signal;
        const meta = options.meta!;
        try {
          if (script.errorAfterMs != null) {
            await sleep(script.errorAfterMs, signal);
            throw new Error(
              script.errorMessage ?? "HTTP 503 provider unavailable",
            );
          }
          if (script.firstChunkAfterMs) {
            meta.httpMs = script.firstChunkAfterMs;
            await sleep(script.firstChunkAfterMs, signal);
          }
          const chunks = script.chunks ?? [VALID_ANSWER];
          for (let i = 0; i < chunks.length; i++) {
            if (i > 0 && script.chunkDelayMs) {
              await sleep(script.chunkDelayMs, signal);
            }
            yield chunks[i];
          }
          if (script.tailAfterLastChunkMs) {
            await sleep(script.tailAfterLastChunkMs, signal);
          }
          meta.finishReason = "stop";
          if (script.resolvedModel) meta.model = script.resolvedModel;
          if (script.backend) meta.provider = script.backend;
        } finally {
          reg.running--;
        }
      },
    };
  }

  return reg;
}

function specs(...providers: string[]): AttemptSpec[] {
  return providers.map((provider) => ({
    provider: provider as AttemptSpec["provider"],
    model: `${provider}-model`,
    apiKey: `key-for-${provider}`,
    maxTokens: 512,
  }));
}

const realisticValidate = (text: string) => {
  if (/^wait[.!]?$/i.test(text.trim())) return { ok: false, reason: "wait" };
  return validateAnswerOutput(text, {});
};

async function run(
  reg: Registry,
  attempts: AttemptSpec[],
  opts: {
    hedgeMs?: number;
    signal?: AbortSignal;
    logs?: string[];
    firstTokenMs?: number;
    totalMs?: number;
    settleGraceMs?: number;
    onStatus?: (s: any) => void;
  } = {},
) {
  return orchestrateAnswer({
    attempts,
    prompt: "question",
    signal: opts.signal ?? new AbortController().signal,
    hedgeMs: opts.hedgeMs ?? 120,
    firstTokenMs: opts.firstTokenMs,
    totalMs: opts.totalMs,
    settleGraceMs: opts.settleGraceMs,
    onStatus: opts.onStatus,
    validate: realisticValidate,
    log: (line) => opts.logs?.push(line),
    resolveProvider: (name) =>
      reg.registry[name] ?? {
        name,
        listModels: () => [name],
        // eslint-disable-next-line require-yield
        async *streamSolution() {
          throw new Error(`unregistered provider ${name}`);
        },
      },
  });
}

// ── 1. OpenRouter succeeds well before the hedge ───────────────────────────
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 10, tailAfterLastChunkMs: 20 },
    groq: { firstChunkAfterMs: 5 },
    nvidia: {},
    gemini: {},
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"));
  check("1 only openrouter called", reg.calls, ["openrouter"]);
  check("1 openrouter wins", res.provider, "openrouter");
  check("1 not hedged", res.hedged, false);
  check("1 answer returned", res.text, VALID_ANSWER);
}

// ── 2. First useful text BEFORE the hedge, total time AFTER it ─────────────
// This is the case the old 4500ms-total-time rule would have wrongly failed over.
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 20, tailAfterLastChunkMs: 400 },
    groq: { firstChunkAfterMs: 5 },
    nvidia: {},
    gemini: {},
  });
  const logs: string[] = [];
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 100,
    logs,
  });
  check("2 healthy stream is never hedged", res.hedged, false);
  check("2 only openrouter called", reg.calls, ["openrouter"]);
  check("2 openrouter wins", res.provider, "openrouter");
  check(
    "2 hedge was disarmed on first text",
    logs.some((l) => l.includes("hedge disarmed")),
    true,
  );
  check(
    "2 total exceeded the hedge window but did not matter",
    res.attemptsStarted[0].totalMs! > 100,
    true,
  );
}

// ── 3. No useful text within the hedge window → second provider starts ─────
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 600, tailAfterLastChunkMs: 20 },
    groq: { firstChunkAfterMs: 10 },
    nvidia: {},
    gemini: {},
  });
  const logs: string[] = [];
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 80,
    logs,
  });
  check("3 both providers called", reg.calls, ["openrouter", "groq"]);
  check("3 hedged", res.hedged, true);
  check("3 concurrency capped at 2", reg.peakConcurrency <= MAX_CONCURRENT_PROVIDERS, true);
  check(
    "3 hedge is logged with the window",
    logs.some((l) => l.includes("hedge: no useful text after 80ms")),
    true,
  );
}

// ── 4. The hedge provider wins → the original is cancelled ────────────────
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 400, tailAfterLastChunkMs: 20 },
    groq: { firstChunkAfterMs: 10 },
    nvidia: {},
    gemini: {},
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 60,
  });
  check("4 groq wins", res.provider, "groq");
  check("4 openrouter cancelled by winner", res.attemptsStarted[0].outcome, "cancelled_by_winner");
  check("4 nvidia never started", reg.calls.includes("nvidia"), false);
}

// ── 5. The original wins even though a hedge was started → hedge cancelled ──
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 200, tailAfterLastChunkMs: 10 },
    groq: { firstChunkAfterMs: 600, tailAfterLastChunkMs: 10 },
    nvidia: {},
    gemini: {},
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 60,
  });
  check("5 openrouter wins despite hedge", res.provider, "openrouter");
  check("5 hedged flag is set", res.hedged, true);
  check("5 groq cancelled by winner", res.attemptsStarted[1].outcome, "cancelled_by_winner");
}

// ── 6. Hard failure moves on IMMEDIATELY, not at the hedge timer ───────────
{
  const reg = buildRegistry({
    openrouter: { errorAfterMs: 15, errorMessage: "HTTP 429 rate limited" },
    groq: { firstChunkAfterMs: 10 },
    nvidia: {},
    gemini: {},
  });
  const t0 = Date.now();
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 5000, // a hedge window that would obviously have been waited out
  });
  const elapsed = Date.now() - t0;
  check("6 groq wins", res.provider, "groq");
  check("6 did not wait for the hedge window", elapsed < 1500, true);
  check("6 openrouter failed", res.attemptsStarted[0].outcome, "failed");
  check(
    "6 failure classified as http",
    res.attemptsStarted[0].failureReason,
    "http",
  );
}

// ── 7 & 8. Sequential exhaustion: openrouter → groq → nvidia → gemini ───────
{
  const reg = buildRegistry({
    openrouter: { errorAfterMs: 5 },
    groq: { errorAfterMs: 5 },
    nvidia: { errorAfterMs: 5 },
    gemini: { firstChunkAfterMs: 10 },
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 60,
  });
  check("7+8 all four attempted in order", reg.calls, [
    "openrouter",
    "groq",
    "nvidia",
    "gemini",
  ]);
  check("7+8 gemini wins", res.provider, "gemini");
  check("7+8 three failures recorded", res.failures.length, 3);
}
{
  // 7 in isolation: openrouter + groq fail → nvidia starts.
  const reg = buildRegistry({
    openrouter: { errorAfterMs: 5 },
    groq: { errorAfterMs: 5 },
    nvidia: { firstChunkAfterMs: 10 },
    gemini: {},
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 60,
  });
  check("7 nvidia is the third attempt", reg.calls, ["openrouter", "groq", "nvidia"]);
  check("7 nvidia wins", res.provider, "nvidia");
}
{
  // 8 in isolation: nvidia fails → gemini starts.
  const reg = buildRegistry({
    openrouter: { errorAfterMs: 5 },
    groq: { errorAfterMs: 5 },
    nvidia: { errorAfterMs: 5 },
    gemini: { firstChunkAfterMs: 10 },
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 60,
  });
  check("8 gemini is the fourth attempt", reg.calls.length, 4);
  check("8 gemini wins", res.provider, "gemini");
}

// ── 9. Everything fails → exactly one result, no winner, no answer ──────────
{
  const reg = buildRegistry({
    openrouter: { errorAfterMs: 5 },
    groq: { errorAfterMs: 5 },
    nvidia: { errorAfterMs: 5 },
    gemini: { errorAfterMs: 5 },
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 60,
  });
  check("9 no winner", res.provider, null);
  check("9 no text", res.text, "");
  check("9 no text is falsy", !!res.text, false);
  check("9 an error is reported", typeof res.error === "string" && res.error.length > 0, true);
  check("9 all four recorded", res.attemptsStarted.length, 4);
}

// ── 10. A partial stream that never completes yields no answer ─────────────
// Note the fragments are deliberately BELOW MEANINGFUL_CHARS, so the hedge
// correctly still fires and a second provider gets its chance. The partial
// text must never surface as an answer.
{
  const reg = buildRegistry({
    openrouter: {
      firstChunkAfterMs: 60,
      tailAfterLastChunkMs: 100000,
      chunks: ["Dep", "endency"],
    },
    groq: { firstChunkAfterMs: 5 },
    nvidia: {},
    gemini: {},
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 40,
  });
  check("10 hedge fired for a never-completing stream", res.hedged, true);
  check("10 the completed provider wins", res.provider, "groq");
  check("10 the partial text is not the answer", res.text, VALID_ANSWER);
  check(
    "10 the never-completing provider did not win",
    res.attemptsStarted[0].winner,
    false,
  );
  check(
    "10 hung provider cancelled",
    res.attemptsStarted[0].outcome,
    "cancelled_by_winner",
  );
}

// ── 11 & 12. Invalid / prompt-echo answers cannot win ───────────────────────
for (const [label, bad] of [
  ["11 prompt-label echo", "Previously mentioned interview questions or requests"],
  ["12 markdown heading echo", "# Latest interviewer utterance"],
  ["12 delimiter echo", "<<<LATEST_QUESTION>>>"],
] as const) {
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 10, chunks: [bad] },
    groq: { firstChunkAfterMs: 10 },
    nvidia: {},
    gemini: {},
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 60,
  });
  check(`${label} rejected`, res.provider, "groq");
  check(`${label} did not become the answer`, res.text === bad, false);
}

// ── 13. A new run cancels the previous one ──────────────────────────────────
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 10, tailAfterLastChunkMs: 100000 },
    groq: {},
    nvidia: {},
    gemini: {},
  });
  const ac = new AbortController();
  const promise = run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 60,
    signal: ac.signal,
  });
  setTimeout(() => ac.abort(), 30);
  const res = await promise;
  check("13 run reports aborted", res.aborted, true);
  check("13 no winner after abort", res.provider, null);
  check("13 no text after abort", res.text, "");
}

// ── 14. A stale provider that would have finished later is ignored ─────────
// OpenRouter's text only arrives at 80ms — long after Groq has already won at
// ~45ms and cancelled it. Its answer must never reach the caller.
{
  const reg = buildRegistry({
    openrouter: {
      firstChunkAfterMs: 80,
      tailAfterLastChunkMs: 10,
      chunks: ["This is a stale answer from OpenRouter."],
    },
    groq: {
      firstChunkAfterMs: 5,
      chunks: ["This is the winning answer from Groq."],
    },
    nvidia: {},
    gemini: {},
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 40,
  });
  check("14 winner text only", res.text, "This is the winning answer from Groq.");
  check("14 stale text never surfaces", res.text.includes("stale"), false);
  check(
    "14 stale provider was cancelled, not successful",
    res.attemptsStarted[0].outcome !== "success",
    true,
  );
  check(
    "14 exactly one winner flagged",
    res.attemptsStarted.filter((a) => a.winner).length,
    1,
  );
}

// ── 15. Duplicate completion cannot produce a duplicate answer ──────────────
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 10 },
    groq: { firstChunkAfterMs: 5 },
    nvidia: {},
    gemini: {},
  });
  const res = await run(reg, specs("openrouter", "groq", "nvidia", "gemini"), {
    hedgeMs: 60,
  });
  check(
    "15 exactly one winner across all attempts",
    res.attemptsStarted.filter((a) => a.winner).length,
    1,
  );
  check("15 single non-empty text", typeof res.text === "string" && res.text.length > 0, true);
}

// ── 16. The OpenRouter resolved model is preserved ──────────────────────────
{
  const reg = buildRegistry({
    openrouter: {
      firstChunkAfterMs: 10,
      resolvedModel: "upstage/solar-pro-3:free",
      backend: "upstage",
    },
    groq: {},
    nvidia: {},
    gemini: {},
  });
  const res = await run(reg, specs("openrouter", "groq"), { hedgeMs: 60 });
  check("16 resolved model surfaced", res.resolvedModel, "upstage/solar-pro-3:free");
  check("16 requested model retained", res.model, "openrouter-model");
  check("16 backend surfaced", res.backend, "upstage");
  check(
    "16 telemetry records the resolved model",
    res.attemptsStarted[0].resolvedModel,
    "upstage/solar-pro-3:free",
  );
}

// ── 17. Telemetry is emitted for every attempt ─────────────────────────────
// openrouter is slow enough to hedge, groq fails, nvidia wins — so every
// telemetry shape (winner + hedged loser + failed attempt) is exercised.
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 5000 },
    groq: { errorAfterMs: 5 },
    nvidia: { firstChunkAfterMs: 5 },
  });
  const logs: string[] = [];
  await run(reg, specs("openrouter", "groq", "nvidia"), {
    hedgeMs: 40,
    logs,
  });
  const summary = logs.find((l) => l.includes("nvidia/nvidia-model"));
  check("17 a summary line per attempt exists", !!summary, true);
  check("17 http timing logged", /http=\d+ms/.test(summary ?? ""), true);
  check("17 firstText timing logged", /firstText=\d+ms/.test(summary ?? ""), true);
  check("17 total timing logged", /total=\d+ms/.test(summary ?? ""), true);
  check("17 winner flag logged", /winner=true/.test(summary ?? ""), true);
  const failure = logs.find(
    (l) => l.includes("groq/groq-model") && l.includes("reason="),
  );
  check("17 failure reason logged", !!failure, true);
  check(
    "17 the hedged-and-losing attempt is marked",
    logs.some((l) => l.includes("openrouter/openrouter-model") && l.includes("cancelled")),
    true,
  );
}

// ── 18. No API key, prompt or resume content is ever logged ────────────────
{
  const reg = buildRegistry({ openrouter: { firstChunkAfterMs: 10 } });
  const logs: string[] = [];
  await orchestrateAnswer({
    attempts: specs("openrouter"),
    prompt: "SECRET RESUME CONTENT about candidate employment history",
    system: "SECRET SYSTEM PROMPT",
    signal: new AbortController().signal,
    hedgeMs: 60,
    validate: realisticValidate,
    log: (line) => logs.push(line),
    resolveProvider: (name) => reg.registry[name],
  });
  const joined = logs.join("\n");
  check("18 no api key in logs", joined.includes("key-for-openrouter"), false);
  check("18 no resume content in logs", joined.includes("SECRET RESUME"), false);
  check("18 no system prompt in logs", joined.includes("SECRET SYSTEM"), false);
  check("18 key presence is still reported as a boolean", joined.includes("apiKeyPresent=true"), true);
}

// ── Extra: an empty provider answer cannot win ─────────────────────────────
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 10, chunks: ["   "] },
    groq: { firstChunkAfterMs: 10 },
  });
  const res = await run(reg, specs("openrouter", "groq"), { hedgeMs: 60 });
  check("extra empty answer rejected", res.provider, "groq");
}

// ── Extra: WAIT responses cannot win ───────────────────────────────────────
{
  const reg = buildRegistry({
    openrouter: { firstChunkAfterMs: 10, chunks: ["WAIT"] },
    groq: { firstChunkAfterMs: 10 },
  });
  const res = await run(reg, specs("openrouter", "groq"), { hedgeMs: 60 });
  check("extra WAIT cannot win", res.provider, "groq");
}

// ── Extra: no providers configured ─────────────────────────────────────────
{
  const res = await orchestrateAnswer({
    attempts: [],
    prompt: "q",
    signal: new AbortController().signal,
    validate: realisticValidate,
    resolveProvider: () => ({ name: "x", listModels: () => [], async *streamSolution() {} }),
  });
  check("extra empty chain yields no answer", res.text, "");
  check("extra empty chain has an error", typeof res.error === "string", true);
}

// ═══════════════════════════════════════════════════════════════════════════
// THE DEFAULT CHAIN: Gemini → OpenRouter
//
// Every case below runs the two-provider chain the app actually ships with, so
// the behaviour asserted is the behaviour an interview gets — not a four-way
// synthetic chain.
// ═══════════════════════════════════════════════════════════════════════════

// ── Fast-fallback classification: every recoverable failure must hand over ──
//
// The requirement is that OpenRouter is reached QUICKLY for a specific list of
// recoverable conditions. "Quickly" is asserted as elapsed < the hedge window,
// because waiting the hedge out is precisely the 27.5s behaviour being fixed.
{
  const cases: Array<{ label: string; message: string; reason: string }> = [
    { label: "HTTP 429", message: "HTTP 429 rate limit exceeded", reason: "http" },
    { label: "HTTP 500", message: "HTTP 500 internal error", reason: "http" },
    { label: "HTTP 502", message: "HTTP 502 bad gateway", reason: "http" },
    { label: "HTTP 503", message: "HTTP 503 service unavailable", reason: "http" },
    { label: "network error", message: "TypeError: Failed to fetch", reason: "network" },
    {
      label: "unavailable model",
      message: "HTTP 404 model gemini-x does not exist",
      reason: "model",
    },
  ];
  for (const c of cases) {
    const reg = buildRegistry({
      gemini: { errorAfterMs: 5, errorMessage: c.message },
      openrouter: { firstChunkAfterMs: 10 },
    });
    const t0 = Date.now();
    const res = await run(reg, specs("gemini", "openrouter"), { hedgeMs: 5000 });
    const elapsed = Date.now() - t0;
    check(`fast-fallback on ${c.label}: openrouter answers`, res.provider, "openrouter");
    check(`fast-fallback on ${c.label}: classified`, res.attemptsStarted[0].failureReason, c.reason);
    check(
      `fast-fallback on ${c.label}: did NOT wait for the hedge window`,
      elapsed < 1500,
      true,
    );
  }
}

// A timeout, an empty reply and a validation rejection are the three
// non-HTTP routes to the same place, and each must also hand over immediately.
{
  // Never completes and never produces text → first-token deadline.
  const reg = buildRegistry({
    gemini: { firstChunkAfterMs: 60_000 },
    openrouter: { firstChunkAfterMs: 10 },
  });
  const res = await run(reg, specs("gemini", "openrouter"), {
    hedgeMs: 5000,
    firstTokenMs: 300,
    totalMs: 60_000,
  });
  check("first-token timeout hands over", res.provider, "openrouter");
  check("first-token timeout is classified as timeout", res.attemptsStarted[0].failureReason, "timeout");
  check("the timed-out attempt is a FAILURE, not a cancellation", res.attemptsStarted[0].outcome, "failed");
  check(
    "the timeout is reported with the budget that was exceeded",
    res.failures[0]?.message,
    "no answer text within 300ms",
  );
}
{
  const reg = buildRegistry({
    gemini: { firstChunkAfterMs: 10, chunks: ["   "] },
    openrouter: { firstChunkAfterMs: 10 },
  });
  const res = await run(reg, specs("gemini", "openrouter"), { hedgeMs: 5000 });
  check("empty reply hands over immediately", res.provider, "openrouter");
}
{
  const reg = buildRegistry({
    gemini: { firstChunkAfterMs: 10, chunks: ["<<<LATEST_TASK>>>"] },
    openrouter: { firstChunkAfterMs: 10 },
  });
  const res = await run(reg, specs("gemini", "openrouter"), { hedgeMs: 5000 });
  check("validation rejection hands over immediately", res.provider, "openrouter");
  check(
    "validation rejection loses the race, it does not end the run",
    res.attempts,
    2,
  );
}

// ── The total budget: the 27.5s wait must become a bounded failure ─────────
{
  // Gemini is fast and healthy. OpenRouter starts a real answer and then stalls
  // forever — the shape of the observed 27.5s run.
  //
  // The first chunk must clear MEANINGFUL_CHARS on purpose: a one-character
  // trickle would never disarm the first-token budget, so the run would fail on
  // the WRONG deadline and this test would prove nothing about the total one.
  const reg = buildRegistry({
    gemini: { errorAfterMs: 5, errorMessage: "HTTP 429" },
    openrouter: {
      firstChunkAfterMs: 10,
      chunks: ["Dependency injection is"],
      tailAfterLastChunkMs: 60_000,
    },
  });
  const t0 = Date.now();
  const res = await run(reg, specs("gemini", "openrouter"), {
    hedgeMs: 200,
    // Production values are 5s / 12s; scaled down so the test is fast while
    // keeping the RELATIONSHIP (total > first-token) identical.
    firstTokenMs: 400,
    totalMs: 800,
  });
  const elapsed = Date.now() - t0;
  check("a stalling last provider yields no answer", res.provider, null);
  check("no text is invented", res.text, "");
  check("it is reported as a timeout", res.attemptsStarted[1].failureReason, "timeout");
  check("the total budget is what was exceeded", res.failures.at(-1)?.message, "did not complete within 800ms");
  check(
    "the run ended at the total budget, not after 27s",
    elapsed < 3000,
    true,
  );
  // …and the message must say WHICH budget was exceeded, because a stream that
  // produced text and a stream that produced nothing fail for different
  // reasons and a shared message hides that.
  check(
    "the total budget is the completion deadline",
    /did not complete within \d+ms/.test(res.failures.at(-1)?.message ?? ""),
    true,
  );
  check(
    "and it ended cleanly rather than hanging",
    typeof res.error === "string" && res.error.length > 0,
    true,
  );
}

// ── HTTP 200 + streaming text must NEVER be classified as a timeout ────────
//
// The real observed failure this pins down: OpenRouter returned HTTP 200,
// streamed its first chunk at ~1.2s and real answer text at ~3.7s — and the
// absolute 12s timer still aborted the fetch mid-stream and reported
// `reason=timeout` with the accumulated text discarded. Progress must re-arm
// the completion deadline: chunks keep arriving (each closer than `totalMs`),
// so the stream completes, validates and wins — even though its TOTAL runtime
// (1.8s) is longer than the budget (800ms).
{
  const chunks = [
    "Redis is an in-memory data structure store that also supports persistence. ",
    "It answers reads in microseconds because everything lives in RAM, ",
    "which makes it a natural fit for caches, session stores and leaderboards. ",
    "You would use it when latency matters more than storage cost, ",
    "and you would avoid it as the system of record for data that outgrows memory. ",
    "Replication and clustering add durability without changing the client model. ",
  ];
  const reg = buildRegistry({
    gemini: { errorAfterMs: 5, errorMessage: "HTTP 500" },
    openrouter: {
      firstChunkAfterMs: 10,
      chunks,
      chunkDelayMs: 300,
      tailAfterLastChunkMs: 50,
    },
  });
  const t0 = Date.now();
  const res = await run(reg, specs("gemini", "openrouter"), {
    hedgeMs: 120,
    firstTokenMs: 400,
    totalMs: 800,
  });
  const elapsed = Date.now() - t0;
  check(
    "C: HTTP 200 + streaming text is not a timeout",
    res.provider,
    "openrouter",
  );
  check(
    "C: no timeout was recorded against the healthy stream",
    res.failures.some((f) => f.reason === "timeout"),
    false,
  );
  check(
    "C: the stream outlived the absolute budget and still completed",
    elapsed > 800,
    true,
  );
  check("C: the full answer is returned intact", res.text, chunks.join(""));
  check(
    "C: the healthy attempt is marked as the winner",
    res.attemptsStarted.find((a) => a.provider === "openrouter")?.winner,
    true,
  );
}

// The counterpart: a stream that produced text and then went QUIET must still
// time out — `totalMs` after its LAST text, not after attempt start.
{
  const reg = buildRegistry({
    gemini: { errorAfterMs: 5, errorMessage: "HTTP 500" },
    openrouter: {
      firstChunkAfterMs: 10,
      chunks: ["Redis is an in-memory data structure store. "],
      tailAfterLastChunkMs: 60_000,
    },
  });
  const t0 = Date.now();
  const res = await run(reg, specs("gemini", "openrouter"), {
    hedgeMs: 120,
    firstTokenMs: 400,
    totalMs: 700,
  });
  const elapsed = Date.now() - t0;
  check(
    "C2: a stream that stops producing text still fails",
    res.provider,
    null,
  );
  check(
    "C2: it is classified as a timeout",
    res.failures.at(-1)?.reason,
    "timeout",
  );
  check(
    "C2: the wait was the completion deadline, not an absolute cap",
    elapsed >= 700 && elapsed < 3000,
    true,
  );
}

// ── Heartbeats keep the first-token budget alive; silence does not ─────────
//
// The second real failure mode: `openrouter/free` returned HTTP 200, framed
// the whole time (first frame at 1.1–3.7s across runs) and only started the
// answer TEXT later — a frame-blind timer pinned to attempt start reported
// `no answer text within 5000ms` against a stream that was demonstrably
// working. Empty yields are activity; only REAL TEXT satisfies the budget
// permanently.
{
  const chunks = ["", "", "", VALID_ANSWER];
  const reg = buildRegistry({
    gemini: { errorAfterMs: 5, errorMessage: "HTTP 500" },
    openrouter: {
      firstChunkAfterMs: 10,
      chunks,
      chunkDelayMs: 200, // frames at 10/210/410ms, text at 610ms
      tailAfterLastChunkMs: 30,
    },
  });
  const res = await run(reg, specs("gemini", "openrouter"), {
    hedgeMs: 120,
    firstTokenMs: 300, // would fire at 300ms if heartbeats were invisible
    totalMs: 800,
  });
  check(
    "D: a framing stream is not killed by the first-token budget",
    res.provider,
    "openrouter",
  );
  check(
    "D: no timeout was recorded",
    res.failures.some((f) => f.reason === "timeout"),
    false,
  );
  check("D: the answer text arrived and won", res.text, VALID_ANSWER);
  check(
    "D: heartbeats are visible as first-chunk telemetry",
    (res.attemptsStarted.find((a) => a.provider === "openrouter")?.firstChunkMs ?? 999) < 100,
    true,
  );
}

// …and a stream that does NOTHING but frame, forever, is still bounded — by
// the total budget (no answer text ever arrives), never left running.
{
  const chunks = new Array(40).fill(""); // 40 frames × 50ms = 2s of heartbeats
  const reg = buildRegistry({
    gemini: { errorAfterMs: 5, errorMessage: "HTTP 500" },
    openrouter: { firstChunkAfterMs: 10, chunks, chunkDelayMs: 50 },
  });
  const t0 = Date.now();
  const res = await run(reg, specs("gemini", "openrouter"), {
    hedgeMs: 120,
    firstTokenMs: 300,
    totalMs: 700,
  });
  const elapsed = Date.now() - t0;
  check("D2: frame-only stream yields no answer", res.provider, null);
  check(
    "D2: the total budget is what bounds it",
    res.failures.at(-1)?.message,
    "did not complete within 700ms",
  );
  check("D2: it failed on schedule", elapsed >= 700 && elapsed < 3000, true);
}

// ── A slow but VALID answer must still be allowed to finish ───────────────
//
// The counterpart to the above, and the reason the first-token budget is
// disarmed by real text: bounding latency must not throw away a correct answer
// that is merely arriving slowly.
{
  const chunks = [
    "Dependency injection means the object receives ",
    "its collaborators instead of constructing them, ",
    "so the wiring lives in one place and can be substituted in tests.",
  ];
  const reg = buildRegistry({
    gemini: {
      firstChunkAfterMs: 10,
      chunks,
      tailAfterLastChunkMs: 200,
    },
    openrouter: {},
  });
  const res = await run(reg, specs("gemini", "openrouter"), {
    hedgeMs: 120,
    // Generous budgets: the point is that nothing fired.
    firstTokenMs: 5000,
    totalMs: 12_000,
  });
  check("a slow-but-valid answer still wins", res.provider, "gemini");
  check("the full answer is returned intact", res.text, chunks.join(""));
  check("no fallback was needed", reg.calls, ["gemini"]);
  check("it was not hedged", res.hedged, false);
}

// A provider that starts producing text only AFTER the first-token budget's
// normal horizon is still measured against the TOTAL budget, and is never
// abandoned just because it is slow. The hedge is a head start for the next
// provider, not a deadline for this one.
{
  const reg = buildRegistry({
    gemini: { firstChunkAfterMs: 900, tailAfterLastChunkMs: 20 },
    // The hedge partner fails, so the slow provider is the only one that can
    // win — which is exactly what makes this a test of patience.
    openrouter: { errorAfterMs: 150, errorMessage: "HTTP 503" },
  });
  const res = await run(reg, specs("gemini", "openrouter"), {
    hedgeMs: 100,
    firstTokenMs: 3000,
    totalMs: 8000,
  });
  check("late text is not killed by the first-token budget", res.provider, "gemini");
  check("and it was still hedged (the hedge is not a deadline)", res.hedged, true);
  check(
    "the slow provider's text time is reported truthfully",
    (res.attemptsStarted[0].firstTextMs ?? 0) >= 850,
    true,
  );
  check("the hedge partner simply failed", res.attemptsStarted[1].outcome, "failed");
}

// ── Budgets are configurable, and the shipped values are what we claim ─────
{
  check(
    "shipped first-token budget is 5s",
    FIRST_TOKEN_TIMEOUT_MS,
    5000,
  );
  check("shipped total budget is 12s", TOTAL_PROVIDER_TIMEOUT_MS, 12000);
  check(
    "the total budget must exceed the first-token budget",
    TOTAL_PROVIDER_TIMEOUT_MS > FIRST_TOKEN_TIMEOUT_MS,
    true,
  );
  check(
    "the hedge fires before the first-token budget does",
    OPENROUTER_HEDGE_MS < FIRST_TOKEN_TIMEOUT_MS,
    true,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// A KEY POOL MUST NOT WEAKEN VALIDATION
//
// This is the specific risk introduced by giving a provider three credentials:
// every extra attempt is another chance for a degenerate answer to win, because
// "another key" and "another chance" are the same mechanism from the validator's
// point of view. So the acceptance rule is re-asserted here explicitly — a
// provider only wins on a COMPLETE answer that PASSES validation, no matter
// which of its keys produced it.
// ═══════════════════════════════════════════════════════════════════════════
{
  const ARTIFACT = "<<<LATEST_TASK>>>\nThe candidate asks about the CAP theorem.";
  let call = 0;
  const provider = {
    name: "gemini" as const,
    listModels: () => ["m"],
    async *streamSolution() {
      const thisCall = call++;
      await sleep(5);
      // Slot 1 leaks the prompt template; slot 2 answers properly.
      yield thisCall === 0 ? ARTIFACT : VALID_ANSWER;
    },
  };

  const res = await orchestrateAnswer({
    attempts: [
      { provider: "gemini", model: "m", apiKey: "k1", keyIndex: 0 },
      { provider: "gemini", model: "m", apiKey: "k2", keyIndex: 1 },
    ],
    prompt: "q",
    system: "<<<INTERVIEW_SYSTEM_PROMPT>>>",
    signal: new AbortController().signal,
    hedgeMs: 5000,
    firstTokenMs: 4000,
    totalMs: 9000,
    validate: realisticValidate,
    resolveProvider: () => provider as any,
  });

  check("the artifact-bearing slot did not win", res.attemptsStarted[0].winner, false);
  check("it was rejected, not merely outrun", res.attemptsStarted[0].outcome, "failed");
  check(
    "the rejection is recorded as a failure, so the run continues",
    res.attemptsStarted[0].failureReason,
    "artifact-delimiter",
  );
  check("the valid slot won", res.attemptsStarted[1].winner, true);
  check("no leaked template text survived", res.text.includes("<<<"), false);
  check("the answer is the valid one", res.text, VALID_ANSWER);
  check("exactly one winner across the whole pool", res.attemptsStarted.filter((a) => a.winner).length, 1);
}

// An INCOMPLETE stream must never win, however many keys are available: the
// answer is only displayed once it is complete, so an unfinished one is nothing.
{
  const provider = {
    name: "gemini" as const,
    listModels: () => ["m"],
    async *streamSolution(options: any) {
      yield VALID_ANSWER.slice(0, 20);
      // Never ends. Honours the signal, like a real fetch-backed stream does.
      await sleep(60_000, options.signal);
    },
  };
  const res = await orchestrateAnswer({
    attempts: [
      { provider: "gemini", model: "m", apiKey: "k1", keyIndex: 0 },
      { provider: "gemini", model: "m", apiKey: "k2", keyIndex: 1 },
    ],
    prompt: "q",
    signal: new AbortController().signal,
    hedgeMs: 60,
    firstTokenMs: 300,
    totalMs: 600,
    validate: realisticValidate,
    resolveProvider: () => provider as any,
  });
  check("an incomplete answer wins nothing", res.provider, null);
  check("no partial text is presented as an answer", res.text, "");
  check(
    "and both slots are recorded as timing out",
    res.attemptsStarted.filter((a) => a.failureReason === "timeout").length,
    2,
  );
}

// A stream that IGNORES its abort signal must not be able to hold the interview
// open after the answer is already decided. Without the bounded settle this run
// sat for a full minute; that is the "waiting indefinitely" failure the
// deadlines are supposed to prevent.
{
  const provider = {
    name: "gemini" as const,
    listModels: () => ["m"],
    async *streamSolution() {
      yield VALID_ANSWER.slice(0, 20);
      // Deliberately deaf to the AbortSignal.
      await new Promise((r) => setTimeout(r, 60_000));
    },
  };
  const t0 = Date.now();
  const res = await orchestrateAnswer({
    attempts: [
      { provider: "gemini", model: "m", apiKey: "k1", keyIndex: 0 },
      { provider: "gemini", model: "m", apiKey: "k2", keyIndex: 1 },
    ],
    prompt: "q",
    signal: new AbortController().signal,
    hedgeMs: 60,
    firstTokenMs: 200,
    totalMs: 400,
    settleGraceMs: 300,
    validate: realisticValidate,
    resolveProvider: () => provider as any,
  });
  const elapsed = Date.now() - t0;
  check("the run still returns", res.provider, null);
  check(
    "…without waiting for the deaf stream",
    elapsed < 3000,
    true,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The REAL Gemini provider, with only the HTTP layer stubbed
//
// Everything above uses scripted providers: that proves the ORCHESTRATOR but
// says nothing about the first-party leg that actually 404'd in production.
// These run the shipping `GeminiProvider` against a fake SSE response, so the
// curated model list, the request body and the text-yielding path are the real
// ones — only `fetch` is replaced.
// ─────────────────────────────────────────────────────────────────────────────
{
  const { GeminiProvider, geminiGenerationConfig } = await import("../src/lib/ai/gemini");
  const provider = new GeminiProvider();
  const checkTrue = (name: string, ok: unknown) => check(name, ok, true);

  // ── A. The curated model list ───────────────────────────────────────────
  const models = provider.listModels();
  checkTrue("A the curated model list is non-empty", models.length > 0);
  checkTrue(
    "Ab no RETIRED id survives in it (they answer HTTP 404)",
    !models.some((m) => /^gemini-1\.5/.test(m) || /^gemini-2\.0/.test(m) || m === "gemini-2.5-flash-lite"),
  );
  checkTrue("Ac the measured-good default is present", models.includes("gemini-2.5-flash"));
  checkTrue(
    "Ad every entry is a flash-class model (no Pro/503 legs in the default path)",
    models.every((m) => /flash/.test(m)),
  );

  // ── B. Text reaches the caller through the real parsing path ────────────
  const sse = [
    `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Redis is an in-memory store." }] } }],
    })}`,
    "",
    `data: ${JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text: " It is used as a cache." }] },
          finishReason: "STOP",
        },
      ],
    })}`,
    "",
    "",
  ].join("\n");

  const realFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody: Record<string, any> | null = null;
  const stubFetch = (body: string, status = 200) => {
    (globalThis as any).fetch = async (url: unknown, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(body, {
        status,
        headers: { "Content-Type": "text/event-stream" },
      });
    };
  };
  const restoreFetch = () => {
    (globalThis as any).fetch = realFetch;
  };
  const request = (model: string) =>
    provider.streamSolution({
      prompt: "q",
      system: "rules",
      model,
      apiKey: "test-key",
      maxTokens: 512,
      signal: new AbortController().signal,
    } as AIRequestOptions);

  try {
    stubFetch(sse);
    const got: string[] = [];
    for await (const chunk of request("gemini-2.5-flash")) got.push(chunk);

    check(
      "B1 the real Gemini path yields the answer text",
      got.join(""),
      "Redis is an in-memory store. It is used as a cache.",
    );
    checkTrue(
      "B2 the request went to the streaming endpoint",
      capturedUrl.includes(":streamGenerateContent?alt=sse"),
    );
    checkTrue(
      "B3 the credential rides in the URL only, never in the body",
      capturedUrl.includes("key=test-key") &&
        !JSON.stringify(capturedBody).includes("test-key"),
    );
    checkTrue(
      "B4 a system instruction reaches the request (behavioural rules)",
      Boolean(capturedBody?.systemInstruction?.parts?.[0]?.text),
    );
    check(
      "B5 flash gets the shipping thinking policy",
      capturedBody?.generationConfig?.thinkingConfig,
      { thinkingBudget: 0 },
    );

    // ── C. A frame with no text is a HEARTBEAT, not silence ───────────────
    stubFetch(`data: ${JSON.stringify({ candidates: [{ content: { parts: [] } }] })}\n\n`);
    const beats: string[] = [];
    for await (const chunk of request("gemini-2.5-flash")) beats.push(chunk);
    checkTrue("C1 an empty frame still yields (the budget is re-armed)", beats.length >= 1);
    checkTrue("C2 the heartbeat carries no text", beats.every((c) => c === ""));

    // ── D. flash-lite must NOT receive thinkingConfig (measured HTTP 400) ─
    stubFetch(sse);
    for await (const _ of request("gemini-3.5-flash-lite")) void _;
    check(
      "D1 flash-lite sends NO thinkingConfig",
      capturedBody?.generationConfig?.thinkingConfig,
      undefined,
    );
    check(
      "D2 and the same is true of the pure config function",
      geminiGenerationConfig("gemini-3.5-flash-lite", 4096).thinkingConfig,
      undefined,
    );
    check(
      "D3 while flash still carries one",
      geminiGenerationConfig("gemini-2.5-flash", 4096).thinkingConfig,
      { thinkingBudget: 0 },
    );

    // ── E. A non-2xx response is thrown, never yielded as silence ─────────
    stubFetch(JSON.stringify({ error: { message: "model not found" } }), 404);
    let threw = "";
    try {
      for await (const _ of request("gemini-2.0-flash")) void _;
    } catch (err) {
      threw = String(err);
    }
    checkTrue("E1 a 404 surfaces as an error, not an empty answer", /model not found/.test(threw));
  } finally {
    restoreFetch();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}