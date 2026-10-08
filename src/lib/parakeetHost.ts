/**
 * Parakeet comparison host — the pure, Electron-free core.
 *
 * ── Scope and isolation (the whole point of this file) ─────────────────────
 * Parakeet is a DEVELOPMENT COMPARISON ENGINE ONLY. It is never the production
 * default, never a fallback for Moonshine, and its transcript never reaches the
 * question gate, the prompt, or the answer path. Every result it produces lands
 * in the isolated `asrComparisons` slice and nowhere else.
 *
 * Moonshine remains the production engine. Nothing in here is on Moonshine's
 * path, and enabling Parakeet cannot change, delay, or break a Moonshine
 * decode.
 *
 * ── Why the logic lives here, apart from `electron/parakeetAsr.ts` ──────────
 * Everything that can fail — queueing, timeouts, restarts, validation, idle
 * unload — lives here with NO Electron import, so it can be driven by a fake
 * child process in unit tests. The Electron file is a thin adapter that owns
 * the real `utilityProcess`. That is what makes "Parakeet crashing must not
 * affect Ghostly" a tested property rather than a hope.
 */

/** The one required sample rate. Parakeet TDT is a 16 kHz model. */
export const PARAKEET_SAMPLE_RATE = 16000;

/** ONNX thread count. Deliberately capped below the core count. */
export const PARAKEET_NUM_THREADS = 4;

/**
 * PROVISIONAL silence padding, in milliseconds, applied on each side.
 *
 * PROVISIONAL — pending real recorded clips. The padding test measured a
 * difference on one synthetic clip (a short segment decoded correctly only
 * with padding), but a single clip is not a basis for a policy. Revisit once
 * the real corpus exists.
 *
 * This constant is LOCAL to the Parakeet host. Moonshine's audio path is
 * untouched and receives the original samples.
 */
export const PARAKEET_PADDING_MS = 300;

/**
 * Maximum accepted segment length, in seconds.
 *
 * The VAD closes a phrase after ~1.5 s of silence, so a real segment is a few
 * seconds. 30 s is far beyond anything the pipeline produces and exists only
 * to bound a malformed request.
 */
export const PARAKEET_MAX_SECONDS = 30;

/** Per-request decode timeout. */
export const PARAKEET_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Unload the model after this long with no request.
 *
 * The model costs several hundred MB of resident memory, and a laptop running
 * a video call cannot afford to hold it indefinitely once the interview is
 * over. It is reloaded on demand (Start Interview, or the next request).
 */
export const PARAKEET_IDLE_UNLOAD_MS = 5 * 60_000;

/** Consecutive failures tolerated before the host gives up and reports error. */
export const PARAKEET_MAX_RESTARTS = 3;

/** Base delay for restart backoff; attempt N waits BASE * N ms. */
export const PARAKEET_RESTART_BACKOFF_MS = 500;

export type ParakeetModelStatus =
  | "disabled"
  | "missing"
  | "loading"
  | "ready"
  | "error";

export type ParakeetFailureReason =
  | "disabled"
  | "model_missing"
  | "invalid_audio"
  | "too_long"
  | "timeout"
  | "crashed"
  | "busy"
  | "restart_exhausted"
  | "malformed"
  | "shutdown";

export interface ParakeetAudioValidation {
  ok: boolean;
  reason?: ParakeetFailureReason;
  detail?: string;
  sampleRate?: number;
  seconds?: number;
}

/**
 * Validate an incoming comparison request.
 *
 * Deliberately strict: the renderer is an untrusted web context, and the model
 * will happily spend hundreds of MB of CPU on whatever it is handed. Only a
 * Float32Array at exactly 16 kHz, within the length cap, is accepted.
 */
export function validateParakeetAudio(
  samples: unknown,
  sampleRate: unknown,
): ParakeetAudioValidation {
  if (!(samples instanceof Float32Array)) {
    return {
      ok: false,
      reason: "invalid_audio",
      detail: "samples must be a Float32Array",
    };
  }
  if (sampleRate !== PARAKEET_SAMPLE_RATE) {
    return {
      ok: false,
      reason: "invalid_audio",
      detail: `sampleRate must be ${PARAKEET_SAMPLE_RATE}, got ${String(sampleRate)}`,
    };
  }
  if (samples.length === 0) {
    return { ok: false, reason: "invalid_audio", detail: "empty audio" };
  }
  const seconds = samples.length / PARAKEET_SAMPLE_RATE;
  if (seconds > PARAKEET_MAX_SECONDS) {
    return {
      ok: false,
      reason: "too_long",
      detail: `${seconds.toFixed(1)}s exceeds the ${PARAKEET_MAX_SECONDS}s cap`,
      seconds,
    };
  }
  return { ok: true, sampleRate, seconds };
}

/**
 * Prepend/append silence for the provisional padding policy.
 *
 * Returns a NEW array; the caller's samples are never mutated, which keeps the
 * same buffer safe to hand to Moonshine afterwards.
 */
export function applyParakeetPadding(
  samples: Float32Array,
  sampleRate: number = PARAKEET_SAMPLE_RATE,
  ms: number = PARAKEET_PADDING_MS,
): Float32Array {
  const pad = Math.max(0, Math.round((sampleRate * ms) / 1000));
  if (pad === 0) return samples;
  const out = new Float32Array(samples.length + pad * 2);
  out.set(samples, pad);
  return out;
}

// ── Child process contract ────────────────────────────────────────────────
//
// The host never talks to sherpa directly. It posts a request to the child and
// awaits a reply, so the process boundary is the only thing that needs mocking.

export interface ParakeetHostRequest {
  id: number;
  type: "load" | "unload" | "transcribe";
  samples?: Float32Array;
  sampleRate?: number;
  modelDir?: string;
  paddingMs?: number;
}

export interface ParakeetHostReply {
  id: number;
  ok: boolean;
  type?: "loaded" | "load-error" | "result" | "unloaded" | "error";
  text?: string;
  loadMs?: number;
  decodeMs?: number;
  rssMb?: number;
  code?: string;
  message?: string;
  /**
   * Per-phase load timings, produced by the child (see
   * `electron/parakeetWorker.cjs`). Nulls mean the phase was never reached.
   *
   * Exists because "the load took 15s" is not actionable: this is what
   * separates a slow process spawn from a slow native-addon require from a
   * cold page cache from genuinely expensive session construction.
   */
  breakdown?: ParakeetLoadBreakdown;
}

/**
 * Where a model load spends its time, in milliseconds.
 *
 *  • spawn    — process fork → first line of the child executing.
 *  • require  — loading the sherpa-onnx native addon.
 *  • read     — stat + page-cache warm of the model files.
 *  • construct — ONNX session creation and weight init.
 *  • total    — the child's own `load`: read + require + construct.
 *  • endToEnd — what the user waited for: spawn + total.
 */
export interface ParakeetLoadBreakdown {
  spawn: number | null;
  require: number | null;
  read: number | null;
  construct: number | null;
  total: number;
  endToEnd: number;
  modelBytes: number | null;
}

/** One-line rendering for the log. Never contains audio or model contents. */
export function formatLoadBreakdown(b: ParakeetLoadBreakdown): string {
  const ms = (v: number | null) => (v == null ? "?" : `${v}ms`);
  const mb = (b.modelBytes ?? 0) / 1048576;
  return (
    `spawn=${ms(b.spawn)} require=${ms(b.require)} read=${ms(b.read)} ` +
    `construct=${ms(b.construct)} total=${ms(b.total)} endToEnd=${ms(b.endToEnd)} ` +
    `modelMb=${mb.toFixed(0)}`
  );
}

/** The minimal surface the host needs from a child. */
export interface ParakeetChildLike {
  post(message: ParakeetHostRequest): void;
  kill(): void;
  onMessage(cb: (reply: ParakeetHostReply) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

export interface ParakeetHostDeps {
  /** Spawn a fresh child process. */
  spawnChild: () => ParakeetChildLike;
  /** Model directory passed to the child on load. */
  modelDir: string;
  /** Feature flag. When false the host refuses every request. */
  isEnabled: () => boolean;
  /**
   * Silence padding applied to each segment, in ms, read fresh per request.
   *
   * ── Resolved in MAIN, not sent by the renderer ────────────────────────────
   * The renderer is an untrusted web context; letting it choose its own padding
   * would let it post a 10-minute buffer to a model that bills CPU time. It is a
   * resolver so the padded-vs-unpadded dev toggle can flip it mid-session
   * without rebuilding the host.
   *
   * Returns `undefined` to mean {@link PARAKEET_PADDING_MS}. `0` is honoured and
   * means genuinely unpadded — that distinction is the whole point of the A/B.
   */
  paddingMs?: () => number | undefined;
  /**
   * Whether Parakeet is the PRIMARY engine or a comparison column. Affects
   * diagnostics labelling only; never the decode itself.
   */
  mode?: () => ParakeetHostMode;
  /** Clock injection for deterministic tests. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Diagnostics sink. Must never receive audio or model contents. */
  log?: (line: string) => void;
}

/**
 * How Parakeet is being used this session.
 *
 * Carried into the diagnostics line because the memory figure means something
 * completely different in the two cases: "Parakeet-only" is the number that
 * matters for shipping, while "comparison" is a developer number measured with
 * Moonshine ALSO resident and is therefore not comparable.
 */
export type ParakeetHostMode = "primary" | "comparison";

export interface ParakeetHostResult {
  ok: boolean;
  text?: string;
  decodeMs?: number;
  loadMs?: number;
  /** Per-phase load timings, when the child reported them. */
  breakdown?: ParakeetLoadBreakdown;
  rssMb?: number;
  /** decode time / audio duration. Present on successful decodes only. */
  rtf?: number;
  code?: ParakeetFailureReason;
  message?: string;
}

interface Pending {
  resolve: (r: ParakeetHostResult) => void;
  timer: unknown;
  requestId: number;
}

export class ParakeetHost {
  private child: ParakeetChildLike | null = null;
  private status: ParakeetModelStatus = "disabled";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** One decode at a time: a second request waits rather than racing the model. */
  private queue: Array<{
    samples: Float32Array;
    resolve: (r: ParakeetHostResult) => void;
    /** Resolved at enqueue time so one toggle cannot affect a queued segment. */
    paddingMs: number;
  }> = [];
  private busy = false;
  private consecutiveFailures = 0;
  private idleTimer: unknown = null;
  private lastLoadMs: number | null = null;
  private lastLoadBreakdown: ParakeetLoadBreakdown | null = null;
  private lastRssMb: number | null = null;
  /**
   * Latency of the most recent decode, and its RTF.
   *
   * Kept separate from `lastRssMb` because the memory figure is about the
   * PROCESS while these are about the WORK: for a memory-pressure measurement
   * you need both, and they answer different questions.
   */
  private lastDecodeMs: number | null = null;
  private lastRtf: number | null = null;
  private disposed = false;

  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: ParakeetHostDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as never));
    this.log = deps.log ?? (() => {});
  }

  /**
   * The padding for the next request, clamped to something sane.
   *
   * A non-finite or negative value falls back to the provisional default rather
   * than reaching `applyParakeetPadding`, where it would silently become "no
   * padding" and quietly invalidate an A/B measurement.
   */
  private resolvePaddingMs(): number {
    const raw = this.deps.paddingMs?.();
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      return PARAKEET_PADDING_MS;
    }
    return Math.round(raw);
  }

  /** Whether Parakeet is the primary engine right now. */
  getMode(): ParakeetHostMode {
    return this.deps.mode?.() ?? "comparison";
  }

  getStatus(): ParakeetModelStatus {
    return this.status;
  }

  getDiagnostics() {
    return {
      status: this.status,
      loadMs: this.lastLoadMs,
      breakdown: this.lastLoadBreakdown,
      rssMb: this.lastRssMb,
      decodeMs: this.lastDecodeMs,
      rtf: this.lastRtf,
      queued: this.queue.length,
      inFlight: this.pending.size,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start the model. Called on Start Interview, NOT at app launch, so a normal
   * session never pays the ~6 s load while nobody is transcribing.
   */
  async load(): Promise<ParakeetHostResult> {
    if (this.disposed) return { ok: false, code: "shutdown", message: "host disposed" };
    if (!this.deps.isEnabled()) {
      this.status = "disabled";
      return { ok: false, code: "disabled", message: "Parakeet comparison is off" };
    }
    if (this.status === "ready" && this.child) {
      return { ok: true, loadMs: this.lastLoadMs ?? undefined, rssMb: this.lastRssMb ?? undefined };
    }
    if (this.status === "loading") {
      // A load is already in flight; report ready-pending rather than forking a
      // second child and doubling the memory footprint.
      return { ok: false, code: "busy", message: "a load is already in flight" };
    }

    this.status = "loading";
    const child = this.deps.spawnChild();
    this.child = child;

    child.onMessage((reply) => this.onReply(reply));
    child.onExit((code) => this.onExit(code));

    const requestId = this.nextId++;
    const started = this.now();

    const outcome = await this.send(requestId, { id: requestId, type: "load", modelDir: this.deps.modelDir }, {
      timeoutMs: 90_000, // model load measured ~6 s; allow a cold start
    }).then((r): ParakeetHostResult => ({ ...r, loadMs: r.loadMs ?? this.now() - started }));

    if (outcome.ok) {
      this.status = "ready";
      this.lastLoadMs = outcome.loadMs ?? null;
      this.lastLoadBreakdown = outcome.breakdown ?? null;
      this.lastRssMb = outcome.rssMb ?? null;
      // Deliberately NOT resetting `consecutiveFailures` here.
      //
      // The counter tracks how many failures it took to get back to a working
      // state, and only a SUCCESSFUL DECODE proves the model is really usable
      // again. Clearing it on a successful load meant a child that loaded fine
      // but crashed on every single decode reset the budget each time — so the
      // host would respawn forever, which is precisely the restart loop
      // {@link PARAKEET_MAX_RESTARTS} exists to prevent.
      this.log(
        `[Parakeet] model ready loadMs=${outcome.loadMs ?? "?"} rssMb=${outcome.rssMb ?? "?"}` +
          (outcome.breakdown
            ? ` breakdown: ${formatLoadBreakdown(outcome.breakdown)}`
            : ""),
      );
    } else {
      this.status = outcome.code === "model_missing" ? "missing" : "error";
      this.log(`[Parakeet] model load failed code=${outcome.code ?? "?"} message=${outcome.message ?? ""}`);
      this.teardownChild();
    }
    return outcome;
  }

  /** Release the model. Called on Stop Interview. */
  unload(): void {
    this.clearIdle();
    this.teardownChild();
    this.status = this.deps.isEnabled() ? "missing" : "disabled";
    this.busy = false;
    this.drainQueue({ ok: false, code: "shutdown", message: "unloaded" });
    this.log("[Parakeet] unloaded");
  }

  dispose(): void {
    this.disposed = true;
    this.unload();
    this.status = "disabled";
  }

  // ── transcription ────────────────────────────────────────────────────────

  /**
   * Transcribe one already-captured segment.
   *
   * Fire-and-forget from the caller's perspective: it NEVER throws. Every
   * failure is returned as a value, because this is a diagnostic and must not
   * be able to interrupt an interview.
   */
  async transcribe(
    samples: Float32Array,
    sampleRate: number,
  ): Promise<ParakeetHostResult> {
    if (this.disposed) return { ok: false, code: "shutdown", message: "host disposed" };
    if (!this.deps.isEnabled()) {
      return { ok: false, code: "disabled", message: "Parakeet comparison is off" };
    }

    const validation = validateParakeetAudio(samples, sampleRate);
    if (!validation.ok) {
      // Not a failure worth restarting the model over.
      this.log(`[Parakeet] rejected request code=${validation.reason}`);
      return { ok: false, code: validation.reason, message: validation.detail };
    }

    if (this.status !== "ready" || !this.child) {
      const loaded = await this.load();
      if (!loaded.ok) {
        return { ok: false, code: loaded.code ?? "crashed", message: loaded.message };
      }
    }

    return new Promise<ParakeetHostResult>((resolve) => {
      this.queue.push({ samples, resolve, paddingMs: this.resolvePaddingMs() });
      this.pump();
    });
  }

  /** Serialise: exactly one decode is in flight at a time. */
  private pump(): void {
    if (this.busy || this.disposed) return;
    const next = this.queue.shift();
    if (!next) return;

    this.busy = true;
    this.clearIdle();

    // Padding is applied HERE, on the Parakeet copy only. The caller's buffer
    // is untouched, so Moonshine still receives the original samples.
    const padded = applyParakeetPadding(
      next.samples,
      PARAKEET_SAMPLE_RATE,
      next.paddingMs,
    );
    const requestId = this.nextId++;
    const seconds = padded.length / PARAKEET_SAMPLE_RATE;

    void this.send(
      requestId,
      {
        id: requestId,
        type: "transcribe",
        samples: padded,
        sampleRate: PARAKEET_SAMPLE_RATE,
        paddingMs: next.paddingMs,
      },
      { timeoutMs: PARAKEET_REQUEST_TIMEOUT_MS },
    ).then((r) => {
      this.busy = false;
      this.clearIdle();
      if (r.ok) {
        this.consecutiveFailures = 0;
        this.lastRssMb = r.rssMb ?? this.lastRssMb;
      } else {
        void this.handleFailure(r);
      }
      const result: ParakeetHostResult = r.ok
        ? { ...r, rtf: (r.decodeMs ?? 0) / 1000 / seconds }
        : r;
      // Record latency only for a real decode, so a failed request cannot
      // overwrite the last known-good measurement with a meaningless zero.
      if (result.ok && typeof result.decodeMs === "number") {
        this.lastDecodeMs = result.decodeMs;
        this.lastRtf = result.rtf ?? null;
      }
      next.resolve(result);
      // Start the idle countdown only once nothing is left to do, so an active
      // interview never has the model yanked out from under it.
      if (this.queue.length === 0) this.scheduleIdle();
      this.pump();
    });
  }

  /** Post a request and await its reply, with a hard timeout. */
  private send(
    requestId: number,
    message: ParakeetHostRequest,
    { timeoutMs }: { timeoutMs: number },
  ): Promise<ParakeetHostResult> {
    return new Promise<ParakeetHostResult>((resolve) => {
      if (!this.child) {
        resolve({ ok: false, code: "crashed", message: "no child process" });
        return;
      }
      const timer = this.setTimer(() => {
        if (this.pending.delete(requestId)) {
          resolve({ ok: false, code: "timeout", message: `no reply within ${timeoutMs}ms` });
        }
      }, timeoutMs);

      this.pending.set(requestId, { resolve, timer, requestId });
      try {
        this.child!.post(message);
      } catch (err) {
        this.pending.delete(requestId);
        this.clearTimer(timer);
        resolve({
          ok: false,
          code: "crashed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  private onReply(reply: ParakeetHostReply): void {
    const entry = this.pending.get(reply.id);
    if (!entry) {
      // A reply for a request we already timed out on. Dropped deliberately:
      // resolving it now would resurrect a stale result.
      this.log(`[Parakeet] dropping stale reply id=${reply.id}`);
      return;
    }
    this.pending.delete(reply.id);
    this.clearTimer(entry.timer);
    entry.resolve(
      reply.ok
        ? {
            ok: true,
            text: reply.text ?? "",
            decodeMs: reply.decodeMs,
            loadMs: reply.loadMs,
            breakdown: reply.breakdown,
            rssMb: reply.rssMb,
          }
        : {
            ok: false,
            code: (reply.code as ParakeetFailureReason) ?? "malformed",
            message: reply.message ?? "child reported failure",
          },
    );
  }

  private onExit(code: number | null): void {
    const hadWork = this.pending.size > 0 || this.queue.length > 0;
    // Any in-flight request is dead with the child.
    for (const [id, entry] of this.pending) {
      this.clearTimer(entry.timer);
      entry.resolve({ ok: false, code: "crashed", message: `utility process exited (${code})` });
      this.pending.delete(id);
    }
    this.child = null;
    this.busy = false;
    // Park as `missing` here; `handleFailure` is the only thing allowed to
    // decide that the host has given up and should become `error`, because it
    // is the only place that sees the whole failure sequence.
    if (this.status !== "disabled") this.status = "missing";
    if (hadWork) {
      // Deliberately NO restart attempt here. Resolving the in-flight request
      // makes `pump`'s own failure path call `handleFailure` exactly once, and
      // calling it again from here would count every crash twice — burning the
      // restart budget in two failures instead of the intended three.
      this.drainQueue({ ok: false, code: "crashed", message: "utility process exited" });
    }
  }

  /**
   * Bounded restart with linear backoff.
   *
   * After {@link PARAKEET_MAX_RESTARTS} consecutive failures the host stops
   * trying and parks in `error`. A permanently broken model must not become a
   * restart loop that eats CPU for the rest of the session.
   */
  private async handleFailure(result: ParakeetHostResult): Promise<void> {
    // A timeout or a malformed reply is worth one restart; invalid audio and a
    // missing model are not — retrying cannot fix either.
    if (result.code === "invalid_audio" || result.code === "too_long" || result.code === "model_missing") {
      return;
    }
    this.consecutiveFailures++;
    if (this.consecutiveFailures > PARAKEET_MAX_RESTARTS) {
      this.status = "error";
      this.log(
        `[Parakeet] giving up after ${this.consecutiveFailures - 1} restarts; status=error`,
      );
      return;
    }
    const delay = PARAKEET_RESTART_BACKOFF_MS * this.consecutiveFailures;
    this.log(`[Parakeet] restart ${this.consecutiveFailures}/${PARAKEET_MAX_RESTARTS} in ${delay}ms`);
    await new Promise<void>((resolve) => {
      this.setTimer(() => resolve(), delay);
    });
    if (this.disposed || !this.deps.isEnabled()) return;
    this.status = "missing";
    await this.load();
  }

  // ── idle unload ──────────────────────────────────────────────────────────

  private clearIdle(): void {
    if (this.idleTimer !== null) {
      this.clearTimer(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Start the idle countdown once the queue is empty. */
  private scheduleIdle(): void {
    if (this.disposed || !this.deps.isEnabled()) return;
    this.clearIdle();
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = null;
      if (this.busy || this.pending.size > 0 || this.queue.length > 0) return;
      this.log(`[Parakeet] idle ${PARAKEET_IDLE_UNLOAD_MS}ms — releasing model`);
      this.unload();
    }, PARAKEET_IDLE_UNLOAD_MS);
  }

  private drainQueue(result: ParakeetHostResult): void {
    const queued = this.queue.splice(0, this.queue.length);
    for (const q of queued) q.resolve(result);
  }

  private teardownChild(): void {
    if (!this.child) return;
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
    this.child = null;
  }
}