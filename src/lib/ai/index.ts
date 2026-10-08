import { GeminiProvider } from "./gemini";
import { OpenAIProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import { GroqProvider } from "./groq";
import { OpenRouterProvider } from "./openrouter";
import type { AIProvider } from "./types";

/**
 * The providers Ghostly can call.
 *
 * Local Qwen (the llama.cpp sidecar) and NVIDIA NIM were removed entirely —
 * provider, model, download, IPC, status and UI. The normal interview chain is
 * Gemini → OpenRouter (→ Groq when the user opts it in); see
 * `lib/providerDiagnostics.ts`. Parakeet ASR and the Moonshine fallback are
 * unrelated to this registry and were not touched.
 */
export type ProviderName = "gemini" | "openai" | "anthropic" | "groq" | "openrouter";

const providers: Record<ProviderName, AIProvider> = {
  gemini: new GeminiProvider(),
  openai: new OpenAIProvider(),
  anthropic: new AnthropicProvider(),
  groq: new GroqProvider(),
  openrouter: new OpenRouterProvider(),
};

/**
 * The registered provider names, derived from the registry itself.
 *
 * Never hardcode this list elsewhere. It previously lived as a literal array
 * in `App.tsx`, where it silently fell behind the registry and caused the
 * persisted-settings migration to discard "openrouter" from `providerOrder`.
 * Persisted stores that still contain `local` or `nvidia` are filtered out by
 * `isProviderName` — that is the removal path for old settings blobs.
 */
export const PROVIDER_NAMES = Object.keys(providers) as ProviderName[];

export function isProviderName(value: unknown): value is ProviderName {
  return (
    typeof value === "string" &&
    (PROVIDER_NAMES as string[]).includes(value)
  );
}

export function getProvider(name: ProviderName): AIProvider {
  return providers[name] ?? providers.gemini;
}

export function getAllProviders(): Record<ProviderName, AIProvider> {
  return providers;
}

export { providers };
