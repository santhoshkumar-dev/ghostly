import React, { useRef, useEffect } from "react";
import { useStore } from "../store/useStore";

interface TranscriptBarProps {
  onStart: () => void;
  onStop: () => void;
}

export const TranscriptBar: React.FC<TranscriptBarProps> = ({ onStart, onStop }) => {
  const {
    isInterviewActive,
    isTranscribing,
    transcript,
    whisperStatus,
    clearTranscript,
  } = useStore();

  const endRef = useRef<HTMLDivElement>(null);

  // Auto-scroll transcript to latest text
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  const wordCount = transcript.split(" ").filter(Boolean).length;

  return (
    <div
      className="rounded-xl pointer-events-auto"
      style={{
        background: "rgba(14, 14, 18, 0.92)",
        border: `1px solid ${
          isInterviewActive
            ? "rgba(74, 222, 128, 0.25)"
            : "rgba(255,255,255,0.06)"
        }`,
        transition: "border-color 0.3s ease",
      }}
      onMouseEnter={() => window.ghostly.enableMouse()}
      onMouseLeave={() => window.ghostly.disableMouse()}
    >
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.05]">
        <div className="flex items-center gap-2">
          {/* Pulsing green dot when live */}
          {isInterviewActive && (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
            </span>
          )}

          <span className="text-[10px] font-mono text-white/50">
            {isInterviewActive ? "🎙 LIVE" : "🎙 INTERVIEW"}
          </span>

          {/* Word count badge */}
          {transcript && (
            <span className="text-[9px] text-white/25 font-mono">
              {wordCount}w
            </span>
          )}

          {/* Whisper model status (shown when idle/downloading) */}
          {!isInterviewActive && whisperStatus && whisperStatus !== "idle" && (
            <span className="text-[9px] text-white/20 font-mono truncate max-w-[160px]">
              {whisperStatus}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {transcript && (
            <button
              onClick={clearTranscript}
              className="text-[9px] font-mono text-white/25 hover:text-white/50 transition-colors"
            >
              clear
            </button>
          )}

          {/* Start / Stop button */}
          <button
            onClick={isInterviewActive ? onStop : onStart}
            className={`text-[10px] font-mono px-2 py-0.5 rounded-md transition-all ${
              isInterviewActive
                ? "bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30"
                : "bg-green-500/15 text-green-400 hover:bg-green-500/25 border border-green-500/25"
            }`}
          >
            {isInterviewActive ? "⏹ Stop" : "▶ Start Interview"}
          </button>
        </div>
      </div>

      {/* ── Transcript text ─────────────────────────────────────────── */}
      {(isInterviewActive || transcript) && (
        <div className="px-3 py-2 max-h-[80px] overflow-y-auto">
          {transcript ? (
            <p className="text-[10px] font-mono text-white/60 leading-relaxed whitespace-pre-wrap">
              {transcript}
            </p>
          ) : (
            <p className="text-[10px] font-mono text-white/20 italic">
              {isTranscribing ? "Listening…" : "Starting mic…"}
            </p>
          )}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
};
