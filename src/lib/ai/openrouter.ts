import type { AIProvider, AIRequestOptions, AIStreamMeta } from "./types";
import {
  fetchWithDiagnostics,
  withModelHint,
} from "./fetchWithDiagnostics";

/**
 * A single parsed SSE payload from OpenRouter's chat completions endpoint.
 *
 * OpenRouter wraps the chosen provider's response in its own envelope.
 * Each chunk carries a `provider` field so we can tell which backend
 * actually served the token — that is what powers the "OpenRouter • Groq"
 * style UI label and the fallback detection.
 */
export interface OpenRouterChunk {
  text: string;
  finishReason?: string;
  provider?: string;
  /**
   * The concrete model OpenRouter served. For the `openrouter/free` router this
   * is the free model it picked for THIS request, which differs every time.
   */
  model?: string;
  error?: string;
}

/**
 * The free-model router.
 *
 * `openrouter/free` is NOT a model — it is a router that OpenRouter resolves to
 * a concrete available free model per request. That is the whole point: it
 * removes Ghostly's dependency on one fixed model that may be unavailable or
 * rate-limited.
 *
 * Verified against OpenRouter's Free Models Router documentation. The response
 * carries a top-level `model` field with the model actually used.
 */
export const OPENROUTER_FREE_MODEL = "openrouter/free";

export const isOpenRouterFreeModel = (model: string): boolean =>
  model === OPENROUTER_FREE_MODEL;

/**
 * OpenRouter's SSE format is OpenAI-compatible, but the top-level object
 * includes extra fields (provider, provider_min_p, etc.) and the choices
 * array follows the standard OpenAI delta shape.
 */
export function parseOpenRouterEvent(data: any): OpenRouterChunk {
  // OpenRouter can report a stream-level error inline.
  if (data?.error) {
    return {
      text: "",
      error:
        typeof data.error === "string"
          ? data.error
          : data.error.message ?? String(data.error),
    };
  }

  const choice = data?.choices?.[0];
  const delta = choice?.delta;
  const content =
    typeof delta?.content === "string" ? delta.content : "";

  return {
    text: content,
    finishReason:
      typeof choice?.finish_reason === "string"
        ? choice.finish_reason
        : undefined,
    provider:
      typeof data.provider === "string" ? data.provider : undefined,
    model: typeof data.model === "string" ? data.model : undefined,
  };
}

/**
 * Known-good OpenRouter model ids used as curated fallback when live
 * discovery is unavailable (no key, offline, or the models endpoint is
 * unreachable). These were verified against the OpenRouter catalog.
 *
 * The FIRST entry is the free router: it is the default because it degrades
 * gracefully (OpenRouter picks whatever free model is currently available)
 * instead of hard-failing when one fixed model is down or rate-limited.
 */
export function openRouterListModels(): string[] {
  return [
    OPENROUTER_FREE_MODEL,
    "openai/gpt-oss-120b",
    "google/gemini-2.5-flash",
    "anthropic/claude-haiku-4.5",
  ];
}

export class OpenRouterProvider implements AIProvider {
  name = "openrouter";

  listModels(): string[] {
    return openRouterListModels();
  }

  async fetchModels(apiKey: string): Promise<string[]> {
    const res = await fetchWithDiagnostics(
      "https://openrouter.ai/api/v1/models",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://ghostly.app",
          "X-Title": "Ghostly",
        },
      },
      { provider: "openrouter", model: "(list)", apiKey },
    );
    if (!res.ok) {
      throw new Error(
        `OpenRouter models error: ${res.status} ${res.statusText}`,
      );
    }
    const data = await res.json();
    const ids: string[] = (data?.data ?? [])
      .map((m: any) => m.id as string)
      // Keep only chat-capable text models.
      .filter(
        (id: string) =>
          id &&
          typeof id === "string" &&
          /^[a-z0-9-]+?\/[a-z0-9-_]+$/.test(id),
      )
      .sort();
    return ids;
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

    // `meta` is optional in `AIRequestOptions`, and the per-chunk reporting below
    // is only guarded for `httpMs`. A caller that omits it would have thrown on
    // the first chunk. One local object is written to instead, so a missing
    // reporter costs a discarded object rather than a crash mid-answer.
    const report: AIStreamMeta = meta ?? {};

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
      content: currentContent as any,
    });

    const startedAt = performance.now();
    // `apiKeyPresent` only — the key itself is never logged.
    console.log(
      `[OpenRouter] requested=${model} maxTokens=${maxTokens} apiKeyPresent=${!!apiKey}` +
        (isOpenRouterFreeModel(model)
          ? " (free router — OpenRouter picks the model per request)"
          : ""),
    );

    const response = await fetchWithDiagnostics(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://ghostly.app",
          "X-Title": "Ghostly",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          stream: true,
          messages: apiMessages,
        }),
        signal,
      },
      { provider: "openrouter", model, apiKey },
    );

    console.log(
      `[OpenRouter] http=${Math.round(performance.now() - startedAt)}ms status=${response.status} ${response.statusText}`,
    );
      report.httpMs = Math.round(performance.now() - startedAt);

    if (!response.ok) {
      const err = await response
        .json()
        .catch(() => ({ error: { message: response.statusText } }));
      console.error(
        `[OpenRouter] error: ${JSON.stringify(err).slice(0, 500)}`,
      );
      throw new Error(
        withModelHint(
          `OpenRouter API error: ${err.error?.message || response.statusText}`,
        ),
      );
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let lastProvider: string | undefined;
    let chunkCount = 0;
    let firstChunkAt: number | null = null;

    const consume = (line: string): string => {
      if (!line.startsWith("data: ") || line === "data: [DONE]") return "";
      chunkCount++;
      let parsed: OpenRouterChunk;
      try {
        parsed = parseOpenRouterEvent(JSON.parse(line.slice(6).trim()));
      } catch {
        // A malformed or non-JSON keep-alive frame is not fatal.
        return "";
      }
      if (parsed.error) {
        throw new Error(`OpenRouter stream error: ${parsed.error}`);
      }
      if (firstChunkAt === null) {
        firstChunkAt = performance.now();
        console.log(
          `[OpenRouter] firstChunk=${Math.round(firstChunkAt - startedAt)}ms`,
        );
      }
      // The concrete model OpenRouter served. Essential for `openrouter/free`,
      // where this differs from what we requested on almost every request.
      if (parsed.model && parsed.model !== report.model) {
        report.model = parsed.model;
        if (isOpenRouterFreeModel(model)) {
          console.log(
            `[OpenRouter] resolvedModel=${parsed.model} (requested=${model})`,
          );
        }
      }
      if (parsed.provider) {
        report.provider = parsed.provider;
        // OpenRouter can route mid-stream; log only on an actual change so a
        // long answer doesn't print one line per token.
        if (parsed.provider !== lastProvider) {
          lastProvider = parsed.provider;
          console.log(
            `[OpenRouter] backend=${parsed.provider} (resolvedModel=${report.model ?? model})`,
          );
        }
      }
      if (parsed.finishReason) {
        report.finishReason = parsed.finishReason;
        console.log(
          `[OpenRouter] finishReason=${parsed.finishReason}`,
        );
      }
      return parsed.text;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        // Every SSE frame is YIELDED, including frames with no answer text in
        // them (routing metadata, reasoning-only deltas, keep-alives). An empty
        // yield is the heartbeat the orchestrator's first-token budget needs:
        // a frame-blind timer reported "timeout" on streams that were
        // demonstrably alive and framing the whole time. The orchestrator
        // accumulates only non-empty text, so nothing about the answer changes.
        yield consume(line);
      }
    }

    // The stream can end without a trailing newline, leaving a partial frame.
    if (buffer.trim()) {
      yield consume(buffer);
    }

    console.log(
      `[OpenRouter] done: requested=${model} resolvedModel=${meta?.model ?? "(same)"} ` +
        `backend=${lastProvider ?? "(unknown)"} finishReason=${meta?.finishReason ?? "(none)"} ` +
        `chunks=${chunkCount} total=${Math.round(performance.now() - startedAt)}ms`,
    );
  }
}
