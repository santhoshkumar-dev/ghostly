/**
 * Groq Whisper (Speech-to-Text) — pure protocol layer.
 *
 * ── Scope: optional THIRD comparison engine ────────────────────────────────
 * Moonshine stays the default and is untouched. This module exists so the SAME
 * Ghostly captured segment can ALSO be transcribed by Groq Whisper
 * (`whisper-large-v3`) and compared against Moonshine and Deepgram. Its output
 * is held in the isolated `asrComparisons` slice and never reaches the question
 * gate, the prompt, or the answer path.
 *
 * ── Why the pure parts are separated from Electron ─────────────────────────
 * The three things worth testing here are exactly the ones that break silently:
 *
 *   1. {@link buildGroqAsrFormData} — the multipart contract. A missing `model`
 *      or a comma-joined prompt is rejected by nothing locally and just returns
 *      a worse transcript.
 *   2. {@link parseGroqTranscriptionResponse} — Groq returns `verbose_json`
 *      shaped like OpenAI's; an unexpected shape must degrade to an error code
 *      rather than throw inside the main process.
 *   3. {@link transcribeWithGroq} — the status → reason mapping, so a 401 is a
 *      key problem and a 429 is a rate limit, not a generic "network error".
 *
 * No credential appears in this file. The API key is passed in by the caller
 * (the Electron main process) and only ever reaches the outbound fetch.
 */

/** The documented Groq transcription endpoint. */
export const GROQ_ASR_ENDPOINT =
  "https://api.groq.com/openai/v1/audio/transcriptions";

/**
 * The accuracy-focused model, as specified: NOT the turbo variant. Groq
 * documents `whisper-large-v3` for error-sensitive transcription.
 */
export const DEFAULT_GROQ_ASR_MODEL = "whisper-large-v3";

/** Fixed language hint for this comparison. */
export const GROQ_ASR_LANGUAGE = "en";

/** Deterministic decoding. */
export const GROQ_ASR_TEMPERATURE = 0;

/** Timestamps are useful for diagnostics, so verbose_json is the default. */
export const GROQ_ASR_RESPONSE_FORMAT = "verbose_json";

/**
 * Upper bound on the context prompt.
 *
 * Groq documents a small prompt budget (roughly 224 tokens). The prompt is a
 * spelling hint, NOT a whitelist: the interviewer can ask anything, so a short
 * bounded technical vocabulary is all that is sent.
 */
export const MAX_GROQ_ASR_PROMPT_CHARS = 800;

/**
 * Refuse to upload an implausibly large segment.
 *
 * The comparison reuses Ghostly's own short VAD segment, so this should never
 * trip; it exists so a runaway buffer fails deterministically instead of being
 * silently rejected (or accepted) by the API.
 */
export const MAX_GROQ_ASR_AUDIO_BYTES = 20 * 1024 * 1024;

/** Bound on how long the transcription request may take. */
export const GROQ_ASR_TIMEOUT_MS = 20000;

export type GroqAsrErrorCode =
  | "no_key"
  | "too_large"
  | "unsupported"
  | "http_400"
  | "http_401"
  | "http_403"
  | "http_413"
  | "http_429"
  | "http_5xx"
  | "http_other"
  | "timeout"
  | "network"
  | "malformed"
  | "empty";

/** One timestamped transcript span from `verbose_json`. */
export interface GroqAsrSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

/** Provider-neutral ASR result — nothing downstream needs to know it is Groq. */
export interface GroqAsrResult {
  provider: "groq";
  model: string;
  text: string;
  audioSeconds: number;
  latencyMs: number;
  firstResultMs: number | null;
  segments: GroqAsrSegment[];
}

/** Developer telemetry for one attempt. Carries no transcript text. */
export interface GroqAsrTelemetry {
  provider: "groq";
  model: string;
  audioSeconds: number;
  requestStartMs: number;
  firstResultMs: number | null;
  totalMs: number;
  httpStatus: number | null;
  success: boolean;
  failureReason: GroqAsrErrorCode | null;
  chars: number;
  segmentCount: number;
}

export type GroqAsrOutcome =
  | {
      ok: true;
      result: GroqAsrResult;
      telemetry: GroqAsrTelemetry;
      httpStatus: number;
    }
  | {
      ok: false;
      code: GroqAsrErrorCode;
      httpStatus: number | null;
      telemetry: GroqAsrTelemetry;
      message: string;
    };

/** Fixed, non-leaking messages per failure category. */
export const GROQ_ASR_ERROR_MESSAGES: Record<GroqAsrErrorCode, string> = {
  no_key: "No Groq API key configured. Add one in the ASR comparison settings.",
  too_large: "Segment too large to send to Groq Whisper.",
  unsupported: "Segment is not a supported 16 kHz mono WAV.",
  http_400: "Groq rejected the request (HTTP 400).",
  http_401: "Groq rejected the API key (HTTP 401).",
  http_403: "Groq denied access (HTTP 403).",
  http_413: "Segment too large for Groq (HTTP 413).",
  http_429: "Groq rate limit reached (HTTP 429).",
  http_5xx: "Groq is temporarily unavailable (HTTP 5xx).",
  http_other: "Groq returned an unexpected error.",
  timeout: "Groq Whisper request timed out.",
  network: "Could not reach Groq.",
  malformed: "Groq returned a malformed response.",
  empty: "Groq returned an empty transcription.",
};

/** Map an HTTP status onto a stable error category. */
export function classifyGroqHttpStatus(status: number): GroqAsrErrorCode {
  if (status === 400 || status === 422) return "http_400";
  if (status === 401) return "http_401";
  if (status === 403) return "http_403";
  if (status === 413) return "http_413";
  if (status === 429) return "http_429";
  if (status >= 500 && status <= 599) return "http_5xx";
  return "http_other";
}

/**
 * Build the bounded context prompt.
 *
 * Joins a small set of technical terms on commas and hard-caps the length. It
 * NEVER includes resume prose or a candidate profile: the interviewer can ask
 * anything, so this is a spelling boost, not a whitelist.
 */
export function buildGroqAsrPrompt(terms: string[], maxChars = MAX_GROQ_ASR_PROMPT_CHARS): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of terms) {
    if (typeof raw !== "string") continue;
    const term = raw.replace(/[\r\n,]+/g, " ").replace(/\s+/g, " ").trim();
    if (term.length < 2 || term.length > 60) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const candidate = kept.length === 0 ? term : `${kept.join(", ")}, ${term}`;
    if (candidate.length > maxChars) break;
    kept.push(term);
  }
  return kept.join(", ");
}

export interface GroqAsrRequest {
  /** Mono 16-bit PCM WAV bytes of the captured segment. */
  audio: Blob;
  model?: string;
  language?: string;
  temperature?: number;
  responseFormat?: string;
  /** Optional bounded context prompt. */
  prompt?: string;
  /** Defaults to segment-level timestamps for diagnostics. */
  timestampGranularities?: Array<"segment" | "word">;
}

/**
 * Construct the multipart body exactly as Groq documents it.
 *
 * `temperature` and `response_format` are sent as strings, which is the
 * multipart form contract (every part is a string). `timestamp_granularities[]`
 * is repeated, never comma-joined.
 */
export function buildGroqAsrFormData(input: GroqAsrRequest): FormData {
  const form = new FormData();
  form.append("file", input.audio, "segment.wav");
  form.append("model", input.model ?? DEFAULT_GROQ_ASR_MODEL);
  form.append("language", input.language ?? GROQ_ASR_LANGUAGE);
  form.append(
    "temperature",
    String(input.temperature ?? GROQ_ASR_TEMPERATURE),
  );
  form.append(
    "response_format",
    input.responseFormat ?? GROQ_ASR_RESPONSE_FORMAT,
  );
  if (input.prompt?.trim()) form.append("prompt", input.prompt.trim());
  const granularities = input.timestampGranularities ?? ["segment"];
  for (const g of granularities) form.append("timestamp_granularities[]", g);
  return form;
}

export interface GroqParseOutcome {
  ok: boolean;
  text: string;
  audioSeconds: number;
  segments: GroqAsrSegment[];
  errorCode?: GroqAsrErrorCode;
}

/**
 * Normalise a `verbose_json` transcription response.
 *
 * Total by construction: an unexpected shape yields a `malformed` outcome
 * rather than throwing, because this runs inside the main-process request where
 * an exception would surface as a generic failure with no diagnosis.
 */
export function parseGroqTranscriptionResponse(raw: unknown): GroqParseOutcome {
  if (!raw || typeof raw !== "object") {
    return { ok: false, text: "", audioSeconds: 0, segments: [], errorCode: "malformed" };
  }
  const obj = raw as Record<string, unknown>;
  const text = typeof obj.text === "string" ? obj.text.trim() : "";
  const audioSeconds = typeof obj.duration === "number" ? obj.duration : 0;

  const segments: GroqAsrSegment[] = [];
  if (Array.isArray(obj.segments)) {
    for (const s of obj.segments) {
      if (!s || typeof s !== "object") continue;
      const seg = s as Record<string, unknown>;
      if (typeof seg.text !== "string") continue;
      segments.push({
        id: typeof seg.id === "number" ? seg.id : segments.length,
        start: typeof seg.start === "number" ? seg.start : 0,
        end: typeof seg.end === "number" ? seg.end : 0,
        text: seg.text.trim(),
      });
    }
  }

  if (!text) {
    return { ok: false, text: "", audioSeconds, segments, errorCode: "empty" };
  }
  return { ok: true, text, audioSeconds, segments };
}

export interface TranscribeWithGroqOptions {
  apiKey: string;
  audio: Blob;
  /** Bytes of the WAV, for the size guard and the duration fallback. */
  audioBytes?: number;
  model?: string;
  language?: string;
  prompt?: string;
  timestampGranularities?: Array<"segment" | "word">;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Run one transcription and normalise everything into a single outcome.
 *
 * Never throws: every failure path becomes a typed outcome so the caller (the
 * main process) can return it over IPC without leaking a stack trace, a URL, or
 * a key.
 */
export async function transcribeWithGroq(
  options: TranscribeWithGroqOptions,
): Promise<GroqAsrOutcome> {
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model ?? DEFAULT_GROQ_ASR_MODEL;
  const requestStartMs = now();

  const bytes = options.audioBytes ?? options.audio.size;
  const audioSecondsFallback =
    bytes > 44 ? (bytes - 44) / 2 / 16000 : 0;

  const baseTelemetry = (): GroqAsrTelemetry => ({
    provider: "groq",
    model,
    audioSeconds: audioSecondsFallback,
    requestStartMs,
    firstResultMs: null,
    totalMs: Math.max(0, now() - requestStartMs),
    httpStatus: null,
    success: false,
    failureReason: null,
    chars: 0,
    segmentCount: 0,
  });

  const fail = (
    code: GroqAsrErrorCode,
    httpStatus: number | null,
  ): GroqAsrOutcome => {
    const telemetry = baseTelemetry();
    telemetry.failureReason = code;
    telemetry.httpStatus = httpStatus;
    return {
      ok: false,
      code,
      httpStatus,
      telemetry,
      message: GROQ_ASR_ERROR_MESSAGES[code],
    };
  };

  if (!options.apiKey?.trim()) return fail("no_key", null);
  if (bytes > MAX_GROQ_ASR_AUDIO_BYTES) return fail("too_large", null);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? GROQ_ASR_TIMEOUT_MS,
  );

  try {
    const response = await fetchImpl(GROQ_ASR_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}` },
      body: buildGroqAsrFormData({
        audio: options.audio,
        model,
        language: options.language,
        prompt: options.prompt,
        timestampGranularities: options.timestampGranularities,
      }),
      signal: controller.signal,
    });

    const firstResultMs = Math.max(0, now() - requestStartMs);

    if (!response.ok) {
      const code = classifyGroqHttpStatus(response.status);
      const telemetry = baseTelemetry();
      telemetry.firstResultMs = firstResultMs;
      telemetry.failureReason = code;
      telemetry.httpStatus = response.status;
      return {
        ok: false,
        code,
        httpStatus: response.status,
        telemetry,
        message: GROQ_ASR_ERROR_MESSAGES[code],
      };
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return fail("malformed", response.status);
    }

    const parsed = parseGroqTranscriptionResponse(raw);
    const totalMs = Math.max(0, now() - requestStartMs);

    if (!parsed.ok) {
      const code = parsed.errorCode ?? "malformed";
      const telemetry = baseTelemetry();
      telemetry.firstResultMs = firstResultMs;
      telemetry.totalMs = totalMs;
      telemetry.httpStatus = response.status;
      telemetry.failureReason = code;
      return {
        ok: false,
        code,
        httpStatus: response.status,
        telemetry,
        message: GROQ_ASR_ERROR_MESSAGES[code],
      };
    }

    const audioSeconds =
      parsed.audioSeconds > 0 ? parsed.audioSeconds : audioSecondsFallback;
    const result: GroqAsrResult = {
      provider: "groq",
      model,
      text: parsed.text,
      audioSeconds,
      latencyMs: totalMs,
      firstResultMs,
      segments: parsed.segments,
    };
    const telemetry: GroqAsrTelemetry = {
      provider: "groq",
      model,
      audioSeconds,
      requestStartMs,
      firstResultMs,
      totalMs,
      httpStatus: response.status,
      success: true,
      failureReason: null,
      chars: parsed.text.length,
      segmentCount: parsed.segments.length,
    };
    return { ok: true, result, telemetry, httpStatus: response.status };
  } catch (err) {
    if (controller.signal.aborted) return fail("timeout", null);
    return fail("network", null);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One-line telemetry log.
 *
 * Prints counts and latencies ONLY — never the transcript, never the prompt,
 * never the key. The interviewer's words do not belong in a console.
 */
export function formatGroqTelemetryForLog(telemetry: GroqAsrTelemetry): string {
  const ms = (v: number | null) => (v === null ? "-" : `${Math.round(v)}ms`);
  return (
    `[Groq] model=${telemetry.model} http=${telemetry.httpStatus ?? "-"} ` +
    `audio=${telemetry.audioSeconds.toFixed(2)}s first=${ms(telemetry.firstResultMs)} ` +
    `total=${telemetry.totalMs}ms success=${telemetry.success} ` +
    `reason=${telemetry.failureReason ?? "-"} chars=${telemetry.chars} ` +
    `segments=${telemetry.segmentCount}`
  );
}
