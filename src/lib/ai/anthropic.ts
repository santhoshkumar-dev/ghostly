import type { AIProvider, AIRequestOptions } from "./types";
import {
  fetchWithDiagnostics,
  withModelHint,
} from "./fetchWithDiagnostics";

export class AnthropicProvider implements AIProvider {
  name = "anthropic";

  listModels(): string[] {
    return [
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-opus-20240229",
    ];
  }

  async fetchModels(apiKey: string): Promise<string[]> {
    const res = await fetchWithDiagnostics(
      "https://api.anthropic.com/v1/models",
      {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
      },
      { provider: "anthropic", model: "(list)", apiKey },
    );
    if (!res.ok) {
      throw new Error(
        `Anthropic models error: ${res.status} ${res.statusText}`,
      );
    }
    const data = await res.json();
    return (data?.data ?? []).map((m: any) => m.id as string).sort();
  }

  async *streamSolution(options: AIRequestOptions): AsyncGenerator<string> {
    const {
      base64Image,
      mimeType = "image/png",
      prompt,
      system,
      messages = [],
      model,
      apiKey,
      maxTokens = 4096,
      signal,
      meta,
    } = options;

    const imageData = base64Image?.includes(",")
      ? base64Image.split(",")[1]
      : base64Image;

    const apiMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const currentContent: any[] = [];
    if (imageData) {
      currentContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mimeType,
          data: imageData,
        },
      });
    }
    currentContent.push({ type: "text", text: prompt });

    apiMessages.push({
      role: "user",
      content: currentContent as any,
    });

    const response = await fetchWithDiagnostics(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          stream: true,
          // Anthropic's dedicated system slot — higher priority than messages.
          ...(system?.trim() ? { system } : {}),
          messages: apiMessages,
        }),
        signal,
      },
      { provider: "anthropic", model, apiKey },
    );

    if (!response.ok) {
      const err = await response
        .json()
        .catch(() => ({ error: { message: response.statusText } }));
      throw new Error(
        withModelHint(
          `Anthropic API error: ${err.error?.message || response.statusText}`,
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
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === "content_block_delta" && data.delta?.text) {
              yield data.delta.text;
            }
            if (data.type === "message_delta" && data.delta?.stop_reason && meta) {
              meta.finishReason = data.delta.stop_reason;
            }
            if (data.type === "error" && meta) {
              meta.blockReason = data.error?.message ?? "anthropic stream error";
            }
          } catch {
            /* skip malformed chunks */
          }
        }
      }
    }
  }
}
