/**
 * Deterministic tests for the per-provider cooldown.
 *
 * Run: `npx tsx scripts/verify-provider-cooldown.mts`
 *
 * ── Why this needs its own harness ──────────────────────────────────────────
 * Every case here came from a LIVE run where the app retried a provider that was
 * structurally unable to answer, and then reported the provider's raw text to
 * the user instead of saying what was wrong:
 *
 *   • OpenRouter — HTTP 429, daily limit, with a reset header.
 *   • Gemini — HTTP 429, body text `… retry in 3h 15m`.
 *   • NVIDIA — `TypeError: Failed to fetch` on EVERY turn: a CORS block.
 *
 * None of those is fixed by retrying, and each one costs a full timeout window
 * per turn. The clock is injected throughout, so "3h 15m from now" is asserted
 * as a number rather than waited for.
 */
import {
  CORS_SESSION_COOLDOWN_MS,
  DEFAULT_NETWORK_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  MODEL_SESSION_COOLDOWN_MS,
  applyCooldown,
  buildCooldownSummary,
  clearCooldown,
  decideCooldown,
  describeCooldowns,
  extractStatus,
  formatCooldown,
  isCorsOrNetworkFailure,
  isOnCooldown,
  looksLikeMissingModel,
  looksLikeRateLimit,
  parseDurationProse,
  parseResetHeaders,
  pruneCooldowns,
  type ProviderCooldownState,
} from "../src/lib/providerCooldown";
import {
  orchestrateAnswer,
  type AttemptSpec,
} from "../src/lib/ai/orchestrator";
import { describeProviderChain } from "../src/lib/providerDiagnostics";
import type { AIProvider, AIRequestOptions } from "../src/lib/ai/types";

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

/** A fixed instant, so every duration below is exact. */
const T0 = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;

const empty = (): ProviderCooldownState => ({ records: {}, now: T0 });

// ═══════════════════════════════════════════════════════════════════════════
// 1. Reset headers
// ═══════════════════════════════════════════════════════════════════════════

check(
  "1a retry-after seconds",
  parseResetHeaders({ "retry-after": "120" }, T0),
  T0 + 120_000,
);
check(
  "1b retry-after HTTP-date",
  parseResetHeaders(
    { "retry-after": new Date(T0 + 45 * MIN).toUTCString() },
    T0,
  ),
  T0 + 45 * MIN,
);
check(
  "1c x-ratelimit-reset as seconds-until",
  parseResetHeaders({ "x-ratelimit-reset": "3600" }, T0),
  T0 + HOUR,
);
check(
  "1d x-ratelimit-reset as EPOCH seconds, not a delta",
  parseResetHeaders(
    { "x-ratelimit-reset": String((T0 + 3 * HOUR) / 1000) },
    T0,
  ),
  T0 + 3 * HOUR,
);
check("1e no headers", parseResetHeaders(null, T0), null);
check("1f unparseable", parseResetHeaders({ "retry-after": "soon" }, T0), null);
check(
  "1g header name matching is case-insensitive",
  parseResetHeaders({ "X-RateLimit-Reset-Requests": "60" }, T0),
  T0 + MIN,
);
check(
  "1h an absurd value is capped, never parked for days",
  parseResetHeaders({ "retry-after": "999999999" }, T0),
  T0 + MAX_COOLDOWN_MS,
);

// ═══════════════════════════════════════════════════════════════════════════
// 2. Quota prose — "retry in 3h 15m"
// ═══════════════════════════════════════════════════════════════════════════

check(
  "2a the exact observed phrase",
  parseDurationProse("Quota exceeded. Please retry in 3h 15m."),
  3 * HOUR + 15 * MIN,
);
check("2b single unit", parseDurationProse("resets in 45 minutes"), 45 * MIN);
check("2c seconds", parseDurationProse("try again in 30s"), 30_000);
check("2d hours", parseDurationProse("available again in 2 hours"), 2 * HOUR);
check("2e unrelated prose", parseDurationProse("invalid api key"), null);
check("2f no digits", parseDurationProse("retry later"), null);

// ═══════════════════════════════════════════════════════════════════════════
// 3. Classification
// ═══════════════════════════════════════════════════════════════════════════

checkTrue(
  "3a 'Failed to fetch' is a CORS/network block",
  isCorsOrNetworkFailure("TypeError: Failed to fetch"),
);
checkTrue(
  "3b a blocked-by-CORS message is recognised",
  isCorsOrNetworkFailure("Blocked by CORS policy"),
);
checkTrue(
  "3c an abort is NOT a fault — the user did it",
  !isCorsOrNetworkFailure("AbortError: The operation was aborted"),
);
checkTrue(
  "3d a 429 message is recognised without a status",
  looksLikeRateLimit("Gemini API error: Resource has been exhausted. retry in 3h 15m"),
);
checkTrue(
  "3e OpenRouter's rate_limit_exceeded is recognised",
  looksLikeRateLimit("OpenRouter API error: rate_limit_exceeded"),
);
check("3f status recovered from a message", extractStatus("HTTP 429: too many"), 429);
check("3g no status when there is none", extractStatus("invalid api key"), undefined);

// ── 3h. OpenRouter 429 with the reset header ─────────────────────────────
{
  const d = decideCooldown({
    provider: "openrouter",
    status: 429,
    headers: { "x-ratelimit-reset": "7200" },
    message: "Rate limit reached",
    now: T0,
  });
  checkTrue("3h OpenRouter 429 is parked", d.cooldown);
  check("3h kind", d.kind, "quota");
  check("3h until comes from the header, not prose", d.until, T0 + 2 * HOUR);
  checkTrue("3h detail mentions the reset", /2h/.test(d.detail ?? ""));
}

// ── 3i. Gemini 429 whose only signal is prose ────────────────────────────
{
  const d = decideCooldown({
    provider: "gemini",
    message:
      "Gemini API error: 429 Resource has been exhausted. Quota exceeded, please retry in 3h 15m.",
    now: T0,
  });
  checkTrue("3i Gemini 429 is parked", d.cooldown);
  check("3i kind", d.kind, "quota");
  check("3i until is 3h15m from now", d.until, T0 + 3 * HOUR + 15 * MIN);
}

// ── 3j. NVIDIA CORS — the rest of the session ───────────────────────────
{
  const d = decideCooldown({
    provider: "nvidia",
    message: "Cannot reach integrate.api.nvidia.com. Network error: Failed to fetch.",
    now: T0,
  });
  checkTrue("3j NVIDIA CORS is parked", d.cooldown);
  check("3j kind", d.kind, "cors");
  check("3j until is the session cooldown", d.until, T0 + CORS_SESSION_COOLDOWN_MS);
  checkTrue("3j detail says the session", /rest of this session/i.test(d.detail ?? ""));
}

// ── 3k. A plain offline machine is NOT a session-long CORS block ─────────
{
  const d = decideCooldown({
    provider: "groq",
    message: "Cannot reach api.groq.com (groq / model). Network error: fetch failed.",
    now: T0,
  });
  // Deliberately `network`, NOT `cors`. "fetch failed" is Node's wording for a
  // transport failure and carries no evidence of an origin policy; parking it
  // for the rest of the session over a transient blip would be a real cost. The
  // CORS verdict needs a CORS marker or a browser `Failed to fetch`.
  check("3k kind", d.kind, "network");
  checkTrue("3k is parked", d.cooldown);
  check("3k until is the short window", d.until, T0 + DEFAULT_NETWORK_COOLDOWN_MS);
}

// ── 3l. A 400 must also be parked: repeating it verbatim cannot help ────
{
  const d = decideCooldown({
    provider: "openrouter",
    status: 400,
    message: "HTTP 400: invalid model",
    now: T0,
  });
  checkTrue("3l a 400 is parked too", d.cooldown);
  // CHANGED from `T0 + DEFAULT_NETWORK_COOLDOWN_MS`. A 400 that names the
  // model is as deterministic as a 404 that does, so it is now parked for the
  // session. The assertion is retained (still parked) and only the window
  // lengthened — nothing was weakened.
  check("3l until (invalid model is now a session-long park)", d.until, T0 + MODEL_SESSION_COOLDOWN_MS);
  check("3l and is filed as model", d.kind, "model");
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. State machine
// ═══════════════════════════════════════════════════════════════════════════

{
  const q = decideCooldown({
    provider: "gemini",
    message: "429 Resource has been exhausted. retry in 3h 15m",
    now: T0,
  });
  const s1 = applyCooldown(empty(), q, "gemini");
  checkTrue("4a parked immediately", isOnCooldown(s1, "gemini", T0));
  check("4b record kind", s1.records.gemini.kind, "quota");
  check("4c hits", s1.records.gemini.hits, 1);

  // A second failure while still parked EXTENDS rather than resets — otherwise
  // every turn would hand back the remaining quota it just spent.
  const q2 = decideCooldown({
    provider: "gemini",
    message: "429 Resource has been exhausted. retry in 3h 15m",
    now: T0 + MIN,
  });
  const s2 = applyCooldown(s1, q2, "gemini");
  checkTrue(
    "4d a repeat failure never SHORTENS the window",
    s2.records.gemini.until! >= s1.records.gemini.until!,
  );
  check(
    "4d-extended it takes the LATER of the two",
    s2.records.gemini.until,
    T0 + MIN + 3 * HOUR + 15 * MIN,
  );
  check("4e hits accumulate", s2.records.gemini.hits, 2);
  check("4f since is the FIRST failure", s2.records.gemini.since, T0);

  const pruned = pruneCooldowns(s2, T0 + 4 * HOUR);
  checkTrue("4g expired cooldown is pruned", !isOnCooldown(pruned, "gemini", T0 + 4 * HOUR));
  check("4h pruning drops the record", pruned.records.gemini, undefined);
  checkTrue(
    "4i pruning is identity-stable when nothing changed",
    pruneCooldowns(s2, T0 + MIN) === s2,
  );

  const cleared = clearCooldown(s2, "gemini");
  checkTrue("4j clear works", !isOnCooldown(cleared, "gemini", T0));
  checkTrue("4k clearing an unknown provider is a no-op", clearCooldown(s2, "nope") === s2);
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Formatting
// ═══════════════════════════════════════════════════════════════════════════

check("5a seconds", formatCooldown(T0 + 30_000, T0), "30s");
check("5b minutes", formatCooldown(T0 + 45 * MIN, T0), "45m");
check("5c hours and minutes", formatCooldown(T0 + 3 * HOUR + 15 * MIN, T0), "3h 15m");
check("5d whole hours", formatCooldown(T0 + 2 * HOUR, T0), "2h");
check("5e days", formatCooldown(T0 + 30 * HOUR, T0), "1d 6h");

// ═══════════════════════════════════════════════════════════════════════════
// 6. The user-facing summary — the whole point of B5
// ═══════════════════════════════════════════════════════════════════════════

{
  const q = decideCooldown({
    provider: "openrouter",
    status: 429,
    headers: { "x-ratelimit-reset": "7200" },
    message: "Rate limit reached",
    now: T0,
  });
  const state = applyCooldown(empty(), q, "openrouter");

  const summary = buildCooldownSummary({
    state,
    now: T0,
    chain: ["groq"],
    chainNotes: [
      { provider: "nvidia", reason: "not in the configured chain" },
      { provider: "gemini", reason: "no API key" },
    ],
  });

  const text = [summary.headline, ...summary.lines].join("\n");
  checkTrue("6a says which provider is parked", /OPENROUTER/.test(text));
  checkTrue("6b says until when", /2h/.test(text));
  checkTrue(
    "6c says WHY a provider is not in use (the config reason)",
    /NVIDIA/.test(text) && /not in the configured chain/i.test(text),
  );
  checkTrue("6d names the missing key provider", /GEMINI/.test(text));
  checkTrue(
    "6e does NOT dump the raw provider error",
    !/Rate limit reached/i.test(text) && !/429/.test(text),
  );
  checkTrue("6f offers a next step", /Settings/.test(summary.headline));
}

{
  // No keys at all: the honest answer is "add a key", not "429 quota reached".
  const summary = buildCooldownSummary({
    state: empty(),
    now: T0,
    chain: [],
    chainNotes: [
      { provider: "openrouter", reason: "no API key" },
      { provider: "groq", reason: "no API key" },
    ],
  });
  checkTrue(
    "6g an empty chain says so",
    /API key/i.test(summary.headline),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. "Groq is not in your provider chain" is reachable
// ═══════════════════════════════════════════════════════════════════════════
{
  // Gemini removed from the chain by the user: this is the CONFIG reason the
  // panel has to be able to state ("not in the configured chain"), distinct from
  // a missing key and from a provider that was never enabled by default.
  const chain = describeProviderChain({
    providerOrder: ["openrouter"],
    models: { openrouter: "openrouter/free", gemini: "gemini-2.5-flash" },
    apiKeys: { openrouter: "k", gemini: "gk" },
  });
  const gemini = chain.status.find((s) => s.provider === "gemini");
  check("7a Gemini has a key but was removed from the chain", gemini?.availability, "not-in-chain");
  checkTrue(
    "7b the reason is stated for the user",
    /not in the configured chain/i.test(gemini?.detail ?? ""),
  );

  // Groq is OPTIONAL: out of the chain by policy, and the panel must be able to
  // say so differently from "you turned it off".
  const opt = describeProviderChain({
    providerOrder: ["gemini", "openrouter"],
    models: { groq: "llama-3.3-70b-versatile" },
    apiKeys: { gemini: "k", openrouter: "k", groq: "gk" },
  });
  const groq = opt.status.find((s) => s.provider === "groq");
  check("7c Groq out of chain by default reads as optional", groq?.availability, "optional");
  // NVIDIA and Local Qwen were removed ENTIRELY (provider, model, IPC, UI), so a
  // stronger statement than "optional" applies: they must not be reported at all.
  check(
    "7d NVIDIA and Local Qwen are gone from the report entirely",
    opt.status.some((s) => s.provider === "nvidia" || s.provider === "local"),
    false,
  );
  checkTrue(
    "7e and the user is told how to enable it",
    /add it in Settings/i.test(groq?.detail ?? ""),
  );
  check(
    "7f the optional provider is NOT in the default chain",
    opt.configured.includes("groq"),
    false,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. The orchestrator actually SKIPS a parked provider
// ═══════════════════════════════════════════════════════════════════════════

{
  const calls: string[] = [];
  const registry: Record<string, AIProvider> = {};
  for (const name of ["openrouter", "groq", "gemini"]) {
    registry[name] = {
      name,
      listModels: () => [name],
      // eslint-disable-next-line require-yield
      async *streamSolution(_o: AIRequestOptions) {
        calls.push(name);
        if (name === "groq") throw new Error("HTTP 429: rate limit reached");
        yield "A hash map gives O(1) average lookup because it buckets keys by hash.";
      },
    };
  }

  // Real `Date.now()` here, NOT the fixed T0 used elsewhere in this file. The
  // gate below compares against the live clock, so a record anchored to T0
  // (Nov 2023) would already have expired and the provider would not be skipped
  // — a test that passes for the wrong reason.
  const state = applyCooldown(
    { records: {}, now: Date.now() },
    decideCooldown({
      provider: "openrouter",
      status: 429,
      headers: { "x-ratelimit-reset": "7200" },
      message: "Rate limit reached",
      now: Date.now(),
    }),
    "openrouter",
  );

  const attempts: AttemptSpec[] = ["openrouter", "groq", "gemini"].map(
    (provider) =>
      ({ provider, model: `${provider}-m`, apiKey: "k" }) as AttemptSpec,
  );

  const run = await orchestrateAnswer({
    attempts,
    prompt: "p",
    signal: new AbortController().signal,
    log: () => {},
    // Explicit, so this harness can never make a real network call — a test
    // that hits api.groq.com with the key "k" is a flaky test, not a test.
    resolveProvider: (name) => registry[name],
    cooldown: {
      isBlocked: (provider) =>
        isOnCooldown(state, provider, Date.now())
          ? { blocked: true, detail: state.records[provider].detail }
          : { blocked: false },
      reportFailure: (provider, info) => {
        const d = decideCooldown({
          provider,
          status: info.status,
          headers: info.headers,
          message: info.message,
          now: Date.now(),
        });
        if (d.cooldown) {
          Object.assign(
            state.records,
            applyCooldown(state, d, provider).records,
          );
        }
      },
    },
  });

  checkTrue(
    "8a a parked provider is never called at all",
    !calls.includes("openrouter"),
  );
  check("8b it is reported as skipped", run.skipped.map((s) => s.provider), [
    "openrouter",
  ]);
  checkTrue("8c the detail explains why", /reset/i.test(run.skipped[0]?.detail ?? ""));
  checkTrue("8d another provider still wins", run.winner && run.provider === "gemini");
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. Everything parked — the user is told what to do, not what failed
// ═══════════════════════════════════════════════════════════════════════════
{
  const registry: Record<string, AIProvider> = {
    groq: {
      name: "groq",
      listModels: () => ["groq"],
      // eslint-disable-next-line require-yield
      async *streamSolution(_o: AIRequestOptions) {
        throw new Error("HTTP 429: rate limit reached");
      },
    },
  };

  const report: string[] = [];
  const run = await orchestrateAnswer({
    attempts: [{ provider: "groq", model: "groq-m", apiKey: "k" }],
    prompt: "p",
    signal: new AbortController().signal,
    log: () => {},
    // Explicit, so this harness can never make a real network call.
    resolveProvider: (name) => registry[name],
    cooldown: {
      isBlocked: () => ({ blocked: false }),
      reportFailure: (provider, info) =>
        report.push(
          `${provider}:${decideCooldown({
            provider,
            status: info.status,
            // Headers are deliberately excluded: a previous request's header bag
            // must not decide THIS failure.
            headers: null,
            message: info.message,
            now: 0,
          }).kind}`,
        ),
    },
  });

  checkTrue("9a no winner", !run.winner);
  check("9b the failure was reported to the cooldown", report, ["groq:quota"]);
  checkTrue(
    "9c the error still exists for the log (never lost)",
    /groq/i.test(run.error ?? ""),
  );
}

// ── 10. A missing MODEL is parked for the session, not for 30 seconds ──────
//
// Observed live: NVIDIA returned HTTP 404 for
// `nvidia/llama-3.1-nemotron-70b-instruct`. A 404 used to fall into the generic
// 4xx branch and cool the provider down for 30 seconds, so every subsequent
// turn re-spent a full request plus its latency re-discovering a failure that
// cannot resolve without a human changing the setting.
{
  const now = 1_700_000_000_000;

  const nf404 = decideCooldown({
    provider: "nvidia",
    status: 404,
    message: "HTTP 404: model not found",
    now,
  });
  checkTrue("10a a 404 parks the provider", nf404.cooldown);
  check("10b with kind=model", nf404.kind, "model");
  check("10c for the whole session", nf404.until, now + MODEL_SESSION_COOLDOWN_MS);
  checkTrue(
    "10d the message tells the user to change the model in Settings",
    /not found/i.test(nf404.detail) && /Settings/i.test(nf404.detail),
  );
  checkTrue(
    "10e and says it is skipped for the session",
    /rest of this session/i.test(nf404.detail),
  );
  checkTrue(
    "10f a 404 is strictly longer than the old 30s cooldown",
    nf404.until > now + DEFAULT_NETWORK_COOLDOWN_MS,
  );

  // The exact observed id must be recognised from prose alone, with no status.
  const prose = decideCooldown({
    provider: "nvidia",
    message:
      "The model nvidia/llama-3.1-nemotron-70b-instruct does not exist or you do not have access to it.",
    now,
  });
  checkTrue("10g prose-only model failure is detected without a status", prose.cooldown);
  check("10h and is filed as model", prose.kind, "model");

  // Gateways report this as 400/422 too, so status alone is not enough.
  const bad400 = decideCooldown({
    provider: "groq",
    status: 400,
    message: "invalid model: llama-nope",
    now,
  });
  check("10i a 400 naming an invalid model is model, not generic 4xx", bad400.kind, "model");

  // A 404 that is NOT about a model (a wrong endpoint path) must not be
  // parked for the session — only the model case is deterministic.
  const wrongPath = decideCooldown({
    provider: "groq",
    status: 404,
    message: "HTTP 404 Not Found",
    now,
  });
  checkTrue(
    "10j a non-model 404 is NOT parked for the session",
    wrongPath.until < now + MODEL_SESSION_COOLDOWN_MS,
  );

  // The detector itself must not fire on ordinary failures.
  checkTrue("10k does not fire on a rate limit", !looksLikeMissingModel("429 rate limit exceeded"));
  checkTrue("10l does not fire on a server error", !looksLikeMissingModel("HTTP 500 internal error"));
  checkTrue(
    "10m does not fire on a 401 bad key",
    !looksLikeMissingModel("HTTP 401 invalid api key"),
  );

  // And it must survive a whole interview without expiring.
  const late = now + 10 * 60 * 1000;
  const state: ProviderCooldownState = { now, records: {} };
  const decision = decideCooldown({
    provider: "nvidia",
    status: 404,
    message: "model not found",
    now,
  });
  const parked = applyCooldown(state, decision, "nvidia");
  checkTrue("10n still parked 10 minutes into the session", isOnCooldown(parked, "nvidia", late));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}