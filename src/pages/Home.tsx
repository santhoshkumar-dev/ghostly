import React, { useEffect, useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useStore } from "../store/useStore";
import { getProvider } from "../lib/ai";
import { buildPrompt } from "../lib/prompts";
import { v4 as uuidv4 } from "uuid";
import { TopBar } from "../components/TopBar";
import { SettingsPanel } from "../components/SettingsPanel";
import { SolutionCard } from "../components/SolutionCard";
import { TranscriptBar } from "../components/TranscriptBar";
import { useTranscription } from "../hooks/useTranscription";

export const Home: React.FC = () => {
  const {
    currentSolution,
    isStreaming,
    screenshots,
    error,
    settings,
    transcript,
    addScreenshot,
    removeScreenshot,
    setCurrentSolution,
    appendToSolution,
    setIsStreaming,
    setError,
    clearSolution,
    addToHistory,
  } = useStore();

  const [settingsOpen, setSettingsOpen] = useState(false);

  // Keep refs in sync so hotkey callbacks always read the latest values
  const screenshotsRef = useRef<string[]>(screenshots);
  const transcriptRef  = useRef<string>(transcript);

  useEffect(() => { screenshotsRef.current = screenshots; }, [screenshots]);
  useEffect(() => { transcriptRef.current  = transcript;  }, [transcript]);

  // ── Whisper transcription hook
  const { startTranscription, stopTranscription } = useTranscription();

  // ── AI streaming ─────────────────────────────────────────────────────
  const runAIStream = useCallback(
    async (screenshotList: string[], transcriptText?: string) => {
      const apiKey = settings.apiKeys[settings.activeProvider];
      if (!apiKey) {
        setError(
          `No API key for ${settings.activeProvider}. Open Settings (⚙) to add one.`,
        );
        setIsStreaming(false);
        return;
      }

      const isGeneral = settings.interviewType === "general";
      // Allow solve with transcript alone (no screenshot needed)
      if (!isGeneral && screenshotList.length === 0 && !transcriptText) {
        setError(
          "No screenshots or transcript yet. Press Ctrl+H to capture, or start an interview.",
        );
        setIsStreaming(false);
        return;
      }

      setCurrentSolution("");
      setError(null);
      setIsStreaming(true);

      // Pass transcript into the prompt builder
      const prompt =
        settings.interviewType === "general"
          ? settings.customInstructions || "Please answer the general question."
          : buildPrompt(settings.interviewType, settings.language, transcriptText);

      try {
        const provider = getProvider(settings.activeProvider);
        let fullSolution = "";

        const latestScreenshot = screenshotList[screenshotList.length - 1];

        const stream = provider.streamSolution({
          base64Image: latestScreenshot,
          prompt,
          model: settings.activeModel,
          apiKey,
          mimeType: latestScreenshot ? "image/png" : undefined,
        });

        for await (const chunk of stream) {
          fullSolution += chunk;
          appendToSolution(chunk);
        }

        // Persist to history
        const entry = {
          id: uuidv4(),
          timestamp: Date.now(),
          screenshotBase64: latestScreenshot,
          solution: fullSolution,
          provider: settings.activeProvider,
          model: settings.activeModel,
          interviewType: settings.interviewType,
          language: settings.language,
        };
        addToHistory(entry);

        try {
          const currentHistory = await window.ghostly.getHistory();
          await window.ghostly.saveHistory([entry, ...currentHistory]);
        } catch {
          /* best-effort */
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "AI streaming failed";
        setError(message);
      } finally {
        setIsStreaming(false);
      }
    },
    [
      settings,
      setCurrentSolution,
      setError,
      setIsStreaming,
      appendToSolution,
      addToHistory,
    ],
  );

  // ── Hotkey listeners from main process ───────────────────────────────
  useEffect(() => {
    // Ctrl+H — screenshot captured, accumulate multiple
    const offScreenshot = window.ghostly.onScreenshot((b64: string) => {
      addScreenshot(b64);
    });

    // Ctrl+Enter — solve: pass BOTH screenshots AND live transcript
    const offSolve = window.ghostly.onSolve(async () => {
      const shots = screenshotsRef.current;
      const tx    = transcriptRef.current;
      setCurrentSolution("");
      await runAIStream(shots, tx || undefined);
    });

    // Ctrl+G — start over: clears solution + screenshots + transcript
    const offStartOver = window.ghostly.onStartOver(() => {
      clearSolution();
    });

    return () => {
      offScreenshot();
      offSolve();
      offStartOver();
    };
  }, [runAIStream, addScreenshot, clearSolution, setCurrentSolution]);

  return (
    <div className="min-h-screen w-full bg-transparent text-white font-mono pointer-events-none select-none">
      {/* Top Bar */}
      <TopBar
        onOpenSettings={() => setSettingsOpen(true)}
        settingsOpen={settingsOpen}
      />

      {/* Settings Panel */}
      <AnimatePresence>
        {settingsOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.15 }}
          >
            <SettingsPanel onClose={() => setSettingsOpen(false)} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Content */}
      {!settingsOpen && (
        <div className="flex justify-center mt-2">
          <div className="w-[860px] space-y-2">

            {/* ── Interview Mode / Transcript Bar (always visible) */}
            <TranscriptBar
              onStart={startTranscription}
              onStop={stopTranscription}
            />

            {/* ── Error */}
            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="p-3 rounded-xl pointer-events-auto"
                  style={{
                    background: "rgba(255, 60, 60, 0.1)",
                    border: "1px solid rgba(255, 60, 60, 0.15)",
                  }}
                >
                  <p className="text-[11px] text-red-300/80 font-mono">{error}</p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* ── Screenshots strip */}
            {screenshots.length > 0 && !currentSolution && !isStreaming && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="pointer-events-auto rounded-xl p-3"
                style={{
                  background: "rgba(20, 20, 23, 0.90)",
                  border: "1px solid rgba(255,255,255,0.06)",
                }}
                onMouseEnter={() => window.ghostly.enableMouse()}
                onMouseLeave={() => window.ghostly.disableMouse()}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] text-white/40 font-mono">
                    📸 {screenshots.length} screenshot{screenshots.length > 1 ? "s" : ""} captured
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-white/25 font-mono">
                      Press{" "}
                      <kbd className="bg-black/40 border border-white/[0.12] rounded px-1 py-0.5 text-[9px] text-white/50">
                        Ctrl
                      </kbd>{" "}
                      <kbd className="bg-black/40 border border-white/[0.12] rounded px-1 py-0.5 text-[9px] text-white/50">
                        ↵
                      </kbd>{" "}
                      to solve
                    </span>
                    <button
                      onClick={() => clearSolution()}
                      className="text-[10px] text-white/30 hover:text-white/60 transition-colors"
                    >
                      Clear all
                    </button>
                  </div>
                </div>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {screenshots.map((shot, i) => (
                    <div key={i} className="relative group flex-shrink-0">
                      <img
                        src={shot}
                        alt={`Screenshot ${i + 1}`}
                        className="h-[80px] w-auto rounded-lg border border-white/[0.06] object-cover"
                      />
                      <button
                        onClick={() => removeScreenshot(i)}
                        className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500/80 text-white text-[8px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        ✕
                      </button>
                      <span className="absolute bottom-1 left-1 text-[8px] text-white/40 bg-black/50 rounded px-1">
                        #{i + 1}
                      </span>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}

            {/* ── AI Solution */}
            {(currentSolution || isStreaming) && (
              <div
                className="pointer-events-auto rounded-2xl overflow-hidden"
                style={{
                  background: "rgba(20, 20, 23, 0.55)",
                  backdropFilter: "blur(24px)",
                  WebkitBackdropFilter: "blur(24px)",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
                onMouseEnter={() => window.ghostly.enableMouse()}
                onMouseLeave={() => window.ghostly.disableMouse()}
              >
                <div className="p-4 max-h-[65vh] overflow-y-auto">
                  <SolutionCard
                    content={currentSolution}
                    isStreaming={isStreaming}
                  />
                </div>
              </div>
            )}

          </div>
        </div>
      )}
    </div>
  );
};
