import { isProviderName, type ProviderName } from "./ai";
import { isOpenRouterFreeModel, OPENROUTER_FREE_MODEL } from "./ai/openrouter";

/**
 * The interview provider chain.
 *
 * ── The default chain ───────────────────────────────────────────────────────
 *   Gemini → OpenRouter
 *
 * Gemini leads because it is a first-party endpoint with a fast time-to-first-
 * token and, unlike the free routers, a quota that a single interview cannot
 * exhaust. OpenRouter is the fallback because it is a gateway: when a direct
 * provider is down, rate-limited or out of quota, OpenRouter can usually route
 * around it without any change on our side.
 *
 * The LOCAL Qwen fallback and NVIDIA NIM have been REMOVED entirely (provider,
 * model, download, IPC and UI) — never confuse the local Qwen LLM with
 * Parakeet ASR, which is untouched and remains the interview's speech engine.
 *
 * ── What is NOT in it, and why ──────────────────────────────────────────────
 * `OPTIONAL_PROVIDER_ORDER` holds providers that remain fully integrated and
 * configurable but are NOT attempted by default:
 *
 *   • **Groq** — fast, but redundant with OpenRouter for fallback purposes.
 *     The user opts it in from Settings; when they do, it sits after
 *     OpenRouter and is waited on like any other chain member.
 *
 * The distinction matters for latency, not tidiness: anything in the chain is
 * waited on. A broken member of the chain is a tax on every question, so the
 * default chain contains only providers that are expected to work.
 *
 * All of them are always REPORTED by {@link describeProviderChain}, so the log
 * can always say why a provider was or was not used — a provider that silently
 * vanishes is indistinguishable from one that is broken.
 */

export const INTERVIEW_PROVIDER_ORDER: ProviderName[] = [
  "gemini",
  "openrouter",
];

/** Integrated and configurable, but never attempted unless explicitly added. */
export const OPTIONAL_PROVIDER_ORDER: ProviderName[] = ["groq"];

/** Every provider the interview path can ever use, in reporting order. */
export const ALL_INTERVIEW_PROVIDERS: ProviderName[] = [
  ...INTERVIEW_PROVIDER_ORDER,
  ...OPTIONAL_PROVIDER_ORDER,
];

/**
 * The provider the chain leads with by policy, whatever keys exist.
 *
 * Kept separate from the *resolved* chain on purpose: "which provider is
 * primary" is a configuration fact and must be stable even when the user has no
 * key yet, whereas "which providers will actually run" depends on credentials.
 * Conflating them is what produced a UI that claimed OpenRouter was configured
 * while the interview ran on Groq.
 */
export function primaryInterviewProvider(): ProviderName {
  return INTERVIEW_PROVIDER_ORDER[0];
}

export type ProviderAvailability =
  /** In the chain with a credential — will be attempted. */
  | "ready"
  /** In the chain but no API key saved — skipped. */
  | "missing-api-key"
  /** Has a key but is not in the configured chain — skipped. */
  | "not-in-chain"
  /** Integrated but optional, and the user has not added it. */
  | "optional";

export interface ProviderStatus {
  provider: ProviderName;
  model: string;
  availability: ProviderAvailability;
  /** Short human-readable explanation, e.g. "no API key saved". */
  detail: string;
}

export interface ChainDescription {
  /** Every provider in the configured order, e.g. `gemini(gemini-2.5-flash) → …`. */
  configured: string;
  /** Only the providers that will actually be attempted. */
  resolved: string;
  /** The provider the chain leads with by policy. See the function comment. */
  primary: ProviderName;
  status: ProviderStatus[];
  /** Ready-to-log lines, including the per-provider reasons. */
  lines: string[];
}

interface ChainSettings {
  providerOrder?: ProviderName[];
  models?: Partial<Record<ProviderName, string>>;
  apiKeys?: Partial<Record<ProviderName, string>>;
}

const label = (p: ProviderName) => p.toUpperCase();

const withModel = (p: ProviderName, model: string) =>
  `${p}(${model || "unset"})`;

/**
 * Normalise a persisted `providerOrder`.
 *
 * Guarantees, in order of precedence:
 *  1. every entry is a provider that actually exists in the registry;
 *  2. the DEFAULT chain leads, in its documented order — Gemini, then
 *     OpenRouter — regardless of what the store happened to contain, so an old
 *     store cannot silently keep routing the interview somewhere else;
 *  3. OPTIONAL providers are retained only if the user's saved order already had
 *     them, so opting in survives a restart while never being opted into by
 *     default;
 *  4. anything else valid the user had (a provider added after this table was
 *     written) is preserved, appended.
 *
 * Point 3 is what replaced the previous behaviour of force-including every
 * known provider. That made NVIDIA part of every chain, so a provider that 404s
 * on every request was waited on by every interview. Whether a provider is
 * actually *attempted* is still decided per run by the key filter; this only
 * decides what the user's enabled chain contains.
 */
export function normalizeProviderOrder(
  saved: unknown,
  apiKeys: Partial<Record<ProviderName, string>> | undefined,
): ProviderName[] {
  void apiKeys;

  const valid = Array.isArray(saved) ? saved.filter(isProviderName) : [];

  const result: ProviderName[] = [];
  const add = (p: ProviderName) => {
    if (!result.includes(p)) result.push(p);
  };

  // 1 + 2. The default chain always leads, in its documented order.
  for (const p of INTERVIEW_PROVIDER_ORDER) add(p);

  // 3. Optional providers survive only if they were already opted into. Their
  //    documented relative order is used, so a user who had both gets a stable
  //    chain rather than whatever order the JSON happened to be written in.
  for (const p of OPTIONAL_PROVIDER_ORDER) {
    if (valid.includes(p)) add(p);
  }

  // 4. Anything else the user had (a provider added after this table was
  //    written) is preserved, appended, in the order they saved it.
  for (const p of valid) add(p);

  return result;
}

/**
 * Describe the chain in full: what is configured, what will actually run, and —
 * for every provider that will NOT run — exactly why.
 *
 * This exists so "Groq didn't answer" is never a mystery: the log states
 * `missing API key` or `not in chain` rather than leaving the user to guess
 * whether the provider architecture is broken.
 */
export function describeProviderChain(settings: ChainSettings): ChainDescription {
  const order = settings.providerOrder ?? [];
  const models = settings.models ?? {};
  const keys = settings.apiKeys ?? {};

  const modelFor = (p: ProviderName): string => {
    const configured = models[p]?.trim();
    if (configured) return configured;
    // The gateway default is always valid even without a saved model.
    if (p === "openrouter") return OPENROUTER_FREE_MODEL;
    return "unset";
  };

  const optional = new Set<ProviderName>(OPTIONAL_PROVIDER_ORDER);

  const status: ProviderStatus[] = ALL_INTERVIEW_PROVIDERS.map((p) => {
    const model = modelFor(p);
    const inChain = order.includes(p);
    const hasKey = Boolean(keys[p]?.trim());

    // Availability is decided in this order, and the ORDER IS THE POLICY:
    // a provider that is not in the chain is never "ready", no matter how good
    // its key is, because being in the chain is the user's decision.
    if (!inChain) {
      const wasOptedIn = optional.has(p);
      return {
        provider: p,
        model,
        availability: wasOptedIn ? "optional" : "not-in-chain",
        detail: wasOptedIn
          ? "optional — add it in Settings to enable it"
          : hasKey
            ? "not in the configured chain"
            : "not in the configured chain; no API key",
      };
    }
    // ── No credential → not ready ────────────────────────────────────────────
    if (!hasKey) {
      return {
        provider: p,
        model,
        availability: "missing-api-key",
        detail: "no API key",
      };
    }
    return {
      provider: p,
      model,
      availability: "ready",
      detail: isOpenRouterFreeModel(model)
        ? "free router — model chosen per request"
        : "",
    };
  });

  const configured = order
    .map((p) => withModel(p, modelFor(p)))
    .join(" → ");
  const resolved = status
    .filter((s) => s.availability === "ready")
    .map((s) => withModel(s.provider, s.model))
    .join(" → ");

  // The PRIMARY is a configuration fact, so it is stated from the default chain
  // and not from the resolved one: a user with no Gemini key must still be told
  // that Gemini leads, otherwise the very next thing they do is add a key to
  // the wrong provider.
  const primary =
    order.includes(primaryInterviewProvider())
      ? primaryInterviewProvider()
      : (order[0] ?? primaryInterviewProvider());

  return {
    configured,
    resolved: resolved || "(none — no provider has an API key)",
    primary,
    status,
    lines: [
      `[AI] primary provider=${primary}`,
      `[AI] configured provider chain: ${configured || "(empty)"}`,
      `[AI] resolved interview provider chain: ${resolved}`,
      "[AI] provider status:",
      ...status.map((s) =>
        s.availability === "ready"
          ? `  ${label(s.provider)} [${s.model}] — ready${s.detail ? ` (${s.detail})` : ""}`
          : `  ${label(s.provider)} [${s.model}] — SKIPPED: ${s.detail}`,
      ),
    ],
  };
}