import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  clearAllKeys,
  clearKey,
  describeKeyStatus,
  EMPTY_KEY_HEALTH,
  isKeySpecificFailure,
  markKeyFailure,
  markKeySuccess,
  selectKeyIndices,
  TIMEOUT_KEY_COOLDOWN_MS,
  type KeyHealthState,
} from "./keyHealth";
import type { ProviderName } from "./ai";

/**
 * Live key health, as React state.
 *
 * ── Shape mirrors `useProviderCooldown` on purpose ─────────────────────────
 * A stable gate object for the orchestrator (a ref, not render state), a
 * `useState` counter only to trigger re-renders, and an interval sweep so an
 * expired cooldown stops being displayed while the user merely reads the panel.
 *
 * ── What it does NOT own ────────────────────────────────────────────────────
 * The keys themselves. They live in Settings and are persisted there; this holds
 * only the transient per-slot failure state, which is deliberately NOT persisted
 * — a cooldown that outlived the process would exclude a credential that may be
 * perfectly healthy now, and there is no reason to restore it.
 */
export interface KeyHealthGate {
  /** Slot indices to try for a provider, most-preferred first. */
  eligible: (provider: ProviderName, keys: string[]) => number[];
  /**
   * Called after a completed attempt. `status`/`reason` are the orchestrator's
   * classification; only credential-shaped failures move to another key.
   */
  reportOutcome: (
    provider: ProviderName,
    index: number,
    ok: boolean,
    info: { status?: number | undefined; reason?: string | undefined },
  ) => void;
}

export interface UseKeyHealth {
  gate: KeyHealthGate;
  state: KeyHealthState;
  /** Display string for one slot. Never contains key material. */
  statusOf: (provider: ProviderName, index: number, key: string) => string;
  /** Forget one slot — called when the user edits it. */
  clear: (provider: ProviderName, index: number) => void;
  /** Forget everything, so Retry genuinely retries. */
  clearAll: () => void;
}

/** How often expired cooldowns are swept while the app is running. */
const PRUNE_INTERVAL_MS = 5_000;

export function useKeyHealth(): UseKeyHealth {
  const stateRef = useRef<KeyHealthState>(EMPTY_KEY_HEALTH);
  const [, bump] = useState(0);

  const commit = useCallback((next: KeyHealthState) => {
    stateRef.current = next;
    bump((n) => n + 1);
  }, []);

  const gate = useMemo<KeyHealthGate>(
    () => ({
      eligible(provider, keys) {
        return selectKeyIndices(stateRef.current, provider, keys, Date.now());
      },
      reportOutcome(provider, index, ok, info) {
        const now = Date.now();
        if (ok) {
          const next = markKeySuccess(stateRef.current, provider, index, now);
          if (next !== stateRef.current) commit(next);
          return;
        }
        // Only credential-shaped failures move to another key. Anything else is
        // the provider's or the request's problem, and re-spending another of
        // the user's keys on it would be wrong.
        if (!isKeySpecificFailure(info)) return;
        const next = markKeyFailure(
          { ...stateRef.current, now },
          {
            provider,
            index,
            now,
            cooldownMs: info.reason === "timeout" ? TIMEOUT_KEY_COOLDOWN_MS : undefined,
            reason: keyFailureReason(info),
          },
        );
        const record = next.records[`${provider}#${index}`];
        console.warn(
          record?.failed
            ? `[AI] ${provider.toUpperCase()} API Key ${index + 1} → failed after repeated refusals`
            : `[AI] ${provider.toUpperCase()} API Key ${index + 1} → cooldown ${Math.ceil(
                ((record?.until ?? now) - now) / 1000,
              )}s (${record?.reason ?? "refused"})`,
        );
        commit(next);
      },
    }),
    [commit],
  );

  // Sweep expired cooldowns so the UI stops claiming a slot is parked. Expired
  // records are dropped rather than cleared, which is equivalent for display and
  // keeps the consecutive-failure count, which must survive the gap.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      const records: KeyHealthState["records"] = {};
      for (const [id, record] of Object.entries(stateRef.current.records)) {
        if (record.until <= now && !record.failed) continue;
        records[id] = record;
        changed = true;
      }
      if (!changed) return;
      commit({ records, now });
    }, PRUNE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [commit]);

  return {
    gate,
    state: stateRef.current,
    statusOf: (provider, index, key) =>
      describeKeyStatus(stateRef.current, provider, index, Date.now(), key),
    clear: (provider, index) =>
      commit(clearKey(stateRef.current, provider, index, Date.now())),
    clearAll: () => commit(clearAllKeys(stateRef.current, Date.now())),
  };
}

// Re-exported so callers get the selection from one place.

/**
 * A short reason word for a key failure. A status number or a status class —
 * never a message body, never a header, never a key.
 */
function keyFailureReason(info: {
  status?: number | undefined;
  reason?: string | undefined;
}): string {
  if (info.status === 401) return "unauthorized";
  if (info.status === 403) return "not entitled";
  if (info.status === 429) return "rate limited";
  if (info.status === 400) return "rejected";
  if (info.reason === "timeout") return "timeout";
  return "refused";
}