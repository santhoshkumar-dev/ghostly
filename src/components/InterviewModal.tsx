import React, { useState, useEffect, useRef, useMemo } from "react";
import { useInterviewAudio } from "../hooks/useInterviewAudio";
import { formatLatencyReport } from "../lib/stageTiming";
import { formatLoadBreakdown } from "../lib/parakeetHost";
import { useStore } from "../store/useStore";
import { gs } from "../lib/overlaySurfaces";
import { getParakeetStatus, type ParakeetStatus } from "../lib/parakeetClient";
import { PARAKEET_PADDING_MS } from "../lib/parakeetHost";
import { serializeAsrComparisonExport } from "../lib/asrComparisonExport";
import {
  debugClipFileName,
  describeSessionFolder,
  sessionFolderName,
} from "../lib/debugClipSave";
import type { InterviewTurn } from "../lib/interviewAgent";

interface InterviewModalProps {
  onClose: () => void;
  /**
   * Hands the *structured* turn to the answering agent: committed utterances
   * (what the interviewer finished saying) plus the in-progress line. The agent
   * decides which of those is a complete question.
   *
   * Optional candidate-signal and transcript-clear flags are forwarded to the
   * host so the same handler drives voice, manual text and candidate correction.
   */
  onSubmit: (
    turn: InterviewTurn,
    candidateSignal?: { text: string; timestamp?: number },
    clearTranscript?: boolean,
  ) => void;
  /** Collapsed = one bar. Capture keeps running, the answer gets the space. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export const InterviewModal: React.FC<InterviewModalProps> = ({
  onClose,
  onSubmit,
  collapsed = false,
  onToggleCollapse,
}) => {
  const {
    messages,
    interim,
    isRecording,
    logs,
    addLog,
    debugAudios,
    debugWavOn,
    setDebugWav,
    isModelReady,
    downloadProgress,
    startInterview,
    stopInterview,
    primaryAsr,
    parakeetStatus,
    parakeetMessage,
    parakeetBreakdown,
    parakeetUiState,
    parakeetUiMessage,
    downloadParakeet,
    useMoonshineEngine,
    fallbackNotice,
    retryParakeet,
  } = useInterviewAudio();
  const [showLogs, setShowLogs] = useState(false);
  // ── Latency report ──────────────────────────────────────────────────────
  // Derived, never stateful: the store owns the records and this recomputes the
  // text from them, so the report cannot drift out of sync with the data.
  const latencyTurns = useStore((s) => s.latencyTurns);
  const clearLatencyTurns = useStore((s) => s.clearLatencyTurns);
  const latencyReport = useMemo(
    () => formatLatencyReport(latencyTurns),
    [latencyTurns],
  );
  // Developer-only engine comparison, read straight from the store.
  const asrComparisons = useStore((s) => s.asrComparisons);
  const asrCompareParakeet = useStore((s) => s.settings.asrCompareParakeet);
  const asrCompareMode = useStore((s) => s.settings.asrCompareMode);
  const asrCompareGroq = useStore((s) => s.settings.asrCompareGroq);
  // ── Cloud-audio indicator ────────────────────────────────────────────────
  // Deepgram and Groq Whisper comparison send the RAW AUDIO off the machine.
  // Both are off by default and additionally hard-blocked outside DEV, so this
  // can only ever be true in a development build the user explicitly
  // configured. It is still worth stating on screen: "your microphone audio is
  // being uploaded to a third party right now" is not something anyone should
  // have to infer from a dev-only checkbox.
  const cloudComparisonEngines = useMemo(() => {
    const names: string[] = [];
    if (import.meta.env.DEV && asrCompareMode) names.push("Deepgram");
    if (import.meta.env.DEV && asrCompareGroq) names.push("Groq Whisper");
    return names;
  }, [asrCompareMode, asrCompareGroq]);
  const updateSettings = useStore((s) => s.updateSettings);
  const [parakeetPaddingMs, setParakeetPaddingMs] = useState(
    () => useStore.getState().settings.parakeetPaddingMs ?? PARAKEET_PADDING_MS,
  );
  // Comparison-mode model status. Polled only while the dev comparison is on:
  // the model loads on Start and unloads on Stop, so a slow poll is enough to
  // show "loading" rather than a stale "ready".
  //
  // Named apart from the hook's `parakeetStatus` on purpose: this one describes
  // the COMPARISON column, that one describes the engine that is actually
  // transcribing. Merging them would let a healthy comparison column make a
  // broken primary engine look fine.
  const [compareModelStatus, setCompareModelStatus] =
    useState<ParakeetStatus>("disabled");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!import.meta.env.DEV || !asrCompareParakeet) {
      setCompareModelStatus("disabled");
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const status = await getParakeetStatus();
      if (!cancelled) setCompareModelStatus(status);
    };
    void poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [asrCompareParakeet]);

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, interim]);

  // Manual typed question input (compact text field, Send on Enter).
  //
  // This is a MANUAL OVERRIDE / FALLBACK: it does NOT start audio capture,
  // does NOT stop capture, and does NOT touch Moonshine / Deepgram / Groq
  // Whisper. It is fed straight through the existing downstream AI pipeline
  // (`onSubmit` → `runAIStream`) as a manual question.
  const [manualText, setManualText] = useState("");
  // Prevents duplicate submissions from key auto-repeat without any timer.
  const manualSubmittedRef = useRef(false);

  // Handle manual submit
  const handleSubmit = () => {
    // Capture the turn BEFORE stopInterview() clears the interim line.
    const turn: InterviewTurn = {
      finals: messages.map((m) => ({ source: m.source, text: m.text })),
      interim: interim ? { source: interim.source, text: interim.text } : null,
    };
    stopInterview();
    onSubmit(turn);
  };

  /**
 * The transcript writer, bound at the TOP of the component.
 *
 * ── Why this is not read inside the handler ────────────────────────────────
 * It was: `const addInterviewMessage = useStore(...)` sat inside
 * `handleManualSubmit`, which is an EVENT handler. A hook called from a
 * callback is not "a hook called in the wrong order" — it is not a hook call at
 * all as far as React is concerned, and the real one crashed the renderer with
 * `Minified React error #321` the first time anyone typed a question into this
 * box. The typed-question path was therefore unusable, and it is the only way to
 * exercise the interview answer path without a live microphone.
 *
 * The fix is to bind the selector where every other selector in this file is
 * bound, so the hook count no longer depends on which event fired.
 */
const addInterviewMessage = useStore((s) => s.addInterviewMessage);

  /** Submit a manually typed question as an explicit override. */
  const handleManualSubmit = () => {
    const question = manualText.trim();
    // Empty / whitespace input is ignored.
    if (!question || manualSubmittedRef.current) return;
    manualSubmittedRef.current = true;

    // Preserve the submitted question in history (same store used by the voice
    // path), tagged as a MANUAL question so it renders like a detected question
    // without any audio capture involved.
    addInterviewMessage({
      id: crypto.randomUUID(),
      source: "system",
      text: question,
      timestamp: Date.now(),
    });

    // Build a turn containing ONLY this manual question. Because it is a fresh
    // turn, the old voice text is NOT automatically combined with it.
    // `clearTranscript` is false here: the manual message was already added to
    // the store, and this is an explicit override not a fresh voice session.
    const turn: InterviewTurn = {
      finals: [{ source: "system", text: question }],
      interim: null,
    };
    onSubmit(turn, undefined, false);

    setManualText("");
    manualSubmittedRef.current = false;
  };

  const handleClose = () => {
    stopInterview();
    onClose();
  };

  const lastLine = messages[messages.length - 1]?.text;

  // Collapsed: keep the panel mounted (so audio capture keeps running) but
  // reduce it to a single bar, because the transcript is not what you are
  // reading during an answer.
  if (collapsed) {
    return (
      <div
        className="pointer-events-auto rounded-2xl px-4 py-2 flex items-center justify-between gap-3 w-full"
        style={{
          ...gs("20 20 23", 0.75),
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
        }}
        onMouseEnter={() => window.ghostly.enableMouse()}
        onMouseLeave={() => window.ghostly.disableMouse()}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="relative flex h-2.5 w-2.5 flex-none">
            {isRecording && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            )}
            <span
              className={`relative inline-flex rounded-full h-2.5 w-2.5 ${isRecording ? "bg-red-500" : "bg-white/20"}`}
            />
          </span>
          <span className="text-white/70 font-semibold text-[11px] font-mono flex-none">
            Live Interview
          </span>
          <span className="text-[10px] text-white/30 font-mono truncate">
            {interim?.text
              ? `${interim.text}▍`
              : (lastLine ?? "listening…")}
          </span>
        </div>
        <button
          onClick={onToggleCollapse}
          className="flex-none px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-white/60 text-[10px] font-mono transition-colors"
        >
          Expand ⤢
        </button>
      </div>
    );
  }

  return (
    <div
      className="pointer-events-auto rounded-2xl overflow-hidden flex flex-col transition-all duration-300 w-full"
      style={{
        ...gs("20 20 23", 0.75),
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        boxShadow: "0 10px 40px -10px rgba(0,0,0,0.5)",
      }}
      onMouseEnter={() => window.ghostly.enableMouse()}
      onMouseLeave={() => window.ghostly.disableMouse()}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.05] bg-white/[0.02]">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              {isRecording && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
              )}
              <span
                className={`relative inline-flex rounded-full h-2.5 w-2.5 ${isRecording ? "bg-red-500" : "bg-white/20"}`}
              ></span>
            </span>
            <h2 className="text-white/90 font-semibold text-xs font-mono">
              Live Interview
            </h2>
          </div>
          <span className="text-white/30 text-[10px] font-mono hidden sm:inline">
            | System audio (Interviewer only)
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleCollapse}
            title="Collapse — keeps listening, gives the answer more room"
            className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-white/60 text-[10px] transition-colors"
          >
            Collapse ⤡
          </button>
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-white/60 text-[10px] transition-colors"
          >
            {showLogs ? "Hide Debug" : "Debug"}
          </button>
          <button
            onClick={handleClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-red-500/20 hover:text-red-400 text-white/60 transition-colors text-xs"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Download Progress Bar */}
      {!isModelReady && (
        <div className="px-4 py-2.5 border-b border-white/[0.05] bg-black/20">
          {downloadProgress !== null ? (
            <>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] text-white/50 font-mono">
                  Downloading model...
                </span>
                <span className="text-[10px] text-white/70 font-mono tabular-nums">
                  {downloadProgress}%
                </span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${downloadProgress}%`,
                    background:
                      "linear-gradient(90deg, #6366f1, #8b5cf6, #a78bfa)",
                    boxShadow: "0 0 8px rgba(139, 92, 246, 0.6)",
                  }}
                />
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex gap-0.5">
                <span
                  className="w-1 h-1 rounded-full bg-white/30 animate-bounce"
                  style={{ animationDelay: "0ms" }}
                />
                <span
                  className="w-1 h-1 rounded-full bg-white/30 animate-bounce"
                  style={{ animationDelay: "150ms" }}
                />
                <span
                  className="w-1 h-1 rounded-full bg-white/30 animate-bounce"
                  style={{ animationDelay: "300ms" }}
                />
              </div>
              <span className="text-[10px] text-white/40 font-mono">
                Initializing AI engine...
              </span>
            </div>
          )}
        </div>
      )}

      {/* Parakeet cannot transcribe — say so, and offer the two real choices.
          Deliberately NOT a disabled "Loading…" caption: an engine that is
          missing, corrupt or failed will never finish loading, so the only
          honest states are the words and the two buttons. Nothing here can
          reach a cloud engine — "Use Moonshine" is local. */}
      {primaryAsr === "parakeet" && parakeetUiMessage && (
        <div className="px-4 py-3 border-b border-amber-400/20 bg-amber-500/[0.06]">
          <p className="text-[10px] font-mono text-amber-200/90 leading-relaxed">
            {parakeetUiMessage}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void downloadParakeet()}
              disabled={parakeetUiState === "downloading"}
              className="px-2 py-1 rounded bg-accent/20 hover:bg-accent/30 disabled:opacity-40 text-accent transition-colors text-[10px] font-mono"
            >
              {parakeetUiState === "downloading"
                ? "Downloading…"
                : "Download model"}
            </button>
            <button
              type="button"
              onClick={useMoonshineEngine}
              className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-white/70 transition-colors text-[10px] font-mono"
            >
              Use Moonshine
            </button>
            <span className="text-[9px] font-mono text-white/30">
              Audio stays on this machine either way.
            </span>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      {/* Capped height (its own scroll) so the transcript can never squeeze the
          answer area out of the window. */}
      <div className="flex w-full" style={{ height: "min(320px, 35vh)" }}>
        {/* Chat Interface */}
        <div
          className={`flex flex-col h-full transition-all duration-300 ${showLogs ? "w-[60%] border-r border-white/[0.05]" : "w-full"}`}
        >
          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && !interim && (
              <div className="h-full flex flex-col items-center justify-center text-white/30 text-xs space-y-1 font-mono">
                <p>No audio captured yet.</p>
                <p className="text-[10px] text-white/20">
                  Click Start below to begin.
                </p>
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex w-full ${msg.source === "mic" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-xl px-3 py-2 flex flex-col ${
                    msg.source === "mic"
                      ? "bg-blue-500/10 text-blue-100 border border-blue-500/20 rounded-br-sm"
                      : "bg-white/[0.03] text-white/80 border border-white/[0.05] rounded-bl-sm"
                  }`}
                >
                  <div className="text-[9px] opacity-50 mb-0.5 font-sans uppercase tracking-wider">
                    {msg.source === "mic" ? "You" : "Interviewer"}
                  </div>
                  <div className="text-xs leading-relaxed">{msg.text}</div>
                </div>
              </div>
            ))}
            {/* Live interim line — appears while the interviewer is still
                speaking and is replaced by the final message. */}
            {interim && (
              <div className="flex w-full justify-start">
                <div className="max-w-[85%] rounded-xl rounded-bl-sm px-3 py-2 flex flex-col bg-white/[0.02] border border-dashed border-white/[0.12]">
                  <div className="text-[9px] opacity-50 mb-0.5 font-sans uppercase tracking-wider flex items-center gap-1.5">
                    {interim.source === "mic" ? "You" : "Interviewer"}
                    <span className="text-[8px] text-accent/70 normal-case tracking-normal">
                      transcribing…
                    </span>
                  </div>
                  <div className="text-xs leading-relaxed text-white/55 italic">
                    {interim.text}
                    <span className="animate-pulse text-white/60">▍</span>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Manual typed question (compact input + Send on Enter) — a manual
              override / fallback. Does not start or stop capture; goes through the
              same downstream AI pipeline as voice. */}
          <div className="px-3 pb-1">
            <form
              autoComplete="off"
              onSubmit={(e) => {
                e.preventDefault();
                handleManualSubmit();
              }}
              className="flex items-center gap-2"
            >
              <input
                autoFocus={false}
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                onKeyDown={(e) => {
                  // Enter submits; Shift+Enter is a no-op (single-line input).
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleManualSubmit();
                  }
                }}
                placeholder="Type interviewer question..."
                className="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-[11px] text-white placeholder-white/30 font-mono focus:border-accent/40 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!manualText.trim() || manualSubmittedRef.current}
                className="flex-none px-3 py-1.5 rounded-lg bg-accent/15 hover:bg-accent/25 disabled:opacity-30 text-accent font-medium text-[11px] transition-colors"
              >
                Send
              </button>
            </form>
          </div>

          {/* Controls */}
          <div className="p-3 bg-black/20 border-t border-white/[0.05] flex items-center justify-between">
            <div className="flex items-center gap-2">
              {!isRecording ? (
                <button
                  onClick={startInterview}
                  disabled={!isModelReady}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500/90 hover:bg-green-400 disabled:bg-white/10 disabled:text-white/30 text-black font-semibold rounded text-xs transition-all"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-black/50" />
                  {isModelReady
                    ? "Start"
                    : downloadProgress !== null
                      ? `${downloadProgress}%`
                      : "Loading..."}
                </button>
              ) : (
                <button
                  onClick={stopInterview}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 font-semibold rounded text-xs transition-all"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                  Stop
                </button>
              )}
            </div>

            <button
              onClick={handleSubmit}
              disabled={messages.length === 0 && !interim?.text.trim()}
              className="px-4 py-1.5 bg-white/10 hover:bg-white/20 disabled:opacity-30 text-white font-medium rounded text-xs transition-colors flex items-center gap-1.5"
            >
              Ask Copilot 🚀
            </button>
          </div>
        </div>

        {/* Dev Logs Panel */}
        {showLogs && (
          <div className="w-[40%] bg-black/40 flex flex-col">
            <div className="flex-1 overflow-y-auto p-3 space-y-4">
              {/* ── ASR comparison (dev only) ─────────────────────────── */}
              {/* Both engines transcribe the SAME captured buffer, so the
                  difference is the engine, not the audio. */}
              {import.meta.env.DEV && asrComparisons.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[9px] text-white/40 uppercase tracking-wider font-semibold">
                    ASR comparison (same audio):
                  </div>
                  {asrComparisons.map((c) => {
                    // The Parakeet column is only rendered while the dev
                    // comparison is on, so a shipped build never shows a cell
                    // for an engine that was never run.
                    // The Parakeet column shows whenever Parakeet is EITHER the
                    // primary engine (it is filling this cell with the live
                    // transcript) or the dev comparison is on.
                    const showParakeet =
                      !!asrCompareParakeet || primaryAsr === "parakeet";
                    const t = c.deepgramTelemetry;
                    const g = c.groqTelemetry;
                    const ms = (v: number | null | undefined) =>
                      v === null || v === undefined ? "-" : `${Math.round(v)}ms`;
                    const groqCorrected =
                      c.groqCorrectedText && c.groqCorrectedText !== c.groqText
                        ? c.groqCorrectedText
                        : null;
                    return (
                      <div
                        key={c.id}
                        className="bg-white/[0.02] p-1.5 rounded border border-white/[0.05] space-y-1"
                      >
                        <div className="text-[9px] text-white/40">
                          {c.audioSeconds.toFixed(1)}s audio
                        </div>
                        <div
                          className={`grid gap-1.5 text-[9px] ${showParakeet ? "grid-cols-4" : "grid-cols-3"}`}
                        >
                          <div>                            <div className="text-white/40 mb-0.5">
                              Moonshine
                              {primaryAsr === "parakeet" && (
                                <span className="text-white/25"> (fallback only)</span>
                              )}
                            </div>
                            <div className="text-white/70">
                              {c.moonshineText || "(not run)"}
                            </div>
                          </div>
                          <div>
                            <div className="text-white/40 mb-0.5">
                              Deepgram{` ${ms(t?.firstInterimMs)}`}
                            </div>
                            <div className="text-white/70">
                              {c.deepgramText || "(not run)"}
                            </div>
                          </div>
                          <div>
                            <div className="text-white/40 mb-0.5">
                              Groq Whisper{` ${ms(g?.firstResultMs)}`}
                            </div>
                            <div className="text-white/70">
                              {c.groqText || "(not run)"}
                            </div>
                            {groqCorrected && (
                              <div className="text-emerald-300/70 mt-0.5">
                                corrected: {groqCorrected}
                              </div>
                            )}
                          </div>
                          {showParakeet && (
                            <div>
                              <div className="text-white/40 mb-0.5">
                                Parakeet{` ${ms(c.parakeetMs)}`}
                              </div>
                              <div className="text-white/70">
                                {c.parakeetText ||
                                  (c.parakeetStatus && c.parakeetStatus !== "ok"
                                    ? `(${c.parakeetStatus})`
                                    : "(pending)")}
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="text-[8px] text-white/30">
                          {`dg final ${ms(t?.firstFinalMs)} · speech_final ${ms(t?.speechFinalMs)} · total ${ms(t?.totalMs)}`}
                          {`  ·  groq http ${g?.httpStatus ?? "-"} · ${g?.success ? "ok" : g?.failureReason ?? "-"} · ${ms(g?.totalMs)}`}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── Export comparison records (dev only) ──────────────── */}
              {/* Moonshine runs in a Web Worker and cannot be driven from the
                  Node benchmark, so its accuracy and latency can only come from
                  a real session. This writes what the session measured:
                  engine text and numbers, never audio. */}
              {import.meta.env.DEV && asrComparisons.length > 0 && (
                <button
                  onClick={() => {
                    const json = serializeAsrComparisonExport(
                      useStore.getState().asrComparisons,
                    );
                    void window.ghostly
                      .writeAsrComparisonExport(json)
                      .then((result) => {
                        if (result.ok && result.path) {
                          addLog(`Exported ${asrComparisons.length} comparison row(s) to ${result.path}`);
                          console.log(`[ASR-EXPORT] ${result.path} (${result.bytes} bytes)`);
                        } else {
                          addLog(`Export failed: ${result.message ?? "unknown error"}`);
                        }
                      })
                      .catch(() =>
                        addLog("Export failed: could not reach the main process."),
                      );
                  }}
                  className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-white/60 text-[9px] transition-colors"
                >
                  Export comparison JSON ({asrComparisons.length})
                </button>
              )}

              {/* ── Latency report ────────────────────────────────────────
                  Numbers only, no styling work, no charts. Plain text with a
                  Copy button, because a latency report is only useful once it
                  has left the app and reached an issue, and a screenshot of a
                  chart cannot be pasted into a terminal.

                  Contains no transcript, no prompt, no answer and no key, so it
                  is safe to share as-is. */}
              <div className="space-y-1">
                <div className="text-[9px] text-white/40 uppercase tracking-wider font-semibold">
                  Latency report ({latencyTurns.length} turn
                  {latencyTurns.length === 1 ? "" : "s"})
                </div>
                <pre className="text-[9px] text-white/50 bg-black/30 rounded border border-white/[0.05] p-2 max-h-64 overflow-auto whitespace-pre leading-relaxed">
                  {latencyReport}
                </pre>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(latencyReport)
                        .then(() => addLog("Latency report copied to the clipboard."))
                        .catch(() =>
                          addLog(
                            "Could not reach the clipboard — select the text and copy it manually.",
                          ),
                        );
                    }}
                    className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-white/60 text-[9px] transition-colors"
                  >
                    Copy report
                  </button>
                  <button
                    type="button"
                    onClick={() => clearLatencyTurns()}
                    className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-white/60 text-[9px] transition-colors"
                  >
                    Clear
                  </button>
                </div>
              </div>

              {/* ── Primary engine + model state ─────────────────────── */}
              {/*
               * Always visible, not dev-gated: which engine is transcribing is
               * not a developer detail. If it is not on screen, a silent switch
               * to the fallback would be indistinguishable from the model simply
               * getting worse.
               */}
              <div className="text-[9px] text-white/40 space-y-1">
                <div>
                  Engine:{" "}
                  <span className="text-white/70">
                    {primaryAsr === "parakeet"
                      ? "Parakeet (local)"
                      : "Moonshine (local)"}
                  </span>
                </div>
                {primaryAsr === "parakeet" && (
                  <div
                    className={
                      parakeetStatus === "ready"
                        ? "text-emerald-300/70"
                        : parakeetStatus === "loading"
                          ? "text-amber-200/80"
                          : "text-amber-300/90"
                    }
                  >
                    {parakeetStatus === "ready"
                      ? "Speech model ready."
                      : parakeetStatus === "loading"
                        ? "Loading speech model…"
                        : `Speech model: ${parakeetStatus}`}
                  </div>
                )}
                {parakeetMessage && (
                  <div className="text-amber-200/80">{parakeetMessage}</div>
                )}
                {/* Where the load actually went. Shown here because the standing
                    question "why is it 15s in the app and 6s in the smoke test"
                    is answerable only from these four numbers, and the log panel
                    is the one place a developer is already looking. */}
                {parakeetBreakdown && (
                  <div className="text-white/30">
                    Load:{" "}
                    {formatLoadBreakdown(parakeetBreakdown)}
                  </div>
                )}
                {primaryAsr === "parakeet" && parakeetStatus === "error" && (
                  <button
                    onClick={retryParakeet}
                    className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-white/60 transition-colors"
                  >
                    Retry loading the speech model
                  </button>
                )}
                {fallbackNotice && (
                  <div className="text-amber-200/80">{fallbackNotice}</div>
                )}
                {/* ── Cloud-audio indicator ────────────────────────────────
                 * Rendered whenever a COMPARISON engine that uploads raw audio
                 * is enabled. It sits with the other dev diagnostics rather
                 * than in Settings because the consequence is about the live
                 * session, not about the saved configuration. */}
                {cloudComparisonEngines.length > 0 && (
                  <div
                    role="status"
                    className="rounded border border-red-500/60 bg-red-500/10 px-2 py-1 text-red-200"
                  >
                    <span className="font-semibold">
                      Recording audio is being uploaded to{" "}
                      {cloudComparisonEngines.join(" and ")}.
                    </span>{" "}
                    Turn the Deepgram / Groq comparison off in Settings to stop
                    sending microphone audio off this machine. The primary
                    engine is unaffected.
                  </div>
                )}
              </div>

              {/* ── Padding A/B (dev only) ───────────────────────────── */}
              {/*
               * `PARAKEET_PADDING_MS` (300 ms of silence each side) is marked
               * PROVISIONAL because it was never measured against real interview
               * audio. This toggle is the measurement instrument: flip it, run the
               * same conversation, and the comparison grid shows the same clips
               * decoded both ways, with an empty result visible as such rather
               * than as a blank cell.
               *
               * The value is written through to electron-store for the same
               * reason the comparison toggle above is: the main process reads the
               * padding from the STORE, not from zustand.
               */}
              {import.meta.env.DEV && (
                <label className="flex items-start gap-2 text-[9px] text-white/50 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={parakeetPaddingMs === 0}
                    onChange={(e) => {
                      const nextMs = e.target.checked ? 0 : PARAKEET_PADDING_MS;
                      setParakeetPaddingMs(nextMs);
                      const next = {
                        ...useStore.getState().settings,
                        parakeetPaddingMs: nextMs,
                      };
                      void window.ghostly.saveSettings(next);
                      addLog(
                        nextMs === 0
                          ? "Parakeet padding OFF — segments are decoded exactly as captured."
                          : `Parakeet padding ON — ${nextMs} ms of silence is added to each side before decoding.`,
                      );
                    }}
                    className="accent-white/60 mt-0.5"
                  />
                  <span>
                    Parakeet padding A/B (dev only)
                    <span className="block text-white/30 mt-0.5">
                      {parakeetPaddingMs === 0
                        ? "unpadded — 0 ms"
                        : `padded — ${parakeetPaddingMs ?? PARAKEET_PADDING_MS} ms each side`}
                      . Applies to the next segment decoded. Compare this run
                      against a padded one on the same clips.
                    </span>
                  </span>
                </label>
              )}

              {/* ── Parakeet comparison (dev only) ───────────────────── */}
              {/* A DEVELOPMENT COMPARISON ENGINE, off by default. The model is
                  ~631 MB and costs several hundred MB of resident memory, so
                  it is loaded on Start and released on Stop. Moonshine remains
                  the production engine: this column never feeds the transcript,
                  the question gate or the AI. */}
              {import.meta.env.DEV && (
                <label className="flex items-start gap-2 text-[9px] text-white/50 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={!!asrCompareParakeet}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      updateSettings({ asrCompareParakeet: enabled });
                      // Persist explicitly.
                      //
                      // The auto-save effect that normally mirrors settings to
                      // electron-store lives in SettingsPanel, which is a
                      // different component. Ticking the box here updated
                      // zustand and nothing else, so the main process — which
                      // reads the flag from the STORE, not from zustand — never
                      // saw it, and the feature could never turn on. Writing
                      // through on change is what makes the toggle work at all.
                      const next = {
                        ...useStore.getState().settings,
                        asrCompareParakeet: enabled,
                      };
                      void window.ghostly.saveSettings(next);
                      addLog(
                        enabled
                          ? "Parakeet comparison ON — the model loads on Start Interview (~7 s, ~650 MB) and is released on Stop."
                          : "Parakeet comparison OFF — the model is not loaded.",
                      );
                    }}
                    className="accent-white/60 mt-0.5"
                  />
                  <span>
                    Compare with local Parakeet (dev only — Moonshine stays the
                    engine that reaches the AI)
                    <span className="block text-white/30 mt-0.5">
                      status: {compareModelStatus}
                    </span>
                  </span>
                </label>
              )}

              {/* Audio Debugger */}
              {/* Recording interview audio is opt-in and dev-only. The toggle
                  is here, behind the Debug panel, because that is where
                  someone would go looking for it. */}
              <label className="flex items-center gap-2 text-[9px] text-white/50 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={debugWavOn}
                  onChange={(e) => setDebugWav(e.target.checked)}
                  className="accent-white/60"
                />
                <span>
                  Record debug WAV — kept in memory; written to disk only when
                  you click &quot;Save all debug clips&quot;
                  <span className="block text-white/30 mt-0.5">
                    Files go to{" "}
                    <span className="text-white/45">
                      {describeSessionFolder(new Date())}
                    </span>{" "}
                    in the project folder. That directory is gitignored.
                    Nothing is ever uploaded.
                  </span>
                </span>
              </label>

              {debugAudios.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[9px] text-white/40 uppercase tracking-wider font-semibold">
                    Raw Audio:
                  </div>
                  {/* ── Save all debug clips ────────────────────────────
                      The ONLY thing in this feature that writes to disk, and
                      only when clicked. Each clip is named
                      `<phraseId>_<audioSeconds>s.wav` so it joins exactly to the
                      same row in the comparison JSON written beside it — no
                      duration guessing is needed anywhere. */}
                  <button
                    onClick={() => {
                      const withBytes = debugAudios.filter(
                        (d) => d.blob && typeof d.phraseId === "number",
                      );
                      if (withBytes.length === 0) {
                        addLog(
                          "No clips with a phraseId to save. Record with the checkbox ticked, then try again.",
                        );
                        return;
                      }
                      const skipped = debugAudios.length - withBytes.length;
                      addLog(`Saving ${withBytes.length} clip(s)…`);
                      void Promise.all(
                        withBytes.map(async (clip) => ({
                          name: debugClipFileName(
                            clip.phraseId as number,
                            clip.audioSeconds ?? 0,
                          ),
                          data: new Uint8Array(
                            await (clip.blob as Blob).arrayBuffer(),
                          ),
                        })),
                      )
                        .then((files) =>
                          window.ghostly.saveDebugClips({
                            session: sessionFolderName(),
                            files,
                            // The comparison export travels with the clips so
                            // one folder is self-contained: every WAV and the
                            // text measured for it share a phraseId.
                            exportJson: serializeAsrComparisonExport(
                              useStore.getState().asrComparisons,
                            ),
                          }),
                        )
                        .then((result) => {
                          if (result.ok && result.dir) {
                            addLog(
                              `Saved ${result.written} clip(s) + comparison-export.json to ${result.dir}` +
                                (skipped > 0 ? ` (${skipped} skipped: no phraseId)` : ""),
                            );
                            console.log(`[ASR-CLIPS] ${result.dir}`);
                          } else {
                            addLog(`Save failed: ${result.message ?? "unknown error"}`);
                          }
                        })
                        .catch(() =>
                          addLog("Save failed: could not reach the main process."),
                        );
                    }}
                    className="px-2 py-1 rounded bg-white/[0.08] hover:bg-white/[0.14] text-white/75 text-[9px] transition-colors"
                  >
                    Save all debug clips ({debugAudios.length}) →{" "}
                    {describeSessionFolder(new Date())}
                  </button>
                  {debugAudios.map((da, i) => (
                    <div
                      key={i}
                      className="bg-white/[0.02] p-1.5 rounded border border-white/[0.05]"
                    >
                      <div className="text-[9px] text-white/60 mb-1">
                        {da.name}
                        {typeof da.phraseId === "number" && (
                          <span className="text-white/35">
                            {" "}
                            · phraseId {da.phraseId}
                          </span>
                        )}
                      </div>
                      <audio
                        controls
                        src={da.url}
                        className="h-5 w-full"
                        style={{ filter: "invert(100%)" }}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* Text Logs */}
              <div className="space-y-0.5 font-mono text-[9px] text-white/50">
                <div className="text-[9px] text-white/40 uppercase tracking-wider font-semibold mb-1.5 mt-3">
                  Logs:
                </div>
                {logs.map((log, i) => (
                  <div
                    key={i}
                    className={`break-words ${log.includes("WARNING") ? "text-yellow-400" : ""}`}
                  >
                    {log}
                  </div>
                ))}
                {logs.length === 0 && (
                  <div className="italic opacity-30">Waiting for logs...</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
