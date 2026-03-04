import { GeminiProvider } from "./gemini";
import { OpenAIProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import { GroqProvider } from "./groq";
import type { AIProvider } from "./types";

export type ProviderName = "gemini" | "openai" | "anthropic" | "groq";

const providers: Record<ProviderName, AIProvider> = {
  gemini: new GeminiProvider(),
  openai: new OpenAIProvider(),
  anthropic: new AnthropicProvider(),
  groq: new GroqProvider(),
};

export function getProvider(name: ProviderName): AIProvider {
  return providers[name];
}

export function getAllProviders(): Record<ProviderName, AIProvider> {
  return providers;
}

export { providers };
