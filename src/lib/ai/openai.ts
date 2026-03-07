import type { AIProvider, AIRequestOptions } from "./types";

export class OpenAIProvider implements AIProvider {
  name = "openai";

  listModels(): string[] {
    return ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"];
  }

  async *streamSolution(options: AIRequestOptions): AsyncGenerator<string> {
    const { base64Image, prompt, messages = [], model, apiKey, maxTokens = 4096 } = options;

    const imageUrl = base64Image?.startsWith("data:")
      ? base64Image
      : base64Image
        ? `data:image/png;base64,${base64Image}`
        : undefined;

    const apiMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const currentContent: any[] = [];
    if (imageUrl) {
      currentContent.push({ type: "image_url", image_url: { url: imageUrl } });
    }
    currentContent.push({ type: "text", text: prompt });

    apiMessages.push({
      role: "user",
      content: currentContent as any, // OpenAI accepts array of parts for the new message
    });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
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
    });

    if (!response.ok) {
      const err = await response
        .json()
        .catch(() => ({ error: { message: response.statusText } }));
      throw new Error(
        `OpenAI API error: ${err.error?.message || response.statusText}`,
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
            const text = data.choices?.[0]?.delta?.content;
            if (text) yield text;
          } catch {
            /* skip malformed chunks */
          }
        }
      }
    }
  }
}
