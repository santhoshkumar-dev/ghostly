import { ipcMain } from "electron";
import {
  transcribeWithGroq,
  DEFAULT_GROQ_ASR_MODEL,
  GROQ_ASR_LANGUAGE,
  type GroqAsrOutcome,
} from "../src/lib/groqWhisper";

/**
 * Groq Whisper credential + request handling — MAIN PROCESS ONLY.
 *
 * ── Why the key lives here and nowhere else ────────────────────────────────
 * The long-lived Groq ASR key must never be reachable from the renderer. The
 * renderer is a normal web context with a DevTools console, so anything it can
 * read it can leak. Unlike Deepgram (which needs a short-lived token because a
 * browser WebSocket cannot set an Authorization header), Groq is a plain HTTP
 * multipart POST — so the whole request is done in the main process and the
 * key never crosses the IPC boundary at all. The renderer only ever sends the
 * captured WAV bytes and receives a normalised transcript.
 *
 * ── Storage isolation ─────────────────────────────────────────────────────
 * The key is stored under a TOP-LEVEL store key (`groqAsrKey`), deliberately
 * NOT nested inside `settings`. The renderer persists the whole `settings`
 * object on every change; if the key lived inside it, a normal settings save
 * would round-trip the secret through the renderer. A separate top-level key
 * keeps it out of every renderer read/write path.
 */

export function readGroqAsrKey(store: {
  get: (key: string) => unknown;
}): string {
  const key = store.get("groqAsrKey");
  return typeof key === "string" ? key.trim() : "";
}

/** Coerce an IPC-supplied buffer into bytes without trusting its shape. */
function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}

export interface GroqTranscribePayload {
  wav?: unknown;
  model?: unknown;
  language?: unknown;
  prompt?: unknown;
}

export function registerGroqAsrHandlers(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  // has-key reduces the secret to a boolean so the renderer can grey out the
  // comparison toggle without ever holding the key.
  ipcMain.handle("groq:has-key", () => readGroqAsrKey(store).length > 0);

  // Store / clear the key directly in the main process. Never returns it.
  ipcMain.handle("groq:set-key", (_event, value: unknown) => {
    const key = typeof value === "string" ? value.trim() : "";
    store.set("groqAsrKey", key);
    return { ok: true as const, configured: key.length > 0 };
  });

  ipcMain.handle(
    "groq:transcribe",
    async (_event, payload: GroqTranscribePayload): Promise<GroqAsrOutcome> => {
      const apiKey = readGroqAsrKey(store);
      const bytes = toBytes(payload?.wav);
      if (!apiKey) {
        // Construct the failure through the shared helper so the code/message
        // stay consistent with the rest of the pipeline.
        return await transcribeWithGroq({
          apiKey: "",
          audio: new Blob([], { type: "audio/wav" }),
        });
      }
      if (!bytes || bytes.byteLength === 0) {
        return await transcribeWithGroq({
          apiKey,
          audio: new Blob([], { type: "audio/wav" }),
          audioBytes: 0,
        });
      }

      const model =
        typeof payload.model === "string" && payload.model.trim()
          ? payload.model.trim()
          : DEFAULT_GROQ_ASR_MODEL;
      const language =
        typeof payload.language === "string" && payload.language.trim()
          ? payload.language.trim()
          : GROQ_ASR_LANGUAGE;
      const prompt = typeof payload.prompt === "string" ? payload.prompt : "";

      // `Uint8Array<ArrayBufferLike>` is not assignable to `BlobPart` under
      // TS 5.7's typed-array generics; the buffer is always a real ArrayBuffer.
      const audio = new Blob([bytes as unknown as BlobPart], {
        type: "audio/wav",
      });
      const outcome = await transcribeWithGroq({
        apiKey,
        audio,
        audioBytes: bytes.byteLength,
        model,
        language,
        prompt,
      });

      // Fixed, non-leaking line: status/latency/counts only.
      console.log(
        `[Groq] transcribe http=${outcome.telemetry.httpStatus ?? "-"} ` +
          `success=${outcome.ok} total=${outcome.telemetry.totalMs}ms ` +
          `chars=${outcome.telemetry.chars} reason=${outcome.telemetry.failureReason ?? "-"}`,
      );
      return outcome;
    },
  );
}
