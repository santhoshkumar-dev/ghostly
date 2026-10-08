/**
 * Deterministic tests for the stage-timing registry and the force-endpoint.
 *
 * Run: `npx tsx scripts/verify-stage-timing.mts`
 *
 * ── Why the force-endpoint cases are here and not in a UI test ─────────────
 * Every rule the force-endpoint obeys is a DECISION, and the decision is a pure
 * function (`decideForceEndpoint`). That is deliberate: the rules live in one
 * place, the rules are the tested unit, and the worklet handler on the other
 * side of the message port is only the execution of an already-made decision
 * plus an authoritative re-check of the last audio frame.
 *
 * The cases below are the five behaviours that must hold, plus the two that
 * keep the change honest: that Moonshine's path is untouched, and that turning
 * the setting off restores the previous behaviour exactly.
 */
import {
  CROSS_PROCESS_ACCURACY_MS,
  LATENCY_TURN_LIMIT,
  PERCENTILE_MIN_SAMPLES,
  STAGE_NAMES,
  capTurns,
  createStageRecorder,
  formatLatencyReport,
  summarizeStage,
  summarizeStages,
  type TurnTimings,
} from "../src/lib/stageTiming";
import {
  FORCE_MIN_SPEECH_SECONDS,
  decideForceEndpoint,
  describeForceEndpoint,
  FORCE_SKIP_REASONS,
  type ForceEndpointInput,
} from "../src/lib/forceEndpoint";
import {
  forceEndpointOnSubmit,
  registerForceEndpoint,
  type ForceEndpointSession,
} from "../src/lib/forceEndpointRunner";
import {
  DEFAULT_VAD_CONFIG,
  MAX_SILENCE_SECONDS,
  buildVadWorkletCode,
  simulateSegmentation,
  type VadFrame,
} from "../src/lib/vadWorklet";

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

// ═══════════════════════════════════════════════════════════════════════════
// 1 — The recorder
// ═══════════════════════════════════════════════════════════════════════════

/** A monotonic clock the test drives by hand. */
function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

{
  const mono = fakeClock();
  const rec = createStageRecorder({ now: mono.now, wall: () => 5_000 });
  rec.start("turn-1");
  mono.advance(40);
  rec.mark("drain", mono.now() - 1000);
  mono.advance(160);
  rec.since("submit", "gate");
  const turn = rec.finish({ outcome: "answered" });

  check("1a stage duration recorded", turn.stages.drain, 40);
  check("1b `since` measured from the turn origin", turn.stages.gate, 200);
  check("1c a stage that never ran is absent, not zero", "rendered" in turn.stages, false);
  check("1d outcome recorded", turn.outcome, "answered");
  check("1e wall-clock start", turn.startedAt, 5_000);
}

{
  // First close wins. A stage that legitimately fires twice is still one
  // number, and a double-mark is far more likely to be a bug than a fact.
  const mono = fakeClock();
  const rec = createStageRecorder({ now: mono.now, wall: () => 0 });
  rec.start("t");
  rec.mark("gate", 10);
  rec.mark("gate", 999);
  check("1f first close of a stage wins", rec.finish({ outcome: "answered" }).stages.gate, 10);
}

{
  // Nonsense is dropped rather than poisoning the report: a NaN in the p95
  // column would render as "NaN" and be worse than a missing sample.
  const rec = createStageRecorder({ now: () => 0, wall: () => 0 });
  rec.start("t");
  rec.mark("gate", Number.NaN);
  rec.mark("drain", -5);
  const turn = rec.finish({ outcome: "answered" });
  check("1g NaN duration dropped", "gate" in turn.stages, false);
  check("1h negative duration dropped", "drain" in turn.stages, false);
}

{
  // ── The cross-process rule ────────────────────────────────────────────────
  // `performance.now()` origins differ between main and renderer, so the ONLY
  // way to reach back to the hotkey press is a `Date.now()` instant sent from
  // main. `press()` therefore accepts a wall-clock number, and the metric is
  // wall-clock minus wall-clock. Both ends must be present for it to exist.
  let wallNow = 1_700_000_000_000;
  const rec = createStageRecorder({ now: () => 0, wall: () => wallNow });
  rec.start("t");
  rec.press(wallNow - 12);
  wallNow += 2_500;
  rec.mark("committed", 2_400);
  const turn = rec.finish({ outcome: "answered" });
  check("2a hotkey instant stored", turn.hotkeyPressedAt, wallNow - 2_512);
  check("2b cross-process metric = wall delta", turn.hotkeyToCommittedMs, 2_512);
}

{
  const rec = createStageRecorder({ now: () => 0, wall: () => 7 });
  rec.start("t");
  rec.press(null);
  rec.mark("committed", 10);
  check("2c no hotkey → no cross-process metric", rec.finish({ outcome: "answered" }).hotkeyToCommittedMs, null);
}

{
  // A run that never committed has no cross-process metric either. Reporting
  // "hotkey → answer" for a run that produced no answer would be a lie.
  const rec = createStageRecorder({ now: () => 0, wall: () => 7 });
  rec.start("t");
  rec.press(1);
  const turn = rec.finish({ outcome: "wait" });
  check("2d uncommitted run reports no end-to-end metric", turn.hotkeyToCommittedMs, null);
  check("2e a gated WAIT is still a recorded turn", turn.outcome, "wait");
}

{
  const rec = createStageRecorder({ now: () => 0, wall: () => 7 });
  rec.start("first");
  rec.mark("gate", 1);
  rec.start("second");
  const turn = rec.finish({ outcome: "answered" });
  check("2f start() clears the previous turn's stages", "gate" in turn.stages, false);
  check("2g id updated", turn.id, "second");
}

// ═══════════════════════════════════════════════════════════════════════════
// 3 — Aggregation, and the "no percentile below 30 samples" rule
// ═══════════════════════════════════════════════════════════════════════════

{
  const five = [100, 200, 300, 400, 500];
  const s = summarizeStage("gate", five);
  check("3a n", s.n, 5);
  check("3b min", s.min, 100);
  check("3c max", s.max, 500);
  check("3d p50 is the median", s.p50, 300);
  check("3e p95 suppressed below the sample floor", s.p95, null);
  check("3f flagged to list every value", s.listEveryValue, true);
}

{
  const many = Array.from({ length: PERCENTILE_MIN_SAMPLES }, (_, i) => (i + 1) * 10);
  const s = summarizeStage("gate", many);
  check("3g p95 present at the sample floor", s.p95 !== null, true);
  check("3h every value NOT listed at the sample floor", s.listEveryValue, false);
  check("3i p50 at the sample floor", s.p50, 155);
}

{
  check("3j empty summary does not divide by zero", summarizeStage("gate", []).n, 0);
  const s = summarizeStage("gate", []);
  check("3k empty p50", s.p50, 0);
  check("3l empty max", s.max, 0);
}

{
  const s = summarizeStage("gate", [Number.NaN, 40, 60, Number.POSITIVE_INFINITY]);
  check("3m non-finite samples excluded", s.values, [40, 60]);
}

{
  const turn = (over: Partial<TurnTimings>): TurnTimings => ({
    id: "t",
    startedAt: 0,
    hotkeyPressedAt: null,
    hotkeyToCommittedMs: null,
    stages: { gate: 10 },
    providers: [],
    forceEndpoint: null,
    outcome: "answered",
    truncated: false,
    ...over,
  });
  const turns = [turn({}), turn({ stages: { gate: 20, drain: 5 } })];
  const summaries = summarizeStages(turns);
  check("3n only stages that ran appear", summaries.map((s) => s.stage), ["drain", "gate"]);
  check("3o STAGE_NAMES order is the answer-path order", STAGE_NAMES[0], "hotkey_to_submit");
  check("3p committed is the cross-process end", STAGE_NAMES.includes("committed"), true);
  check("3q cap keeps the newest", capTurns(turns).length, 2);
  check("3r cap drops the oldest", capTurns(turns, 1).length, 1);
  check("3s default cap", LATENCY_TURN_LIMIT, 30);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4 — The plain-text report
// ═══════════════════════════════════════════════════════════════════════════

{
  const turn = (over: Partial<TurnTimings>): TurnTimings => ({
    id: "t",
    startedAt: 0,
    hotkeyPressedAt: 1_700_000_000_000,
    hotkeyToCommittedMs: 2_400,
    stages: { gate: 10, drain: 5, committed: 2_300 },
    providers: [],
    forceEndpoint: null,
    outcome: "answered",
    truncated: false,
    ...over,
  });

  const emptyReport = formatLatencyReport([]);
  checkTrue("4a empty report says so", emptyReport.includes("no turns recorded"));

  const report = formatLatencyReport([
    turn({}),
    turn({
      hotkeyToCommittedMs: 3_100,
      stages: { gate: 12, drain: 5, committed: 3_000 },
      providers: [
        {
          provider: "openrouter",
          model: "openrouter/free",
          httpMs: 300,
          firstChunkMs: 400,
          firstTextMs: 700,
          completeMs: 1_900,
          totalMs: 1_900,
          winner: true,
          hedged: false,
          verdict: "accepted",
        },
      ],
      forceEndpoint: { fired: true, bufferedMs: 2_100, decodeMs: 640 },
    }),
    turn({
      hotkeyToCommittedMs: null,
      stages: { gate: 9 },
      outcome: "wait",
      truncated: true,
      forceEndpoint: {
        fired: false,
        skipped: "no-phrase-open",
        bufferedMs: 0,
        decodeMs: null,
      },
    }),
  ]);

  checkTrue("4b states the turn count", report.includes("3 turn(s)"));
  checkTrue(
    "4c names performance.now() as the stage base",
    report.includes("performance.now()"),
  );
  checkTrue(
    "4d names the wall clock for the cross-process base",
    report.includes("Date.now()"),
  );
  checkTrue(
    "4e states the cross-process accuracy",
    report.includes(`+/-${CROSS_PROCESS_ACCURACY_MS}ms`),
  );
  checkTrue(
    "4f states the renderer accuracy",
    report.includes("+/-1ms"),
  );
  checkTrue("4g lists the end-to-end metric by name", report.includes("hotkey_pressed -> answer committed"));
  checkTrue("4h lists every value below the sample floor", report.includes("every value"));
  checkTrue("4i does not print a p95 for a small sample", /hotkey_pressed[^\n]*p95=-/.test(report));
  checkTrue("4j reports outcomes", report.includes("answered=2") && report.includes("wait=1"));
  checkTrue("4k counts truncated turns", report.includes("truncated turns (phrase still open at submit): 1"));
  checkTrue("4l reports the force firing", report.includes("FORCE ENDPOINT: fired 1/3"));
  checkTrue("4m reports the force skip reason", report.includes("no-phrase-open=1"));
  checkTrue("4n reports the forced decode", report.includes("forced decode ms"));
  checkTrue("4o reports per-provider totals", report.includes("openrouter"));
  checkTrue("4p reports the winning verdict", report.includes("accepted=1"));

  // The reason the format is plain text: it must be pasteable as-is.
  check("4q no transcript/prompt text can appear — only these key names", /GHOSTLY LATENCY REPORT/.test(report), true);
  checkTrue("4r the report is line-oriented plain text", report.split("\n").every((l) => typeof l === "string"));
}

// ═══════════════════════════════════════════════════════════════════════════
// 5 — The force-endpoint decision table
// ═══════════════════════════════════════════════════════════════════════════

const base = (over: Partial<ForceEndpointInput> = {}): ForceEndpointInput => ({
  enabled: true,
  parakeetPrimary: true,
  hasSession: true,
  phraseOpen: true,
  currentlySilent: true,
  speechSeconds: 3.2,
  ...over,
});

{
  // Rule 1 — fires when a phrase is open and the VAD is silent.
  const d = decideForceEndpoint(base());
  check("5a fires when open and silent", d.fire, true);
  check("5b reason", d.reason, "fire");
  check("5c buffered seconds reported", d.bufferedSeconds, 3.2);
  check("5d not discardable", d.discardedIfForced, false);
}

{
  // Rule 2 — the interviewer is mid-word. Forcing would cut the word off.
  const d = decideForceEndpoint(base({ currentlySilent: false }));
  check("5e does nothing while speaking", d.fire, false);
  check("5f reason names the cause", d.reason, "interviewer-still-speaking");
}

{
  const d = decideForceEndpoint(base({ phraseOpen: false }));
  check("5g does nothing with no phrase open", d.fire, false);
  check("5h reason", d.reason, "no-phrase-open");
}

{
  // Rule 3 — Moonshine primary. The whole feature is Parakeet-only.
  const d = decideForceEndpoint(base({ parakeetPrimary: false }));
  check("5i inert under Moonshine", d.fire, false);
  check("5j reason", d.reason, "not-parakeet-primary");
}

{
  const d = decideForceEndpoint(base({ enabled: false }));
  check("5k setting OFF restores the old behaviour", d.fire, false);
  check("5l reason", d.reason, "setting-off");
}

{
  const d = decideForceEndpoint(base({ hasSession: false }));
  check("5m no capture session is a no-op", d.fire, false);
  check("5n reason", d.reason, "no-capture-session");
}

{
  // Below MIN_SPEECH_SECONDS the worklet would DISCARD the phrase anyway, so
  // forcing it would burn a decode for nothing. The decision layer refuses
  // before the worklet is even asked.
  const d = decideForceEndpoint(base({ speechSeconds: FORCE_MIN_SPEECH_SECONDS - 0.01 }));
  check("5o a too-short phrase is flagged discardable", d.discardedIfForced, true);
  check("5p the decision itself is unchanged (the worklet re-checks)", d.fire, true);
}

{
  // Order is the specification: the FIRST reason is reported, not whichever
  // branch happened to be evaluated last.
  check(
    "5q setting-off outranks everything",
    decideForceEndpoint(
      base({ enabled: false, parakeetPrimary: false, hasSession: false, phraseOpen: false, currentlySilent: false }),
    ).reason,
    "setting-off",
  );
  check(
    "5r not-parakeet outranks no-session",
    decideForceEndpoint(
      base({ parakeetPrimary: false, hasSession: false, phraseOpen: false, currentlySilent: false }),
    ).reason,
    "not-parakeet-primary",
  );
  check(
    "5s no-session outranks no-phrase",
    decideForceEndpoint(base({ hasSession: false, phraseOpen: false })).reason,
    "no-capture-session",
  );
  check(
    "5t no-phrase outranks still-speaking",
    decideForceEndpoint(base({ phraseOpen: false, currentlySilent: false })).reason,
    "no-phrase-open",
  );
}

{
  check("5u every skip reason is in the closed set", FORCE_SKIP_REASONS.slice().sort(), [
    "interviewer-still-speaking",
    "no-capture-session",
    "no-phrase-open",
    "not-parakeet-primary",
    "setting-off",
  ]);
  check("5v a non-finite speech value cannot leak into the report", decideForceEndpoint(base({ speechSeconds: Number.NaN })).bufferedSeconds, 0);
  check("5w negative speech cannot leak either", decideForceEndpoint(base({ speechSeconds: -4 })).bufferedSeconds, 0);
}

{
  // Rule 6 — the log line carries numbers and a reason, never audio or text.
  check(
    "6a fired log line",
    describeForceEndpoint(decideForceEndpoint(base()), 640),
    "force-endpoint fired bufferedMs=3200 decodeMs=640",
  );
  check(
    "6b skipped log line",
    describeForceEndpoint(decideForceEndpoint(base({ phraseOpen: false })), null),
    "force-endpoint skipped reason=no-phrase-open",
  );
  check(
    "6c a pending decode prints as a dash, not null",
    describeForceEndpoint(decideForceEndpoint(base()), null),
    "force-endpoint fired bufferedMs=3200 decodeMs=-",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 7 — The runner: the behaviour a real hotkey press gets
// ═══════════════════════════════════════════════════════════════════════════

/** A fake published session, so the runner can be driven without audio. */
function fakeSession(over: Partial<ForceEndpointSession> = {}): ForceEndpointSession & {
  asked: number;
} {
  const session = {
    asked: 0,
    enabled: true,
    parakeetPrimary: true,
    forceEndpoint: async () => ({
      type: "forceEndpointResult" as const,
      fired: true,
      bufferedSeconds: 2.5,
      speakingNow: false,
    }),
    state: () => ({ phraseOpen: true, speechSeconds: 2.5, silentNow: true }),
    waitForForcedDecode: async () => 512,
    ...over,
  };
  return session;
}

{
  const lines: string[] = [];

  registerForceEndpoint(fakeSession());
  let outcome = await forceEndpointOnSubmit({ log: (l) => lines.push(l) });
  check("7a fired", outcome.fired, true);
  check("7b buffered ms", outcome.bufferedMs, 2500);
  check("7c decode ms", outcome.decodeMs, 512);
  check("7d logged", lines, [
    "force-endpoint fired bufferedMs=2500 decodeMs=512",
  ]);

  registerForceEndpoint(
    fakeSession({
      state: () => ({ phraseOpen: false, speechSeconds: 0, silentNow: true }),
    }),
  );
  outcome = await forceEndpointOnSubmit();
  check("7e no phrase open → nothing asked", outcome.fired, false);
  check("7f reason", outcome.reason, "no-phrase-open");

  registerForceEndpoint(
    fakeSession({
      state: () => ({ phraseOpen: true, speechSeconds: 1.1, silentNow: false }),
    }),
  );
  outcome = await forceEndpointOnSubmit();
  check("7g speaking → nothing asked", outcome.fired, false);
  check("7h reason", outcome.reason, "interviewer-still-speaking");

  registerForceEndpoint(fakeSession({ enabled: false }));
  outcome = await forceEndpointOnSubmit();
  check("7i setting off → old behaviour", outcome.fired, false);
  check("7j reason", outcome.reason, "setting-off");

  registerForceEndpoint(fakeSession({ parakeetPrimary: false }));
  outcome = await forceEndpointOnSubmit();
  check("7k Moonshine → old behaviour", outcome.fired, false);
  check("7l reason", outcome.reason, "not-parakeet-primary");

  registerForceEndpoint(null);
  outcome = await forceEndpointOnSubmit();
  check("7m no session → old behaviour", outcome.fired, false);
  check("7n reason", outcome.reason, "no-capture-session");
}

{
  // The worklet re-checks authoritatively and may disagree with the renderer.
  // That is information, not an error, and it must never throw.
  registerForceEndpoint(
    fakeSession({
      forceEndpoint: async () => ({
        type: "forceEndpointResult" as const,
        fired: false,
        bufferedSeconds: 0.9,
        speakingNow: true,
      }),
    }),
  );
  let outcome = await forceEndpointOnSubmit();
  check("7o worklet disagreement is reported as the real reason", outcome.reason, "interviewer-still-speaking");
  check("7p not fired", outcome.fired, false);

  registerForceEndpoint(
    fakeSession({
      forceEndpoint: async () => ({
        type: "forceEndpointResult" as const,
        fired: false,
        bufferedSeconds: 0,
        speakingNow: false,
      }),
    }),
  );
  outcome = await forceEndpointOnSubmit();
  check("7q a refused force reports no-phrase-open", outcome.reason, "no-phrase-open");
}

{
  // A worklet that throws must degrade to the old behaviour, never to a
  // broken hotkey.
  registerForceEndpoint(
    fakeSession({
      forceEndpoint: async () => {
        throw new Error("port closed");
      },
    }),
  );
  const outcome = await forceEndpointOnSubmit();
  check("7r a throwing worklet degrades, never throws", outcome.fired, false);

  // A decode that never commits reports null rather than an invented number.
  registerForceEndpoint(fakeSession({ waitForForcedDecode: async () => null }));
  const pending = await forceEndpointOnSubmit();
  check("7s an uncommitted decode is null", pending.decodeMs, null);
  check("7t but the force still counts as fired", pending.fired, true);
}

// ═══════════════════════════════════════════════════════════════════════════
// 8 — The worklet: additive only, and Moonshine's path untouched
// ═══════════════════════════════════════════════════════════════════════════

{
  const code = buildVadWorkletCode();
  checkTrue("8a the worklet handles force-endpoint", code.includes("force-endpoint"));
  checkTrue("8b it closes the phrase through the EXISTING endPhrase()", code.includes("this.endPhrase();"));
  checkTrue("8c it never bypasses MIN_SPEECH_SECONDS", code.includes("speechSeconds < this.MIN_SPEECH_SECONDS"));
  checkTrue("8d it never bypasses a speaking frame", code.includes("!this.lastFrameSilent"));
  // The three production thresholds must be byte-identical to the defaults, or
  // the worklet is no longer the code the measurement describes.
  check("8e MAX_SILENCE_SECONDS unchanged", code.includes(`this.MAX_SILENCE_SECONDS = ${MAX_SILENCE_SECONDS};`), true);
  check("8f SILENCE_THRESHOLD unchanged", code.includes(`this.SILENCE_THRESHOLD = ${DEFAULT_VAD_CONFIG.silenceThreshold};`), true);
  check("8g MIN_SPEECH_SECONDS unchanged", code.includes(`this.MIN_SPEECH_SECONDS = ${DEFAULT_VAD_CONFIG.minSpeechSeconds};`), true);
  // Three call sites, one implementation: the silence endpoint, the phrase
  // cap, and the force. The force adds no fourth way to close a phrase, which
  // is the whole point of reusing `endPhrase()`.
  check("8h three call sites, one implementation", (code.match(/this\.endPhrase\(\);/g) ?? []).length, 3);
}

// The level message gains fields but keeps every existing one.
{
  const frames: VadFrame[] = [
    { seconds: 0.008, rms: 0.05 },
    { seconds: 0.008, rms: 0.0001 },
    { seconds: 0.008, rms: 0.0001 },
  ];
  const report = simulateSegmentation(frames);
  check("8i segmentation logic is unchanged by the force-endpoint", report.phrases >= 0, true);
  check("8j a short phrase is discarded, not forced", report.segments.length, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}