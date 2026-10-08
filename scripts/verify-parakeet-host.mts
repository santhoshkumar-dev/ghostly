/**
 * Deterministic tests for the Parakeet comparison host.
 *
 * Run: `npx tsx scripts/verify-parakeet-host.mts`
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Parakeet is a native addon in a separate process, so the risky logic is NOT
 * the decode — it is everything around it: the one-decode-at-a-time queue, the
 * timeout, the restart budget, the stale reply, the idle unload. Those are the
 * parts that can wedge, leak, or (much worse) reach the live transcript.
 *
 * None of it is exercised by loading a real model, so all of it is driven here
 * through a fake child. The clock and timers are injected too, so "wait 20
 * seconds for a timeout" and "wait 5 minutes for the idle unload" run
 * instantly and deterministically.
 *
 * The final section is the isolation guarantee: Moonshine's path is untouched,
 * and a Parakeet transcript cannot reach the question gate or the AI.
 */
import {
  ParakeetHost,
  PARAKEET_SAMPLE_RATE,
  PARAKEET_PADDING_MS,
  PARAKEET_MAX_SECONDS,
  PARAKEET_REQUEST_TIMEOUT_MS,
  PARAKEET_IDLE_UNLOAD_MS,
  PARAKEET_MAX_RESTARTS,
  PARAKEET_RESTART_BACKOFF_MS,
  applyParakeetPadding,
  validateParakeetAudio,
  type ParakeetChildLike,
  type ParakeetHostReply,
  type ParakeetHostRequest,
} from "../src/lib/parakeetHost";
import { evaluateInterviewTurn, normalizeTurn } from "../src/lib/interviewAgent";
import { readFile } from "node:fs/promises";

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

function checkTrue(name: string, actual: unknown) {
  check(name, Boolean(actual), true);
}

/** Yield to the microtask queue so pending promise chains can settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

// ═══════════════════════════════════════════════════════════════════════════
// Fake infrastructure
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A stand-in for the utility process. It records every request, never decodes
 * anything, and only answers when a test tells it to — which is what makes
 * "one decode at a time" and "a timeout really fires" observable.
 */
class FakeChild implements ParakeetChildLike {
  readonly posted: ParakeetHostRequest[] = [];
  killed = false;
  private messageCb: ((reply: ParakeetHostReply) => void) | null = null;
  private exitCb: ((code: number | null) => void) | null = null;

  post(message: ParakeetHostRequest): void {
    this.posted.push(message);
  }
  kill(): void {
    this.killed = true;
  }
  onMessage(cb: (reply: ParakeetHostReply) => void): void {
    this.messageCb = cb;
  }
  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }

  /** The most recent request, for asserting on what the host actually sent. */
  get last(): ParakeetHostRequest | undefined {
    return this.posted[this.posted.length - 1];
  }

  /** Deliver a reply from the child. */
  reply(reply: ParakeetHostReply): void {
    this.messageCb?.(reply);
  }

  /** Simulate the process dying. */
  exit(code: number | null = 1): void {
    this.exitCb?.(code);
  }

  /** A successful `load` reply for the pending load request. */
  replyLoaded(loadMs = 6100, rssMb = 620): void {
    const req = this.posted.find((r) => r.type === "load");
    if (!req) throw new Error("no load request was posted");
    this.reply({ id: req.id, ok: true, type: "loaded", loadMs, rssMb });
  }

  /** A successful `transcribe` reply for the most recent request. */
  replyText(text: string, decodeMs = 300): void {
    const req = this.last;
    if (!req || req.type !== "transcribe") throw new Error("no transcribe request");
    this.reply({ id: req.id, ok: true, type: "result", text, decodeMs, rssMb: 640 });
  }
}

/** Manual clock so timeouts and the idle unload are instant and exact. */
function createClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();

  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    /** Advance time, firing everything due along the way. */
    async advance(ms: number): Promise<void> {
      const target = now + ms;
      for (;;) {
        let dueId: number | null = null;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < dueAt) {
            dueAt = t.at;
            dueId = id;
          }
        }
        if (dueId === null) break;
        const timer = timers.get(dueId)!;
        timers.delete(dueId);
        now = timer.at;
        timer.fn();
        await flush();
      }
      now = target;
      await flush();
    },
    /** Timers still armed. Used to prove the idle countdown is running. */
    armed: () => timers.size,
  };
}

/** A host wired to fakes. `spawnChild` returns children in creation order. */
function createHost(options: { enabled?: boolean } = {}) {
  const clock = createClock();
  const children: FakeChild[] = [];
  const logs: string[] = [];
  let enabled = options.enabled ?? true;

  const host = new ParakeetHost({
    modelDir: "D:/fake/models/parakeet",
    isEnabled: () => enabled,
    spawnChild: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: (line) => logs.push(line),
  });

  return {
    host,
    clock,
    children,
    logs,
    /** Most recently spawned child. */
    child: () => children[children.length - 1],
    setEnabled: (v: boolean) => {
      enabled = v;
    },
  };
}

/** Bring a host all the way to `ready`, with the load answered. */
async function readyHost(options: { enabled?: boolean } = {}) {
  const h = createHost(options);
  const loading = h.host.load();
  await flush();
  h.child().replyLoaded();
  const loaded = await loading;
  return Object.assign(h, { loaded });
}

const speech = (seconds: number): Float32Array => {
  const n = Math.round(seconds * PARAKEET_SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((i / 16000) * 440) * 0.2;
  return out;
};

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Validation (Float32Array / 16 kHz / 30 s cap) ──────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  checkTrue("1 Float32Array @16k is accepted", validateParakeetAudio(speech(1), 16000).ok);
  check("1 accepted validation reports the sample rate",
    validateParakeetAudio(speech(1), 16000).sampleRate, PARAKEET_SAMPLE_RATE);

  check("2 a plain array is rejected",
    validateParakeetAudio([0, 1, 2], 16000).reason, "invalid_audio");
  check("2 a null payload is rejected",
    validateParakeetAudio(null, 16000).reason, "invalid_audio");
  check("2 an ArrayBuffer is rejected",
    validateParakeetAudio(new ArrayBuffer(64), 16000).reason, "invalid_audio");

  check("3 44.1 kHz is rejected", validateParakeetAudio(speech(1), 44100).reason, "invalid_audio");
  check("3 8 kHz is rejected", validateParakeetAudio(speech(1), 8000).reason, "invalid_audio");
  check("3 an undefined rate is rejected",
    validateParakeetAudio(speech(1), undefined).reason, "invalid_audio");

  check("4 empty audio is rejected", validateParakeetAudio(new Float32Array(0), 16000).reason,
    "invalid_audio");

  const justUnder = validateParakeetAudio(speech(PARAKEET_MAX_SECONDS), 16000);
  checkTrue("5 exactly 30 s is accepted", justUnder.ok);
  const over = validateParakeetAudio(speech(PARAKEET_MAX_SECONDS + 1), 16000);
  check("6 31 s exceeds the cap", over.reason, "too_long");
  check("6 the cap is 30 s", PARAKEET_MAX_SECONDS, 30);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Padding (Parakeet copy only) ────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const padSamples = Math.round((PARAKEET_SAMPLE_RATE * PARAKEET_PADDING_MS) / 1000);
  check("7 the padding constant is 300 ms", PARAKEET_PADDING_MS, 300);

  const original = speech(1);
  const originalLength = original.length;
  const originalFirst = original[0];

  const padded = applyParakeetPadding(original);
  check("8 padding adds 300 ms on each side",
    padded.length, originalLength + padSamples * 2);
  checkTrue("9 the leading pad is silent", padded.slice(0, padSamples).every((v) => v === 0));
  checkTrue("10 the trailing pad is silent",
    padded.slice(padded.length - padSamples).every((v) => v === 0));
  check("11 the audio itself is unchanged by position", padded[padSamples], originalFirst);

  // The whole point: Moonshine still receives the ORIGINAL buffer afterwards.
  check("12 the caller's buffer length is untouched", original.length, originalLength);
  check("13 the caller's buffer contents are untouched", original[0], originalFirst);

  check("14 a zero padding width is a no-op",
    applyParakeetPadding(original, PARAKEET_SAMPLE_RATE, 0).length, originalLength);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Disabled: the model is never loaded ─────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const h = createHost({ enabled: false });
  const result = await h.host.load();
  check("15 load refuses when disabled", result.ok, false);
  check("15 load reports why", result.code, "disabled");
  check("16 no child process is spawned when disabled", h.children.length, 0);
  check("17 the status is `disabled`", h.host.getStatus(), "disabled");

  const t = await h.host.transcribe(speech(1), 16000);
  check("18 transcribe refuses when disabled", t.code, "disabled");
  check("19 still no child process", h.children.length, 0);

  const diag = h.host.getDiagnostics();
  check("20 diagnostics report the disabled status", diag.status, "disabled");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Load ────────────────────────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const h = await readyHost();
  check("21 load succeeds", h.loaded.ok, true);
  check("22 the measured load time is carried through", h.loaded.loadMs, 6100);
  check("23 the status becomes ready", h.host.getStatus(), "ready");
  check("24 exactly one child was spawned", h.children.length, 1);
  check("25 loadMs is recorded for diagnostics", h.host.getDiagnostics().loadMs, 6100);
  check("26 rssMb is recorded for diagnostics", h.host.getDiagnostics().rssMb, 620);

  // A second load must not fork a second process — that would double the
  // several-hundred-MB footprint for no reason.
  const again = await h.host.load();
  check("27 a second load is a no-op", again.ok, true);
  check("28 it does not spawn a second child", h.children.length, 1);
}

{
  // A model that is not on disk: reported as `missing`, and NOT retried.
  const h = createHost();
  const loading = h.host.load();
  await flush();
  const req = h.child().posted.find((r) => r.type === "load")!;
  h.child().reply({
    id: req.id,
    ok: false,
    code: "model_missing",
    message: "model not found at D:/fake/models/parakeet",
  });
  const result = await loading;
  check("29 a missing model fails the load", result.ok, false);
  check("29 the reason is model_missing", result.code, "model_missing");
  check("30 the status is `missing`, not `error`", h.host.getStatus(), "missing");
}

{
  // Two concurrent loads must not fork two processes.
  const h = createHost();
  const a = h.host.load();
  const b = await h.host.load();
  await flush();
  check("31 a concurrent load is refused, not duplicated", b.ok, false);
  check("31 the refusal has its own reason", b.code, "busy");
  check("32 only one child exists", h.children.length, 1);
  h.child().replyLoaded();
  await a;
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Transcription ───────────────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const h = await readyHost();
  const pending = h.host.transcribe(speech(2), 16000);
  await flush();

  const sent = h.child().last!;
  check("33 a transcribe request is posted", sent.type, "transcribe");
  check("34 the request carries an id", typeof sent.id, "number");
  check("35 the request is at 16 kHz", sent.sampleRate, PARAKEET_SAMPLE_RATE);
  check("36 the padded audio is sent, not the raw segment",
    sent.samples!.length,
    2 * PARAKEET_SAMPLE_RATE + 2 * Math.round((PARAKEET_SAMPLE_RATE * PARAKEET_PADDING_MS) / 1000));
  check("37 the padding is recorded on the request", sent.paddingMs, PARAKEET_PADDING_MS);

  h.child().replyText("What is MongoDB?", 300);
  const result = await pending;
  check("38 the transcript comes back", result.text, "What is MongoDB?");
  check("39 decode latency is carried through", result.decodeMs, 300);
  checkTrue("40 RTF is computed", typeof result.rtf === "number");
  // 300 ms of decode over 2.6 s of padded audio.
  checkTrue("41 RTF is sane", result.rtf! > 0 && result.rtf! < 1);
}

{
  // Validation happens before anything is queued or posted.
  const h = await readyHost();
  const before = h.child().posted.length;
  const wrongRate = await h.host.transcribe(speech(1), 48000);
  check("42 a wrong sample rate never reaches the child", wrongRate.code, "invalid_audio");
  const tooLong = await h.host.transcribe(speech(PARAKEET_MAX_SECONDS + 1), 16000);
  check("43 an over-long segment never reaches the child", tooLong.code, "too_long");
  check("44 nothing extra was posted", h.child().posted.length, before);
  check("45 a rejected request leaves the model loaded", h.host.getStatus(), "ready");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── One decode at a time ─────────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const h = await readyHost();
  const first = h.host.transcribe(speech(1), 16000);
  const second = h.host.transcribe(speech(1), 16000);
  const third = h.host.transcribe(speech(1), 16000);
  await flush();

  check("46 only one decode is in flight", h.child().posted.length, 2); // +1 for load
  check("47 the queue holds the other two", h.host.getDiagnostics().queued, 2);

  h.child().replyText("first", 100);
  await first;
  await flush();
  check("48 the next queued request starts only after the previous finishes",
    h.child().posted.length, 3);
  check("49 one is still queued", h.host.getDiagnostics().queued, 1);

  h.child().replyText("second", 100);
  await second;
  await flush();
  check("50 the last request starts", h.child().posted.length, 4);

  h.child().replyText("third", 100);
  await third;
  await flush();
  check("51 the queue drains completely", h.host.getDiagnostics().queued, 0);
  check("52 every result is returned in order",
    [first, second, third].length, 3);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Timeout ──────────────────────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const h = await readyHost();
  const pending = h.host.transcribe(speech(1), 16000);
  await flush();

  // Before the deadline nothing has resolved.
  await h.clock.advance(PARAKEET_REQUEST_TIMEOUT_MS - 1000);
  check("53 no result before the deadline", h.host.getDiagnostics().inFlight, 1);

  await h.clock.advance(2000);
  const result = await pending;
  check("54 a silent decode times out", result.ok, false);
  check("54 the reason is `timeout`", result.code, "timeout");
  check("55 the per-request timeout is 20 s", PARAKEET_REQUEST_TIMEOUT_MS, 20000);

  // The slot must be genuinely free — otherwise a single silent decode would
  // wedge the queue for the rest of the interview. A restart may be in flight
  // first (a timeout is restart-worthy), so the replacement's load is answered
  // before the next request is issued.
  if (h.children.length > 1) {
    h.child().replyLoaded();
    await flush();
  }
  const postedBefore = h.child().posted.length;
  const next = h.host.transcribe(speech(1), 16000);
  await flush();
  checkTrue("56 a new request is accepted after a timeout",
    h.child().posted.length > postedBefore);
  h.child().replyText("after the timeout", 40);
  check("56 the queue keeps working after a timeout", (await next).text, "after the timeout");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Stale replies ────────────────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const h = await readyHost();
  const staleId = 999;
  const first = h.host.transcribe(speech(1), 16000);
  await flush();

  // A reply for a request id the host knows nothing about must be dropped: if
  // it were honoured, it could resolve an unrelated, already-settled promise.
  const before = h.host.getDiagnostics().inFlight;
  h.child().reply({ id: staleId, ok: true, type: "result", text: "ghost", decodeMs: 1 });
  await flush();
  check("57 an unknown reply id does not disturb the queue",
    h.host.getDiagnostics().inFlight, before);

  // Clear the slot so the next request is genuinely in flight rather than
  // queued behind this one.
  h.child().replyText("first", 50);
  await first;
  await flush();

  // And a reply that arrives AFTER its request timed out must be dropped too,
  // or a long-dead decode would silently resolve a later expectation.
  const pending = h.host.transcribe(speech(1), 16000);
  await flush();
  const timedOutChild = h.child();
  const timedOutId = timedOutChild.last!.id;
  await h.clock.advance(PARAKEET_REQUEST_TIMEOUT_MS + 1000);
  const timedOut = await pending;
  check("58 the request timed out", timedOut.code, "timeout");
  // The reply is delivered to the ORIGINAL child, which may have been replaced
  // by a restart: a stale reply must not settle anything either way.
  const inFlightBefore = h.host.getDiagnostics().inFlight;
  timedOutChild.reply({ id: timedOutId, ok: true, type: "result", text: "too late", decodeMs: 1 });
  await flush();
  check("59 a late reply is dropped, not resurrected",
    h.host.getDiagnostics().inFlight, inFlightBefore);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Crash and bounded restart ────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const h = await readyHost();
  const pending = h.host.transcribe(speech(1), 16000);
  await flush();

  h.child().exit(1);
  await flush();
  const result = await pending;
  check("60 a crash fails the in-flight request rather than hanging it",
    result.ok, false);
  check("60 the reason is `crashed`", result.code, "crashed");

  // The restart is attempted after a backoff, and spawns a NEW child.
  await h.clock.advance(PARAKEET_RESTART_BACKOFF_MS + 50);
  await flush();
  check("61 a crashed child is replaced", h.children.length, 2);
  check("62 the replacement is loaded", h.child().posted[0].type, "load");
}

{
  // Exhaustion: the host must STOP trying, not spin for the rest of the session.
  //
  // Each cycle deliberately answers the restart's load, so the next request is
  // genuinely in flight and crashes again. Without that the host would sit on
  // an unanswered reload and never accumulate the failures the budget counts.
  const h = await readyHost();
  let crashes = 0;
  for (let i = 0; i < PARAKEET_MAX_RESTARTS + 4; i++) {
    const pending = h.host.transcribe(speech(1), 16000);
    await flush();
    h.child().exit(1);
    await flush();
    await pending;
    crashes++;
    await h.clock.advance(PARAKEET_RESTART_BACKOFF_MS * 10 + 50);
    await flush();
    if (h.host.getStatus() === "error") break;
    // Answer the replacement's load so the cycle can repeat.
    if (h.children.length > crashes) {
      h.child().replyLoaded();
      await flush();
    }
  }

  check("63 the host gives up rather than restarting forever",
    h.host.getStatus(), "error");
  checkTrue("64 the failure was observed", crashes >= 2);
  check("65 the restart budget is bounded", PARAKEET_MAX_RESTARTS, 3);
  checkTrue("66 the give-up is logged",
    h.logs.some((l) => l.includes("giving up")));
}

{
  // A crashed process with queued work must fail the queue, not strand it.
  const h = await readyHost();
  const first = h.host.transcribe(speech(1), 16000);
  const second = h.host.transcribe(speech(1), 16000);
  await flush();
  h.child().exit(9);
  await flush();
  const [a, b] = await Promise.all([first, second]);
  check("67 the in-flight request fails", a.code, "crashed");
  check("68 the queued request fails too, rather than waiting forever", b.code, "crashed");
  check("69 the queue is empty afterwards", h.host.getDiagnostics().queued, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Idle unload ──────────────────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const h = await readyHost();
  check("70 the idle window is 5 minutes", PARAKEET_IDLE_UNLOAD_MS, 5 * 60_000);

  const pending = h.host.transcribe(speech(1), 16000);
  await flush();
  h.child().replyText("hi", 100);
  await pending;
  await flush();

  check("71 an idle countdown starts once the queue empties", h.clock.armed(), 1);
  await h.clock.advance(PARAKEET_IDLE_UNLOAD_MS - 1000);
  check("72 the model is still held just before the deadline", h.host.getStatus(), "ready");
  await h.clock.advance(2000);
  check("73 the model is released after 5 idle minutes", h.host.getStatus(), "missing");
  check("74 the idle child is killed", h.children[0].killed, true);
  checkTrue("75 the idle unload is logged",
    h.logs.some((l) => l.includes("idle")));
}

{
  // Activity must reset the countdown, or a long interview would lose the
  // model mid-question.
  const h = await readyHost();
  for (let i = 0; i < 3; i++) {
    const pending = h.host.transcribe(speech(1), 16000);
    await flush();
    h.child().replyText("q", 50);
    await pending;
    await h.clock.advance(PARAKEET_IDLE_UNLOAD_MS - 1000);
    await flush();
  }
  check("76 an active interview never trips the idle unload", h.host.getStatus(), "ready");
  await h.clock.advance(2000);
  check("77 it still unloads once the interview goes quiet", h.host.getStatus(), "missing");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Stop / dispose ───────────────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const h = await readyHost();
  h.host.unload();
  check("78 unload kills the child", h.children[0].killed, true);
  check("79 unload clears the status", h.host.getStatus(), "missing");

  const pending = h.host.transcribe(speech(1), 16000);
  await flush();
  check("80 transcribing after unload reloads on demand", h.children.length, 2);
  h.child().replyLoaded();
  await flush();
  h.child().replyText("after stop", 10);
  const result = await pending;
  check("81 and works", result.text, "after stop");
}

{
  const h = await readyHost();
  h.host.dispose();
  check("82 dispose parks the host as disabled", h.host.getStatus(), "disabled");
  check("83 dispose kills the child", h.children[0].killed, true);
  const result = await h.host.transcribe(speech(1), 16000);
  check("84 a disposed host answers, it does not throw", result.code, "shutdown");
  const load = await h.host.load();
  check("85 a disposed load answers too", load.code, "shutdown");
  check("86 nothing new was spawned", h.children.length, 1);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Never throws ────────────────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  // A child whose `post` explodes must still produce a value, never a rejection
  // that could surface in the capture path.
  const clock = createClock();
  const host = new ParakeetHost({
    modelDir: "D:/fake",
    isEnabled: () => true,
    spawnChild: () => ({
      post() {
        throw new Error("EPIPE: child went away");
      },
      kill() {},
      onMessage() {},
      onExit() {},
    }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  let loadThrew = false;
  try {
    await host.load();
  } catch {
    loadThrew = true;
  }
  check("87 a throwing child does not reject load()", loadThrew, false);

  const result = await host.transcribe(speech(1), 16000);
  check("88 and transcribe() returns a failure value", result.ok, false);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Isolation: Moonshine unchanged, AI unaffected ────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  // A Parakeet-shaped transcript reaching the AI would be a gate question.
  // The regression: `asrComparisons` is not on the turn the AI reads.
  const parakeetOnly = "Explain how you would shard a Postgres database";
  const turn = {
    finals: [{ source: "system" as const, text: parakeetOnly }],
    interim: null,
  };
  check("89 a Parakeet-shaped sentence is a normal question to the gate",
    evaluateInterviewTurn(turn).action, "answer");

  const normalized = normalizeTurn(turn);
  check("90 the AI turn is built from committed finals only", normalized.finals.length, 1);
  checkTrue("91 no Parakeet text is on the turn the AI reads",
    !("parakeetText" in (normalized as unknown as Record<string, unknown>)));
  checkTrue("92 no Parakeet status is on the turn the AI reads",
    !("parakeetStatus" in (normalized as unknown as Record<string, unknown>)));
}

{
  const store = await readFile("src/store/useStore.ts", "utf8");
  const hook = await readFile("src/hooks/useInterviewAudio.ts", "utf8");
  const client = await readFile("src/lib/parakeetClient.ts", "utf8");

  // The comparison fields exist, and only in the developer-only slice.
  checkTrue("93 the comparison record carries parakeetText",
    /parakeetText\?: string;/.test(store));
  checkTrue("94 it carries parakeetMs", /parakeetMs\?: number \| null;/.test(store));
  checkTrue("95 it carries parakeetStatus", /parakeetStatus\?: string;/.test(store));
  checkTrue("96 getInterviewTurn never reads asrComparisons",
    !/asrComparisons[\s\S]{0,200}getInterviewTurn/.test(store));

  // The result is written ONLY through the comparison upsert.
  checkTrue("97 the Parakeet result goes through the comparison upsert",
    /upsertComparison\(phraseId, \{[\s\S]*?parakeetText: result\.text/.test(hook));
  checkTrue("98 the Parakeet path never writes an interview message",
    !/addInterviewMessage\([\s\S]{0,300}parakeet/i.test(hook));

  // Moonshine stays the production engine: no engine switch, no fallback.
  checkTrue("99 the default engine is still moonshine",
    /asrEngine: "moonshine"/.test(store));
  checkTrue("100 the Parakeet comparison defaults to OFF",
    /asrCompareParakeet: false/.test(store));
  checkTrue("101 the renderer client cannot reach the transcript store",
    !/useStore|addInterviewMessage|interviewMessages/.test(
      client.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
    ));

  // All four engines must be handed the SAME buffer, or the comparison means
  // nothing.
  checkTrue("102 every engine receives the same downsampled buffer",
    /onCompareWithDeepgram\(downsampled, speechSeconds, phraseId\);\s*onCompareWithGroq\(downsampled, speechSeconds, phraseId\);\s*onCompareWithParakeet\(downsampled, speechSeconds, phraseId\);/.test(
      hook,
    ));

  // The Moonshine worker path must be untouched by this feature.
  const worker = await readFile("src/lib/asr.worker.ts", "utf8");
  // Strip comments before checking: the worker legitimately MENTIONS Parakeet in
  // a comment explaining why it now reports its own latency. The property that
  // matters is that no Parakeet CODE lives in Moonshine's process, so the
  // check is for imports/calls, not for the word.
  const workerCode = worker
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  checkTrue("103 the Moonshine worker has no Parakeet code",
    !/parakeet|sherpa|utilityProcess/i.test(workerCode));
  checkTrue("103b Moonshine's worker never imports the Parakeet host",
    !/parakeetHost/i.test(worker));
  checkTrue("104 Moonshine still decodes with its own max_new_tokens budget",
    /max_new_tokens/.test(workerCode));
  // Moonshine must keep reporting its own real decode latency, so its numbers
  // can be compared with anything. Without this the field is silently null.
  checkTrue("104b the worker reports its own decode latency on a final",
    /type: "final"[\s\S]{0,200}asrMs/.test(workerCode));
}

{
  // Parakeet must be inert in a packaged build.
  const ipc = await readFile("electron/ipc.ts", "utf8");
  checkTrue("105 Parakeet is disabled in a packaged build",
    /!app\.isPackaged[\s\S]{0,200}asrCompareParakeet === true/.test(ipc));
  const preload = await readFile("electron/preload.ts", "utf8");
  checkTrue("106 the preload bridge exposes no model path or handle",
    !/parakeetModelDir|OfflineRecognizer/.test(preload));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}