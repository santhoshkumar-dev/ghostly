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
    error,
    settings,
    sessionMessages,
    addScreenshot,
    removeScreenshot,
    setCurrentSolution,
    appendToSolution,
    setIsStreaming,
    setError,
    clearSolution,
    addToHistory,
    addSessionMessage,
  } = useStore();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [interviewOpen, setInterviewOpen] = useState(false);
  const [followUpText, setFollowUpText] = useState("");
  const screenshotsRef = useRef<string[]>(screenshots);
  const abortControllerRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Keep ref in sync
  useEffect(() => {
    screenshotsRef.current = screenshots;
  }, [screenshots]);

  // Auto-scroll chat
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [sessionMessages, currentSolution]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // AI streaming function
  const runAIStream = useCallback(
    async (
      screenshotList: string[],
      transcriptOverride?: string,
      followUpQuery?: string,
    ) => {
      const apiKey = settings.apiKeys[settings.activeProvider];
      if (!apiKey) {
        setError(
          `No API key for ${settings.activeProvider}. Open Settings (⚙) to add one.`,
        );
        setIsStreaming(false);
        return;
      }

      // We only strictly require screenshots for the FIRST dsa/code question if no followUp or transcript
      const isGeneral = settings.interviewType === "general";
      const isFollowUp = !!followUpQuery;

      if (
        !isGeneral &&
        screenshotList.length === 0 &&
        !transcriptOverride &&
        !isFollowUp &&
        sessionMessages.length === 0
      ) {
        setError(
          "No screenshots yet. Press Ctrl+H to take a screenshot first.",
        );
        setIsStreaming(false);
        return;
      }

      // Abort any ongoing stream
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const signal = abortController.signal;

      setCurrentSolution("");
      setError(null);
      setIsStreaming(true);
      setFollowUpText(""); // clear input

      let prompt = "";
      if (followUpQuery) {
        prompt = followUpQuery;
      } else if (transcriptOverride) {
        prompt = `Here is a live interview transcript. Please provide a brief, excellent answer to the interviewer's most recent question, considering the context of the whole conversation:\n\n${transcriptOverride}`;
      } else {
        prompt =
          settings.interviewType === "general"
            ? settings.customInstructions ||
              "Please answer the general question."
            : buildPrompt(settings.interviewType, settings.language);
      }

      try {
        const provider = getProvider(settings.activeProvider);
        let fullSolution = "";

        // Use the latest screenshot for the AI call (if it exists)
        const latestScreenshot =
          screenshotList.length > 0
            ? screenshotList[screenshotList.length - 1]
            : undefined;

        // PERF: Prevent context window token explosion.
        // 1. Keep only the last 6 messages (3 interactions).
        // 2. We only send the text. We do NOT re-send historical Base64 images to save tokens and latency.
        const recentMessages = sessionMessages.slice(-6);
        const historyContext = recentMessages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        }));

        const stream = provider.streamSolution({
          base64Image: latestScreenshot,
          prompt,
          messages: historyContext,
          model: settings.activeModel,
          apiKey,
          mimeType: latestScreenshot ? "image/png" : undefined,
        });

        for await (const chunk of stream) {
          if (signal.aborted) {
            break;
          }
          fullSolution += chunk;
          appendToSolution(chunk);
        }

        if (signal.aborted) {
          return; // Skip history save if we aborted
        }

        // Add User Message to Session
        addSessionMessage({
          id: uuidv4(),
          role: "user",
          content: prompt,
          screenshotBase64: latestScreenshot,
        });

        // Add AI Assistant Message to Session
        addSessionMessage({
          id: uuidv4(),
          role: "assistant",
          content: fullSolution,
        });

        // Save to global history log
        const entry = {
          id: uuidv4(),
          timestamp: Date.now(),
          screenshotBase64: latestScreenshot,
          solution: fullSolution,
          provider: settings.activeProvider,
          model: settings.activeModel,
          interviewType: transcriptOverride
            ? "live-interview"
            : settings.interviewType,
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
        if (signal.aborted) return;
        const message =
          err instanceof Error ? err.message : "AI streaming failed";
        setError(message);
      } finally {
        if (!signal.aborted) {
          setIsStreaming(false);
          setCurrentSolution(""); // Clear current (it is now in session messages)
        }
      }
    },
    [
      settings,
      sessionMessages,
      setCurrentSolution,
      setError,
      setIsStreaming,
      appendToSolution,
      addToHistory,
      addSessionMessage,
    ],
  );

  const handleInterviewSubmit = useCallback(
    async (transcript: string) => {
      setInterviewOpen(false);
      await runAIStream([], transcript);
    },
    [runAIStream],
  );

  const handleFollowUpSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!followUpText.trim() || isStreaming) return;
      runAIStream([], undefined, followUpText.trim());
    },
    [followUpText, isStreaming, runAIStream],
  );

  // Listen for hotkey events from main process
  useEffect(() => {
    // Ctrl+H — screenshot captured (multiple accumulate)
    const offScreenshot = window.ghostly.onScreenshot((b64: string) => {
      addScreenshot(b64);
    });

    // Ctrl+Enter — solve with all accumulated screenshots
    const offSolve = window.ghostly.onSolve(async () => {
      const shots = screenshotsRef.current;
      await runAIStream(shots);
    });

    // Ctrl+G — start over (clear everything)
    const offStartOver = window.ghostly.onStartOver(() => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      setIsStreaming(false);
      clearSolution();
    });

    return () => {
      offScreenshot();
      offSolve();
      offStartOver();
    };
  }, [runAIStream, addScreenshot, clearSolution, setIsStreaming]);

  return (
    <div className="h-screen w-full bg-transparent text-white font-mono pointer-events-none select-none flex flex-col">
      {/* Top Bar */}
      <div className="flex-none">
        <TopBar
          onOpenSettings={() => setSettingsOpen(true)}
          settingsOpen={settingsOpen}
          onStartInterview={() => setInterviewOpen(!interviewOpen)}
        />
      </div>

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

      {/* Content Area (only when settings are closed) */}
      {!settingsOpen && (
        <div className="flex-1 min-h-0 flex justify-center mt-2 pb-6 overflow-hidden">
          <div className="w-[860px] space-y-2 flex flex-col h-full">
            {/* Inline Interview Panel */}
            <AnimatePresence>
              {interviewOpen && (
                <motion.div
                  initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                  animate={{ opacity: 1, height: "auto", marginBottom: 8 }}
                  exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                  className="overflow-hidden flex-shrink-0"
                  transition={{ duration: 0.2 }}
                >
                  <InterviewModal
                    onClose={() => setInterviewOpen(false)}
                    onSubmit={handleInterviewSubmit}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {/* Error */}
            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="p-3 rounded-xl pointer-events-auto flex-shrink-0"
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

            {/* Screenshots strip */}
            {screenshots.length > 0 &&
              !currentSolution &&
              !isStreaming &&
              sessionMessages.length === 0 && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="pointer-events-auto rounded-xl p-3 flex-shrink-0"
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

            {/* Chat Container */}
            {(sessionMessages.length > 0 || currentSolution || isStreaming) && (
              <div
                className="pointer-events-auto rounded-2xl overflow-hidden flex flex-col flex-1"
                style={{
                  background: "rgba(20, 20, 23, 0.65)",
                  backdropFilter: "blur(24px)",
                  WebkitBackdropFilter: "blur(24px)",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
                onMouseEnter={() => window.ghostly.enableMouse()}
                onMouseLeave={() => window.ghostly.disableMouse()}
              >
                {/* Scrollable messages area */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {sessionMessages.map((msg, idx) => (
                    <div
                      key={msg.id}
                      className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      {msg.role === "user" ? (
                        <div className="max-w-[80%] bg-white/[0.08] border border-white/[0.1] rounded-2xl rounded-tr-sm px-4 py-2 text-xs text-white/80 whitespace-pre-wrap shadow-md">
                          {msg.screenshotBase64 && (
                            <img
                              src={msg.screenshotBase64}
                              alt="attached context"
                              className="max-h-24 rounded mb-2 border border-white/10"
                            />
                          )}
                          {msg.content.includes(
                            "Here is a live interview transcript",
                          )
                            ? "🎙️ Live Transcript Submitted"
                            : msg.content}
                        </div>
                      ) : (
                        <div className="w-full">
                          <SolutionCard
                            content={msg.content}
                            isStreaming={false}
                          />
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Streaming Block */}
                  {(isStreaming || currentSolution) && (
                    <div className="w-full">
                      <SolutionCard
                        content={currentSolution}
                        isStreaming={isStreaming}
                      />
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Follow-up input */}
                <div className="p-3 bg-black/20 border-t border-white/[0.05]">
                  <form onSubmit={handleFollowUpSubmit} className="relative">
                    <input
                      type="text"
                      value={followUpText}
                      onChange={(e) => setFollowUpText(e.target.value)}
                      placeholder="Ask a follow-up question..."
                      disabled={isStreaming}
                      className="w-full bg-black/40 border border-white/[0.1] rounded-xl pl-4 pr-10 py-2.5 text-xs text-white/90 placeholder:text-white/30 focus:outline-none focus:border-white/20 transition-colors disabled:opacity-50"
                    />
                    <button
                      type="submit"
                      disabled={isStreaming || !followUpText.trim()}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-white/50 hover:text-white/90 hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition-all"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="22" y1="2" x2="11" y2="13"></line>
                        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                      </svg>
                    </button>
                  </form>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
