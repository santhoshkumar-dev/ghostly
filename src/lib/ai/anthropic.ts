import type { AIProvider, AIRequestOptions } from "./types";

export class AnthropicProvider implements AIProvider {
  name = "anthropic";

  listModels(): string[] {
    return [
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-opus-20240229",
    ];
  }

  async *streamSolution(options: AIRequestOptions): AsyncGenerator<string> {
    const {
      base64Image,
      mimeType = "image/png",
      prompt,
      model,
      apiKey,
      maxTokens = 4096,
    } = options;

    const imageData = base64Image.includes(",")
      ? base64Image.split(",")[1]
      : base64Image;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
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
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType,
                  data: imageData,
                },
              },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response
        .json()
        .catch(() => ({ error: { message: response.statusText } }));
      throw new Error(
        `Anthropic API error: ${err.error?.message || response.statusText}`,
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
            if (data.type === "content_block_delta") {
              yield data.delta.text;
            }
          } catch {
            /* skip malformed chunks */
          }
        }
      }
    }
  }
}
