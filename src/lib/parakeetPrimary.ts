/**
 * Everything about Parakeet-as-primary that is a POLICY rather than plumbing.
 *
 * Kept out of the hook on purpose. The two decisions below — what happens to a
 * segment that arrives while the model is still loading, and how long the submit
 * drain may wait for a Parakeet decode — are the two places where being wrong
 * either loses a question or hangs the hotkey. Both are pure state machines, so
 * both are exercised directly by the test harness against a fake clock.
 */

/**
 * Ceiling on segments buffered while the model is still loading.
 *
 * ── Why queue rather than fall back ──────────────────────────────────────────
 * The obvious alternative is to send every early segment to Moonshine. That is
 * the wrong trade on this machine: Moonshine's WASM/q8 path was measured at
 * ~22 s to load (far slower than Parakeet's ~7 s), so "fall back immediately"
 * would mean triggering a much longer load than the one it is avoiding. Queueing
 * is strictly faster here, and it keeps a single decode path.
 *
 * ── Why a bound is still needed ─────────────────────────────────────────────
 * An unbounded queue holding 16 kHz `Float32Array`s is unbounded memory in the
 * renderer. The bound is stated in TWO units because one is not sufficient:
 * eight very short segments is a fraction of a second of audio, while three
 * long ones is nearly the whole cap. Whichever is reached first drops, so the
 * worst case is bounded in BOTH count and duration.
 *
 * ── Why eight and 60 s ──────────────────────────────────────────────────────
 * The load was measured at 6.5 s standalone but 14.7–23.8 s in the app on a
 * machine already running the renderer, the capture pipeline and the ASR
 * comparison columns. At ~3–5 s per phrase, 60 s of cover is twelve to twenty
 * phrases — comfortably past the worst observed load, which is the entire point
 * of raising it from four. The old limit of four overflowed after roughly
 * 12–20 s of speech, which is exactly the window the slowest observed load
 * landed in.
 *
 * ── Which end overflow drops ────────────────────────────────────────────────
 * The OLDEST. A segment's job is to carry the question; the newest one is the
 * one whose tail is the actual ask, and the tail is also the part the drain
 * barrier is designed to protect. Dropping the newest would discard exactly what
 * the user is about to submit.
 */
export const PARAKEET_PRIMARY_QUEUE_LIMIT = 8;

/**
 * Ceiling on buffered AUDIO, in seconds.
 *
 * Derived from the measurement above rather than from the segment count, because
 * the two are genuinely different failure modes: a long-phrased speaker
 * overflows the count bound in seconds and a staccato one overflows the time
 * bound in a minute, and only the second bound describes how much audio — and
 * therefore how much memory — is actually at stake.
 *
 * 16 kHz mono `Float32Array` costs 64 KB per second, so the absolute worst case
 * here is under 4 MB.
 */
export const PARAKEET_PRIMARY_QUEUE_MAX_SECONDS = 60;

/** A segment waiting for the model to finish loading. */
export interface QueuedParakeetSegment<T> {
  /** Monotonic, supplied by the caller — the VAD phraseId. */
  phraseId: number;
  payload: T;
  /**
   * Speech duration of the segment, in seconds.
   *
   * Required because the queue's second bound is expressed in seconds and the
   * queue has no way to measure audio itself. The caller knows this from the
   * VAD; passing it in keeps the queue pure and testable with plain numbers.
   */
  seconds: number;
}

export interface SegmentQueueSnapshot {
  /** Segments currently buffered. */
  size: number;
  /**
   * Segments discarded because the queue was full, SINCE THE LAST `clear()`.
   *
   * Scoped to a session rather than to the object's lifetime on purpose: the
   * hook calls `clear()` on Start Interview, and a cumulative counter would make
   * the second session of a morning announce "14 dropped so far" from a session
   * that has dropped nothing yet.
   */
  dropped: number;
  /** Buffered audio, in seconds. */
  seconds: number;
}

/** Why a push returned `false`. */
export type QueueOverflowReason = "count" | "seconds";

export interface ParakeetSegmentQueue<T> {
  /**
   * Buffer a segment.
   *
   * Returns `true` if it was accepted. `false` means the queue was full and
   * this segment DISPLACED an older one — a real loss that must be surfaced to
   * the user, never swallowed.
   */
  push(segment: QueuedParakeetSegment<T>): boolean;
  /** Remove and return the oldest segment, or `null` when empty. */
  shift(): QueuedParakeetSegment<T> | null;
  /** Buffer length. */
  size(): number;
  /** Counters, for the diagnostics line and the on-screen log. */
  snapshot(): SegmentQueueSnapshot;
  /** Why the most recent push overflowed, or `null` when it did not. */
  lastOverflowReason(): QueueOverflowReason | null;
  /**
   * Forget everything, e.g. on Stop Interview / Start Interview.
   *
   * Resets the drop counter as well as the buffer: the queue is scoped to ONE
   * interview, and a counter carried across sessions reports losses that did not
   * happen in the session being described.
   */
  clear(): void;
}

export function createParakeetSegmentQueue<T>(
  limit: number = PARAKEET_PRIMARY_QUEUE_LIMIT,
  maxSeconds: number = PARAKEET_PRIMARY_QUEUE_MAX_SECONDS,
): ParakeetSegmentQueue<T> {
  const items: QueuedParakeetSegment<T>[] = [];
  let dropped = 0;
  let bufferedSeconds = 0;
  let overflow: QueueOverflowReason | null = null;

  return {
    push(segment) {
      const seconds =
        Number.isFinite(segment.seconds) && segment.seconds > 0
          ? segment.seconds
          : 0;

      // Whether this push overflows, and WHY, decided before anything is
      // evicted so the reported reason names the bound that actually broke.
      const countOverflow = items.length >= limit;
      const secondsOverflow = bufferedSeconds + seconds > maxSeconds;
      overflow = countOverflow ? "count" : secondsOverflow ? "seconds" : null;
      const accepted = overflow === null;

      // Evict from the OLDEST end until BOTH bounds have room.
      //
      // Re-checking both bounds after every removal is what makes the
      // invariant "buffered <= maxSeconds" actually hold at all times. Testing
      // only the incoming segment's own length would let the queue hold eight
      // 40 s segments — 320 s — which defeats the point of a time bound.
      while (items.length >= limit || bufferedSeconds + seconds > maxSeconds) {
        const evicted = items.shift();
        // Nothing left to evict. A single segment longer than the whole time
        // bound is still admitted: dropping the only buffered question means
        // losing it outright, which is strictly worse than briefly exceeding
        // the bound. `overflow` still reports it so the caller can log it.
        if (!evicted) break;
        bufferedSeconds -= evicted.seconds;
        dropped++;
      }

      items.push(segment);
      bufferedSeconds += seconds;
      return accepted;
    },
    shift() {
      const next = items.shift() ?? null;
      if (next) bufferedSeconds -= next.seconds;
      return next;
    },
    size() {
      return items.length;
    },
    snapshot() {
      return { size: items.length, dropped, seconds: bufferedSeconds };
    },
    lastOverflowReason() {
      return overflow;
    },
    clear() {
      items.length = 0;
      bufferedSeconds = 0;
      overflow = null;
      // Reset, not carried. See the `dropped` doc comment: the counter describes
      // THIS session, and `clear()` is how a session begins.
      dropped = 0;
    },
  };
}

// ── Submit drain ────────────────────────────────────────────────────────────

/**
 * Cap on how long the submit drain waits for an in-flight PARAKEET decode.
 *
 * ── Why Parakeet needs a different budget from Moonshine ─────────────────────
 * The drain exists to stop the tail of a question being submitted without its
 * last words. Its deadline (900 ms) was sized against Moonshine, whose measured
 * decode is ~0.6 s for a real utterance. Parakeet's decode measured 326-2231 ms
 * live on this machine — its worst case is more than double the entire budget.
 * Leaving 900 ms in place would mean the barrier times out on most turns, which
 * reintroduces exactly the truncation it was built to prevent.
 *
 * 2500 ms sits above the observed worst case (2231 ms) with headroom for IPC,
 * while still being short enough that a human pressing a hotkey does not think
 * the app has hung.
 *
 * MOONSHINE'S 900 ms IS DELIBERATELY UNTOUCHED. This constant is only ever
 * passed to `createAsrDrain` on the Parakeet-primary path.
 *
 * Phase 8 is expected to measure how often this cap is actually reached.
 */
export const PARAKEET_DRAIN_DEADLINE_MS = 2500;

/**
 * Flush attempts allowed within {@link PARAKEET_DRAIN_DEADLINE_MS}.
 *
 * `createAsrDrain` caps attempts independently of the deadline, so a longer
 * deadline with the default 4 attempts would still stop early — 4 x 150 ms is
 * 600 ms of waiting regardless of the 2500 ms cap. Derived from the deadline so
 * the two can never disagree.
 */
export const PARAKEET_DRAIN_MAX_ATTEMPTS = Math.ceil(
  PARAKEET_DRAIN_DEADLINE_MS / 150,
);
