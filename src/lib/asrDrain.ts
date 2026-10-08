/**
 * The bounded ASR drain barrier.
 *
 * ── The race this closes ────────────────────────────────────────────────────
 * `Ctrl+Enter` (`electron/hotkeys.ts` → `onSolve` → `Home.tsx`) reads the
 * transcript SYNCHRONOUSLY out of the store:
 *
 *     const turn = useStore.getState().getInterviewTurn();
 *
 * But a final ASR result is not in the store the instant the interviewer's
 * speech ends. It is posted to the worker's `finals[]` queue, decoded, and only
 * then delivered back to the hook, which is what calls `addInterviewMessage`.
 * On a typical machine a decode is a few hundred milliseconds.
 *
 * So if the interviewer stopped speaking and the user pressed `Ctrl+Enter`
 * within that window, the words at the END of the question were still sitting in
 * the worker queue. The question was submitted without them — the single most
 * damaging possible failure for an interview assistant, because the answer is
 * confidently wrong rather than visibly broken.
 *
 * There was previously no flush or drain operation anywhere in the codebase;
 * the only thing between the hotkey and `getInterviewTurn()` was nothing.
 *
 * ── Why it is bounded, and why it is here rather than in `Home.tsx` ─────────
 * The hotkey must NEVER hang. A stalled or wedged worker would otherwise freeze
 * the whole submit path behind an await, and the user would have to kill the
 * app. So:
 *
 *   • every wait is capped by {@link DRAIN_DEADLINE_MS};
 *   • on timeout the barrier RESOLVES ANYWAY and reports `timedOut`, so the
 *     submit proceeds on whatever has been committed — degraded, never stuck.
 *
 * The sequencing rules (flush, wait for the marker, re-check, repeat) are pure
 * state machine logic with no worker, DOM or React dependency, so they can be
 * unit-tested with a scripted fake. Only {@link createAsrDrain}'s `flush`
 * callback touches a real `Worker`.
 */

/**
 * Hard cap on the whole barrier, in ms.
 *
 * Sized against the measured decode cost: WASM/q8 transcribes a 1 s buffer in
 * ~0.23 s and a real utterance in ~0.6 s, so a single queued final is normally
 * well inside this. 900 ms leaves room for two queued finals plus event-loop
 * scheduling while still being short enough that a human pressing a hotkey
 * perceives it as instant. Beyond this we submit what we have.
 */
export const DRAIN_DEADLINE_MS = 900;

/** Ceiling on drain retries, a second guard against a worker that never idles. */
export const MAX_DRAIN_ATTEMPTS = 4;

/** How long to wait for one flush round-trip before re-checking. */
export const DRAIN_STEP_MS = 150;

export type DrainOutcome =
  /** Every final that was queued when the barrier started has been committed. */
  | "drained"
  /**
   * The deadline passed with finals still outstanding. The barrier resolved
   * anyway so the submit proceeds on the committed transcript. This is a
   * degraded submit, not a failure — and it is always logged.
   */
  | "timedOut"
  /**
   * No finals were outstanding when the barrier started, so there was nothing
   * to wait for. Distinguished from `drained` so the hotkey path can skip the
   * round-trip entirely in the common case.
   */
  | "alreadyIdle"
  /** No ASR worker is attached (capture not running) — nothing can be pending. */
  | "noWorker";

export interface DrainResult {
  outcome: DrainOutcome;
  /** Wall-clock time spent in the barrier, in ms. */
  waitedMs: number;
  /** Flush round-trips performed. */
  attempts: number;
  /**
   * True when the barrier is making no forward progress and the caller should
   * expect a truncated question. Always logged; never silently ignored.
   */
  timedOut: boolean;
}

/** The subset of the worker's flush protocol this barrier depends on. */
export interface FlushTransport {
  /**
   * Ask the worker to report when its final queue reaches the marker. Resolves
   * with the number of finals still outstanding at that moment, or `null` if
   * the worker did not answer in time.
   */
  flush(): Promise<number | null>;
  /**
   * Finals currently outstanding, or `null` when unknown. Used for the fast
   * path so an already-idle worker costs zero round-trips.
   */
  pending(): number | null;
}

export interface DrainOptions {
  /** Overrides {@link DRAIN_DEADLINE_MS}. Tests use this; production does not. */
  deadlineMs?: number;
  /** Overrides {@link DRAIN_STEP_MS}. */
  stepMs?: number;
  /** Overrides {@link MAX_DRAIN_ATTEMPTS}. */
  maxAttempts?: number;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
  /** Injectable sleep, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AsrDrain {
  drain(): Promise<DrainResult>;
}

export function createAsrDrain(
  transport: FlushTransport | null,
  options: DrainOptions = {},
): AsrDrain {
  const deadlineMs = options.deadlineMs ?? DRAIN_DEADLINE_MS;
  const stepMs = options.stepMs ?? DRAIN_STEP_MS;
  const maxAttempts = options.maxAttempts ?? MAX_DRAIN_ATTEMPTS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;

  return {
    async drain(): Promise<DrainResult> {
      const started = now();

      // Nothing is capturing, so nothing can be in flight. The hotkey still
      // works for screenshots in this state, so this must not block.
      if (!transport) {
        return {
          outcome: "noWorker",
          waitedMs: 0,
          attempts: 0,
          timedOut: false,
        };
      }

      // Fast path: the worker knows its own queue is empty, so there is no
      // point paying a round-trip. This is the case for every screenshot-only
      // submit and for a hotkey pressed long after the question finished.
      const initial = transport.pending();
      if (initial === 0) {
        return {
          outcome: "alreadyIdle",
          waitedMs: now() - started,
          attempts: 0,
          timedOut: false,
        };
      }

      let attempts = 0;

      // Loop until the worker's queue is empty, the deadline passes, or the
      // attempt cap trips. Each pass puts a marker behind everything queued so
      // far, waits for it, then re-reads the count: a final that arrived
      // DURING the wait shows up as a non-zero count and gets picked up by the
      // next pass, so nothing that was in flight at any point is missed.
      while (attempts < maxAttempts && now() - started < deadlineMs) {
        attempts++;
        const remaining = transport.pending();
        if (remaining === 0) {
          return {
            outcome: "drained",
            waitedMs: now() - started,
            attempts,
            timedOut: false,
          };
        }

        const outstanding = await transport.flush();
        if (outstanding !== null && outstanding === 0) {
          return {
            outcome: "drained",
            waitedMs: now() - started,
            attempts,
            timedOut: false,
          };
        }

        // The worker did not answer, or answered with work still queued.
        // Yield so the final's `postMessage` can be delivered, then re-check.
        if (now() - started >= deadlineMs) break;
        await sleep(Math.min(stepMs, deadlineMs - (now() - started)));
      }

      // One last read: the last flush may have completed as the loop exited.
      if (transport.pending() === 0) {
        return {
          outcome: "drained",
          waitedMs: now() - started,
          attempts,
          timedOut: false,
        };
      }

      return {
        outcome: "timedOut",
        waitedMs: now() - started,
        attempts,
        timedOut: true,
      };
    },
  };
}

/** Human-readable one-liner for the `[ASR]` diagnostic line. */
export function describeDrain(result: DrainResult): string {
  switch (result.outcome) {
    case "drained":
      return `drained in ${result.waitedMs}ms (${result.attempts} flush${
        result.attempts === 1 ? "" : "es"
      })`;
    case "alreadyIdle":
      return "already idle, no barrier needed";
    case "noWorker":
      return "no ASR worker attached, nothing pending";
    case "timedOut":
      return `TIMED OUT after ${result.waitedMs}ms (${result.attempts} flushes) — submitting the committed transcript, the tail of the question may be missing`;
  }
}

// ── The bridge between the hook that owns the worker and the hotkey ────────
//
// `useInterviewAudio` is instantiated in `InterviewModal`, but the hotkey
// handler that needs this barrier lives in `Home.tsx` — a different component
// tree position entirely, and re-parenting the capture session to make the
// call direct would be a far larger change than the problem warrants.
//
// So the hook PUBLISHES its drain function into this module-level slot and the
// hotkey CONSUMES it. This is the same shape as `lib/audioStatus.ts`, which
// exists for the same reason (audio level must be shared between the capture
// hook and the overlay without re-rendering React 20x/second). Keeping it here
// also means the singleton is trivially resettable in tests.
let activeDrain: (() => Promise<DrainResult>) | null = null;

/** Called by the capture hook when it mounts. */
export function registerAsrDrain(fn: (() => Promise<DrainResult>) | null): void {
  activeDrain = fn;
}

/**
 * Await the capture session's drain barrier, if there is one.
 *
 * Resolves immediately when no session is mounted (screenshots-only submit, or
 * the interview panel is closed), so this is always safe to call on the hotkey
 * path without a guard.
 */
export async function drainInterviewAsr(): Promise<DrainResult> {
  if (!activeDrain) {
    return {
      outcome: "noWorker",
      waitedMs: 0,
      attempts: 0,
      timedOut: false,
    };
  }
  // A rejection here would mean the hook's drain threw, which must never
  // block the submit. Degrade to "nothing pending" rather than propagating.
  try {
    return await activeDrain();
  } catch (err) {
    console.warn(`[ASR] drain barrier failed: ${err}`);
    return {
      outcome: "timedOut",
      waitedMs: 0,
      attempts: 0,
      timedOut: true,
    };
  }
}
