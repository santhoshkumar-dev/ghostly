import React, { useEffect, useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useStore } from "../store/useStore";
import { getProvider } from "../lib/ai";
import { buildPrompt } from "../lib/prompts";
import { v4 as uuidv4 } from "uuid";
import { TopBar } from "../components/TopBar";
import { SettingsPanel } from "../components/SettingsPanel";
import { SolutionCard } from "../components/SolutionCard";
import { InterviewModal } from "../components/InterviewModal";

export const Home: React.FC = () => {
  const {
    currentSolution,
    isStreaming,
    screenshots,
    currentScreenshot,
    error,
    settings,
    addScreenshot,
    removeScreenshot,
    clearScreenshots,
    setCurrentSolution,
    appendToSolution,
    setIsStreaming,
    setError,
    clearSolution,
    addToHistory,
  } = useStore();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [interviewOpen, setInterviewOpen] = useState(false);
  const screenshotsRef = useRef<string[]>(screenshots);

  // Keep ref in sync
  useEffect(() => {
    screenshotsRef.current = screenshots;
  }, [screenshots]);

  // AI streaming function
  const runAIStream = useCallback(
    async (screenshotList: string[], transcriptOverride?: string) => {
      const apiKey = settings.apiKeys[settings.activeProvider];
      if (!apiKey) {
        setError(
          `No API key for ${settings.activeProvider}. Open Settings (⚙) to add one.`,
        );
        setIsStreaming(false);
        return;
      }

      const isGeneral = settings.interviewType === "general";
      if (!isGeneral && screenshotList.length === 0 && !transcriptOverride) {
        setError(
          "No screenshots yet. Press Ctrl+H to take a screenshot first.",
        );
        setIsStreaming(false);
        return;
      }

      setCurrentSolution("");
      setError(null);
      setIsStreaming(true);

      let prompt = "";
      if (transcriptOverride) {
        prompt = `Here is a live interview transcript. Please provide a brief, excellent answer to the interviewer's most recent question, considering the context of the whole conversation:\n\n${transcriptOverride}`;
      } else {
        prompt = settings.interviewType === "general"
            ? settings.customInstructions || "Please answer the general question."
            : buildPrompt(settings.interviewType, settings.language);
      }

      try {
        const provider = getProvider(settings.activeProvider);
        let fullSolution = "";

        // Use the latest screenshot for the AI call (if it exists)
        const latestScreenshot = screenshotList.length > 0 ? screenshotList[screenshotList.length - 1] : undefined;

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

        // Save to history
        const entry = {
          id: uuidv4(),
          timestamp: Date.now(),
          screenshotBase64: latestScreenshot,
          solution: fullSolution,
          provider: settings.activeProvider,
          model: settings.activeModel,
          interviewType: transcriptOverride ? "live-interview" : settings.interviewType,
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
        const message =
          err instanceof Error ? err.message : "AI streaming failed";
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

  const handleInterviewSubmit = useCallback(async (transcript: string) => {
    setInterviewOpen(false);
    // Inject transcript as the prompt context, ignoring screenshots if any
    await runAIStream([], transcript);
  }, [runAIStream]);

  // Listen for hotkey events from main process
  useEffect(() => {
    // Ctrl+H — screenshot captured (multiple accumulate)
    const offScreenshot = window.ghostly.onScreenshot((b64: string) => {
      addScreenshot(b64);
    });

    // Ctrl+Enter — solve with all accumulated screenshots
    const offSolve = window.ghostly.onSolve(async () => {
      const shots = screenshotsRef.current;
      setCurrentSolution("");
      await runAIStream(shots);
    });

    // Ctrl+G — start over (clear everything)
    const offStartOver = window.ghostly.onStartOver(() => {
      clearSolution();
    });

    return () => {
      offScreenshot();
      offSolve();
      offStartOver();
    };
  }, [runAIStream, addScreenshot, clearSolution, setError, setCurrentSolution]);

  return (
    <div className="min-h-screen w-full bg-transparent text-white font-mono pointer-events-none select-none">
      {/* Top Bar */}
      <TopBar
        onOpenSettings={() => setSettingsOpen(true)}
        settingsOpen={settingsOpen}
        onStartInterview={() => setInterviewOpen(true)}
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

      {/* Interview Modal */}
      <AnimatePresence>
        {interviewOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
          >
            <InterviewModal 
              onClose={() => setInterviewOpen(false)} 
              onSubmit={handleInterviewSubmit} 
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Content Area (only when settings/interview are closed) */}
      {!settingsOpen && !interviewOpen && (
        <div className="flex justify-center mt-2">
          <div className="w-[860px] space-y-2">
            {/* Error */}
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
                  <p className="text-[11px] text-red-300/80 font-mono">
                    {error}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Screenshots strip (shows all captured screenshots) */}
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
                    📸 {screenshots.length} screenshot
                    {screenshots.length > 1 ? "s" : ""} captured
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

            {/* Solution */}
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
