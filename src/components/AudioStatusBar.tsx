import React, { useEffect, useRef, useSyncExternalStore } from "react";
import {
  getAudioLevel,
  getAudioStatusSnapshot,
  subscribeAudioStatus,
  type AudioStatusState,
} from "../lib/audioStatus";

/**
 * Compact live status for the interviewer (system-loopback) audio path.
 *
 * ── Rendering strategy ──────────────────────────────────────────────────────
 * The TEXT state comes from `useSyncExternalStore`, so the component re-renders
 * only when the discrete state actually changes (LISTENING → SPEECH → …).
 *
 * The LEVEL BAR is written imperatively from a `requestAnimationFrame` loop:
 * the worklet emits ~20 samples/second, and each one calls
 * `pushAudioLevel()`. Routing those through React state would re-render the
 * overlay 20×/second for no reason. Instead the rAF loop reads the current
 * value and sets `style.width` directly on the bar — the React tree is never
 * touched.
 *
 * The signal shown is the RMS of the SAME system-audio stream the VAD segments
 * and Moonshine decodes. It is never the microphone: the mic is not part of the
 * interviewer path, so showing it would be misleading.
 */

interface Presentation {
  label: string;
  dot: string;
  text: string;
  /** Meter colour — green when healthy, amber when quiet, red when broken. */
  tone: string;
  showMeter: boolean;
}

function present(state: AudioStatusState): Presentation {
  switch (state) {
    case "speech":
      return {
        label: "Speech detected",
        dot: "bg-emerald-400",
        text: "text-emerald-300/90",
        tone: "bg-emerald-400/80",
        showMeter: true,
      };
    case "transcribing":
      return {
        label: "Transcribing",
        dot: "bg-sky-400 animate-pulse",
        text: "text-sky-300/90",
        tone: "bg-sky-400/80",
        showMeter: true,
      };
    case "listening":
      return {
        label: "Listening",
        dot: "bg-emerald-500/70",
        text: "text-white/60",
        tone: "bg-emerald-500/70",
        showMeter: true,
      };
    case "no-audio":
      return {
        label: "No audio",
        dot: "bg-amber-400",
        text: "text-amber-200/90",
        tone: "bg-amber-400/70",
        showMeter: true,
      };
    case "disconnected":
      return {
        label: "Audio disconnected",
        dot: "bg-rose-500",
        text: "text-rose-300/90",
        tone: "bg-rose-500/50",
        showMeter: false,
      };
    case "error":
      return {
        label: "Audio error",
        dot: "bg-rose-500",
        text: "text-rose-300/90",
        tone: "bg-rose-500/50",
        showMeter: false,
      };
    case "idle":
    default:
      return {
        label: "Idle",
        dot: "bg-white/25",
        text: "text-white/35",
        tone: "bg-white/25",
        showMeter: false,
      };
  }
}

export const AudioStatusBar: React.FC = () => {
  const snapshot = useSyncExternalStore(
    subscribeAudioStatus,
    getAudioStatusSnapshot,
  );

  const barRef = useRef<HTMLDivElement | null>(null);
  const pctRef = useRef<HTMLSpanElement | null>(null);

  // Imperative meter — runs only while mounted, never triggers a render.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const level = getAudioLevel();
      if (barRef.current) {
        barRef.current.style.width = `${Math.round(level)}%`;
      }
      if (pctRef.current) {
        pctRef.current.textContent = `${Math.round(level)}%`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const p = present(snapshot.state);

  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.06] text-[10px] font-mono"
      title={
        snapshot.detail
          ? `${snapshot.state}: ${snapshot.detail}`
          : `system loopback audio — ${snapshot.state}`
      }
    >
      <span className={`w-1.5 h-1.5 rounded-full flex-none ${p.dot}`} />
      <span className={p.text}>{p.label}</span>

      {p.showMeter && (
        <>
          <div className="w-16 h-1 rounded-full bg-white/10 overflow-hidden flex-none">
            <div
              ref={barRef}
              className={`h-full rounded-full ${p.tone} transition-[width] duration-75 ease-out`}
              style={{ width: "0%" }}
            />
          </div>
          <span ref={pctRef} className="text-white/25 tabular-nums w-8 text-right">
            0%
          </span>
        </>
      )}
    </div>
  );
};