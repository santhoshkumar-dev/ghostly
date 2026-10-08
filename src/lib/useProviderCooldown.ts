import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  applyCooldown,
  buildCooldownSummary,
  clearCooldown,
  decideCooldown,
  EMPTY_COOLDOWN_STATE,
  isOnCooldown,
  pruneCooldowns,
  type ProviderCooldownState,
} from "./providerCooldown";
import type { ProviderName } from "./ai";

/**
 * Live provider cooldown, as React state.
 *
 * ── What this owns and what it deliberately does not ────────────────────────
 * It owns WHEN each provider becomes eligible again and WHY. It does not own
 * the provider chain, the API keys, or the retry — those stay in Settings and in
 * the orchestrator, so a cooldown can never quietly change the architecture the
 * user configured.
 *
 * ── Why the state lives in a ref as well as React state ─────────────────────
 * `orchestrateAnswer` is called from a hotkey handler, not from a render, so it
 * needs a STABLE object whose `isBlocked` reads the CURRENT records. A ref
 * provides that; the `useState` counter exists only to trigger a re-render when
 * a cooldown starts or expires. Reading state during a hotkey handler is exactly
 * the stale-closure bug this avoids.
 */
export interface ProviderCooldownGate {
  /** Stable identity. Reads live records, so it never goes stale. */
  isBlocked: (provider: ProviderName) => { blocked: boolean; detail?: string };
  /** Called by the orchestrator after a hard failure. */
  reportFailure: (
    provider: ProviderName,
    info: {
      message: string;
      status?: number;
      headers?: Record<string, string>;
    },
  ) => void;
}

export interface UseProviderCooldown {
  gate: ProviderCooldownGate;
  state: ProviderCooldownState;
  /** Whether a provider is parked right now. */
  isBlocked: (provider: string) => boolean;
  /** Forget every cooldown, so Retry genuinely retries. */
  clearAll: () => void;
  /** Forget one provider. */
  clear: (provider: string) => void;
}

/** How often expired cooldowns are swept while the app is running. */
const PRUNE_INTERVAL_MS = 30_000;

export function useProviderCooldown(): UseProviderCooldown {
  const stateRef = useRef<ProviderCooldownState>(EMPTY_COOLDOWN_STATE);
  const [, bump] = useState(0);

  const commit = useCallback((next: ProviderCooldownState) => {
    stateRef.current = next;
    bump((n) => n + 1);
  }, []);

  const gate = useMemo<ProviderCooldownGate>(
    () => ({
      isBlocked(provider) {
        const now = Date.now();
        if (!isOnCooldown(stateRef.current, provider, now)) {
          return { blocked: false };
        }
        const record = stateRef.current.records[provider];
        return {
          blocked: true,
          // The detail is the existing, already-computed explanation. It is
          // never recomputed here, so what the user reads on screen is exactly
          // what produced the decision.
          detail: record?.detail ?? "on cooldown",
        };
      },
      reportFailure(provider, info) {
        const decision = decideCooldown({
          provider,
          status: info.status,
          headers: info.headers,
          message: info.message,
          now: Date.now(),
        });
        if (!decision.cooldown) return;
        const next = applyCooldown(
          { ...stateRef.current, now: Date.now() },
          decision,
          provider,
        );
        console.warn(
          `[AI] ${provider.toUpperCase()} put on cooldown until ${localTime(
            decision.until ?? 0,
          )} — ${decision.detail}`,
        );
        commit(next);
      },
    }),
    [commit],
  );

  // Sweep expired cooldowns so the UI stops claiming a provider is parked.
  // Interval rather than per-request pruning because a provider can expire
  // while the user is simply reading the panel.
  useEffect(() => {
    const timer = setInterval(() => {
      const pruned = pruneCooldowns(stateRef.current, Date.now());
      if (pruned !== stateRef.current) commit(pruned);
    }, PRUNE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [commit]);

  return {
    gate,
    // A new object per commit is intentional: the render has to see the change,
    // and `useMemo` on the records would not fire because the records object
    // identity does change but the consumer reads through the ref.
    state: stateRef.current,
    isBlocked: (provider: string) =>
      isOnCooldown(stateRef.current, provider, Date.now()),
    clearAll: () => commit({ records: {}, now: Date.now() }),
    clear: (provider: string) =>
      commit(clearCooldown(stateRef.current, provider)),
  };
}

/** Local time only. Used for a console line, never for a decision. */
function localTime(until: number): string {
  return new Date(until).toLocaleTimeString();
}

/**
 * The banner text when every provider failed.
 *
 * Kept next to the hook so the two cannot disagree about what "on cooldown"
 * means, and exported separately because `Home.tsx` needs it for a message
 * whose other inputs (the chain) it owns.
 */
export { buildCooldownSummary };