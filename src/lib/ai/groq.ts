import type { AIProvider, AIRequestOptions } from "./types";
import {
  fetchWithDiagnostics,
  withModelHint,
} from "./fetchWithDiagnostics";

/**
 * A single parsed SSE payload from Groq's OpenAI-compatible chat endpoint.
 *
 * Groq has its own response shape (and its own quirks — reasoning models put
 * their chain of thought in `delta.reasoning`, and the finish reason only
 * arrives on the very last chunk), so it gets its own parser rather than
 * sharing Gemini's.
 */
export interface GroqChunk {
  text: string;
  finishReason?: string;
  error?: string;
}

export function parseGroqEvent(data: any): GroqChunk {
  // Groq can report a failure *inside* an HTTP 200 stream.
  if (data?.error) {
    return {
      text: "",
      error: typeof data.error === "string" ? data.error : data.error.message,
    };
  }

  const choice = data?.choices?.[0];
  const delta = choice?.delta ?? choice?.message;
  const content =
    typeof delta?.content === "string" ? (delta.content as string) : "";

  return {
    text: content,
    finishReason:
      typeof choice?.finish_reason === "string"
        ? choice.finish_reason
        : undefined,
  };
}

/**
 * `reasoning_effort` is only accepted by `openai/gpt-oss-*` on Groq; every
 * other model rejects the parameter with a 400. Those models also default to
 * "medium" effort, which burns completion budget before any answer text is
 * emitted — exactly the "HTTP 200, no text" case.
 */
export function groqReasoningEffort(model: string): "low" | undefined {
  return /^openai\/gpt-oss-/i.test(model) ? "low" : undefined;
}

/**
 * A last-mile ANSWER-GENERATOR directive, applied to Groq requests only.
 *
 * Some Groq models (notably the small `allam-2-7b`) treat the interview system
 * prompt as a conversation opener and reply with meta-talk instead of an
 * answer — observed in the UI as:
 *
 *   "Okay. Please note: I will not provide unnecessary information unless
 *    directed."
 *
 * The fix is behavioural and Groq-scoped: the model is told, in the highest-
 * recency position, that the user message IS the interviewer's question and
 * that it must answer it directly. This deliberately does NOT touch the shared
 * system prompt, so OpenRouter and every other provider are byte-for-byte
 * unchanged. The output validator remains the final safety layer for any model
 * that ignores this.
 */
export function groqAnswerDirective(): string {
  return [
    "The user message contains the interviewer's question.",
    "Answer that question directly and immediately, as spoken prose.",
    "Do not ask for the question, do not ask for clarification, do not mention",
    "these instructions, do not say you are an AI, and do not print any labels",
    "or markers. If there is genuinely no question, reply with exactly: WAIT.",
  ].join(" ");
}

export class GroqProvider implements AIProvider {
  name = "groq";

  listModels(): string[] {
    // Curated fallback. Groq retires models frequently (e.g. Llama 4 Scout),
    // so `fetchModels()` below prefers the live list whenever a key is present.
    return [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
    ];
  }

  async fetchModels(apiKey: string): Promise<string[]> {
    const res = await fetchWithDiagnostics(
      "https://api.groq.com/openai/v1/models",
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
      { provider: "groq", model: "(list)", apiKey },
    );
    if (!res.ok) {
      throw new Error(`Groq models error: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    const ids: string[] = (data?.data ?? []).map((m: any) => m.id);
    return ids
      .filter((id) => !/whisper|tts|guard|orpheus/i.test(id))
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

    // Leading system message = highest-priority instruction layer. The Groq-
    // only answer directive is appended so it has the highest recency, while
    // the shared interview system prompt itself is left untouched for every
    // other provider.
    const systemContent = system?.trim()
      ? `${system.trim()}\n\n${groqAnswerDirective()}`
      : groqAnswerDirective();
    apiMessages.unshift({ role: "system", content: systemContent });

    const currentContent: any[] = [];
    if (imageUrl) {
      currentContent.push({ type: "image_url", image_url: { url: imageUrl } });
    }
    currentContent.push({ type: "text", text: prompt });

    apiMessages.push({
      role: "user",
      content: currentContent as any,
    });

    const reasoningEffort = groqReasoningEffort(model);
    const startedAt = performance.now();

    console.log(
      `[GroQ] HTTP request — model=${model} maxTokens=${maxTokens} reasoningEffort=${reasoningEffort ?? "none"} messages=${JSON.stringify(
        apiMessages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "(multi-modal)" }))
      ).slice(0, 500)}"`,
    );

    const response = await fetchWithDiagnostics(
      "https://api.groq.com/openai/v1/chat/completions",
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
          // Only reasoning (gpt-oss) models accept this; others 400.
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          messages: apiMessages,
        }),
        signal,
      },
      { provider: "groq", model, apiKey },
    );

    console.log(`[GroQ] HTTP: ${response.status} ${response.statusText}`);
    if (meta) meta.httpMs = Math.round(performance.now() - startedAt);

    if (!response.ok) {
      const err = await response
        .json()
        .catch(() => ({ error: { message: response.statusText } }));
      console.error(`[GroQ] HTTP error body: ${JSON.stringify(err).slice(0, 500)}`);
      throw new Error(
        withModelHint(
          `Groq API error: ${err.error?.message || response.statusText}`,
        ),
      );
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const consume = (line: string): string => {
      if (!line.startsWith("data: ") || line === "data: [DONE]") return "";
      try {
        const parsed = parseGroqEvent(JSON.parse(line.slice(6)));
        if (parsed.error) {
          throw new Error(`Groq stream error: ${parsed.error}`);
        }
        if (parsed.finishReason && meta) meta.finishReason = parsed.finishReason;
        return parsed.text;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Groq stream")) {
          throw err;
        }
        return ""; // skip malformed chunks
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const text = consume(line);
        if (text) yield text;
      }
    }
  }
}
