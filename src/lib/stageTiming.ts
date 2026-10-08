/**
 * Stage timing for the answer path — the measurement instrument Phase 8.1
 * never had.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Before this file the only numbers that reached a human were the Parakeet
 * load breakdown and the ASR comparison grid, both in the Debug panel. Every
 * AI-side timing was computed and then thrown at `console.log`, and nothing
 * survived the turn that produced it. There was no way to answer "how long
 * from the hotkey to an answer, and which stage spent it", which is the only
 * question worth asking when an answer feels slow.
 *
 * ── Timing accuracy (the rule that shapes this whole file) ────────────────
 * `performance.now()` has a DIFFERENT ORIGIN in the main process, in each
 * renderer, and in the Node utility process. Subtracting a main-process
 * `performance.now()` from a renderer one produces a plausible-looking number
 * that is meaningless. So:
 *
 *   • Every DURATION is computed INSIDE one process, from `performance.now()`
 *     deltas taken there. Durations never cross a process boundary.
 *   • The only values that cross a boundary are single wall-clock INSTANTS
 *     (`Date.now()`), used to anchor the cross-process ends of a metric.
 *     `Date.now()` is the same clock everywhere on one machine, so a
 *     cross-process difference is meaningful to within the resolution of the
 *     underlying system clock — which is the accuracy we state in the report.
 *
 * The answer path is entirely inside the renderer, so every stage below is a
 * renderer-local `performance.now()` delta. The one cross-process metric is
 * `hotkey_pressed -> answer committed`, which spans main → renderer.
 * For that, main sends `pressedAt: Date.now()` and the renderer subtracts it
 * from its own `Date.now()` at the moment the answer is committed; the report
 * states the resulting accuracy rather than pretending it is sub-millisecond.
 *
 * ── What is deliberately NOT here ─────────────────────────────────────────
 * No transcript text, no prompt text, no provider key, no question, no answer.
 * A timing record is numbers and short enum-ish reasons only, so the whole
 * report can be pasted into an issue or a chat without a redaction pass.
 */

/** How many turns the report keeps and summarises over. */
export const LATENCY_TURN_LIMIT = 30;

/**
 * Below this many samples a percentile is a restatement of the smallest value.
 *
 * With 5 samples "p95" is the maximum, printed as if it were a tail estimate.
 * So below this threshold the report prints every value and the maximum and
 * says nothing about percentiles at all.
 */
export const PERCENTILE_MIN_SAMPLES = 30;

/**
 * The accuracy we claim for a cross-process duration.
 *
 * Both ends are `Date.now()` on the same machine, so the error is the
 * resolution/jitter of the system clock across an IPC hop — order 1-5 ms, not
 * the 0.005 ms resolution `performance.now()` would give. Renderer-local
 * stages are far tighter than this.
 */
export const CROSS_PROCESS_ACCURACY_MS = 5;

/** Renderer-local `performance.now()` deltas are quoted as ±1 ms. */
export const LOCAL_ACCURACY_MS = 1;

/** Duration stages in the answer path, in the order they occur. */
export const STAGE_NAMES = [
  /** Hotkey received in the renderer → submit handler entered. */
  "hotkey_to_submit",
  /** Force-endpoint (if it fired): open phrase closed → decode committed. */
  "force_endpoint_decode",
  /** Submit handler entered → drain resolved. */
  "drain",
  /** Drain resolved → gate decided. */
  "gate",
  /** Gate decided → user prompt assembled. */
  "prompt_built",
  /** Prompt assembled → orchestration started. */
  "orchestration_start",
  /** Orchestration started → a provider's answer was accepted. */
  "provider_accepted",
  /** Provider accepted → the answer was committed to the store. */
  "committed",
  /** Committed → the answer card rendered. */
  "rendered",
] as const;

export type StageName = (typeof STAGE_NAMES)[number];

const STAGE_SET: ReadonlySet<string> = new Set(STAGE_NAMES);

export function isStageName(value: string): value is StageName {
  return STAGE_SET.has(value);
}

/** Why a run ended. Never carries text — only a closed set of reasons. */
export type RunOutcome =
  | "answered"
  | "wait"
  | "rejected"
  | "empty"
  | "duplicate"
  | "no-provider"
  | "aborted"
  | "superseded";

export const RUN_OUTCOMES: readonly RunOutcome[] = [
  "answered",
  "wait",
  "rejected",
  "empty",
  "duplicate",
  "no-provider",
  "aborted",
  "superseded",
];

/** Per-provider timings, mirrored from the orchestrator's own telemetry. */
export interface ProviderTiming {
  provider: string;
  model: string;
  /** attempt start → response headers. */
  httpMs: number | null;
  /** attempt start → first chunk of any kind. */
  firstChunkMs: number | null;
  /** attempt start → first MEANINGFUL text — the anti-hedge signal. */
  firstTextMs: number | null;
  /** attempt start → stream end. */
  completeMs: number | null;
  totalMs: number;
  /** Won the run (passed the validator and completed first). */
  winner: boolean;
  /** Started only because the previous provider was silent past the hedge. */
  hedged: boolean;
  /**
   * Rejection reason, or `"accepted"`. A closed vocabulary so the report can
   * stay free of model output — the same reasons the orchestrator classifies.
   */
  verdict: string;
}

/** Why the force-endpoint ran, or did not. */
export interface ForceEndpointTiming {
  /** The setting was on, Parakeet was primary, and a phrase was closed. */
  fired: boolean;
  /** Why not, when it did not fire. One of the `FORCE_SKIP_*` reasons. */
  skipped?: string;
  /** Speech milliseconds buffered in the open phrase at the moment of the press. */
  bufferedMs: number;
  /** Decode milliseconds for the forced phrase, when it fired. */
  decodeMs: number | null;
}

export const FORCE_SKIP_DISABLED = "setting-off";
export const FORCE_SKIP_NOT_PARAKEET = "not-parakeet-primary";
export const FORCE_SKIP_NO_PHRASE = "no-phrase-open";
export const FORCE_SKIP_SPEAKING = "interviewer-still-speaking";
export const FORCE_SKIP_NO_SESSION = "no-capture-session";

/** One turn's timings. Numbers and closed-vocabulary reasons only. */
import type { ShadowOverlap } from "./outputValidation";

export interface TurnTimings {
  id: string;
  /** `Date.now()` when the submit handler was entered. */
  startedAt: number;
  /**
   * `Date.now()` in the MAIN process when the hotkey was pressed, or null when
   * the run did not start from a hotkey (auto mode, Retry).
   */
  hotkeyPressedAt: number | null;
  /** Milliseconds from hotkey press to commit — null without a hotkey. */
  hotkeyToCommittedMs: number | null;
  /** Stage durations in ms. A stage that never ran is null, not 0. */
  stages: Partial<Record<StageName, number>>;
  providers: ProviderTiming[];
  forceEndpoint: ForceEndpointTiming | null;
  outcome: RunOutcome;
  /**
   * True when the run's transcript was missing its tail — the force-endpoint
   * did not fire and a phrase was still open. Counted, never acted on.
   */
  truncated: boolean;
  /**
   * Result of the SHADOW overlap rule (c), when one was computed. Numbers only.
   *
   * Recorded, aggregated in the report, and never consulted by anything that
   * decides whether an answer is shown — that is the entire point of shadow
   * mode.
   */
  shadow?: ShadowOverlap;
}

// ── The recorder ────────────────────────────────────────────────────────────

/**
 * A monotonic recorder for one turn.
 *
 * Holds its own `performance.now()` origin so every stage is a local delta.
 * `press()` accepts the main process' `Date.now()` separately, and that value
 * is only ever subtracted from another `Date.now()`.
 */
export interface StageRecorder {
  /** Begin the turn. `now` is injectable so tests are deterministic. */
  start(id: string): void;
  /** Record the main-process hotkey instant (wall clock, `Date.now()`). */
  press(pressedAt: number | null): void;
  /** Close a stage. The first close of a stage wins; later ones are ignored. */
  mark(stage: StageName, durationMs: number): void;
  /** Mark a stage relative to a previously recorded point on this recorder. */
  since(point: Point, stage: StageName): void;
  /** Wall-clock instant at which a named stage was closed. */
  at(stage: StageName): number | null;
  /** Close the turn. Computes the cross-process metric here, once. */
  finish(input: {
    outcome: RunOutcome;
    providers?: ProviderTiming[];
    forceEndpoint?: ForceEndpointTiming | null;
    truncated?: boolean;
    shadow?: ShadowOverlap;
  }): TurnTimings;
}

/** A point in the turn that can be used as a `since` reference. */
const POINTS = [
  "submit",
  "drain_done",
  "gate_done",
  "prompt_done",
  "orchestration_start",
  "accepted",
  "committed",
] as const;

type Point = (typeof POINTS)[number];

export interface StageRecorderOptions {
  /** Injectable monotonic clock. Tests supply a fake; production does not. */
  now?: () => number;
  /** Injectable wall clock. Defaults to `Date.now`. */
  wall?: () => number;
}

export function createStageRecorder(
  options: StageRecorderOptions = {},
): StageRecorder {
  const now = options.now ?? (() => performance.now());
  const wall = options.wall ?? (() => Date.now());

  let id = "";
  let origin = 0;
  let started = false;
  let hotkeyPressedAt: number | null = null;
  const stages: Partial<Record<StageName, number>> = {};
  const points = new Map<Point, number>();
  const wallPoints = new Map<Point, number>();

  const ensureStarted = () => {
    if (!started) {
      started = true;
      origin = now();
      points.set("submit", origin);
      wallPoints.set("submit", wall());
    }
  };

  return {
    start(nextId) {
      id = nextId;
      started = false;
      origin = 0;
      hotkeyPressedAt = null;
      for (const key of Object.keys(stages)) {
        delete stages[key as StageName];
      }
      points.clear();
      wallPoints.clear();
      ensureStarted();
    },

    press(pressedAt) {
      // Only a real wall-clock instant is stored. A monotonic value from
      // another process would be meaningless against `Date.now()` here.
      hotkeyPressedAt =
        typeof pressedAt === "number" && Number.isFinite(pressedAt)
          ? pressedAt
          : null;
    },

    mark(stage, durationMs) {
      ensureStarted();
      if (!isStageName(stage)) return;
      // First close wins: a stage that legitimately happens twice is still one
      // number in the report, and a double-mark is far more likely to be a bug.
      if (stages[stage] !== undefined) return;
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      stages[stage] = Math.round(durationMs);
      points.set(stage as unknown as Point, now());
      wallPoints.set(stage as unknown as Point, wall());
    },

    since(point, stage) {
      const from = points.get(point);
      if (from === undefined) return;
      this.mark(stage, now() - from);
    },

    at(stage) {
      return wallPoints.get(stage as unknown as Point) ?? null;
    },

    finish(input) {
      ensureStarted();
      const providers = input.providers ?? [];

      // The cross-process metric, computed once, wall clock to wall clock.
      const committedWall = wallPoints.get("committed");
      const hotkeyToCommittedMs =
        hotkeyPressedAt !== null && committedWall != null
          ? Math.max(0, committedWall - hotkeyPressedAt)
          : null;

      return {
        id,
        startedAt: wallPoints.get("submit") ?? wall(),
        hotkeyPressedAt,
        hotkeyToCommittedMs,
        stages: { ...stages },
        providers,
        forceEndpoint: input.forceEndpoint ?? null,
        outcome: input.outcome,
        truncated: input.truncated === true,
        shadow: input.shadow,
      };
    },
  };
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export interface StageSummary {
  stage: StageName;
  /** Samples that actually ran. */
  n: number;
  values: number[];
  min: number;
  max: number;
  /** Median. Always reported — meaningful at any n. */
  p50: number;
  /** Only present when `n >= PERCENTILE_MIN_SAMPLES`. */
  p95: number | null;
  /**
   * True when `n < PERCENTILE_MIN_SAMPLES`, so the report prints every value
   * instead of a percentile that would be a lie at this sample size.
   */
  listEveryValue: boolean;
}

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return Math.round(sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo));
}

export function summarizeStage(
  stage: StageName,
  values: number[],
): StageSummary {
  const clean = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  const n = clean.length;
  return {
    stage,
    n,
    values: clean,
    min: n ? clean[0] : 0,
    max: n ? clean[n - 1] : 0,
    p50: quantile(clean, 0.5),
    p95: n >= PERCENTILE_MIN_SAMPLES ? quantile(clean, 0.95) : null,
    listEveryValue: n < PERCENTILE_MIN_SAMPLES,
  };
}

/** Summarise every stage that ran at least once, in `STAGE_NAMES` order. */
export function summarizeStages(turns: TurnTimings[]): StageSummary[] {
  return STAGE_NAMES.map((stage) =>
    summarizeStage(
      stage,
      turns
        .map((t) => t.stages[stage])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
    ),
  ).filter((s) => s.n > 0);
}

/** Keep the most recent `limit` turns, newest last. */
export function capTurns(
  turns: TurnTimings[],
  limit: number = LATENCY_TURN_LIMIT,
): TurnTimings[] {
  if (turns.length <= limit) return turns.slice();
  return turns.slice(turns.length - limit);
}

// ── The plain-text report ───────────────────────────────────────────────────

const FIXED = (v: number) => String(v);

/**
 * Render the report as plain text.
 *
 * Numbers, stage names and closed-vocabulary reasons only: no transcript, no
 * prompt, no question, no answer, no key, no model output of any kind. The
 * whole string is safe to paste into an issue, which is the point of asking
 * for plain text rather than a chart.
 */
export function formatLatencyReport(turns: TurnTimings[]): string {
  const kept = capTurns(turns);
  const lines: string[] = [];

  lines.push(`GHOSTLY LATENCY REPORT — ${kept.length} turn(s)`);
  lines.push(
    `timing base: stage durations = performance.now() deltas inside the renderer;`,
  );
  lines.push(
    `             hotkey_pressed and commit = Date.now() wall clock, main and renderer;`,
  );
  lines.push(
    `accuracy:     renderer stages +/-${LOCAL_ACCURACY_MS}ms; hotkey->commit +/-${CROSS_PROCESS_ACCURACY_MS}ms (IPC + system clock)`,
  );
  lines.push("");

  if (kept.length === 0) {
    lines.push("(no turns recorded yet)");
    return lines.join("\n");
  }

  // ── Per-stage ──────────────────────────────────────────────────────────
  lines.push("STAGE                n     min     p50     p95     max");
  for (const s of summarizeStages(kept)) {
    // Below the sample threshold the p95 cell is replaced by `-` and every
    // value is listed underneath, because a p95 over 5 samples is just the max.
    lines.push(
      `${s.stage.padEnd(20)}${FIXED(s.n).padStart(3)}${FIXED(s.min).padStart(8)}${FIXED(
        s.p50,
      ).padStart(8)}${(s.p95 === null ? "-" : FIXED(s.p95)).padStart(8)}${FIXED(
        s.max,
      ).padStart(8)}`,
    );
    if (s.listEveryValue) {
      lines.push(`  ${s.stage} every value (n=${s.n} < ${PERCENTILE_MIN_SAMPLES}): ${s.values.join(", ")}`);
    }
  }
  lines.push("");

  // ── The metric that matches the flow ───────────────────────────────────
  const hotkey = kept
    .map((t) => t.hotkeyToCommittedMs)
    .filter((v): v is number => typeof v === "number");
  const committed = kept
    .map((t) => t.stages.committed)
    .filter((v): v is number => typeof v === "number");

  lines.push("END TO END");
  const e2eLine = (label: string, values: number[]) => {
    if (values.length === 0) {
      lines.push(`${label}: no samples`);
      return;
    }
    const s = summarizeStage("committed", values);
    const p95 = s.p95 === null ? "-" : FIXED(s.p95);
    lines.push(
      `${label}: n=${s.n} min=${s.min} p50=${s.p50} p95=${p95} max=${s.max}`,
    );
    if (s.listEveryValue) {
      lines.push(`  every value: ${values.join(", ")}`);
    }
  };
  // Named `hotkey -> ANSWER`, not `-> transcript`: the span runs from the keypress
  // to the point an answer was committed to history, which is the only number a
  // user experiences. `final transcript committed` was misleading twice over —
  // it stopped sounding like a measurement once the AI stages were added, and
  // it described a point (transcript) that is not the one being timed.
  e2eLine("hotkey_pressed -> answer committed", hotkey);
  e2eLine("submit -> committed", committed);
  lines.push("");

  // ── Shadow rule (c) ────────────────────────────────────────────────────
  //
  // Instrumentation for a rule that is NOT in force. Reported as counts and
  // scores only — never as a rejection — because the rule is known to be able
  // to reject a correct paraphrase. See `shadowOverlapCheck`.
  {
    const sampled = kept.filter((t) => t.shadow);
    const wouldReject = sampled.filter((t) => t.shadow!.wouldReject);
    const abstained = sampled.filter((t) => t.shadow!.abstained !== null);

    lines.push("SHADOW RULE (c) — overlap, NOT ENFORCED");
    if (sampled.length === 0) {
      lines.push("no samples: shadow overlap was not computed on any turn");
    } else {
      lines.push(
        `sampled n=${sampled.length} would-reject=${wouldReject.length} ` +
          `rate=${FIXED((wouldReject.length / sampled.length) * 100)}% ` +
          `abstained=${abstained.length}`,
      );
      // Every zero-overlap sample is listed individually, because the count
      // alone cannot tell a real miss from a degenerate short answer.
      for (const t of wouldReject) {
        const s = t.shadow!;
        lines.push(
          `  would-reject overlaps=${s.sharedContentWords}/` +
            `${Math.min(s.questionContentWords, s.answerContentWords)} ` +
            `score=${FIXED(s.overlapScore)} q=${s.questionContentWords} a=${s.answerContentWords}`,
        );
      }
      const reasons = new Map<string, number>();
      for (const t of abstained) {
        const r = t.shadow!.abstained as string;
        reasons.set(r, (reasons.get(r) ?? 0) + 1);
      }
      if (reasons.size > 0) {
        lines.push(
          `  abstained because: ${[...reasons.entries()]
            .sort()
            .map(([r, n]) => `${r} x${n}`)
            .join(", ")}`,
        );
      }
    }
    lines.push("");
  }

  // ── Outcomes ───────────────────────────────────────────────────────────
  const outcomeCounts = new Map<RunOutcome, number>();
  for (const t of kept) {
    outcomeCounts.set(t.outcome, (outcomeCounts.get(t.outcome) ?? 0) + 1);
  }
  lines.push(
    `OUTCOMES: ${RUN_OUTCOMES.filter((o) => outcomeCounts.has(o))
      .map((o) => `${o}=${outcomeCounts.get(o)}`)
      .join("  ")}`,
  );
  const truncated = kept.filter((t) => t.truncated).length;
  lines.push(`truncated turns (phrase still open at submit): ${truncated}`);
  lines.push("");

  // ── Force endpoint ─────────────────────────────────────────────────────
  const fired = kept.filter((t) => t.forceEndpoint?.fired).length;
  const skips = new Map<string, number>();
  for (const t of kept) {
    const f = t.forceEndpoint;
    if (!f || f.fired || !f.skipped) continue;
    skips.set(f.skipped, (skips.get(f.skipped) ?? 0) + 1);
  }
  lines.push(
    `FORCE ENDPOINT: fired ${fired}/${kept.length}${
      skips.size
        ? `  skipped: ${[...skips.entries()]
            .map(([k, v]) => `${k}=${v}`)
            .join("  ")}`
        : ""
    }`,
  );
  const decode = kept
    .map((t) => t.forceEndpoint?.decodeMs)
    .filter((v): v is number => typeof v === "number");
  if (decode.length) {
    const s = summarizeStage("force_endpoint_decode", decode);
    lines.push(
      `  forced decode ms: n=${s.n} min=${s.min} p50=${s.p50} max=${s.max}${
        s.p95 === null ? "" : ` p95=${s.p95}`
      }`,
    );
  }
  lines.push("");

  // ── Providers ──────────────────────────────────────────────────────────
  lines.push("PROVIDERS (per attempt, all runs)");
  const byProvider = new Map<string, number[]>();
  for (const t of kept) {
    for (const p of t.providers) {
      const list = byProvider.get(p.provider) ?? [];
      list.push(p.totalMs);
      byProvider.set(p.provider, list);
    }
  }
  if (byProvider.size === 0) {
    lines.push("  (no provider attempts)");
  } else {
    for (const [provider, values] of byProvider) {
      const s = summarizeStage("committed", values);
      const wins = kept.reduce(
        (n, t) => n + t.providers.filter((p) => p.provider === provider && p.winner).length,
        0,
      );
      const verdicts = new Map<string, number>();
      for (const t of kept) {
        for (const p of t.providers) {
          if (p.provider !== provider) continue;
          verdicts.set(p.verdict, (verdicts.get(p.verdict) ?? 0) + 1);
        }
      }
      lines.push(
        `  ${provider.padEnd(11)} n=${s.n} totalMs min=${s.min} p50=${s.p50} max=${s.max} wins=${wins}  verdicts: ${[
          ...verdicts.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}`,
      );
    }
  }

  return lines.join("\n");
}