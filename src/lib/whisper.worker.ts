import { pipeline, env } from "@xenova/transformers";

// Disable local models, fetch from HuggingFace CDN on first run, then cache
env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber: any = null;

const log = (msg: string) =>
  postMessage({ type: "log", message: `[Worker] ${msg}` });

let currentModel: string | null = null;

self.addEventListener("message", async (e) => {
  const { type, audio, source, audioUrl, model } = e.data;

  if (type === "load") {
    const requestedModel = model || "Xenova/whisper-base.en";
    // Re-create transcriber if model changed or not yet loaded
    if (!transcriber || currentModel !== requestedModel) {
      transcriber = null;
      currentModel = requestedModel;
      log(`Loading model: ${requestedModel}...`);
      const start = performance.now();
      try {
        transcriber = await pipeline(
          "automatic-speech-recognition",
          requestedModel,
          {
            progress_callback: (p: any) => {
              // Only forward download-type progress (status === "downloading")
              if (p.status === "downloading" || p.status === "progress") {
                postMessage({
                  type: "progress",
                  file: p.file ?? p.name ?? "",
                  loaded: p.loaded ?? 0,
                  total: p.total ?? 0,
                  progress: p.progress ?? 0, // 0-100
                });
              }
            },
          },
        );
        log(
          `Model loaded in ${((performance.now() - start) / 1000).toFixed(1)}s`,
        );
        postMessage({ type: "ready" });
      } catch (err) {
        log(`Failed to load model: ${err}`);
      }
    } else {
      postMessage({ type: "ready" });
    }
  }

  if (type === "transcribe") {
    if (!transcriber) return;

    const start = performance.now();
    try {
      // 1. Ensure audio is a genuine Float32Array.
      // When crossing the Web Worker boundary via postMessage, typed arrays can sometimes lose their prototype.
      const float32Audio =
        audio instanceof Float32Array
          ? audio
          : new Float32Array(Object.values(audio));

      log(`Processing audio of length: ${float32Audio.length}`);

      // 2. Simplified pipeline call as per Transformers.js docs
      const result = await transcriber(float32Audio);

      const time = ((performance.now() - start) / 1000).toFixed(2);
      log(`Transcribed ${source} in ${time}s`);

      // 3. Log raw output to see exact structure
      log(`Raw Output: ${JSON.stringify(result)}`);

      // 4. Safely extract text whether it returns an object or an array of objects
      let text = "";
      if (Array.isArray(result)) {
        text = result.map((r) => r.text).join(" ");
      } else if (result && result.text) {
        text = result.text;
      }

      text = text.trim();

      if (text.length > 0) {
        postMessage({
          type: "result",
          source,
          text,
          audioUrl,
        });
      } else {
        log(`[WARNING] Parsed text was empty!`);
      }
    } catch (err) {
      log(`Transcription error: ${err}`);
    }
  }
});
