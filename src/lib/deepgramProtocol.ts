/**
 * Deepgram Nova-3 streaming — pure protocol layer.
 *
 * ── Deliberately optional, deliberately second ─────────────────────────────
 * Moonshine remains the default engine and nothing here modifies it. This
 * module exists so the SAME Ghostly system-loopback audio can also be sent to a
 * second engine and the two results compared side by side. Comparison is
 * developer-only; Deepgram output never reaches the AI pipeline on its own.
 *
 * ── Why the pure parts are separated from the socket ───────────────────────
 * The three things worth testing here are exactly the things that break
 * silently in production:
 *
 *   1. {@link buildDeepgramUrl} — Deepgram does NOT error on a malformed
 *      keyterm. `?keyterm=a,b` is accepted and boosts the single literal
 *      string "a,b", which boosts nothing. A bug here is invisible: the
 *      transcript just quietly stays wrong. So the repeated-parameter form is
 *      asserted directly.
 *   2. {@link parseDeepgramMessage} — Deepgram's envelope changed shape
 *      across versions (`channel` vs `channels`, `speech_final` vs
 *      `speech_finalized`), and an unexpected shape must degrade to "no result"
 *      rather than throw inside a socket callback.
 *   3. {@link createTelemetryRecorder} — the comparison numbers are only
 *      meaningful if they are captured at consistent instants, and they must
 *      never carry the transcript into a log line.
 *
 * No credentials appear in this file. The API key never reaches the renderer
 * at all (see `electron/deepgram.ts`); the renderer only ever holds a
 * short-lived JWT.
 */

/** Fixed endpoint. The path is not configurable — only query parameters are. */
export const DEEPGRAM_WS_ENDPOINT = "wss://api.deepgram.com/v1/listen";

/**
 * Required parameters, exactly as specified for this integration.
 *
 * `model=nova-3` and `language=en-US` pin the model; `interim_results=true` is
 * what produces live text; `endpointing=400` sets Deepgram's own turn
 * detection, which is deliberately INDEPENDENT of Ghostly's VAD (the VAD still
 * decides what is an utterance — see the comparison-mode note in
 * `useInterviewAudio.ts`). `smart_format` + `punctuate` give readable text
 * without a separate formatting model.
 */
export const DEEPGRAM_PARAMS = {
  model: "nova-3",
  language: "en-US",
  interim_results: "true",
  endpointing: "400",
  smart_format: "true",
  punctuate: "true",
} as const;

/**
 * The audio encoding Ghostly already produces.
 *
 * Ghostly's VAD emits 16 kHz mono Float32, which `resampleTo16k` already
 * guarantees (the AudioContext is created at 16 kHz). Deepgram accepts raw
 * little-endian PCM16 over the socket, so `Float32 → PCM16` happens here
 * without any re-encoding or re-sampling.
 */
export const DEEPGRAM_ENCODING = "linear16";
export const DEEPGRAM_SAMPLE_RATE = 16000;
export const DEEPGRAM_CHANNELS = 1;

/** Build the streaming URL. Keyterms are REPEATED, never comma-joined. */
export function buildDeepgramUrl(keyterms: string[] = []): string {
  const params = new URLSearchParams();
  params.set("model", DEEPGRAM_PARAMS.model);
  params.set("language", DEEPGRAM_PARAMS.language);
  params.set("interim_results", DEEPGRAM_PARAMS.interim_results);
  params.set("endpointing", DEEPGRAM_PARAMS.endpointing);
  params.set("smart_format", DEEPGRAM_PARAMS.smart_format);
  params.set("punctuate", DEEPGRAM_PARAMS.punctuate);
  params.set("encoding", DEEPGRAM_ENCODING);
  params.set("sample_rate", String(DEEPGRAM_SAMPLE_RATE));
  params.set("channels", String(DEEPGRAM_CHANNELS));
  // Repeated `keyterm=` params — Deepgram's documented multi-term form.
  for (const term of keyterms) params.append("keyterm", term);
  return `${DEEPGRAM_WS_ENDPOINT}?${params.toString()}`;
}

/**
 * Float32 [-1, 1] → little-endian PCM16.
 *
 * Clamped, because the capture path can legitimately exceed full scale and a
 * wrapped sample is an audible click that corrupts the decode. The clipping
 * itself is reported separately by the debug WAV writer.
 */
export function float32ToPcm16(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    const raw = samples[i];
    const s = raw < -1 ? -1 : raw > 1 ? 1 : raw;
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

/** One transcript event from Deepgram. */
export interface DeepgramResult {
  text: string;
  /**
   * Deepgram's turn boundary. `speech_final=true` means Deepgram considers the
   * turn complete. This is NOT the same as `is_final`, and the distinction is
   * the whole reason both are recorded: `is_final` fires for interim-safe
   * snapshots when `interim_results=true`.
   */
  speechFinal: boolean;
  /** True when this transcript should supersede interim display text. */
  isFinal: boolean;
  /** Deepgram's own confidence for this alternative, when present. */
  confidence?: number;
  /** Duration of the audio covered, in seconds, when present. */
  audioDurationSeconds?: number;
}

export interface ParseOutcome {
  results: DeepgramResult[];
  /** Set when the message was understood but carried no transcript. */
  error?: string;
}

/**
 * Parse one Deepgram socket message.
 *
 * Total by construction: an unrecognised envelope yields no results rather than
 * throwing, because this runs inside a socket callback where an exception would
 * be swallowed and look like a silent stall.
 *
 * Handles both the modern single-`channel` shape and the older `channels`
 * array, since which one arrives depends on the API version.
 */
export function parseDeepgramMessage(raw: unknown): ParseOutcome {
  let msg: any;
  try {
    msg = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { results: [] };
  }
  if (!msg || typeof msg !== "object") return { results: [] };

  // Metadata / control frames (Metadata, CloseStream, Upgrade) carry no text.
  if (msg.type !== undefined && msg.type !== "Results") return { results: [] };

  if (msg.error) {
    const detail =
      typeof msg.error === "string" ? msg.error : msg.error?.message ?? "error";
    return { results: [], error: detail };
  }

  const alternatives: any[] = Array.isArray(msg.channel?.alternatives)
    ? msg.channel.alternatives
    : Array.isArray(msg.channels?.[0]?.alternatives)
      ? msg.channels[0].alternatives
      : [];
  if (alternatives.length === 0) return { results: [] };

  const isFinal = msg.is_final === true;
  const speechFinal = msg.speech_final === true || msg.speech_finalized === true;

  const results: DeepgramResult[] = [];
  for (const alt of alternatives) {
    if (!alt || typeof alt.transcript !== "string") continue;
    const text = alt.transcript.trim();
    if (!text) continue;
    results.push({
      text,
      speechFinal,
      isFinal,
      confidence:
        typeof alt.confidence === "number" ? alt.confidence : undefined,
      audioDurationSeconds:
        typeof msg.duration === "number" ? msg.duration : undefined,
    });
  }
  return { results };
}

// ── Telemetry ─────────────────────────────────────────────────────────────

/**
 * The comparison record for one utterance.
 *
 * Every latency is milliseconds from `startedAt` — the instant audio for this
 * utterance began streaming. Measuring from "when the socket opened" instead
 * would fold connection setup into the number and make Moonshine and Deepgram
 * incomparable.
 */
export interface DeepgramTelemetry {
  /** ms from stream start to the first non-empty interim transcript. */
  firstInterimMs: number | null;
  /** ms to the first `is_final` transcript. */
  firstFinalMs: number | null;
  /** ms to the first `speech_final` transcript — Deepgram's turn boundary. */
  speechFinalMs: number | null;
  /** ms to the transcript Ghostly will actually use (see `finalText`). */
  totalMs: number | null;
  /** The transcript Ghostly committed. */
  finalText: string;
  /** Audio seconds streamed to Deepgram. */
  audioSeconds: number;
  /** Number of transcript events received. */
  resultCount: number;
}

export function emptyTelemetry(): DeepgramTelemetry {
  return {
    firstInterimMs: null,
    firstFinalMs: null,
    speechFinalMs: null,
    totalMs: null,
    finalText: "",
    audioSeconds: 0,
    resultCount: 0,
  };
}

export interface TelemetryRecorder {
  /** Fold one parsed result in. Only the FIRST of each kind is timed. */
  record(result: DeepgramResult, now: number): void;
  /** Add streamed audio duration, in seconds. */
  addAudio(seconds: number): void;
  /** Finalise. `totalMs` is set from the committing transcript. */
  finish(now: number, finalText: string): DeepgramTelemetry;
  snapshot(): DeepgramTelemetry;
}

/**
 * Create a telemetry recorder.
 *
 * The recorder deliberately does NOT capture the transcript into any log line.
 * `finalText` is returned to the caller for on-screen comparison only; see
 * `formatTelemetryForLog`, which prints lengths and latencies but never text.
 */
export function createTelemetryRecorder(startedAt: number): TelemetryRecorder {
  const data = emptyTelemetry();
  return {
    record(result, now) {
      data.resultCount++;
      if (result.text) {
        if (!result.isFinal && data.firstInterimMs === null) {
          data.firstInterimMs = Math.max(0, now - startedAt);
        }
        if (result.isFinal && data.firstFinalMs === null) {
          data.firstFinalMs = Math.max(0, now - startedAt);
        }
        if (result.speechFinal && data.speechFinalMs === null) {
          data.speechFinalMs = Math.max(0, now - startedAt);
        }
      }
    },
    addAudio(seconds) {
      data.audioSeconds += seconds;
    },
    finish(now, finalText) {
      data.finalText = finalText;
      if (finalText) data.totalMs = Math.max(0, now - startedAt);
      return { ...data };
    },
    snapshot() {
      return { ...data };
    },
  };
}

/**
 * One-line comparison log.
 *
 * Prints latencies and COUNTS only — never the transcript text. The
 * interviewer is a real person and the transcript is their words; the console
 * is not the place for them. Text is compared on screen instead.
 */
export function formatTelemetryForLog(
  label: string,
  telemetry: DeepgramTelemetry,
): string {
  const ms = (v: number | null) => (v === null ? "-" : `${Math.round(v)}ms`);
  return (
    `[Deepgram] ${label} audio=${telemetry.audioSeconds.toFixed(2)}s ` +
    `interim=${ms(telemetry.firstInterimMs)} final=${ms(telemetry.firstFinalMs)} ` +
    `speech_final=${ms(telemetry.speechFinalMs)} total=${ms(telemetry.totalMs)} ` +
    `events=${telemetry.resultCount} chars=${telemetry.finalText.length}`
  );
}