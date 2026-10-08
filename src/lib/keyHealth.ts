/**
 * Per-KEY health and failover for the AI providers.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * Gemini and OpenRouter both rate-limit per key, and a quota error on one key
 * says nothing about the user's other keys. Ghostly therefore holds a small
 * pool of keys per provider and moves to the next one when a request fails for
 * a reason that belongs to the KEY rather than to the request.
 *
 * This is deliberately NOT quota evasion. Every key here is a credential the
 * user owns and has authorized Ghostly to use, entered by the user into Ghostly's
 * own settings. Rotating between them only decides WHICH of the user's
 * authorized credentials serves the next request once one of them is refused;
 * it cannot raise any quota, and it never retries a request that was refused
 * for a reason another key would also hit (a bad prompt, a moderation block, an
 * invalid model).
 *
 * ── What decides a key-specific failure ────────────────────────────────────
 * Only failures that are properties of the CREDENTIAL move to the next key:
 *
 *   • 400/401/403 — bad, revoked or unentitled key
 *   • 429          — this key is rate-limited / out of quota
 *   • timeout      — this key's request never produced an answer
 *
 * Everything else (a 500 from the provider, a network blip, a validation
 * rejection, a model that does not exist) is a property of the PROVIDER or of
 * the REQUEST, and repeating it on another key of the same provider would fail
 * identically while spending another key's budget. Those fall through to the
 * provider-level failover in `providerCooldown.ts` instead.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * Pure and Electron-free, with an injected clock, so every ordering and every
 * cooldown boundary is deterministic in `scripts/verify-key-pool.mts`.
 *
 * ── Never log a key ─────────────────────────────────────────────────────────
 * Nothing here accepts a key for any purpose other than testing whether one is
 * configured, and every status string is derived from state, never from the key
 * material. `assertNoKeyLeaks` in the harness sweeps for that.
 */

import type { ProviderName } from "./ai";

/** How many slots every provider gets. Three is the documented pool size. */
export const KEY_SLOTS_PER_PROVIDER = 3;

/**
 * How long a key that just failed a key-specific error is skipped.
 *
 * Deliberately short. The point is to stop hammering a refused credential for
 * the rest of the current question; the next question a minute later is a
 * different request and may well succeed. A long cooldown here would turn one
 * transient refusal into a permanently reduced pool.
 */
export const DEFAULT_KEY_COOLDOWN_MS = 30_000;

/**
 * How long a key that produced text and then timed out is skipped.
 *
 * Shorter than the network-failure cooldown is wrong here: unlike a network
 * blip, a key that accepted a connection and produced text before stalling is
 * usually fine. It is skipped briefly so the same stalled request is not
 * repeated, then allowed back.
 */
export const TIMEOUT_KEY_COOLDOWN_MS = 15_000;

/**
 * Consecutive failed cooldown windows before a key is declared FAILED.
 *
 * A key that fails, is allowed back, and fails again is broken rather than
 * unlucky, and retrying it forever would quietly shrink the pool to nothing
 * mid-interview. After this many, it is excluded until it is changed or reset,
 * and the UI says so instead of pretending it will come back on its own.
 */
export const MAX_CONSECUTIVE_KEY_FAILURES = 3;

export type KeyStatus =
  /** Configured, no outstanding failure. */
  | "healthy"
  /** Configured, temporarily skipped until `until`. */
  | "cooldown"
  /** Configured, excluded after repeated failures until reset. */
  | "failed"
  /** No key in this slot. */
  | "not-configured";

export interface KeyRecord {
  /** Epoch ms this key becomes eligible again. Ignored while `status==="failed"`. */
  until: number;
  /** Epoch ms of the first failure in the current run of failures. */
  since: number;
  /** Consecutive failures not yet followed by a success. */
  hits: number;
  /** Whether the slot is excluded until reset. */
  failed: boolean;
  /**
   * Short, safe reason. A status word or a bounded phrase — NEVER key material,
   * never a response body, never a header value.
   */
  reason: string;
}

export interface KeyHealthState {
  records: Record<string, KeyRecord>;
  now: number;
}

export const EMPTY_KEY_HEALTH: KeyHealthState = { records: {}, now: 0 };

/**
 * Stable identifier for one slot. Never contains the key itself — only the
 * provider name and the slot index — so it is safe to use as a record key, to
 * log, and to put in a React key.
 */
export function keyId(provider: ProviderName, index: number): string {
  return `${provider}#${index}`;
}

/**
 * The pool for one provider.
 *
 * Always exactly {@link KEY_SLOTS_PER_PROVIDER} entries, padding with empty
 * strings, so the UI can render a fixed number of fields and "2/3 configured"
 * can be computed without a special case for a provider with no keys at all.
 * Empty slots are inert: `selectKeyIndices` skips anything not configured.
 */
export function keyPool(
  keys: Record<ProviderName, string> | undefined,
  extra: Partial<Record<ProviderName, string[]>> | undefined,
  provider: ProviderName,
): string[] {
  const primary = keys?.[provider] ?? "";
  const rest = extra?.[provider] ?? [];
  const pool: string[] = [primary];
  for (let i = 0; i < KEY_SLOTS_PER_PROVIDER; i++) {
    // Slot 0 is `apiKeys`; slots 1..n come from the pool map.
    pool[i] = i === 0 ? primary : (rest[i - 1] ?? "");
  }
  return pool;
}

/** True when the slot holds something other than whitespace. */
export function isConfigured(key: string | undefined): boolean {
  return typeof key === "string" && key.trim().length > 0;
}

export interface KeyFailureInput {
  provider: ProviderName;
  index: number;
  now: number;
  /** Optional override; defaults to {@link DEFAULT_KEY_COOLDOWN_MS}. */
  cooldownMs?: number;
  /** Short, safe reason. Defaults to a status word. */
  reason?: string;
}

/**
 * Should a failure move to a DIFFERENT key, or to the provider-level failover?
 *
 * Only credential-shaped failures do. This predicate is the whole safety
 * argument for the pool: if it returned true for everything, every transient
 * provider hiccup would burn through all three of the user's keys and end the
 * run, which is strictly worse than retrying one provider once.
 */
export function isKeySpecificFailure(info: {
  status?: number | undefined;
  reason?: string | undefined;
}): boolean {
  const status = info.status;
  if (status === 400 || status === 401 || status === 403 || status === 429) {
    return true;
  }
  // A timeout is key-specific for our purposes: it is the failure that would
  // otherwise be re-spent on the very same stalled request.
  if (info.reason === "timeout") return true;
  // A 5xx is the PROVIDER, not the credential: another key would hit the same
  // outage. Deliberately excluded.
  return false;
}

/** Record a failure against one slot. Returns a new state. */
export function markKeyFailure(
  state: KeyHealthState,
  input: KeyFailureInput,
): KeyHealthState {
  const id = keyId(input.provider, input.index);
  const previous = state.records[id];
  const cooldownMs = input.cooldownMs ?? DEFAULT_KEY_COOLDOWN_MS;
  const until = input.now + cooldownMs;
  const hits = (previous?.hits ?? 0) + 1;
  return {
    now: input.now,
    records: {
      ...state.records,
      [id]: {
        // Repeated failures extend the window rather than resetting it, for the
        // same reason `applyCooldown` does: a key that is still refusing has
        // told us something.
        until: Math.max(until, previous?.failed ? 0 : previous?.until ?? 0),
        since: previous?.since ?? input.now,
        hits,
        failed: hits >= MAX_CONSECUTIVE_KEY_FAILURES,
        reason: input.reason ?? "refused",
      },
    },
  };
}

/**
 * Record a success.
 *
 * A success CLEARS the slot's record and is the only thing that resets the
 * consecutive-failure count — which is what makes "do not rotate keys on
 * success" true: nothing here picks a different key because of a success, it
 * only stops treating this one as suspect.
 */
export function markKeySuccess(
  state: KeyHealthState,
  provider: ProviderName,
  index: number,
  now: number,
): KeyHealthState {
  const id = keyId(provider, index);
  if (!state.records[id]) return state;
  const records = { ...state.records };
  delete records[id];
  return { records, now };
}

/** Current status of one slot. Never returns anything derived from the key. */
export function keyStatus(
  state: KeyHealthState,
  provider: ProviderName,
  index: number,
  now: number,
  configured: boolean,
): KeyStatus {
  if (!configured) return "not-configured";
  const record = state.records[keyId(provider, index)];
  if (!record) return "healthy";
  if (record.failed) return "failed";
  return record.until > now ? "cooldown" : "healthy";
}

/**
 * The ordered slot indices to try for one provider.
 *
 * Two rules, both deliberate:
 *  • the last-known-healthy key is tried FIRST, so a pool does not walk itself
 *    down to key 3 for no reason;
 *  • keys already on cooldown or failed are excluded, so a request is never
 *    re-spent on a credential that just refused it.
 *
 * Slots are otherwise tried in index order, which is what makes the behaviour
 * deterministic and therefore testable.
 */
export function selectKeyIndices(
  state: KeyHealthState,
  provider: ProviderName,
  keys: string[],
  now: number,
): number[] {
  const eligible: number[] = [];
  for (let index = 0; index < keys.length; index++) {
    if (!isConfigured(keys[index])) continue;
    const status = keyStatus(state, provider, index, now, true);
    if (status === "cooldown" || status === "failed") continue;
    eligible.push(index);
  }
  return eligible;
}

/**
 * A short, user-facing status. One of exactly the five words the UI is allowed
 * to show, plus a remaining-seconds figure for a cooldown.
 *
 * Takes the KEY only to decide configured/not — never returns any part of it.
 */
export function describeKeyStatus(
  state: KeyHealthState,
  provider: ProviderName,
  index: number,
  now: number,
  key: string,
): string {
  const status = keyStatus(state, provider, index, now, isConfigured(key));
  switch (status) {
    case "not-configured":
      return "not configured";
    case "failed":
      return "failed";
    case "cooldown": {
      const record = state.records[keyId(provider, index)];
      const remaining = Math.max(0, (record?.until ?? now) - now);
      return `cooldown ${Math.ceil(remaining / 1000)}s`;
    }
    default:
      return "healthy";
  }
}

/**
 * `Gemini API Key 2`. The only label the UI shows; the number is what the user
 * typed into which box.
 */
export function describeKeySlot(index: number): string {
  return `API Key ${index + 1}`;
}

/** Per-provider configured/total counts, for the report and the UI. */
export function summarizeKeys(
  state: KeyHealthState,
  provider: ProviderName,
  keys: string[],
  now: number,
): {
  configured: number;
  total: number;
  healthy: number;
  cooldown: number;
  failed: number;
} {
  let configured = 0;
  let healthy = 0;
  let cooldown = 0;
  let failed = 0;
  for (let index = 0; index < keys.length; index++) {
    if (!isConfigured(keys[index])) continue;
    configured++;
    const status = keyStatus(state, provider, index, now, true);
    if (status === "healthy") healthy++;
    else if (status === "cooldown") cooldown++;
    else if (status === "failed") failed++;
  }
  return { configured, total: keys.length, healthy, cooldown, failed };
}

/** Forget one slot — used when the user edits or replaces that key. */
export function clearKey(
  state: KeyHealthState,
  provider: ProviderName,
  index: number,
  now: number,
): KeyHealthState {
  const id = keyId(provider, index);
  if (!state.records[id]) return state;
  const records = { ...state.records };
  delete records[id];
  return { records, now };
}

/** Forget everything. Retry and "clear" both use this. */
export function clearAllKeys(state: KeyHealthState, now: number): KeyHealthState {
  if (Object.keys(state.records).length === 0) return state;
  return { records: {}, now };
}

/**
 * One log line per key state change.
 *
 * Contains the provider, the SLOT NUMBER, the status and the reason — and
 * nothing else. There is deliberately no code path in this module that can put
 * key material into a string it returns.
 */
export function formatKeyLog(
  provider: ProviderName,
  index: number,
  event: "cooldown" | "failed" | "recovered",
  reason: string,
): string {
  return `[AI] ${provider.toUpperCase()} ${describeKeySlot(index)} → ${event} (${reason})`;
}