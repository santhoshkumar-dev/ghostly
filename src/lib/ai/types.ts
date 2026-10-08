export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

/** Facts a provider reports back while/after streaming. */
export interface AIStreamMeta {
  /** Provider-native finish reason of the last chunk (e.g. `STOP`, `length`). */
  finishReason?: string;
  /**
   * Provider-level block: Gemini `promptFeedback.blockReason` (SAFETY, …) or a
   * Groq inline stream error. When set, an empty answer is not a mystery.
   */
  blockReason?: string;
  /**
   * For gateway providers like OpenRouter, the actual backend that served
   * the response (e.g. "groq", "google", "anthropic").
   */
  provider?: string;
  /**
   * The model the gateway ACTUALLY served, when it differs from the one we
   * asked for.
   *
   * Essential for `openrouter/free`: that model id is a *router*, not a model.
   * OpenRouter picks a concrete free model per request and returns it in the
   * response's top-level `model` field (e.g. `upstage/solar-pro-3:free`).
   * Reporting it keeps the dynamic selection visible instead of pretending a
   * fixed model was used.
   */
  model?: string;
  /**
   * Milliseconds from request start until the provider returned response
   * headers. Lets us tell a slow TCP/TLS connection apart from a slow model,
   * which is exactly the distinction needed before touching any timeout.
   */
  httpMs?: number;
}

export interface AIRequestOptions {
  base64Image?: string;
  mimeType?: string;
  prompt: string;
  /**
   * Highest-priority instruction layer. Every provider maps this onto its own
   * native system slot (Gemini `systemInstruction`, Anthropic top-level
   * `system`, OpenAI/Groq a leading `system` message) so behavioural rules can
   * never be overridden by user-role content.
   */
  system?: string;
  messages?: { role: "user" | "assistant"; content: string }[];
  model: string;
  apiKey: string;
  maxTokens?: number;
  /**
   * Cancels the underlying HTTP request — not just the local read loop. Without
   * this, an aborted request keeps streaming (and billing) in the background.
   */
  signal?: AbortSignal;
  /** Mutated by the provider as the stream progresses. */
  meta?: AIStreamMeta;
}

export interface AIProvider {
  name: string;
  streamSolution(options: AIRequestOptions): AsyncGenerator<string>;
  /**
   * Curated fallback list used when live discovery is unavailable
   * (no API key, offline, or provider CORS blocked).
   */
  listModels(): string[];
  /**
   * Optional live model discovery against the provider's /models endpoint,
   * so deprecated or plan-restricted models never appear in the picker.
   */
  fetchModels?(apiKey: string): Promise<string[]>;
}
