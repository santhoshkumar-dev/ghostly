/**
 * The Deepgram streaming socket, owned by the renderer.
 *
 * ── Scope: optional second engine, comparison only ─────────────────────────
 * Nothing in this module is on the critical path. Moonshine remains the default
 * and is not modified here. Deepgram exists so the SAME Ghostly system-loopback
 * audio can be transcribed by a second engine and the two compared. Its output
 * goes to a dedicated comparison slice and NEVER to `interviewMessages`, so it
 * cannot reach the question gate, the prompt, or the answer path.
 *
 * ── Credential handling ────────────────────────────────────────────────────
 * This file never holds the long-lived API key. It asks the main process for a
 * ~30 s JWT (`window.ghostly.deepgramToken()`) and opens the socket with it as
 * a WebSocket SUBPROTOCOL, because a browser `WebSocket` cannot set an
 * `Authorization` header. Deepgram confirms the socket outlives the token, so
 * the short TTL costs nothing at runtime.
 *
 * ── One socket per utterance ───────────────────────────────────────────────
 * Deepgram's endpointing is not used as Ghostly's utterance boundary — the
 * existing local VAD still decides that (unchanged, per the brief). Instead the
 * socket mirrors the VAD: it opens when a segment starts and closes when the
 * segment ends, sending `CloseStream` and waiting for the final result. That
 * keeps the two engines measuring the same audio, which is the only way a
 * comparison means anything.
 */

import {
  buildDeepgramUrl,
  float32ToPcm16,
  parseDeepgramMessage,
  createTelemetryRecorder,
  formatTelemetryForLog,
  DEEPGRAM_SAMPLE_RATE,
  type DeepgramResult,
  type DeepgramTelemetry,
  type TelemetryRecorder,
} from "./deepgramProtocol";

/** How long to wait for the final result after `CloseStream`. */
const FINAL_FLUSH_TIMEOUT_MS = 4000;

export interface DeepgramClientCallbacks {
  /** A live (non-final) transcript for display. */
  onInterim?: (text: string) => void;
  /** The committed transcript for this segment. */
  onFinal: (text: string, telemetry: DeepgramTelemetry) => void;
  /** Any failure. Never throws into the caller's audio path. */
  onError?: (message: string) => void;
}

export interface StartOptions {
  keyterms: string[];
  /** Injectable for tests. */
  socketFactory?: (url: string, token: string) => WebSocket;
  now?: () => number;
}

/**
 * Build the socket. Kept separate so tests can substitute a fake.
 *
 * The token is passed as the SECOND subprotocol value, which is Deepgram's
 * documented browser auth form: `new WebSocket(url, ["token", jwt])`.
 */
function defaultSocketFactory(url: string, token: string): WebSocket {
  return new WebSocket(url, ["token", token]);
}

export interface DeepgramSegment {
  /** Push audio into the stream. Call repeatedly as frames arrive. */
  push(samples: Float32Array): void;
  /** Close the stream and resolve once the final transcript is in. */
  finish(): Promise<void>;
  /** Abandon the stream immediately (session stopped). */
  abort(): void;
}

/**
 * Open a Deepgram stream for one segment.
 *
 * Resolves to `null` when Deepgram could not be started (no key, token
 * failure, socket refused). That is a normal, expected outcome here — it must
 * never throw, because the caller is on the audio path and Moonshine must keep
 * working regardless.
 */
export async function openDeepgramSegment(
  options: StartOptions,
  callbacks: DeepgramClientCallbacks,
): Promise<DeepgramSegment | null> {
  const now = options.now ?? (() => Date.now());
  const factory = options.socketFactory ?? defaultSocketFactory;

  // ── Credential: short-lived token from the main process ────────────────
  let token: string;
  try {
    if (typeof window === "undefined" || !window.ghostly?.deepgramToken) {
      callbacks.onError?.("Deepgram bridge unavailable.");
      return null;
    }
    const granted = await window.ghostly.deepgramToken();
    if (!granted?.ok) {
      // The message is a fixed, non-leaking string from the main process.
      callbacks.onError?.(granted?.message ?? "No Deepgram token available.");
      return null;
    }
    token = granted.token;
  } catch (err) {
    console.warn("[Deepgram] could not obtain a short-lived token");
    callbacks.onError?.("Could not obtain a Deepgram token.");
    return null;
  }

  const startedAt = now();
  let recorder: TelemetryRecorder = createTelemetryRecorder(startedAt);
  let socket: WebSocket;
  try {
    socket = factory(buildDeepgramUrl(options.keyterms), token);
  } catch (err) {
    console.warn("[Deepgram] socket construction failed");
    callbacks.onError?.("Could not open a Deepgram socket.");
    return null;
  }

  let finalText = "";
  let settled = false;
  let finished = false;
  let resolveFinish: (() => void) | null = null;
  let rejectTimer: ReturnType<typeof setTimeout> | null = null;

  const settle = (text: string) => {
    if (settled) return;
    settled = true;
    finalText = text;
    const telemetry = recorder.finish(now(), text);
    if (telemetry.firstInterimMs !== null || telemetry.audioSeconds > 0) {
      console.log(formatTelemetryForLog("segment", telemetry));
    }
    callbacks.onFinal(text, telemetry);
    try {
      socket.close();
    } catch {
      /* already closing */
    }
    if (rejectTimer) clearTimeout(rejectTimer);
    resolveFinish?.();
  };

  socket.onopen = () => {
    // Binary frames are PCM16 little-endian; the encoding is declared in the URL.
  };

  socket.onmessage = (event: MessageEvent) => {
    const { results, error } = parseDeepgramMessage(event.data);
    if (error) {
      // Deepgram error text can include request ids; log the fact, not the body.
      console.warn("[Deepgram] stream reported an error");
      callbacks.onError?.("Deepgram reported a stream error.");
      settle("");
      return;
    }
    for (const result of results) {
      recorder.record(result, now());
      // Interim text is display-only and, like Ghostly's own interim, must
      // never influence detection or generation.
      if (!result.isFinal) {
        callbacks.onInterim?.(result.text);
        continue;
      }
      // Prefer the Deepgram turn boundary when it arrives; otherwise the
      // first final is the best available committed text.
      if (!finalText || result.speechFinal) settle(result.text);
    }
  };

  socket.onerror = () => {
    // The event carries no useful detail and the URL contains a token, so
    // nothing from it is logged.
    console.warn("[Deepgram] socket error");
    callbacks.onError?.("Deepgram socket error.");
    settle(finalText);
  };

  socket.onclose = () => {
    if (!settled) settle(finalText);
  };

  return {
    push(samples: Float32Array) {
      if (finished || settled) return;
      if (socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(float32ToPcm16(samples));
        recorder.addAudio(samples.length / DEEPGRAM_SAMPLE_RATE);
      } catch {
        // A failed frame must not kill the segment; the socket's own error or
        // close handler will settle it.
      }
    },
    async finish() {
      if (settled) return;
      finished = true;
      await new Promise<void>((resolve) => {
        resolveFinish = resolve;
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify({ type: "CloseStream" }));
          } catch {
            /* fall through to the timeout */
          }
        }
        // Bounded: if the final never arrives, settle with what we have.
        rejectTimer = setTimeout(() => settle(finalText), FINAL_FLUSH_TIMEOUT_MS);
      });
    },
    abort() {
      finished = true;
      settle("");
    },
  };
}

/** Re-exported for the comparison UI. */
export type { DeepgramResult, DeepgramTelemetry };