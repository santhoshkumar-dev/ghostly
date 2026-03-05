import { pipeline, env } from '@xenova/transformers';

// Disable local models, fetch from HuggingFace CDN on first run, then cache
env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber: any = null;

const log = (msg: string) => postMessage({ type: 'log', message: `[Worker] ${msg}` });

self.addEventListener('message', async (e) => {
  const { type, audio, source, audioUrl } = e.data;

  if (type === 'load') {
    if (!transcriber) {
      log('Loading Whisper Tiny model...');
      const start = performance.now();
      try {
        transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
        log(`Model loaded in ${((performance.now() - start) / 1000).toFixed(1)}s`);
        postMessage({ type: 'ready' });
      } catch (err) {
        log(`Failed to load model: ${err}`);
      }
    } else {
      postMessage({ type: 'ready' });
    }
  }

  if (type === 'transcribe') {
    if (!transcriber) return;
    
    const start = performance.now();
    try {
      log(`Received audio array length: ${audio.length} for ${source}`);

      // CRITICAL FIX: Ensure the array is strictly a flat Float32Array
      // Sometimes postMessage strips the Float32Array prototype, turning it into a normal object/array
      const float32Audio = audio instanceof Float32Array ? audio : new Float32Array(Object.values(audio));

      // According to Transformers.js docs, simple invocation is best
      const result = await transcriber(float32Audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        language: 'english',
        task: 'transcribe',
      });
      
      const time = ((performance.now() - start) / 1000).toFixed(2);
      log(`Transcribed ${source} in ${time}s`);
      
      // Transformers.js Whisper can sometimes return an array of objects depending on the pipeline config
      let text = "";
      if (Array.isArray(result)) {
        text = result.map(r => r.text).join(" ");
      } else if (result && result.text) {
        text = result.text;
      }
      
      text = text.trim();
      log(`Raw Output: ${JSON.stringify(result)}`);

      if (text.length > 0) {
        postMessage({
          type: 'result',
          source,
          text,
          audioUrl
        });
      } else {
        log(`[WARNING] Text was empty after parsing. Length was ${audio.length}`);
      }
    } catch (err) {
      log(`Transcription error: ${err}`);
    }
  }
});
