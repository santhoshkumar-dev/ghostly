import { getProvider, type ProviderName } from "./index";
import {
  isModelUnavailableError,
  takeRecordedResponseHeaders,
} from "./fetchWithDiagnostics";
import { decideCooldown, extractStatus } from "../providerCooldown";
import { isWaitResponse } from "../interviewAgent";
import { validateAnswerOutput } from "../outputValidation";
import type { AIProvider, AIRequestOptions, AIStreamMeta } from "./types";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Answer orchestration for the MANUAL HOTKEY path.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The user presses a shortcut AFTER the interviewer stops talking, so there is
 * no need to speculate on partial ASR. The whole latency budget is therefore
 * spent on the model call — and the previous design spent it *waiting*:
 *
 *   old:  OpenRouter → block up to 4500ms → then fall back
 *   new:  OpenRouter → 1800ms soft hedge → Groq overlaps → first VALID
 *         COMPLETE answer wins, losers are cancelled
 *
 * Two rules matter most and are the reason this file exists:
 *
 *  1. **FIRST USEFUL TEXT, NOT TOTAL TIME.** A healthy OpenRouter stream that
 *     takes 3.4s in total but produced its first useful text at 1.5s must NOT
 *     be hedged. Only "no meaningful text yet after the hedge window" starts a
 *     second provider.
 *
 *  2. **HARD FAILURE IS IMMEDIATE.** An HTTP error, a network error or a stream
 *     error before any usable text moves on at once — the hedge timer is never
 *     waited out after a confirmed failure.
 *
 * Nothing here writes to the UI. There is exactly one result
 * (`OrchestratorResult`) and the caller decides what to display.
 */

/**
 * Soft hedge window before a second provider is started.
 *
 * A tuned constant, not a guess baked into the logic: every attempt reports
 * `firstTextMs`, so this can be adjusted once real interview numbers exist.
 */
export const OPENROUTER_HEDGE_MS = 1800;

/**
 * Never run more than this many providers at once. */
export const MAX_CONCURRENT_PROVIDERS = 2;

/**
 * ── The latency budget ──────────────────────────────────────────────────────
 * Three SEPARATE deadlines, because they answer three different questions and
 * collapsing them into one "timeout" is what produced the observed 27.5s wait.
 *
 * 1. **`FIRST_TOKEN_TIMEOUT_MS` — "is anything happening at all?"** Armed when
 *    an attempt starts and RE-ARMED by every yield from the provider stream —
 *    including heartbeats, i.e. yields with no answer text in them (an SSE
 *    frame arrived: routing metadata, a reasoning part, a keep-alive).
 *    Permanently disarmed once `MEANINGFUL_CHARS` of real text have arrived.
 *    Measured — a real `openrouter/free` run returned HTTP 200 with its first
 *    frame at 3.7 s but needed longer than the remaining 1.3 s to start the
 *    answer text, and a frame-blind 5 s-from-start timer reported
 *    `no answer text within 5000ms` for a stream that was demonstrably alive.
 *    5s of TOTAL silence is still a failure; 5s during which the provider is
 *    sending frames is not.
 *
 * 2. **`TOTAL_PROVIDER_TIMEOUT_MS` — "has this stream stopped producing answer
 *    text?"** Armed at the same instant, and RE-ARMED by every chunk of real
 *    text (measured — see below). It used to be an absolute cap from attempt
 *    start that was never disarmed by text, and that is exactly how a real
 *    OpenRouter run was destroyed: HTTP 200, first chunk at 1250 ms, first
 *    answer text at 3676 ms, stream healthy and still going — and at 12013 ms
 *    the absolute timer aborted the fetch mid-stream and the run reported
 *    `reason=timeout` with `chars=0`, throwing away valid text that arrived
 *    before every deadline it was measured against. A provider that keeps
 *    producing answer text is healthy by definition; the deadline must answer
 *    "has it gone quiet?", not "has it been slow?". A stream that goes quiet
 *    still fails within 12s of its last text, and output is bounded by
 *    `max_tokens`, so a steadily-producing stream always terminates.
 *
 * 3. The hedge window above, which is not a timeout at all — it starts the NEXT
 *    provider early rather than waiting for the first one to fail.
 *
 * ── Why failing is the right answer past the cap ────────────────────────────
 * Nothing is streamed to the screen: an answer is displayed only once it is
 * complete and validated. So an attempt abandoned at 12s costs nothing that was
 * visible, it just frees the slot for the next provider. Giving up on a correct
 * answer that arrives at 27s would be a worse product than saying "no answer"
 * at 12s, because by then the question has moved on.
 *
 * Both are plain constants and both are overridable per call
 * (`firstTokenMs` / `totalMs`) so they can be tuned against real numbers rather
 * than being frozen forever.
 */
export const FIRST_TOKEN_TIMEOUT_MS = 5000;
export const TOTAL_PROVIDER_TIMEOUT_MS = 12000;

/**
 * Non-whitespace characters that count as "useful answer text".
 *
 * This is the trigger for *not* hedging. It is deliberately generous — the goal
 * is to recognise a real answer arriving, not to judge its quality (that is the
 * validator's job, and it only runs at completion).
 */
export const MEANINGFUL_CHARS = 12;

export type RunState =
  | "idle"
  | "starting"
  | "streaming"
  | "hedging"
  | "completed"
  | "failed"
  | "cancelled";

export type AttemptOutcome =
  | "success"
  | "failed"
  | "cancelled"
  | "cancelled_by_winner";

export type FailureReason =
  | "timeout"
  | "http"
  | "network"
  | "stream"
  | "model"
  | "empty"
  | "invalid"
  | "abort";

export interface AttemptSpec {
  provider: ProviderName;
  model: string;
  apiKey: string;
  maxTokens?: number;
  /** Retired-model safety net for this provider only. */
  fallbackModels?: string[];
  /**
   * Which slot of the user's key pool this attempt uses, 0-based.
   *
   * Reported in the telemetry and used to attribute a success or failure to the
   * right credential, so one refused key can be skipped without touching its
   * siblings. Defaults to 0, so a caller that has no pool is unaffected.
   */
  keyIndex?: number;
  /**
   * Turn telemetry on this slot into key-pool state.
   *
   * Injected rather than imported so the orchestrator stays free of key
   * knowledge: it reports what happened and lets the caller decide whether that
   * is a key problem or a provider problem.
   */
  onKeyOutcome?: (
    ok: boolean,
    info: { status?: number | undefined; reason?: FailureReason | string | undefined },
  ) => void;
}

export interface AttemptTelemetry {
  provider: ProviderName;
  model: string;
  /** Which key-pool slot served this attempt (0 when there is no pool). */
  keyIndex: number;
  /** attempt start → response headers. */
  httpMs: number | null;
  /** attempt start → first SSE chunk of any kind. */
  firstChunkMs: number | null;
  /** attempt start → first MEANINGFUL text (the anti-hedge signal). */
  firstTextMs: number | null;
  /** attempt start → stream end. */
  completeMs: number | null;
  totalMs: number;
  outcome: AttemptOutcome;
  failureReason?: FailureReason;
  /** True when a second provider was started because this one was silent. */
  hedged: boolean;
  winner: boolean;
  /** Concrete model served, when it differs from `model` (openrouter/free). */
  resolvedModel?: string;
  backend?: string;
  finishReason?: string;
  chars: number;
}

export interface StatusUpdate {
  state: RunState;
  provider?: ProviderName;
  model?: string;
  /** Short user-facing phrase, e.g. "OpenRouter slow → Groq". */
  note?: string;
}

export interface OrchestratorResult {
  /** The single authoritative answer text. Empty when nothing won. */
  text: string;
  provider: ProviderName | null;
  model: string;
  resolvedModel?: string;
  backend?: string;
  finishReason?: string;
  winner: boolean;
  /** True when a second provider was ever started. */
  hedged: boolean;
  attempts: number;
  attemptsStarted: AttemptTelemetry[];
  /** Why each losing attempt did not win. */
  failures: Array<{
    provider: ProviderName;
    model: string;
    reason: FailureReason;
    message: string;
  }>;
  aborted: boolean;
  error?: string;
  /**
   * Providers that were in the chain but never attempted because they were on
   * cooldown. Reported to the user as "back in 2h 15m" rather than as a raw
   * provider error, so a dead provider is visibly parked rather than silently
   * missing.
   */
  skipped: Array<{ provider: ProviderName; detail: string }>;
}

export interface OrchestrateOptions {
  attempts: AttemptSpec[];
  prompt: string;
  system?: string;
  messages?: { role: "user" | "assistant"; content: string }[];
  base64Image?: string;
  mimeType?: string;
  /** Cancels the whole run; every in-flight attempt aborts with it. */
  signal: AbortSignal;
  /** Override the hedge window (tests, tuning). */
  hedgeMs?: number;
  /**
   * Override the first-token budget. Defaults to
   * {@link FIRST_TOKEN_TIMEOUT_MS}. Disarmed by the first real text.
   */
  firstTokenMs?: number;
  /**
   * Override the per-attempt total budget. Defaults to
   * {@link TOTAL_PROVIDER_TIMEOUT_MS}. NOT disarmed by text.
   */
  totalMs?: number;
  /**
   * Override the grace period for aborted attempts to report. Defaults to
   * {@link ABORT_SETTLE_GRACE_MS}.
   */
  settleGraceMs?: number;
  maxConcurrent?: number;
  /**
   * Decides whether a COMPLETED answer is acceptable. A provider only wins on
   * `ok: true`. The caller supplies the real validator so this module never
   * has to know about prompts, WAIT or artefacts.
   */
  validate?: (text: string) => { ok: boolean; reason?: string };
  /**
   * Cooldown gate, consulted ONCE per provider before it is scheduled.
   *
   * Supplied by the caller (`lib/providerCooldown.ts`) rather than owned here so
   * the orchestrator stays free of clock and state: it asks "may this provider
   * run?" and records the answer. A provider that is parked is REMOVED from the
   * queue, so it costs no latency at all — which matters, because a 429 that
   * waits for a timeout is exactly the failure mode this replaces.
   */
  cooldown?: {
    /** Whether the provider is currently parked. */
    isBlocked: (provider: ProviderName) => { blocked: boolean; detail?: string };
    /**
     * Called after a provider FAILS, so the caller can park it. Returning
     * nothing keeps this module in charge of nothing at all.
     */
    reportFailure?: (
      provider: ProviderName,
      info: {
        message: string;
        status?: number;
        /** Best-effort header bag from the last response; may be undefined. */
        headers?: Record<string, string>;
      },
    ) => void;
  };
  /** Injected clock; the cooldown caller's business, exposed for symmetry. */
  now?: () => number;
  onStatus?: (status: StatusUpdate) => void;
  log?: (line: string) => void;
  /** Test seam; defaults to the real provider registry. */
  resolveProvider?: (name: ProviderName) => AIProvider;
}

const nonWhitespace = (t: string) => t.replace(/\s+/g, "").length;

const truncate = (t: string, n: number) =>
  t.length <= n ? t : `${t.slice(0, n)}…`;

/**
 * Default acceptance: non-empty, not a WAIT refusal, and free of structural
 * prompt-leak / malformed-output artefacts. The caller normally supplies the
 * richer validator from `Home.tsx`; this default keeps the orchestrator safe on
 * its own (a provider must never win on leaked text even with no validator).
 */
function defaultValidate(text: string): { ok: boolean; reason?: string } {
  if (!text.trim()) return { ok: false, reason: "empty" };
  if (isWaitResponse(text)) return { ok: false, reason: "wait" };
  const verdict = validateAnswerOutput(text);
  return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
}

/** Classify a thrown provider error. */
function classify(err: unknown): FailureReason {
  const message = err instanceof Error ? err.message : String(err);
  if (isModelUnavailableError(message)) return "model";
  if (/HTTP\s+[45]\d\d|API error|status/i.test(message)) return "http";
  if (/stream error/i.test(message)) return "stream";
  return "network";
}

/**
 * Grace period for aborted attempts to finish reporting.
 *
 * After a winner (or a timeout) every loser is aborted, and the run then waits
 * for their telemetry to settle. With a real provider that is instant — aborting
 * the `AbortController` makes the in-flight `fetch` read reject. But the wait is
 * UNBOUNDED, so any stream that ignores its signal — a provider that has already
 * buffered its whole body, a stub, a future transport — can hold the interview
 * open indefinitely after the answer is already decided. That is precisely the
 * "waiting forever" failure the deadlines exist to prevent, so the settle is
 * capped: telemetry that has not arrived in time is simply not reported.
 */
export const ABORT_SETTLE_GRACE_MS = 1500;

/** Wait for the aborted attempts, but never longer than the grace period. */
async function settleWithin(
  flights: InFlight[],
  graceMs: number,
): Promise<void> {
  const all = Promise.allSettled(flights.map((f) => f.done));
  // `setTimeout` rather than a bare race so the timer is always cleared and can
  // never keep the process alive.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs);
  });
  try {
    await Promise.race([all, grace]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface InFlight {
  controller: AbortController;
  telemetry: AttemptTelemetry;
  spec: AttemptSpec;
  /** Resolves when the attempt has definitively finished (any outcome). */
  done: Promise<void>;
  hadMeaningfulText: boolean;
  /**
   * Set when one of this attempt's deadlines expired.
   *
   * The scheduler treats such an attempt as GONE even though its stream may
   * still be suspended: a stream that ignores its abort signal would otherwise
   * keep an in-flight slot occupied forever, so no later attempt could start and
   * the run would wait indefinitely — which is exactly what the deadlines exist
   * to prevent.
   */
  deadlineExpired?: boolean;
}

export async function orchestrateAnswer(
  opts: OrchestrateOptions,
): Promise<OrchestratorResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const resolve = opts.resolveProvider ?? getProvider;
  const validate = opts.validate ?? defaultValidate;
  const hedgeMs = opts.hedgeMs ?? OPENROUTER_HEDGE_MS;
  const firstTokenMs = opts.firstTokenMs ?? FIRST_TOKEN_TIMEOUT_MS;
  const totalMs = opts.totalMs ?? TOTAL_PROVIDER_TIMEOUT_MS;
  const settleGraceMs = opts.settleGraceMs ?? ABORT_SETTLE_GRACE_MS;
  const maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT_PROVIDERS;

  let queue = opts.attempts.filter((a) => a.apiKey?.trim());
  const attemptsStarted: AttemptTelemetry[] = [];
  const failures: OrchestratorResult["failures"] = [];
  const skipped: OrchestratorResult["skipped"] = [];
  const now = opts.now ?? (() => Date.now());

  // Parked providers are removed from the queue up front, not retried and
  // skipped later. Removing them is the point: a provider that is known to be
  // out of quota must not consume a slot, a timeout, or the user's attention.
  if (opts.cooldown) {
    const runnable: AttemptSpec[] = [];
    for (const spec of queue) {
      const gate = opts.cooldown.isBlocked(spec.provider);
      if (gate.blocked) {
        skipped.push({
          provider: spec.provider,
          detail: gate.detail ?? "on cooldown",
        });
        log(
          `[AI] provider=${spec.provider} SKIPPED — ${gate.detail ?? "on cooldown"}`,
        );
        continue;
      }
      runnable.push(spec);
    }
    queue = runnable;
  }

  const inFlight = new Map<string, InFlight>();
  /**
   * Attempts that still hold a concurrency slot.
   *
   * An attempt whose deadline expired is EXCLUDED even if its stream has not
   * settled: its slot is free, the next attempt can start immediately, and the
   * run can finish. That is the whole point of having a deadline — a stream that
   * ignores its abort signal must not be able to stall the interview.
   */
  const liveAttempts = (): InFlight[] =>
    [...inFlight.values()].filter((f) => !f.deadlineExpired);
  let cursor = 0;
  let hedged = false;
  let winner: { text: string; flight: InFlight } | null = null;
  let aborted = opts.signal.aborted;

  // ── wake-up plumbing so the scheduler can await external events ──────────
  let wake: () => void = () => {};
  const waiter = () =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });
  const notify = () => {
    const w = wake;
    wake = () => {};
    w();
  };

  const emit = (status: StatusUpdate) => opts.onStatus?.(status);

  /**
   * Starts one attempt and wires its completion into the scheduler.
   *
   * `id` must be unique PER ATTEMPT, not per provider: with a key pool the chain
   * contains several attempts for the same provider, and keying the in-flight
   * map by provider would make them overwrite each other — which would
   * under-count concurrency, let the cap be exceeded, and leave one attempt
   * un-abandoned when the run ends.
   */
  const start = (spec: AttemptSpec, id: string) => {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    opts.signal.addEventListener("abort", onParentAbort);

    const t0 = performance.now();
    const keyIndex = spec.keyIndex ?? 0;
    const telemetry: AttemptTelemetry = {
      provider: spec.provider,
      model: spec.model,
      keyIndex,
      httpMs: null,
      firstChunkMs: null,
      firstTextMs: null,
      completeMs: null,
      totalMs: 0,
      outcome: "failed",
      hedged: false,
      winner: false,
      chars: 0,
    };
    attemptsStarted.push(telemetry);

    const flight: InFlight = {
      controller,
      telemetry,
      spec,
      done: Promise.resolve(),
      hadMeaningfulText: false,
    };

    // ── Per-attempt deadlines ────────────────────────────────────────────────
    //
    // Both abort THIS attempt through its own controller, never the run's, so a
    // provider that runs out of time cannot take the healthy providers with it.
    //
    // `timedOut` is what distinguishes "we gave up on it" from "a winner arrived
    // and cancelled it": both surface as an AbortError, and without this the
    // orchestrator would report a timeout as a cancellation, which reads as a
    // clean exit rather than a provider that failed.
    let timedOut: "first-token" | "total" | null = null;

    /** Deadline for "nothing at all is arriving from this provider". */
    const onFirstTokenDeadline = () => {
      if (flight.hadMeaningfulText || controller.signal.aborted) return;
      timedOut = "first-token";
      expire();
    };
    let firstTokenTimer = setTimeout(onFirstTokenDeadline, firstTokenMs);

    /**
     * Every yield from the provider stream is activity: an SSE frame arrived.
     * Heartbeats (empty yields) therefore keep the first-token budget alive —
     * the provider is answering, it just has no answer TEXT in this frame —
     * while once real text has arrived the budget is disarmed for good.
     */
    const noteActivity = () => {
      if (flight.hadMeaningfulText) return;
      clearTimeout(firstTokenTimer);
      firstTokenTimer = setTimeout(onFirstTokenDeadline, firstTokenMs);
    };

    /**
     * Fired when NO NEW answer text has arrived for `totalMs` — the completion
     * deadline. See the deadline doc block above: this used to be an absolute
     * timer from attempt start that killed healthy OpenRouter streams
     * mid-answer. Every chunk of real text re-arms it (in the chunk loop
     * below), so "slow but still answering" is never a timeout while "went
     * quiet" still is.
     */
    const onCompletionDeadline = () => {
      if (controller.signal.aborted) return;
      timedOut = "total";
      expire();
    };
    let totalTimer = setTimeout(onCompletionDeadline, totalMs);

    /**
     * Retire this attempt from the SCHEDULER's point of view and wake it.
     *
     * Both halves matter. `deadlineExpired` frees the concurrency slot so the
     * next attempt can start immediately, and `notify()` wakes the main loop,
     * which would otherwise still be parked on the previous `waiter()` — an
     * attempt that never settles never notifies on its own.
     */
    const expire = () => {
      flight.deadlineExpired = true;
      controller.abort();
      notify();
    };

    emit({
      state: hedged ? "hedging" : "starting",
      provider: spec.provider,
      model: spec.model,
    });
    // ── The screenshot trace, at the request builder ────────────────────────
    // Proof that the picture went into the request OBJECT about to be handed to
    // the provider — not merely that a screenshot exists in renderer state.
    // `image=none` on a screenshot solve means the run is being asked to read a
    // picture that was never attached, which is the failure this line exists to
    // make visible. Safe metadata only: MIME type and payload size, never pixels.
    const imageTrace = opts.base64Image
      ? `${opts.mimeType ?? "image/png"} ${opts.base64Image.length}B`
      : "none";
    log(
      `[AI] provider=${spec.provider} model=${spec.model} keySlot=${keyIndex} start apiKeyPresent=${!!spec.apiKey} image=${imageTrace}`,
    );

    /**
     * Hand the outcome to the caller's key pool.
     *
     * Wrapped because this is caller-supplied bookkeeping on a failure path: an
     * exception here must never turn a clean failover into a crashed interview.
     * The HTTP status is recovered from the provider's own message because every
     * provider throws a bare `Error` and throws the status away.
     */
    const reportKey = (
      ok: boolean,
      info: { reason?: string; status?: number | undefined },
    ) => {
      try {
        spec.onKeyOutcome?.(ok, info);
      } catch {
        /* key bookkeeping must never break a run */
      }
    };

    flight.done = (async () => {
      let out = "";
      const meta: AIStreamMeta = {};
      try {
        const request: AIRequestOptions = {
          prompt: opts.prompt,
          system: opts.system,
          messages: opts.messages,
          base64Image: opts.base64Image,
          mimeType: opts.mimeType,
          model: spec.model,
          apiKey: spec.apiKey,
          maxTokens: spec.maxTokens,
          signal: controller.signal,
          meta,
        };
        const stream = resolve(spec.provider).streamSolution(request);

        for await (const chunk of stream) {
          if (opts.signal.aborted) break;
          // First chunk of ANY kind — text or heartbeat. Providers yield an
          // empty string for a frame that carries no answer text, and that is
          // exactly the signal the first-token budget needs (see the deadline
          // doc block above).
          if (telemetry.firstChunkMs == null) {
            telemetry.firstChunkMs = Math.round(performance.now() - t0);
            if (meta.httpMs != null) telemetry.httpMs = meta.httpMs;
          }
          // A frame arrived: the provider is alive.
          noteActivity();
          if (!chunk) continue;
          out += chunk;

          // ── THE COMPLETION DEADLINE IS PROGRESS-BASED ────────────────
          // Real text re-arms the total budget. This is THE fix for the
          // observed "HTTP 200 + first chunks arrive + later reports timeout"
          // failure: the timer used to stay pinned to attempt start, so a
          // stream that was answering the whole time got aborted at 12s and
          // its text discarded. Whitespace does not re-arm it — a stream that
          // only emits padding has gone quiet.
          if (chunk.trim()) {
            clearTimeout(totalTimer);
            totalTimer = setTimeout(onCompletionDeadline, totalMs);
          }

          // ── THE ANTI-HEDGE SIGNAL ──
          // Meaningful text means the provider is healthy. From here on the
          // hedge timer is disarmed and we simply wait for completion, however
          // long the total request takes.
          if (!flight.hadMeaningfulText && nonWhitespace(out) >= MEANINGFUL_CHARS) {
            flight.hadMeaningfulText = true;
            telemetry.firstTextMs = Math.round(performance.now() - t0);
            telemetry.hedged = hedged;
            // A healthy stream is never hedged, however long it runs in total.
            disarmHedge();
            // …and the first-token budget no longer applies: from here the
            // provider is demonstrably producing an answer. Only the total
            // budget still bounds it.
            clearTimeout(firstTokenTimer);
            log(
              `[AI] provider=${spec.provider} model=${spec.model} firstText=${telemetry.firstTextMs}ms (hedge disarmed)`,
            );
            emit({ state: "streaming", provider: spec.provider, model: spec.model });
            notify();
          }
        }

        telemetry.completeMs = Math.round(performance.now() - t0);
        telemetry.chars = out.length;
        telemetry.resolvedModel = meta.model;
        telemetry.backend = meta.provider;
        telemetry.finishReason = meta.finishReason;

        // A timeout takes precedence over every "someone cancelled us" reading:
        // the run must move on immediately, and the failure has to be reported
        // as a timeout so the caller can park the provider.
        if (timedOut) {
          telemetry.outcome = "failed";
          telemetry.failureReason = "timeout";
          failures.push({
            provider: spec.provider,
            model: spec.model,
            reason: "timeout",
            message:
              timedOut === "first-token"
                ? `no answer text within ${firstTokenMs}ms`
                : `did not complete within ${totalMs}ms`,
          });
          log(
            `[AI] provider=${spec.provider} TIMED OUT (${timedOut} after ${telemetry.completeMs}ms) — moving on`,
          );
          opts.cooldown?.reportFailure?.(spec.provider, {
            message: `timeout: ${timedOut}`,
          });
          reportKey(false, { reason: "timeout" });
          return;
        }

        if (opts.signal.aborted) {
          telemetry.outcome = "cancelled";
          return;
        }
        if (!winner && controller.signal.aborted) {
          telemetry.outcome = "cancelled_by_winner";
          return;
        }

        const verdict = validate(out);
        if (!verdict.ok) {
          telemetry.outcome = "failed";
          telemetry.failureReason =
            verdict.reason === "wait" ? "invalid" : (verdict.reason as FailureReason) ?? "invalid";
          failures.push({
            provider: spec.provider,
            model: spec.model,
            reason: telemetry.failureReason,
            message: verdict.reason ?? "answer rejected by validator",
          });
          log(
            `[AI] provider=${spec.provider} rejected (${telemetry.failureReason}) text="${truncate(out, 60)}"`,
          );
          // Reported, but NOT a key problem: the request was well-formed and the
          // credential worked. The key pool ignores it and the provider-level
          // failover carries the run.
          reportKey(false, { reason: telemetry.failureReason });
          return;
        }

        telemetry.outcome = "success";
        // The ONLY thing that clears a slot's failure record, and the reason a
        // successful request never rotates anything.
        reportKey(true, {});
        if (!winner) {
          telemetry.winner = true;
          winner = { text: out, flight };
        }
      } catch (err) {
        telemetry.completeMs = Math.round(performance.now() - t0);
        // Text accumulated before the abort is real telemetry: it is what
        // distinguishes "never produced anything" from "was producing and we
        // gave up", which is the distinction the timeout diagnosis needs.
        telemetry.chars = out.length;
        // A deadline expiry aborts the request, so it arrives here as an
        // AbortError. Reporting that as "cancelled" would tell the caller the
        // attempt was retired by a winner, which is the opposite of what
        // happened — and would leave a provider that just burned 12s looking
        // healthy.
        if (timedOut) {
          telemetry.outcome = "failed";
          telemetry.failureReason = "timeout";
          failures.push({
            provider: spec.provider,
            model: spec.model,
            reason: "timeout",
            message:
              timedOut === "first-token"
                ? `no answer text within ${firstTokenMs}ms`
                : `did not complete within ${totalMs}ms`,
          });
          log(
            `[AI] provider=${spec.provider} TIMED OUT (${timedOut} after ${telemetry.completeMs}ms) — moving on`,
          );
          try {
            opts.cooldown?.reportFailure?.(spec.provider, {
              message: `timeout: ${timedOut}`,
            });
          } catch {
            /* cooldown bookkeeping must never break a run */
          }
          reportKey(false, { reason: "timeout" });
          return;
        }
        if (opts.signal.aborted || controller.signal.aborted) {
          telemetry.outcome = controller.signal.aborted
            ? "cancelled_by_winner"
            : "cancelled";
          telemetry.failureReason = "abort";
          return;
        }
        const reason = classify(err);
        telemetry.outcome = "failed";
        telemetry.failureReason = reason;
        const errorText = err instanceof Error ? err.message : String(err);

        // ── Cooldown report ─────────────────────────────────────────────
        // Called for EVERY hard failure, including the first one. The caller
        // decides what is worth parking (see `lib/providerCooldown.ts`); the
        // orchestrator just supplies the facts it has. Headers come from the
        // fetch choke point because the provider threw away the response.
        //
        // Guarded because it runs in a `finally`-adjacent path: an exception
        // here must never turn a provider failure into a crashed interview.
        try {
          opts.cooldown?.reportFailure?.(spec.provider, {
            message: err instanceof Error ? err.message : String(err),
            // The provider threw a bare Error, so the status is recovered from
            // the message by the cooldown module rather than invented here.
            status: undefined,
            headers: takeRecordedResponseHeaders(spec.provider),
          });
        } catch {
          /* cooldown bookkeeping must never break a run */
        }

        failures.push({
          provider: spec.provider,
          model: spec.model,
          reason,
          message: errorText,
        });
        log(
          `[AI] provider=${spec.provider} FAILED (${reason}): ${errorText}`,
        );
        // The key pool gets the recovered HTTP status so it can tell a refused
        // CREDENTIAL (429/401/403) from a broken PROVIDER (5xx) — the first is
        // worth trying the next key for, the second is not.
        reportKey(false, { reason, status: extractStatus(errorText) });
      } finally {
        telemetry.totalMs = Math.round(performance.now() - t0);
        // Both deadlines must be cleared on every exit path. The total timer is
        // the dangerous one: a live 12s timer per attempt would keep the event
        // loop (and, in tests, the process) alive long after the answer is on
        // screen.
        clearTimeout(firstTokenTimer);
        clearTimeout(totalTimer);
        opts.signal.removeEventListener("abort", onParentAbort);
        // Retire this attempt from the running set. This is what lets the
        // scheduler see "nothing is in flight" and launch the next provider
        // IMMEDIATELY after a hard failure, rather than waiting for a timer.
        if (inFlight.get(id) === flight) inFlight.delete(id);
        notify();
      }
    })();

    inFlight.set(id, flight);
  };

  /** Stops everything that is still running (a winner was chosen). */
  const cancelRemaining = () => {
    for (const flight of inFlight.values()) {
      if (flight !== winner?.flight && !flight.controller.signal.aborted) {
        flight.controller.abort();
      }
    }
  };

  // ── Hedge timer ─────────────────────────────────────────────────────────
  // Disarmed the moment ANY running attempt produces meaningful text.
  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
  let hedgeFired = false;
  const armHedge = () => {
    hedgeTimer = setTimeout(() => {
      // The hedge may fire AT MOST ONCE. A second firing would push the run
      // past the 2-provider concurrency cap and start providers needlessly.
      if (hedgeFired) return;
      // Only hedge if the still-running attempts have produced nothing usable.
      const running = liveAttempts();
      const healthy = running.some((f) => f.hadMeaningfulText);
      if (winner || healthy || aborted || running.length === 0) return;
      if (cursor >= queue.length) return;
      hedgeFired = true;
      hedged = true;
      const spec = queue[cursor++];
      const id = `${spec.provider}#${spec.keyIndex ?? 0}@${cursor}`;
      log(
        `[AI] hedge: no useful text after ${hedgeMs}ms, starting ${spec.provider} alongside ${running.map((f) => f.spec.provider).join(", ")}`,
      );
      emit({
        state: "hedging",
        provider: spec.provider,
        model: spec.model,
        // Named after whatever is actually running, not a hardcoded "OpenRouter".
        // The primary is Gemini now, so a hardcoded label would have told the
        // user "OpenRouter slow" while Gemini was the one stalling.
        note: `${
          running.map((f) => f.spec.provider).join(", ").toUpperCase()
        } slow → ${spec.provider.toUpperCase()}`,
      });
      start(spec, id);
      notify();
    }, hedgeMs);
  };
  const disarmHedge = () => {
    if (hedgeTimer) clearTimeout(hedgeTimer);
    hedgeTimer = undefined;
  };

  // ── Main loop ───────────────────────────────────────────────────────────
  emit({ state: "starting" });
  if (queue.length === 0) {
    emit({ state: "failed" });
    return {
      text: "",
      provider: null,
      model: "",
      winner: false,
      hedged: false,
      attempts: 0,
      attemptsStarted,
      failures,
      skipped,
      aborted: false,
      // Distinguish the two reasons the queue can be empty, because they need
      // different fixes and the raw message used to hide the difference.
      error: skipped.length
        ? `Every provider in the chain is on cooldown: ${skipped
            .map((s) => `${s.provider} (${s.detail})`)
            .join("; ")}.`
        : opts.attempts.every((a) => !a.apiKey?.trim())
          ? "No provider has an API key."
          : "No provider in the chain is available.",
    };
  }

  const first = queue[cursor++];
  start(first, `${first.provider}#${first.keyIndex ?? 0}@0`);
  armHedge();

  while (!winner) {
    if (opts.signal.aborted) {
      aborted = true;
      cancelRemaining();
      break;
    }

    // Launch the next attempt only when it is genuinely useful:
    //  • the chain is under-concurrent, AND
    //  • either a hedge has happened, or no live attempt remains
    //    (i.e. everything before it hard-failed or ran out of time).
    // This is what caps concurrency at 2 and prevents the whole chain firing at
    // once. With a key pool the chain is longer but the cap is unchanged, so
    // adding keys never makes the app more parallel.
    //
    // `live` counts only attempts that still hold a slot, so a timed-out stream
    // that ignores its signal cannot block the next attempt.
    const live = liveAttempts().length;
    const pending = queue.slice(cursor);
    if (
      pending.length > 0 &&
      live < maxConcurrent &&
      (hedgeFired || live === 0)
    ) {
      const spec = queue[cursor++];
      start(spec, `${spec.provider}#${spec.keyIndex ?? 0}@${cursor}`);
      continue;
    }

    // Nothing left to start and nothing left to wait for.
    if (live === 0 && cursor >= queue.length) break;

    await waiter();
  }

  disarmHedge();

  // `winner` is only ever assigned from INSIDE the `start` closure, which
  // TypeScript's control-flow analysis cannot see: after the scheduler loop it
  // still believes the variable is `null`, and narrows `if (winner)` to `never`.
  // The runtime is correct; this assertion just re-widens the type at the read
  // so the winner can actually be consumed. `chosen === winner` at every instant.
  const chosen = winner as { text: string; flight: InFlight } | null;

  if (chosen) {
    cancelRemaining();
    emit({ state: "completed", provider: chosen.flight.spec.provider });
    // Let the aborted attempts settle so their telemetry is recorded, but do not
    // let them overwrite the winner — and do not let a signal-deaf stream hold
    // the interview open (see ABORT_SETTLE_GRACE_MS).
    await settleWithin([...inFlight.values()], settleGraceMs);
  } else if (aborted) {
    emit({ state: "cancelled" });
    await settleWithin([...inFlight.values()], settleGraceMs);
  } else {
    emit({ state: "failed" });
    await settleWithin([...inFlight.values()], settleGraceMs);
  }

  // ── Telemetry ───────────────────────────────────────────────────────────
  for (const t of attemptsStarted) {
    const parts = [
      `http=${t.httpMs ?? "none"}ms`,
      `firstText=${t.firstTextMs ?? "none"}ms`,
      `total=${t.totalMs}ms`,
      `success=${t.outcome === "success"}`,
      `winner=${t.winner}`,
    ];
    if (t.failureReason) parts.push(`reason=${t.failureReason}`);
    if (t.hedged) parts.push("hedged");
    if (t.resolvedModel && t.resolvedModel !== t.model) {
      parts.push(`resolvedModel=${t.resolvedModel}`);
    }
    if (t.backend) parts.push(`backend=${t.backend}`);
    if (t.outcome.startsWith("cancelled")) parts.push(t.outcome);
    log(`[AI] ${t.provider}/${t.model} ${parts.join(" ")}`);
  }

  return {
    text: chosen?.text ?? "",
    provider: chosen?.flight.spec.provider ?? null,
    model: chosen?.flight.spec.model ?? attemptsStarted[0]?.model ?? "",
    resolvedModel: chosen?.flight.telemetry.resolvedModel,
    backend: chosen?.flight.telemetry.backend,
    finishReason: chosen?.flight.telemetry.finishReason,
    winner: !!chosen,
    hedged,
    attempts: attemptsStarted.length,
    attemptsStarted,
    failures,
    skipped,
    aborted,
    error: chosen
      ? undefined
      : aborted
        ? "Cancelled."
        : failures.length
          ? failures.map((f) => `${f.provider}: ${f.message}`).join(" | ")
          : "No provider produced an answer.",
  };
}