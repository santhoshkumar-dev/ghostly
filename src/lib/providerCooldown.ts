/**
 * Per-provider cooldown after a recoverable failure.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Every failure mode observed in a live run is a PROVIDER-level state, not a
 * request-level one:
 *
 *   • OpenRouter answered **429** with a daily-limit reset header, every turn.
 *   • Gemini answered **429** with body text `… retry in 3h 15m`.
 *   • NVIDIA failed with a **CORS** block on every turn from the renderer.
 *
 * None of those are fixed by retrying on the next turn — and retrying makes
 * things worse, because a 429 rate-limit spends quota you do not have and a
 * CORS block burns a full timeout window on every turn of the interview. Before
 * this module the orchestrator simply re-attempted the same dead provider and
 * then reported the raw provider text to the user.
 *
 * ── The three inputs it understands ─────────────────────────────────────────
 * 1. **429 with a reset header.** `Retry-After` / `X-RateLimit-Reset` /
 *    `x-ratelimit-reset-requests`, in either seconds-until-reset or an absolute
 *    epoch. Absolute epochs are preferred when both are available, because a
 *    gateway that says "resets at 03:15 UTC" knows more than one that says
 *    "retry in 3 seconds".
 * 2. **Quota prose.** `retry in 3h 15m`, `resets in 45 minutes`,
 *    `available again at 14:05`. Parsed out of the response body text.
 * 3. **CORS / network.** A renderer-side `TypeError: Failed to fetch` against a
 *    provider that has sent no headers at all is a blocked request, not a slow
 *    one. For CORS the cooldown deliberately lasts the REST OF THE SESSION: the
 *    block is a property of the runtime (the origin is never going to be
 *    allowed), so retrying it 200 times over an interview helps nobody.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * Pure and Electron-free. The clock is injected, so the whole state machine is
 * exercised deterministically by `scripts/verify-provider-cooldown.mts`.
 */

/** How long a CORS-blocked provider is skipped. "The rest of the session." */
export const CORS_SESSION_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/**
 * A missing / deprecated model id is parked for the whole session.
 *
 * Not a tunable: the failure is deterministic. Nothing the app does can make
 * `nvidia/llama-3.1-nemotron-70b-instruct` exist, so the only fix is a human
 * opening Settings. Matches the CORS cooldown's intent — skip for the session,
 * tell the user why.
 */
export const MODEL_SESSION_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/** Fallback when a 429 says nothing about when it resets. */
export const DEFAULT_QUOTA_COOLDOWN_MS = 60 * 60 * 1000;

/** Fallback for a plain network failure (offline, DNS, reset connection). */
export const DEFAULT_NETWORK_COOLDOWN_MS = 30 * 1000;

/** Upper bound so a bogus header can never park a provider for days. */
export const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type CooldownKind =
  /** 429 — daily limit or per-minute quota. */
  | "quota"
  /** Blocked by CORS in the renderer; will not change during the session. */
  | "cors"
  /** The configured model does not exist / is not enabled for this account. */
  | "model"
  /** Transport-level failure: offline, DNS, TLS, reset. */
  | "network";

export interface CooldownRecord {
  provider: string;
  /** Epoch ms at which this provider becomes eligible again. */
  until: number;
  kind: CooldownKind;
  /** One short sentence, safe to show on screen. Never a key or a transcript. */
  detail: string;
  /** Epoch ms of the first failure that created this record. */
  since: number;
  /** How many consecutive failures produced this record. */
  hits: number;
}

export interface ProviderCooldownState {
  records: Record<string, CooldownRecord>;
  now: number;
}

/** What a caller learns when an attempt fails. */
export interface CooldownDecision {
  /** Whether the failure should park this provider. */
  cooldown: boolean;
  kind?: CooldownKind;
  until?: number;
  detail?: string;
}

export const EMPTY_COOLDOWN_STATE: ProviderCooldownState = {
  records: {},
  now: 0,
};

// ── Parsing helpers ─────────────────────────────────────────────────────────

/**
 * Read a reset hint out of response headers.
 *
 * Accepts both conventions because providers differ: OpenRouter sends
 * `x-ratelimit-reset` as seconds-until-reset, while several gateways send
 * `retry-after` as an HTTP-date. Absolute epoch values (10-digit seconds) are
 * detected rather than assumed, which is what stops a "3600" being read as
 * "1970-01-01 01:00".
 */
export function parseResetHeaders(
  headers: Record<string, string | null | undefined> | null | undefined,
  now: number,
): number | null {
  if (!headers) return null;
  const get = (name: string) => {
    const direct = headers[name];
    if (direct != null) return direct;
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === lower) return value;
    }
    return undefined;
  };

  const candidates = [
    "x-ratelimit-reset",
    "x-ratelimit-reset-requests",
    "retry-after",
  ];

  for (const name of candidates) {
    const raw = get(name)?.trim();
    if (!raw) continue;

    // HTTP-date form.
    const asDate = Date.parse(raw);
    if (!Number.isNaN(asDate) && /[A-Za-z]{3}/.test(raw)) {
      const delta = asDate - now;
      if (delta > 0) return now + Math.min(delta, MAX_COOLDOWN_MS);
      continue;
    }

    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) continue;

    // 10-digit values are epoch SECONDS, not a delta.
    if (num >= 1_000_000_000 && String(Math.floor(num)).length === 10) {
      const delta = num * 1000 - now;
      if (delta > 0) return now + Math.min(delta, MAX_COOLDOWN_MS);
      continue;
    }
    return now + Math.min(num * 1000, MAX_COOLDOWN_MS);
  }

  return null;
}

const UNIT_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

/**
 * Parse human duration prose out of a quota message.
 *
 * Handles the shape actually observed (`retry in 3h 15m`), the common
 * single-unit forms (`resets in 45 minutes`, `try again in 1 hour`), and the
 * bare `retry in 30s`. Returns a DELTA in ms, never an absolute time, because
 * every one of these phrases is relative to the moment of the error.
 */
export function parseDurationProse(message: string): number | null {
  const text = message.toLowerCase();
  if (!/(retry|reset|available|again|try)/.test(text)) return null;
  if (!/\d/.test(text)) return null;

  const pair = text.match(
    /(\d+)\s*(hours?|hrs?|h)\s*(\d+)\s*(minutes?|mins?|m)(?!\w)/,
  );
  if (pair) {
    return Number(pair[1]) * UNIT_MS.h + Number(pair[3]) * UNIT_MS.m;
  }

  const single =
    text.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/);
  if (single) {
    const unit = single[2].replace(/s$/, "") || single[2];
    const factor = UNIT_MS[unit] ?? UNIT_MS[single[2]];
    if (factor) return Number(single[1]) * factor;
  }

  return null;
}

/** Clock time such as `14:05` or `3:15am` in a quota message. */
function parseClockProse(message: string): number | null {
  const m = message.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  if (!m) return null;
  let hours = Number(m[1]);
  if (hours > 23) return null;
  const minutes = Number(m[2]);
  if (minutes > 59) return null;
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  return hours * 3_600_000 + minutes * 60_000;
}

/**
 * Is this a CORS / transport failure rather than an HTTP error?
 *
 * Deliberately narrow. "Failed to fetch" from a browser is genuinely ambiguous
 * — it can also be an offline machine — but it is NEVER a server response, so
 * treating it as a network block is correct in both readings. An `AbortError`
 * is explicitly excluded: a cancelled request is a user action, not a fault.
 */
export function isCorsOrNetworkFailure(message: string): boolean {
  const text = message.toLowerCase();
  if (/aborterror|cancelled|canceled|aborted/.test(text)) return false;
  return (
    text.includes("failed to fetch") ||
    text.includes("networkerror") ||
    text.includes("load failed") ||
    text.includes("cors") ||
    text.includes("blocked by cors") ||
    text.includes("access-control-allow-origin")
  );
}

/**
 * Does a provider error message DESCRIBE a rate limit, even though no
 * structured status reached us?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Every provider in `ai/` throws a plain `Error` carrying only a message, so by
 * the time the orchestrator sees a failure the HTTP status is gone. Rather than
 * rewrite six providers to attach typed errors, the status is recovered from the
 * text — and the words below are what the providers actually put there:
 *
 *   • `429`, `HTTP 429`                                      (verbatim status)
 *   • `rate limit`, `rate_limit_exceeded`                   (OpenRouter)
 *   • `resource has been exhausted`                          (Gemini)
 *   • `quota exceeded`, `too many requests`, `insufficient_quota`
 *
 * Anything matching is treated as a quota state with the same precedence as a
 * real 429, so a provider that reports its limit only in prose is still parked
 * instead of retried.
 */
/**
 * True when the provider says the MODEL is the problem, whatever the status.
 *
 * Several gateways report a missing model as 400 or 422 with prose rather than
 * a 404, so the status alone is not sufficient — observed NVIDIA 404 and other
 * providers' prose both have to land in the same branch.
 */
export function looksLikeMissingModel(message: string): boolean {
  const text = message.toLowerCase();
  return (
    /model/.test(text) &&
    /(does not exist|not found|no such model|invalid model|unknown model|deprecat|is not available|unavailable|not enabled|no access)/.test(
      text,
    )
  );
}

export function looksLikeRateLimit(message: string): boolean {
  const text = message.toLowerCase();
  return (
    /\b429\b/.test(text) ||
    text.includes("rate limit") ||
    text.includes("rate_limit") ||
    text.includes("resource has been exhausted") ||
    text.includes("quota exceeded") ||
    text.includes("quota_exceeded") ||
    text.includes("too many requests") ||
    text.includes("insufficient_quota") ||
    text.includes("resource_exhausted")
  );
}

/**
 * Recover an HTTP status from a provider error message.
 *
 * Returns `undefined` rather than guessing when nothing looks like a status, so
 * `decideCooldown` can tell "no status known" from "status 200".
 */
export function extractStatus(message: string): number | undefined {
  const m = message.match(/\b(?:http|status|error)\D{0,12}?([45]\d{2})\b/i);
  if (m) return Number(m[1]);
  const bare = message.match(/\b(429|500|502|503|504|403|401|404|400)\b/);
  if (bare) return Number(bare[1]);
  return undefined;
}

/**
 * Decide what a failure means for this provider.
 *
 * `status` is the HTTP status when there was a response, `undefined` when the
 * request never produced one. `headers` is the response header bag, `message`
 * the provider's own error text. Precedence is deliberate: an explicit HTTP 429
 * with a reset header beats prose, and prose beats the default.
 */
export function decideCooldown(input: {
  provider: string;
  status?: number;
  headers?: Record<string, string | null | undefined> | null;
  message?: string;
  now: number;
}): CooldownDecision {
  const { provider, headers, message = "", now } = input;
  const label = provider.toUpperCase();
  // A provider that throws a plain `Error` never tells us the status, so it is
  // recovered from the text when it is not supplied. See `extractStatus`.
  const status = input.status ?? extractStatus(message);

  // 1. A CORS / transport failure never reached the provider.
  if (status == null && isCorsOrNetworkFailure(message)) {
    return {
      cooldown: true,
      kind: "cors",
      until: now + CORS_SESSION_COOLDOWN_MS,
      detail: `${label} is blocked from this window (network / CORS). It is being skipped for the rest of this session.`,
    };
  }

  // 1b. A rate limit reported only in prose, with no status and no CORS.
  //     Handled before the generic "no response" branch, otherwise a Gemini
  //     "429 Resource has been exhausted. … retry in 3h 15m" would be filed as
  //     a network blip and retried in 30 seconds instead of parked for hours.
  if (status == null && looksLikeRateLimit(message)) {
    return quotaDecision(provider, message, headers, now);
  }

  // 1c. A missing MODEL, detected from the message. MUST run before every status
  //     branch: gateways report a bad model id as 400, 404, 422, and sometimes
  //     as nothing parseable at all — in which case the generic "no response"
  //     branch below files it as a 30-second network blip and re-spends the
  //     failure on every subsequent turn.
  //
  //     Deliberately keyed on the MESSAGE, never on a bare `status === 404`:
  //     a 404 carrying no model wording is a wrong endpoint or a missing route,
  //     which can be transient. Parking that for the whole session would silence
  //     a provider that is working fine.
  if (looksLikeMissingModel(message)) {
    return {
      cooldown: true,
      kind: "model",
      until: now + MODEL_SESSION_COOLDOWN_MS,
      detail:
        `${label} model not found — it is skipped for the rest of this session. ` +
        `Choose another model in Settings.`,
    };
  }

  // 2. A plain network failure with no recognisable text: short cooldown.
  if (status == null) {
    return {
      cooldown: true,
      kind: "network",
      until: now + DEFAULT_NETWORK_COOLDOWN_MS,
      detail: `${label} could not be reached. Retrying in 30 seconds.`,
    };
  }

  // 3. 429 — the only status that is unambiguously a quota state.
  if (status === 429) {
    return quotaDecision(provider, message, headers, now);
  }

  // 4. Any other 5xx: transient, worth a brief pause.
  if (status >= 500) {
    return {
      cooldown: true,
      kind: "network",
      until: now + DEFAULT_NETWORK_COOLDOWN_MS,
      detail: `${label} returned a server error (${status}). Retrying in 30 seconds.`,
    };
  }

  // 4xx that is not 429 is about THIS request (bad model, bad key, blocked
  // content) — repeating it verbatim will fail identically, so cool it down
  // too, but only long enough to matter within one interview.
  if (status >= 400) {
    return {
      cooldown: true,
      kind: "quota",
      until: now + DEFAULT_NETWORK_COOLDOWN_MS,
      detail: `${label} rejected the request (${status}). Retrying it unchanged would fail the same way.`,
    };
  }

  return { cooldown: false };
}

/**
 * The quota branch, shared by a real 429 and by a prose-only rate limit.
 *
 * Source precedence is the whole point of this function and is deliberate:
 *
 *   1. **Header** — the machine-readable answer, when the gateway sends one.
 *   2. **Duration prose** — `retry in 3h 15m`. What Gemini actually sends, and
 *      far more precise than a default.
 *   3. **Clock prose** — `available again at 14:05`.
 *   4. **Default** — one hour, capped.
 *
 * A header beats prose because a gateway that computes its own reset knows more
 * than one that rounds. Prose beats the default because the observed Gemini
 * message is the single most useful piece of information in the whole failure.
 */
function quotaDecision(
  provider: string,
  message: string,
  headers: Record<string, string | null | undefined> | null | undefined,
  now: number,
): CooldownDecision {
  const label = provider.toUpperCase();

  const fromHeader = parseResetHeaders(headers, now);
  if (fromHeader != null) {
    return {
      cooldown: true,
      kind: "quota",
      until: fromHeader,
      detail: `${label} is out of quota and reports a reset in ${formatCooldown(
        fromHeader,
        now,
      )}.`,
    };
  }

  const delta = parseDurationProse(message);
  if (delta != null) {
    const until = now + Math.min(delta, MAX_COOLDOWN_MS);
    return {
      cooldown: true,
      kind: "quota",
      until,
      detail: `${label} is out of quota and reports a reset in ${formatCooldown(
        until,
        now,
      )}.`,
    };
  }

  const clock = parseClockProse(message);
  if (clock != null) {
    const until = nextOccurrence(now, clock);
    return {
      cooldown: true,
      kind: "quota",
      until,
      detail: `${label} is out of quota until ${formatCooldown(until, now)}.`,
    };
  }

  return {
    cooldown: true,
    kind: "quota",
    until: now + DEFAULT_QUOTA_COOLDOWN_MS,
    detail: `${label} is out of quota and did not say when it resets. Skipping it for an hour.`,
  };
}

/** The next time the wall clock reads `clockMs` past midnight, after `now`. */
function nextOccurrence(now: number, clockMs: number): number {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  let until = midnight + clockMs;
  if (until <= now) until += 86_400_000;
  return Math.min(until, now + MAX_COOLDOWN_MS);
}

/**
 * `2h 15m` / `45 minutes` / `3m 20s` — compact, and never a bare timestamp,
 * because an overlay showing "resets at 1783123456789" helps nobody.
 */
export function formatCooldown(until: number, now: number): string {
  const delta = Math.max(0, until - now);
  if (delta < 60_000) return `${Math.ceil(delta / 1000)}s`;

  const totalMinutes = Math.round(delta / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

// ── State machine ───────────────────────────────────────────────────────────

/**
 * Record a failure and return the new state.
 *
 * Repeated failures while already on cooldown EXTEND rather than reset the
 * window: a provider that is still refusing after its own reset time has told
 * us something, and immediately re-attempting it would spend the remaining
 * quota.
 */
export function applyCooldown(
  state: ProviderCooldownState,
  decision: CooldownDecision,
  provider: string,
): ProviderCooldownState {
  if (!decision.cooldown || decision.until == null || !decision.kind) {
    return state;
  }
  const previous = state.records[provider];
  const until = Math.max(decision.until, previous?.until ?? 0);
  return {
    now: state.now,
    records: {
      ...state.records,
      [provider]: {
        provider,
        until,
        kind: decision.kind,
        detail: decision.detail ?? "",
        since: previous?.since ?? state.now,
        hits: (previous?.hits ?? 0) + 1,
      },
    },
  };
}

/** Whether the provider is currently parked. */
export function isOnCooldown(
  state: ProviderCooldownState,
  provider: string,
  now: number,
): boolean {
  const record = state.records[provider];
  return !!record && record.until > now;
}

/**
 * Drop expired records.
 *
 * Returns a NEW state, so a React caller comparing by reference re-renders
 * exactly once when a cooldown lapses.
 */
export function pruneCooldowns(
  state: ProviderCooldownState,
  now: number,
): ProviderCooldownState {
  const records: Record<string, CooldownRecord> = {};
  let changed = false;
  for (const [provider, record] of Object.entries(state.records)) {
    if (record.until <= now) {
      changed = true;
      continue;
    }
    records[provider] = record;
  }
  if (!changed) return state;
  return { records, now };
}

/** Clear one provider (Retry, or a settings change). */
export function clearCooldown(
  state: ProviderCooldownState,
  provider: string,
): ProviderCooldownState {
  if (!state.records[provider]) return state;
  const records = { ...state.records };
  delete records[provider];
  return { records, now: state.now };
}

/** One line per parked provider, for the log. */
export function describeCooldowns(
  state: ProviderCooldownState,
  now: number,
): string[] {
  return Object.values(state.records)
    .filter((r) => r.until > now)
    .sort((a, b) => b.until - a.until)
    .map(
      (r) =>
        `  ${r.provider.toUpperCase()} — on cooldown for ${formatCooldown(
          r.until,
          now,
        )} (${r.kind}, ${r.hits} failure${r.hits === 1 ? "" : "s"})`,
    );
}

/**
 * The user-facing summary shown when EVERY provider failed.
 *
 * ── Why not the raw error ───────────────────────────────────────────────────
 * The raw text is `Groq API error: Rate limit reached for ...` or a CORS
 * message from Chromium. It names a condition the user cannot act on and hides
 * the two things they can: which provider is parked until when, and whether the
 * provider they expected is even in the chain.
 *
 * `chainNotes` carries the second half — it is supplied by the caller from
 * `describeProviderChain`, so this module stays free of settings knowledge.
 */
export function buildCooldownSummary(input: {
  state: ProviderCooldownState;
  now: number;
  /** Provider names that are in the chain and have a key. */
  chain: string[];
  /** `{ provider, reason }` pairs for providers that were never attempted. */
  chainNotes?: Array<{ provider: string; reason: string }>;
  /** What actually went wrong, for the log only — never shown verbatim. */
  failures?: Array<{ provider: string; message: string }>;
}): { headline: string; lines: string[] } {
  const { state, now, chain, chainNotes = [] } = input;
  const parked = Object.values(state.records).filter((r) => r.until > now);

  const lines: string[] = [];

  if (parked.length > 0) {
    lines.push("Providers on cooldown:");
    for (const record of parked) {
      lines.push(
        `• ${record.provider.toUpperCase()} — back in ${formatCooldown(
          record.until,
          now,
        )} (${record.kind === "cors" ? "blocked from this window" : record.kind})`,
      );
    }
  }

  // The single most useful line: a provider that is skipped for a CONFIG reason
  // will never come back on its own, and is invisible in every raw error.
  const configNotes = chainNotes.filter(
    (n) => !parked.some((p) => p.provider === n.provider),
  );
  if (configNotes.length > 0) {
    lines.push("Not used this turn:");
    for (const note of configNotes) {
      lines.push(`• ${note.provider.toUpperCase()} — ${note.reason}`);
    }
  }

  if (parked.length === 0 && configNotes.length === 0 && chain.length === 0) {
    lines.push("No provider in the chain has an API key yet.");
  }

  const headline =
    parked.length > 0
      ? "Every provider failed. Retry once a cooldown expires, or open Settings to change the chain."
      : chain.length === 0
        ? "No provider is ready. Add an API key in Settings."
        : "Every provider returned an unusable answer. Retry, or open Settings.";

  return { headline, lines };
}