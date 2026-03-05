import { useEffect, useRef, useState, useCallback } from "react";

export interface ChatMessage {
  id: string;
  source: "mic" | "system";
  text: string;
  timestamp: number;
}

export function useInterviewAudio() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [isModelReady, setIsModelReady] = useState(false);
  const workerRef = useRef<Worker | null>(null);

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev.slice(-49), `${new Date().toLocaleTimeString()} - ${msg}`]);
  }, []);

  // Worker Initialization
  useEffect(() => {
    workerRef.current = new Worker(new URL("../lib/whisper.worker.ts", import.meta.url), {
      type: "module",
    });

    workerRef.current.onmessage = (e) => {
      const { type, message, result, source, text } = e.data;
      if (type === "log") addLog(message);
      if (type === "ready") {
        addLog("AI Engine Ready.");
        setIsModelReady(true);
      }
      if (type === "result" && text) {
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), source, text, timestamp: Date.now() },
        ]);
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
      const audioCtx = new AudioContext({ sampleRate: 16000 });

      // 1. Get System Audio (Interviewer)
      const sources = await window.ghostly.getDesktopSources();
      const screenSource = sources.find((s) => s.name === "Entire Screen" || s.name.includes("Screen")) || sources[0];
      
      let sysStream: MediaStream | null = null;
      try {
        sysStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: screenSource.id },
          } as any,
          video: false,
        });
        const sysSource = audioCtx.createMediaStreamSource(sysStream);
        setupVAD(audioCtx, sysSource, "system", workerRef, addLog);
        addLog("System audio capture started.");
      } catch (err) {
        addLog(`Warning: System audio capture failed (${err}). Continuing with mic only.`);
      }

      // 2. Get Mic Audio with HARDWARE NOISE CANCELLATION
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });

      // 3. Apply WEB AUDIO API NOISE FILTERS to Mic
      const micSource = audioCtx.createMediaStreamSource(micStream);
      
      // High-pass: cuts rumbling fan/AC noise below 80Hz
      const highpass = audioCtx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 80;

      // Low-pass: cuts high-pitched hissing above 8000Hz
      const lowpass = audioCtx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = 8000;

      micSource.connect(highpass);
      highpass.connect(lowpass);

      // 4. Setup Voice Activity Detection (VAD) processor for Mic
      setupVAD(audioCtx, lowpass, "mic", workerRef, addLog);
      addLog("Mic capture started with noise filters.");

      // Keep streams in a ref so we can stop them later
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
      if (streams[0]) streams[0].getTracks().forEach((t: any) => t.stop()); // Mic
      if (streams[1]) streams[1].getTracks().forEach((t: any) => t.stop()); // Sys
      if (streams[2]) streams[2].close(); // AudioContext
      (window as any)._interviewStreams = null;
    }
  };

  return { messages, isRecording, logs, isModelReady, startInterview, stopInterview };
}

// Voice Activity Detector (VAD) Helper
function setupVAD(
  audioCtx: AudioContext,
  sourceNode: AudioNode,
  sourceName: "mic" | "system",
  workerRef: React.MutableRefObject<Worker | null>,
  addLog: (msg: string) => void
) {
  // Processor size: 4096 frames = ~250ms chunks at 16kHz
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  sourceNode.connect(processor);
  processor.connect(audioCtx.destination);

  let audioBuffer: Float32Array[] = [];
  let silenceFrames = 0;
  const SILENCE_THRESHOLD = 0.01; // Adjust this if fan noise still triggers it
  const MAX_SILENCE_FRAMES = 4; // ~1 second of silence triggers the transcription

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    
    // Calculate volume energy of this chunk
    let sum = 0;
    for (let i = 0; i < input.length; i++) {
      sum += input[i] * input[i];
    }
    const rms = Math.sqrt(sum / input.length);

    if (rms > SILENCE_THRESHOLD) {
      // Speaking
      silenceFrames = 0;
      audioBuffer.push(new Float32Array(input));
    } else {
      // Silence
      if (audioBuffer.length > 0) {
        silenceFrames++;
        if (silenceFrames >= MAX_SILENCE_FRAMES) {
          // Flatten array and send to worker
          const totalLength = audioBuffer.reduce((acc, val) => acc + val.length, 0);
          const merged = new Float32Array(totalLength);
          let offset = 0;
          for (const buffer of audioBuffer) {
            merged.set(buffer, offset);
            offset += buffer.length;
          }
          
          addLog(`Captured ${sourceName} speech (${(totalLength/16000).toFixed(1)}s)`);
          workerRef.current?.postMessage({
            type: "transcribe",
            audio: merged,
            source: sourceName
          });
          
          audioBuffer = []; // reset
          silenceFrames = 0;
        }
      }
    }
  };
}
