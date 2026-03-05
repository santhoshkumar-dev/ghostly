import { useEffect, useRef, useState, useCallback } from "react";

export interface ChatMessage {
  id: string;
  source: "mic" | "system";
  text: string;
  timestamp: number;
  audioUrl?: string; // For debugging playback
}

export function useInterviewAudio() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [isModelReady, setIsModelReady] = useState(false);
  
  // We'll store debug audio blobs in logs too, so if text fails, you still get the audio
  const [debugAudios, setDebugAudios] = useState<{name: string, url: string}[]>([]);
  
  const workerRef = useRef<Worker | null>(null);

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev.slice(-49), `${new Date().toLocaleTimeString()} - ${msg}`]);
  }, []);

  const addDebugAudio = useCallback((name: string, url: string) => {
    setDebugAudios(prev => [...prev.slice(-9), {name, url}]);
  }, []);

  // Worker Initialization
  useEffect(() => {
    workerRef.current = new Worker(new URL("../lib/whisper.worker.ts", import.meta.url), {
      type: "module",
    });

    workerRef.current.onmessage = (e) => {
      const { type, message, result, source, text, audioUrl } = e.data;
      if (type === "log") addLog(message);
      if (type === "ready") {
        addLog("AI Engine Ready.");
        setIsModelReady(true);
      }
      if (type === "result") {
        if (text) {
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), source, text, timestamp: Date.now(), audioUrl },
          ]);
        } else {
          addLog(`[WARNING] Whisper returned empty text for ${source}`);
        }
      }
    };

    workerRef.current.postMessage({ type: "load" });

    return () => workerRef.current?.terminate();
  }, [addLog]);

  const startInterview = async () => {
    if (!isModelReady) {
      addLog("Cannot start: AI Model not ready yet.");
      return;
    }
    
    setIsRecording(true);
    addLog("Starting Audio Capture...");

    try {
      const audioCtx = new window.AudioContext(); 

      // 1. System Audio (Interviewer)
      const sources = await window.ghostly.getDesktopSources();
      const screenSource = sources.find((s) => s.name === "Entire Screen" || s.name.includes("Screen")) || sources[0];
      
      let sysStream: MediaStream | null = null;
      if (screenSource) {
        try {
          sysStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: screenSource.id },
            } as any,
            video: {
              mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: screenSource.id },
            } as any,
          });
          
          sysStream.getVideoTracks().forEach(track => track.stop());

          const sysSource = audioCtx.createMediaStreamSource(sysStream);
          // Don't apply Biquad filters yet to avoid potential silent node chains
          setupVAD(audioCtx, sysSource, "system", workerRef, addLog, addDebugAudio);
          addLog("System audio capture started.");
        } catch (err) {
          addLog(`Warning: System audio capture failed (${err}).`);
        }
      }

      // 2. Mic Audio
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });

      const micSource = audioCtx.createMediaStreamSource(micStream);
      
      // NOTE: Temporarily removed BiquadFilters because they can sometimes 
      // output absolute silence (0.0 arrays) if initialized incorrectly in Chromium
      setupVAD(audioCtx, micSource, "mic", workerRef, addLog, addDebugAudio);
      addLog("Mic capture started.");

      (window as any)._interviewStreams = [micStream, sysStream, audioCtx];

    } catch (err) {
      addLog(`Failed to start audio: ${err}`);
      setIsRecording(false);
    }
  };

  const stopInterview = () => {
    setIsRecording(false);
    addLog("Stopped Interview.");
    const streams = (window as any)._interviewStreams;
    if (streams) {
      if (streams[0]) streams[0].getTracks().forEach((t: any) => t.stop()); 
      if (streams[1]) streams[1].getTracks().forEach((t: any) => t.stop()); 
      if (streams[2]) streams[2].close(); 
      (window as any)._interviewStreams = null;
    }
  };

  return { messages, isRecording, logs, debugAudios, isModelReady, startInterview, stopInterview };
}

// Resample
function resampleAudio(audioBuffer: Float32Array, originalSampleRate: number, targetSampleRate = 16000): Float32Array {
  if (originalSampleRate === targetSampleRate) return audioBuffer;
  const ratio = originalSampleRate / targetSampleRate;
  const newLength = Math.round(audioBuffer.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    result[i] = audioBuffer[Math.floor(i * ratio)];
  }
  return result;
}

// Float32 to WAV
function float32ToWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (view: DataView, offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); 
  view.setUint16(22, 1, true); 
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); 
  view.setUint16(32, 2, true); 
  view.setUint16(34, 16, true); 
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return new Blob([view], { type: 'audio/wav' });
}

// VAD
function setupVAD(
  audioCtx: AudioContext,
  sourceNode: AudioNode,
  sourceName: "mic" | "system",
  workerRef: React.MutableRefObject<Worker | null>,
  addLog: (msg: string) => void,
  addDebugAudio: (name: string, url: string) => void
) {
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  
  // CRITICAL: In Electron/Chrome, if a ScriptProcessor isn't connected to the destination, 
  // the 'onaudioprocess' event might completely stop firing or output zeroed arrays.
  sourceNode.connect(processor);
  processor.connect(audioCtx.destination);

  let audioBuffer: Float32Array[] = [];
  let silenceFrames = 0;
  
  const SILENCE_THRESHOLD = 0.005; 
  const MAX_SILENCE_FRAMES = 5; // ~1.25 seconds of silence

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    
    let sum = 0;
    for (let i = 0; i < input.length; i++) {
      sum += input[i] * input[i];
    }
    
    const rms = Math.sqrt(sum / input.length);

    if (rms > SILENCE_THRESHOLD) {
      silenceFrames = 0;
      audioBuffer.push(new Float32Array(input));
    } else {
      if (audioBuffer.length > 0) {
        silenceFrames++;
        if (silenceFrames >= MAX_SILENCE_FRAMES) {
          
          const totalLength = audioBuffer.reduce((acc, val) => acc + val.length, 0);
          const merged = new Float32Array(totalLength);
          let offset = 0;
          for (const buffer of audioBuffer) {
            merged.set(buffer, offset);
            offset += buffer.length;
          }
          
          const durationSeconds = totalLength / audioCtx.sampleRate;
          if (durationSeconds > 0.5) {
            const downsampled = resampleAudio(merged, audioCtx.sampleRate, 16000);
            
            const wavBlob = float32ToWav(downsampled, 16000);
            const audioUrl = URL.createObjectURL(wavBlob);
            
            const debugName = `${sourceName} - ${durationSeconds.toFixed(1)}s`;
            addDebugAudio(debugName, audioUrl);
            addLog(`Captured ${debugName}, sending to AI...`);
            
            // CRITICAL FIX: To prevent the array from being flattened into an object by postMessage,
            // we must pass the Float32Array's underlying buffer, and specify it in the transfer list.
            workerRef.current?.postMessage({
              type: "transcribe",
              audio: downsampled, // Transformers.js can ingest this directly if properly typed
              source: sourceName,
              audioUrl
            });
          }
          
          audioBuffer = [];
          silenceFrames = 0;
        }
      }
    }
  };
}
