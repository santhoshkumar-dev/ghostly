import { useCallback, useRef } from "react";
import { useStore } from "../store/useStore";
import { getProvider } from "../lib/ai";
import { buildPrompt } from "../lib/prompts";
import { v4 as uuidv4 } from "uuid";

export function useAIStream() {
  const {
    settings,
    setIsStreaming,
    setCurrentSolution,
    appendToSolution,
    addToHistory,
    setError,
    currentScreenshot,
  } = useStore();

  const abortRef = useRef<AbortController | null>(null);

  const startStream = useCallback(
    async (screenshotBase64?: string) => {
      const screenshot = screenshotBase64 || currentScreenshot;
      if (!screenshot) {
        setError("No screenshot available. Capture a screen region first.");
        return;
      }

      const apiKey = settings.apiKeys[settings.activeProvider];
      if (!apiKey) {
        setError(
          `No API key set for ${settings.activeProvider}. Go to Settings to add one.`,
        );
        return;
      }

      // Reset state
      setCurrentSolution("");
      setError(null);
      setIsStreaming(true);

      // Build prompt
      const prompt = buildPrompt(settings.interviewType, settings.language);

      try {
        const provider = getProvider(settings.activeProvider);
        let fullSolution = "";

        const stream = provider.streamSolution({
          base64Image: screenshot,
          prompt,
          model: settings.activeModel,
          apiKey,
          mimeType: "image/png",
        });

        for await (const chunk of stream) {
          fullSolution += chunk;
          appendToSolution(chunk);
        }

        // Save to history
        const entry = {
          id: uuidv4(),
          timestamp: Date.now(),
          screenshotBase64: screenshot,
          solution: fullSolution,
          provider: settings.activeProvider,
          model: settings.activeModel,
          interviewType: settings.interviewType,
          language: settings.language,
        };
        addToHistory(entry);

        // Persist history
        try {
          const currentHistory = await window.ghostlyAPI.getHistory();
          await window.ghostlyAPI.saveHistory([entry, ...currentHistory]);
        } catch {
          /* history persistence is best-effort */
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
      currentScreenshot,
      settings,
      setIsStreaming,
      setCurrentSolution,
      appendToSolution,
      addToHistory,
      setError,
    ],
  );

  const stopStream = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsStreaming(false);
  }, [setIsStreaming]);

  return { startStream, stopStream };
}
