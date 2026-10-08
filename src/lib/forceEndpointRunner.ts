/**
 * The publisher/consumer bridge for the force-endpoint, mirroring
 * `lib/asrDrain.ts` exactly.
 *
 * `useInterviewAudio` owns the capture session and therefore the live VAD
 * instance, but the `Ctrl+Enter` handler that needs to close the open phrase
 * lives in `Home.tsx` — a different position in the component tree. Re-parenting
 * the capture session to make the call direct would be a far larger change than
 * the problem warrants, so the hook PUBLISHES and the hotkey CONSUMES, through a
 * module-level slot. Same shape, same reason, trivially resettable in tests.
 *
 * The consumer here is `forceEndpointOnSubmit`, which the hotkey path calls
 * BEFORE `drainInterviewAsr()`. Order matters: the force has to create the
 * final, and only the drain waits for it.
 */
import {
  decideForceEndpoint,
  describeForceEndpoint,
  type ForceEndpointReply,
  type ForceSkipReason,
} from "./forceEndpoint";

/** What the force-endpoint did, in numbers and a closed-vocabulary reason. */
export interface ForceEndpointOutcome {
  fired: boolean;
  /** The first reason it did not fire, or `"fired"`. */
  reason: ForceSkipReason | "fired" | "no-answer";
  /** Speech milliseconds buffered at decision time. */
  bufferedMs: number;
  /** Decode milliseconds for the forced phrase. Null when it did not fire. */
  decodeMs: number | null;
  /** The one log line, safe to print: numbers and a reason, nothing else. */
  log: string;
}

/** A no-op outcome used when no capture session is published. */
function skipped(reason: ForceSkipReason): ForceEndpointOutcome {
  const decision = decideForceEndpoint({
    enabled: false,
    parakeetPrimary: false,
    hasSession: false,
    phraseOpen: false,
    currentlySilent: false,
    speechSeconds: 0,
  });
  return {
    fired: false,
    reason,
    bufferedMs: Math.round(decision.bufferedSeconds * 1000),
    decodeMs: null,
    log: describeForceEndpoint({ ...decision, reason }, null),
  };
}

export interface ForceEndpointSession {
  /**
   * Whether the user wants the behaviour at all. `undefined` means ON — a
   * settings blob written before the key existed must get the intended default,
   * not silently keep the old truncating behaviour.
   */
  enabled: boolean;
  parakeetPrimary: boolean;
  /** Ask the live worklet to close its open phrase. */
  forceEndpoint: () => Promise<ForceEndpointReply>;
  /** Current mirror of the worklet's phrase state. */
  state: () => { phraseOpen: boolean; speechSeconds: number; silentNow: boolean };
  /**
   * Wait for the forced phrase to be committed by the engine, up to `capMs`.
   *
   * The existing Parakeet drain cap is what bounds this, so the hotkey path
   * gains at most that much and never unboundedly. Returns the decode
   * milliseconds actually spent, or null if it did not commit in time.
   */
  waitForForcedDecode: (capMs?: number) => Promise<number | null>;
}

let activeSession: ForceEndpointSession | null = null;

/** Called by the capture hook when a session starts (and null when it ends). */
export function registerForceEndpoint(
  session: ForceEndpointSession | null,
): void {
  activeSession = session;
}

/** The published session, or null. Exposed for tests. */
export function getForceEndpointSession(): ForceEndpointSession | null {
  return activeSession;
}

/**
 * Run the force-endpoint decision for a submit.
 *
 * Every path returns rather than throws, and none of them can block: the worklet
 * request is bounded, and the decode wait is bounded by the caller. A failure
 * here must degrade to "the old behaviour", never to a broken hotkey.
 */
export async function forceEndpointOnSubmit(
  opts: { log?: (line: string) => void } = {},
): Promise<ForceEndpointOutcome> {
  const session = activeSession;
  if (!session) return skipped("no-capture-session");

  const state = session.state();
  const decision = decideForceEndpoint({
    enabled: session.enabled,
    parakeetPrimary: session.parakeetPrimary,
    hasSession: true,
    phraseOpen: state.phraseOpen,
    currentlySilent: state.silentNow,
    speechSeconds: state.speechSeconds,
  });

  if (!decision.fire) {
    // `decideForceEndpoint` cannot return `reason: "fire"` together with
    // `fire: false` — they are set together on every branch — but TypeScript
    // cannot see that across two fields, hence the narrow.
    const reason = decision.reason as ForceSkipReason;
    const outcome: ForceEndpointOutcome = {
      fired: false,
      reason,
      bufferedMs: Math.round(decision.bufferedSeconds * 1000),
      decodeMs: null,
      log: describeForceEndpoint(decision, null),
    };
    opts.log?.(outcome.log);
    return outcome;
  }

  let reply: ForceEndpointReply;
  try {
    reply = await session.forceEndpoint();
  } catch (err) {
    opts.log?.(`[ASR] force-endpoint request failed: ${err}`);
    return skipped("no-capture-session");
  }

  if (!reply.fired) {
    // The worklet disagreed with the renderer. That is information, not an
    // error: it re-checked the authoritative last-frame state.
    const outcome: ForceEndpointOutcome = {
      fired: false,
      reason: reply.speakingNow
        ? "interviewer-still-speaking"
        : "no-phrase-open",
      bufferedMs: Math.round(reply.bufferedSeconds * 1000),
      decodeMs: null,
      log: `force-endpoint skipped reason=${
        reply.speakingNow ? "interviewer-still-speaking" : "no-phrase-open"
      }`,
    };
    opts.log?.(outcome.log);
    return outcome;
  }

  const decodeMs = await session.waitForForcedDecode();
  const outcome: ForceEndpointOutcome = {
    fired: true,
    reason: "fired",
    bufferedMs: Math.round(reply.bufferedSeconds * 1000),
    decodeMs,
    log: `force-endpoint fired bufferedMs=${Math.round(
      reply.bufferedSeconds * 1000,
    )} decodeMs=${decodeMs === null ? "-" : Math.round(decodeMs)}`,
  };
  opts.log?.(outcome.log);
  return outcome;
}