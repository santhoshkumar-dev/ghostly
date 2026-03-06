import type { AIProvider, AIRequestOptions } from "./types";

export class GeminiProvider implements AIProvider {
  name = "gemini";

  listModels(): string[] {
    return [
      "gemini-3.1-flash-lite-preview",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-1.5-pro",
    ];
  }

  async *streamSolution(options: AIRequestOptions): AsyncGenerator<string> {
    const {
      base64Image,
      mimeType = "image/png",
      prompt,
      messages = [],
      model,
      apiKey,
      maxTokens = 4096,
    } = options;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

    // Strip data URL prefix if present
    const imageData = base64Image?.includes(",")
      ? base64Image.split(",")[1]
      : base64Image;

    const contents: any[] = [];

    // Map previous messages
    for (const msg of messages) {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }]
      });
    }

    // Append new prompt + image
    const parts: any[] = [];
    if (imageData) {
      parts.push({
        inline_data: {
          mime_type: mimeType,
          data: imageData,
        },
      });
    }
    parts.push({ text: prompt });

    contents.push({
      role: "user",
      parts,
    });

    const body = {
      contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.3,
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response
        .json()
        .catch(() => ({ error: { message: response.statusText } }));
      throw new Error(
        `Gemini API error: ${err.error?.message || response.statusText}`,
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
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) yield text;
          } catch {
            /* skip malformed chunks */
          }
        }
      }
    }

    // Process remaining buffer
    if (buffer.startsWith("data: ")) {
      try {
        const data = JSON.parse(buffer.slice(6));
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) yield text;
      } catch {
        /* skip */
      }
    }
  }
}
