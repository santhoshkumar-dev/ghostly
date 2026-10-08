/**
 * The renderer-side Groq Whisper comparison client.
 *
 * ── No credential here ─────────────────────────────────────────────────────
 * This file NEVER holds or reads the Groq ASR key. It turns the captured 16 kHz
 * segment into WAV bytes, hands them to the main process
 * (`window.ghostly.groqTranscribe`), and receives a normalised transcript. The
 * long-lived key stays in the main process; see `electron/groqAsr.ts`.
 *
 * ── Fire-and-forget ────────────────────────────────────────────────────────
 * Every failure path is reported through `onError` and never throws into the
 * caller's audio path, because this is a diagnostic and must never be able to
 * break the default Moonshine workflow.
 */

import {
  DEFAULT_GROQ_ASR_MODEL,
  GROQ_ASR_LANGUAGE,
  buildGroqAsrPrompt,
  type GroqAsrResult,
  type GroqAsrTelemetry,
} from "./groqWhisper";
import { float32ToWavWithClipping } from "./debugWav";

export interface GroqComparisonOptions {
  /** Whisper model id. Defaults to whisper-large-v3. */
  model?: string;
  /** Bounded technical terms for the context prompt (never a whitelist). */
  promptTerms?: string[];
}

export interface GroqComparisonCallbacks {
  onResult: (result: GroqAsrResult, telemetry: GroqAsrTelemetry) => void;
  onError: (message: string) => void;
}

type GroqIpcResult =
  | { ok: true; result: GroqAsrResult; telemetry: GroqAsrTelemetry; httpStatus: number }
  | {
      ok: false;
      code: string;
      httpStatus: number | null;
      telemetry: GroqAsrTelemetry;
      message: string;
    };

/**
 * Transcribe one already-captured segment with Groq Whisper.
 *
 * The audio is the SAME `Float32Array` Moonshine received, so all engines are
 * compared on identical audio. Not awaited by callers: it must never delay the
 * local engine.
 */
export async function runGroqWhisperComparison(
  audio: Float32Array,
  options: GroqComparisonOptions,
  callbacks: GroqComparisonCallbacks,
): Promise<void> {
  if (typeof window === "undefined" || !window.ghostly?.groqTranscribe) {
    callbacks.onError("Groq bridge unavailable.");
    return;
  }
  if (audio.length === 0) {
    callbacks.onError("Empty segment.");
    return;
  }

  let wav: ArrayBuffer;
  try {
    const { blob } = float32ToWavWithClipping(audio, 16000);
    wav = await blob.arrayBuffer();
  } catch {
    callbacks.onError("Could not encode the captured segment.");
    return;
  }

  let response: GroqIpcResult;
  try {
    response = (await window.ghostly.groqTranscribe({
      wav,
      model: options.model ?? DEFAULT_GROQ_ASR_MODEL,
      language: GROQ_ASR_LANGUAGE,
      prompt: buildGroqAsrPrompt(options.promptTerms ?? []),
    })) as GroqIpcResult;
  } catch {
    callbacks.onError("Groq transcription failed.");
    return;
  }

  if (!response || typeof response !== "object") {
    callbacks.onError("Groq returned an unexpected response.");
    return;
  }
  if (!response.ok) {
    callbacks.onError(response.message || "Groq transcription failed.");
    return;
  }
  callbacks.onResult(response.result, response.telemetry);
}
