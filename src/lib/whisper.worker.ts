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
      // audio is a Float32Array from the AudioContext
      const result = await transcriber(audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        language: 'english',
        task: 'transcribe',
      });
      
      const time = ((performance.now() - start) / 1000).toFixed(2);
      log(`Transcribed ${source} in ${time}s`);
      
      const text = result.text.trim();
      if (text.length > 0) {
        postMessage({
          type: 'result',
          source,
          text,
          audioUrl // pass the debugging audio url back
        });
      }
    } catch (err) {
      log(`Transcription error: ${err}`);
    }
  }
});
