/* eslint-disable no-restricted-globals */
/**
 * whisperWorker.ts — Dedicated Web Worker
 *
 * Runs Xenova/whisper-tiny.en entirely in-process via ONNX WebAssembly.
 * Model is quantized int8 → ~39 MB, downloaded once, cached by Electron.
 * Zero API key, zero network calls after first boot.
 */
import { pipeline, env } from "@xenova/transformers";

// Use browser IndexedDB cache — persists across app restarts
env.allowLocalModels = false;
env.useBrowserCache = true;

type Transcriber = Awaited<ReturnType<typeof pipeline>>;
let transcriber: Transcriber | null = null;

async function loadModel(): Promise<void> {
  if (transcriber) return;

  self.postMessage({ type: "status", message: "Downloading Whisper tiny (~39 MB)…" });

  transcriber = await pipeline(
    "automatic-speech-recognition",
    "Xenova/whisper-tiny.en",
    {
      quantized: true, // int8 → 39 MB instead of 150 MB
      progress_callback: (p: { status: string; loaded: number; total: number }) => {
        if (p.status === "downloading" && p.total) {
          const pct = Math.round((p.loaded / p.total) * 100);
          self.postMessage({ type: "progress", pct });
        }
      },
    },
  );

  self.postMessage({ type: "status", message: "Whisper ready ✓" });
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as
    | { type: "load" }
    | { type: "transcribe"; audioData: Float32Array; id: string };

  if (msg.type === "load") {
    await loadModel();
    return;
  }

  if (msg.type === "transcribe") {
    await loadModel(); // no-op if already loaded
    try {
      const result = (await (transcriber as any)(msg.audioData, {
        language: "english",
        task: "transcribe",
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: false,
      })) as { text: string };

      const text = result.text?.trim() ?? "";
      self.postMessage({ type: "result", id: msg.id, text });
    } catch (err) {
      self.postMessage({ type: "error", id: msg.id, error: String(err) });
    }
  }
};
