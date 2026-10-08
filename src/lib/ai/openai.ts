import type { AIProvider, AIRequestOptions } from "./types";
import {
  fetchWithDiagnostics,
  withModelHint,
} from "./fetchWithDiagnostics";

export class OpenAIProvider implements AIProvider {
  name = "openai";

  listModels(): string[] {
    return ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"];
  }

  async fetchModels(apiKey: string): Promise<string[]> {
    const res = await fetchWithDiagnostics(
      "https://api.openai.com/v1/models",
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
      { provider: "openai", model: "(list)", apiKey },
    );
    if (!res.ok) {
      throw new Error(`OpenAI models error: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    // Keep only chat-capable models (drop embeddings, tts, whisper, image, etc.)
    return (data?.data ?? [])
      .map((m: any) => m.id as string)
      .filter((id: string) => /^(gpt-|chatgpt|o[1-9])/.test(id))
      .sort();
  }

  async *streamSolution(options: AIRequestOptions): AsyncGenerator<string> {
    const {
      base64Image,
      prompt,
      system,
      messages = [],
      model,
      apiKey,
      maxTokens = 4096,
      signal,
      meta,
    } = options;

    const imageUrl = base64Image?.startsWith("data:")
      ? base64Image
      : base64Image
        ? `data:image/png;base64,${base64Image}`
        : undefined;

    const apiMessages: any[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Leading system message = highest-priority instruction layer.
    if (system?.trim()) {
      apiMessages.unshift({ role: "system", content: system });
    }

    const currentContent: any[] = [];
    if (imageUrl) {
      currentContent.push({ type: "image_url", image_url: { url: imageUrl } });
    }
    currentContent.push({ type: "text", text: prompt });

    apiMessages.push({
      role: "user",
      content: currentContent as any, // OpenAI accepts array of parts for the new message
    });

    const response = await fetchWithDiagnostics(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          stream: true,
          messages: apiMessages,
        }),
        signal,
      },
      { provider: "openai", model, apiKey },
    );

    if (!response.ok) {
      const err = await response
        .json()
        .catch(() => ({ error: { message: response.statusText } }));
      throw new Error(
        withModelHint(
          `OpenAI API error: ${err.error?.message || response.statusText}`,
        ),
      );
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          try {
            const data = JSON.parse(line.slice(6));
            const choice = data.choices?.[0];
            if (choice?.finish_reason && meta) {
              meta.finishReason = choice.finish_reason;
            }
            if (data.error && meta) {
              meta.blockReason =
                data.error.message ?? String(data.error);
            }
            const text = choice?.delta?.content;
            if (text) yield text;
          } catch {
            /* skip malformed chunks */
          }
        }
      }
    }
  }
}
