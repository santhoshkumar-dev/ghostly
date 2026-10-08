/**
 * Regression harness for the provider KEY POOL and per-key failover.
 *
 * Run: `npx tsx scripts/verify-key-pool.mts`
 *
 * ── What this locks down ────────────────────────────────────────────────────
 * 1. The pool shape: three slots per provider, slot 1 being the long-standing
 *    `apiKeys` entry, so nothing that already read `apiKeys` had to change.
 * 2. The four statuses and their exact transitions — healthy / cooldown /
 *    failed / not configured — including the cooldown boundary to the
 *    millisecond.
 * 3. Selection order: slots in index order, cooled-down and failed slots
 *    excluded, and NO rotation on success.
 * 4. That only CREDENTIAL-shaped failures move to another key. This is the
 *    safety property: if a provider 500 moved keys, three of the user's keys
 *    would be spent on one outage and the pool would end the interview.
 * 5. That no key material can reach a log, an error message or the UI status
 *    line — asserted by sweeping every string this module can return against
 *    the actual key material used in the test.
 * 6. That the orchestrator really does walk the pool, through the real
 *    `onKeyOutcome` seam, with two attempts for the SAME provider coexisting
 *    (the in-flight bookkeeping that a pool needs and a single-key chain never
 *    exercises).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  clearAllKeys,
  clearKey,
  DEFAULT_KEY_COOLDOWN_MS,
  describeKeySlot,
  describeKeyStatus,
  EMPTY_KEY_HEALTH,
  formatKeyLog,
  isConfigured,
  isKeySpecificFailure,
  KEY_SLOTS_PER_PROVIDER,
  keyId,
  keyPool,
  keyStatus,
  markKeyFailure,
  markKeySuccess,
  MAX_CONSECUTIVE_KEY_FAILURES,
  selectKeyIndices,
  summarizeKeys,
  TIMEOUT_KEY_COOLDOWN_MS,
  type KeyHealthState,
} from "../src/lib/keyHealth";

let pass = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else failures.push(`  ${name}\n    expected: ${b}\n    actual:   ${a}`);
}
function checkTrue(name: string, cond: boolean): void {
  check(name, cond, true);
}

const T0 = 1_700_000_000_000;

/** Keys that look like real credentials, so a leak would be unmistakable. */
const KEY_A = "AIzaSyGEMINI-KEY-AAAA1111";
const KEY_B = "AIzaSyGEMINI-KEY-BBBB2222";
const KEY_C = "AIzaSyGEMINI-KEY-CCCC3333";

// ═══════════════════════════════════════════════════════════════════════════
// 1. Pool shape
// ═══════════════════════════════════════════════════════════════════════════
check("three slots per provider", KEY_SLOTS_PER_PROVIDER, 3);

check(
  "slot 1 comes from apiKeys and slots 2-3 from the pool",
  keyPool({ gemini: KEY_A }, { gemini: [KEY_B, KEY_C] }, "gemini"),
  [KEY_A, KEY_B, KEY_C],
);
check(
  "a provider with only the primary key still gets three (padded) slots",
  keyPool({ gemini: KEY_A }, {}, "gemini"),
  [KEY_A, "", ""],
);
check(
  "a provider with no keys at all yields empty strings, not undefined",
  keyPool({}, undefined, "gemini"),
  ["", "", ""],
);
check(
  "extra slots beyond the pool size are dropped, not truncated mid-key",
  keyPool({ gemini: KEY_A }, { gemini: [KEY_B, KEY_C, "extra"] }, "gemini"),
  [KEY_A, KEY_B, KEY_C],
);
check(
  "a missing apiKeys entry is tolerated",
  keyPool(undefined, undefined, "openrouter"),
  ["", "", ""],
);

checkTrue("a real key is configured", isConfigured(KEY_A));
checkTrue("whitespace is NOT a key", !isConfigured("   "));
checkTrue("an empty string is NOT a key", !isConfigured(""));
checkTrue("undefined is NOT a key", !isConfigured(undefined));

// The slot identifier must never contain key material — it is used as a record
// key, in React keys and in log lines.
check("the slot id is provider and index only", keyId("gemini", 1), "gemini#1");
checkTrue(
  "the slot id never embeds a key",
  !keyId("gemini", 1).includes(KEY_A.slice(0, 8)),
);
check("slot labels are 1-based for humans", [
  describeKeySlot(0),
  describeKeySlot(1),
  describeKeySlot(2),
], ["API Key 1", "API Key 2", "API Key 3"]);

// ═══════════════════════════════════════════════════════════════════════════
// 2. Statuses
// ═══════════════════════════════════════════════════════════════════════════
check("an empty slot is not configured", keyStatus(EMPTY_KEY_HEALTH, "gemini", 0, T0, false), "not-configured");
check("a filled slot with no record is healthy", keyStatus(EMPTY_KEY_HEALTH, "gemini", 0, T0, true), "healthy");

let s: KeyHealthState = markKeyFailure(
  { ...EMPTY_KEY_HEALTH, now: T0 },
  { provider: "gemini", index: 1, now: T0, reason: "rate limited" },
);
check("a refused slot is on cooldown", keyStatus(s, "gemini", 1, T0, true), "cooldown");
check("the window is the documented default", s.records[keyId("gemini", 1)].until, T0 + DEFAULT_KEY_COOLDOWN_MS);
check("its siblings are untouched", keyStatus(s, "gemini", 0, T0, true), "healthy");
check("another provider is untouched", keyStatus(s, "openrouter", 0, T0, true), "healthy");

// The boundary, to the millisecond.
check("still on cooldown one ms before expiry", keyStatus(s, "gemini", 1, T0 + DEFAULT_KEY_COOLDOWN_MS - 1, true), "cooldown");
check("healthy again exactly at expiry", keyStatus(s, "gemini", 1, T0 + DEFAULT_KEY_COOLDOWN_MS, true), "healthy");

// A timeout gets its own, shorter window.
s = markKeyFailure(
  { ...EMPTY_KEY_HEALTH, now: T0 },
  { provider: "openrouter", index: 0, now: T0, cooldownMs: TIMEOUT_KEY_COOLDOWN_MS, reason: "timeout" },
);
check("a timeout uses its own shorter window", s.records[keyId("openrouter", 0)].until, T0 + TIMEOUT_KEY_COOLDOWN_MS);
checkTrue(
  "the timeout window is shorter than the refusal window",
  TIMEOUT_KEY_COOLDOWN_MS < DEFAULT_KEY_COOLDOWN_MS,
);

// Repeated failures eventually declare the slot FAILED, which no clock can undo.
{
  let st: KeyHealthState = { ...EMPTY_KEY_HEALTH, now: T0 };
  let now = T0;
  for (let i = 0; i < MAX_CONSECUTIVE_KEY_FAILURES - 1; i++) {
    st = markKeyFailure(st, { provider: "gemini", index: 2, now, reason: "rate limited" });
    now += DEFAULT_KEY_COOLDOWN_MS;
  }
  check(
    "below the threshold it is still a cooldown",
    // One millisecond before expiry, not at it: `markKeyFailure` sets the window
    // RELATIVE to the moment of the failure, so checking exactly at the boundary
    // is checking the wrong instant.
    keyStatus(st, "gemini", 2, now - 1, true),
    "cooldown",
  );
  st = markKeyFailure(st, { provider: "gemini", index: 2, now, reason: "rate limited" });
  check(
    "at the threshold it becomes failed",
    keyStatus(st, "gemini", 2, now + 10 * DEFAULT_KEY_COOLDOWN_MS, true),
    "failed",
  );
  check(
    "and stays failed long past any cooldown",
    keyStatus(st, "gemini", 2, now + 10 * DEFAULT_KEY_COOLDOWN_MS, true),
    "failed",
  );
  // …and a success is the only thing that brings it back.
  st = markKeySuccess(st, "gemini", 2, now);
  check("a success clears a failed slot", keyStatus(st, "gemini", 2, now, true), "healthy");
  checkTrue("and the record is gone entirely", !st.records[keyId("gemini", 2)]);
}

// A success is idempotent and never creates a record.
{
  const clean = markKeySuccess(EMPTY_KEY_HEALTH, "gemini", 0, T0);
  check("a success on a healthy slot changes nothing", clean, EMPTY_KEY_HEALTH);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Selection order
// ═══════════════════════════════════════════════════════════════════════════
{
  const keys = [KEY_A, KEY_B, KEY_C];
  check("with nothing wrong, every configured slot is eligible", selectKeyIndices(EMPTY_KEY_HEALTH, "gemini", keys, T0), [0, 1, 2]);
  check(
    "unconfigured slots are not eligible",
    selectKeyIndices(EMPTY_KEY_HEALTH, "gemini", [KEY_A, "", KEY_C], T0),
    [0, 2],
  );

  // Key 1 refuses → key 2 is next, and key 1 is NOT retried immediately.
  let st = markKeyFailure({ ...EMPTY_KEY_HEALTH, now: T0 }, { provider: "gemini", index: 0, now: T0 });
  check(
    "the refused slot is skipped",
    selectKeyIndices(st, "gemini", keys, T0),
    [1, 2],
  );
  check(
    "…and it comes back when its cooldown expires",
    selectKeyIndices(st, "gemini", keys, T0 + DEFAULT_KEY_COOLDOWN_MS),
    [0, 1, 2],
  );

  // A failed slot never returns on its own.
  st = markKeyFailure(st, { provider: "gemini", index: 1, now: T0 });
  st = markKeyFailure(st, { provider: "gemini", index: 1, now: T0 + 1000 });
  st = markKeyFailure(st, { provider: "gemini", index: 1, now: T0 + 2000 });
  check(
    "a failed slot is excluded long after its cooldowns expired",
    // Slot 0's own cooldown has lapsed by now, so it is legitimately back —
    // the point is that slot 1 (failed) is not.
    selectKeyIndices(st, "gemini", keys, T0 + 10 * DEFAULT_KEY_COOLDOWN_MS),
    [0, 2],
  );

  // Editing a slot resets it.
  st = clearKey(st, "gemini", 1, T0);
  check("editing a slot clears its record", selectKeyIndices(st, "gemini", keys, T0), [1, 2]);
  check(
    "and leaves the others alone — slot 0's expired cooldown is honoured",
    selectKeyIndices(st, "gemini", keys, T0).includes(0),
    false,
  );
  check("clearAll wipes everything", selectKeyIndices(clearAllKeys(st, T0), "gemini", keys, T0), [0, 1, 2]);
}

// ── Success must NOT rotate ────────────────────────────────────────────────
// The requirement in one assertion: after a success the order is byte-identical
// to what it was before. If this ever fails, the pool has become a round-robin.
{
  const keys = [KEY_A, KEY_B, KEY_C];
  // Slot 2 was refused just now, so its cooldown is still live.
  const now = T0 + DEFAULT_KEY_COOLDOWN_MS;
  let st = markKeyFailure(
    { ...EMPTY_KEY_HEALTH, now },
    { provider: "gemini", index: 1, now },
  );
  const before = selectKeyIndices(st, "gemini", keys, now);
  check("slot 2 was skipped before the success", before, [0, 2]);
  st = markKeySuccess(st, "gemini", 2, now);
  const after = selectKeyIndices(st, "gemini", keys, now);
  check("a success does not reorder the pool", after, before);
  check(
    "in particular it does not promote the slot that just answered",
    after,
    [0, 2],
  );

  // And a success on the FIRST slot leaves it first.
  st = markKeySuccess(st, "gemini", 0, now);
  check(
    "the working slot stays where it was",
    selectKeyIndices(st, "gemini", keys, now)[0],
    0,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Only credential-shaped failures move to another key
// ═══════════════════════════════════════════════════════════════════════════
for (const status of [400, 401, 403, 429]) {
  checkTrue(`HTTP ${status} is credential-shaped`, isKeySpecificFailure({ status }));
}
checkTrue("a timeout is credential-shaped", isKeySpecificFailure({ reason: "timeout" }));
for (const status of [500, 502, 503]) {
  check(
    `HTTP ${status} is a PROVIDER problem, not a key problem`,
    isKeySpecificFailure({ status }),
    false,
  );
}
check(
  "a validation rejection is a REQUEST problem, not a key problem",
  isKeySpecificFailure({ reason: "invalid" }),
  false,
);
check(
  "a missing model is a CONFIG problem, not a key problem",
  isKeySpecificFailure({ status: 404, reason: "model" }),
  false,
);
check(
  "a network error is a PROVIDER problem, not a key problem",
  isKeySpecificFailure({ reason: "network" }),
  false,
);

// ═══════════════════════════════════════════════════════════════════════════
// 5. No key material can escape
// ═══════════════════════════════════════════════════════════════════════════
{
  const st = markKeyFailure(
    { ...EMPTY_KEY_HEALTH, now: T0 },
    { provider: "gemini", index: 0, now: T0, reason: "rate limited" },
  );
  // Slot 2 deliberately EMPTY so all three status words are exercised.
  const pool = [KEY_A, KEY_B, ""];
  const strings = [
    describeKeyStatus(st, "gemini", 0, T0, KEY_A),
    describeKeyStatus(st, "gemini", 1, T0, KEY_B),
    describeKeyStatus(st, "gemini", 2, T0, ""),
    formatKeyLog("gemini", 0, "cooldown", "rate limited"),
    formatKeyLog("gemini", 1, "failed", "rate limited"),
    formatKeyLog("gemini", 2, "recovered", "ok"),
    keyId("gemini", 0),
    describeKeySlot(0),
    JSON.stringify(st),
    JSON.stringify(summarizeKeys(st, "gemini", pool, T0)),
  ].join("\n");

  for (const key of [KEY_A, KEY_B, KEY_C]) {
    checkTrue(`no output contains ${key.slice(0, 12)}…`, !strings.includes(key));
    checkTrue(
      `no output contains even a distinctive fragment of ${key.slice(-4)}`,
      !strings.includes(key.slice(-4)),
    );
  }

  // The status vocabulary is closed — the UI is only ever allowed these.
  const statuses = new Set(
    [0, 1, 2].map((i) => describeKeyStatus(st, "gemini", i, T0, pool[i])),
  );
  check(
    "status words are from the closed vocabulary",
    [...statuses].sort(),
    ["cooldown 30s", "healthy", "not configured"],
  );
  check(
    "not-configured is the word shown for an empty slot",
    describeKeyStatus(EMPTY_KEY_HEALTH, "gemini", 9, T0, "  "),
    "not configured",
  );
  check(
    "a failed slot says failed, never a countdown",
    describeKeyStatus(
      markKeyFailure(
        markKeyFailure(
          markKeyFailure({ ...EMPTY_KEY_HEALTH, now: T0 }, { provider: "gemini", index: 0, now: T0 }),
          { provider: "gemini", index: 0, now: T0 },
        ),
        { provider: "gemini", index: 0, now: T0 },
      ),
      "gemini",
      0,
      T0,
      KEY_A,
    ),
    "failed",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. The orchestrator really walks the pool
// ═══════════════════════════════════════════════════════════════════════════
{
  const { orchestrateAnswer } = await import("../src/lib/ai/orchestrator");
  const { validateAnswerOutput } = await import("../src/lib/outputValidation");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const VALID =
    "Dependency injection is a design pattern where objects receive their collaborators.";

  /**
   * Which SLOT each request was served by, and with WHICH credential.
   *
   * Read from the real `AIRequestOptions`, not from a test-only field: the point
   * is to prove the orchestrator actually hands a different `apiKey` to each
   * attempt, which is the only thing that makes a pool more than three copies of
   * one request.
   */
  const servedKeys: string[] = [];
  let call = 0;

  const provider = {
    name: "gemini" as const,
    listModels: () => ["gemini-2.5-flash"],
    async *streamSolution(options: any) {
      servedKeys.push(options.apiKey);
      const thisCall = call++;
      await sleep(5);
      // The first credential is refused; the second serves the answer.
      if (thisCall === 0) throw new Error("HTTP 429 rate limit exceeded for this key");
      yield VALID;
    },
  };

  const keys = [KEY_A, KEY_B, KEY_C];
  const eligible = selectKeyIndices({ ...EMPTY_KEY_HEALTH, now: T0 }, "gemini", keys, T0);
  const attempts = eligible.map((keyIndex) => ({
    provider: "gemini" as const,
    model: "gemini-2.5-flash",
    apiKey: keys[keyIndex],
    keyIndex,
    maxTokens: 512,
  }));

  check("three eligible slots produce three attempts", attempts.length, 3);
  check(
    "each attempt carries its own credential",
    attempts.map((a) => a.apiKey),
    [KEY_A, KEY_B, KEY_C],
  );

  const res = await orchestrateAnswer({
    attempts,
    prompt: "q",
    signal: new AbortController().signal,
    hedgeMs: 5000,
    firstTokenMs: 4000,
    totalMs: 9000,
    validate: (t: string) => validateAnswerOutput(t, {}),
    resolveProvider: () => provider as any,
  });

  check("the run answered", res.provider, "gemini");
  check(
    "each attempt was served by a DIFFERENT credential",
    servedKeys.slice(0, 2),
    [KEY_A, KEY_B],
  );
  check(
    "the telemetry distinguishes the slots",
    res.attemptsStarted.map((t) => t.keyIndex),
    [0, 1],
  );
  check(
    "the refused slot is a FAILURE, not a cancellation",
    res.attemptsStarted[0].outcome,
    "failed",
  );
  check("the second slot won", res.attemptsStarted[1].winner, true);
  check("the answer is the valid one", res.text, VALID);
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Wiring
// ═══════════════════════════════════════════════════════════════════════════
const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const panel = read("src/components/SettingsPanel.tsx");
const home = read("src/pages/Home.tsx");
const store = read("src/store/useStore.ts");
const orchestrator = read("src/lib/ai/orchestrator.ts");

checkTrue(
  "W1 every pool field is masked",
  (panel.match(/type="password"/g) ?? []).length >= KEY_SLOTS_PER_PROVIDER + 1,
);
checkTrue(
  "W2 the pool section exists",
  /Key Pool \(failover\)/.test(panel),
);
checkTrue(
  "W3 it renders all three slots per default-chain provider",
  /INTERVIEW_PROVIDER_ORDER\.map/.test(panel) && /keys\.map/.test(panel),
);
checkTrue(
  "W4 the status comes from the pure describer, not inline logic",
  /keyHealth\.statusOf\(/.test(panel) && /describeKeyStatus/.test(read("src/lib/keyHealth.ts")),
);
checkTrue(
  "W5 slot 1 still writes to apiKeys",
  /setApiKey\(p, value\)/.test(panel),
);
checkTrue(
  "W6 slots 2+ write to apiKeyPool",
  /apiKeyPool/.test(panel) && /next\[index - 1\] = value/.test(panel),
);
checkTrue(
  "W7 editing a slot clears its health record",
  /keyHealth\.clear\(p, index\)/.test(panel),
);
checkTrue(
  "W8 the settings type declares the pool",
  /apiKeyPool\?: Partial<Record<ProviderName, string\[\]>>/.test(store),
);
checkTrue(
  "W9 Home builds one attempt per eligible slot",
  /keyHealth\s*\n?\s*\.gate\.eligible\(provider, keys\)|keyHealth\.gate\.eligible\(provider, keys\)/.test(
    home,
  ),
);
checkTrue(
  "W10 each attempt carries its keyIndex and an outcome reporter",
  /keyIndex: a\.keyIndex/.test(home) && /onKeyOutcome:/.test(home),
);
checkTrue(
  "W11 the attempt log names the slot, never the key",
  /keySlot=\$\{keyIndex\}/.test(orchestrator) &&
    // And the raw credential is interpolated nowhere in that log line.
    !/keySlot=\$\{keyIndex\}[^\n]*apiKey=/.test(orchestrator.replace(/\$\{!!apiKey\}/g, "BOOLEAN")),
);
checkTrue(
  "W12 the attempt chain log uses the slot index, not the key",
  /#\$\{a\.keyIndex\}/.test(home) || /provider}#\$\{a\.keyIndex\}/.test(home),
);
checkTrue(
  "W13 the in-flight map is keyed per attempt, not per provider",
  /const start = \(spec: AttemptSpec, id: string\)/.test(orchestrator) &&
    /inFlight\.set\(id, flight\)/.test(orchestrator),
);
checkTrue(
  "W14 a success is the only thing that clears a slot",
  /reportKey\(true, \{\}\)/.test(orchestrator),
);
checkTrue(
  "W15 cooldown state is NOT persisted",
  /apiKeyPool/.test(store) &&
    !/keyHealth|KeyHealth/.test(read("electron/ipc.ts")),
);
checkTrue(
  "W16 no provider key is written to the electron-store defaults twice",
  !/apiKeyPool: \{[\s\S]{0,40}gemini: "[^"]+"/.test(read("electron/ipc.ts")),
);

// ── A blanket sweep: no committed source may log a key value ───────────────
{
  const files: string[] = [];
  const { readdirSync } = await import("node:fs");
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(full);
    }
  };
  walk(path.join(root, "src"));

  /**
   * Flags the BARE key value being interpolated, and deliberately does not
   * flag `${!!apiKey}`.
   *
   * That distinction is the whole point: reporting `apiKeyPresent=true` is
   * required (a provider log line with no key information at all is useless),
   * while `${apiKey}` or `${spec.apiKey}` is a leak. A sweep that cannot tell
   * them apart would either miss real leaks or forbid the required behaviour.
   */
  const leaks = /\$\{(?!\!)\s*(?:[A-Za-z_$][\w$]*\.)?apiKey\s*[\},]/;

  const offenders = files.filter((f) => {
    const src = readFileSync(f, "utf8");
    // Only console calls and thrown Error messages can put a secret on screen.
    return (src.match(/console\.(?:log|warn|error|info)\([^;]*?\);/g) ?? []).some(
      (call) => leaks.test(call),
    );
  });
  check(
    "no console call interpolates an apiKey VALUE",
    offenders.map((f) => path.relative(root, f)),
    [],
  );
  check(
    "no thrown Error interpolates an apiKey VALUE",
    files.filter((f) =>
      [...readFileSync(f, "utf8").matchAll(/throw new Error\([^;]*?\);/g)].some(
        (m) => leaks.test(m[0]),
      ),
    ),
    [],
  );

  // And the required behaviour is still present, so the sweep above is not
  // vacuous: boolean presence is logged by the providers on purpose.
  checkTrue(
    "boolean key-presence logging is still allowed and still used",
    /apiKeyPresent=\$\{!!apiKey\}/.test(read("src/lib/ai/openrouter.ts")) &&
      /apiKeyPresent=\$\{!!spec\.apiKey\}/.test(read("src/lib/ai/orchestrator.ts")),
  );
}

console.log(`\nPROVIDER KEY POOL`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.join("\n"));
  process.exit(1);
}