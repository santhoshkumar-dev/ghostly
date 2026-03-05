import { useRef, useCallback, useEffect } from "react";
import { useStore } from "../store/useStore";

/** Whisper expects 16 kHz mono PCM */
const SAMPLE_RATE = 16_000;

/** How often (ms) we flush audio chunks to Whisper for transcription */
const FLUSH_INTERVAL_MS = 5_000;

/** Minimum blob size (bytes) to bother sending — skip silence */
const MIN_BLOB_BYTES = 2_000;

export function useTranscription() {
  const { appendToTranscript, setIsInterviewActive, setIsTranscribing, setWhisperStatus } =
    useStore();

  const workerRef    = useRef<Worker | null>(null);
  const recorderRef  = useRef<MediaRecorder | null>(null);
  const chunksRef    = useRef<Blob[]>([]);
  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Boot Whisper worker once on mount ───────────────────────────────────
  useEffect(() => {
    const worker = new Worker(
      new URL("../lib/whisperWorker.ts", import.meta.url),
      { type: "module" },
    );

    worker.onmessage = (e) => {
      const msg = e.data;
      switch (msg.type) {
        case "result":
          if (msg.text) appendToTranscript(msg.text + " ");
          break;
        case "status":
          console.log("[Whisper]", msg.message);
          setWhisperStatus(msg.message);
          break;
        case "progress":
          console.log(`[Whisper] Download: ${msg.pct}%`);
          setWhisperStatus(`Downloading model… ${msg.pct}%`);
          break;
        case "error":
          console.warn("[Whisper] transcribe error:", msg.error);
          break;
      }
    };

    // Pre-warm — loads + caches model in background immediately
    worker.postMessage({ type: "load" });
    workerRef.current = worker;

    return () => {
      worker.terminate();
    };
  }, []);

  // ─── Decode blob → Float32 PCM → send to worker ──────────────────────────
  const flushChunk = useCallback(
    async (blob: Blob): Promise<void> => {
      const worker = workerRef.current;
      if (!worker || blob.size < MIN_BLOB_BYTES) return;

      let audioCtx: AudioContext | null = null;
      try {
        const buf = await blob.arrayBuffer();
        audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
        const decoded = await audioCtx.decodeAudioData(buf);
        // Mix down to mono — use channel 0
        const float32 = decoded.getChannelData(0);

        // Transfer the buffer (zero-copy) to the worker
        worker.postMessage(
          { type: "transcribe", audioData: float32, id: crypto.randomUUID() },
          [float32.buffer],
        );
      } catch {
        // Silence blobs or WebM header-only — silently ignore
      } finally {
        audioCtx?.close();
      }
    },
    [],
  );

  // ─── Start mic recording ──────────────────────────────────────────────────
  const startTranscription = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      // Collect small pieces continuously
      const rec = new MediaRecorder(stream, {
        mimeType: "audio/webm;codecs=opus",
      });

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      rec.start(500); // fire ondataavailable every 500 ms
      recorderRef.current = rec;

      // Every FLUSH_INTERVAL_MS, bundle accumulated blobs → Whisper
      timerRef.current = setInterval(() => {
        const blobs = chunksRef.current.splice(0);
        if (!blobs.length) return;
        flushChunk(new Blob(blobs, { type: "audio/webm" }));
      }, FLUSH_INTERVAL_MS);

      setIsInterviewActive(true);
      setIsTranscribing(true);
      console.log("[Transcription] Started — listening every", FLUSH_INTERVAL_MS, "ms");
    } catch (err) {
      console.error("[Transcription] Mic access denied:", err);
    }
  }, [flushChunk, setIsInterviewActive, setIsTranscribing]);

  // ─── Stop recording ───────────────────────────────────────────────────────
  const stopTranscription = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (recorderRef.current) {
      recorderRef.current.stream.getTracks().forEach((t) => t.stop());
      recorderRef.current.stop();
      recorderRef.current = null;
    }
    chunksRef.current = [];
    setIsInterviewActive(false);
    setIsTranscribing(false);
    console.log("[Transcription] Stopped");
  }, [setIsInterviewActive, setIsTranscribing]);

  return { startTranscription, stopTranscription };
}
