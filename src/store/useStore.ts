import { create } from "zustand";
import type { ProviderName } from "../lib/ai";

export interface Solution {
  id: string;
  timestamp: number;
  screenshotBase64: string;
  solution: string;
  provider: ProviderName;
  model: string;
  interviewType: string;
  language: string;
}

export interface Settings {
  activeProvider: ProviderName;
  activeModel: string;
  interviewType:
    | "dsa"
    | "system_design"
    | "frontend"
    | "sql"
    | "behavioral"
    | "general";
  language: "python" | "javascript" | "typescript" | "java" | "cpp" | "go";
  apiKeys: Record<ProviderName, string>;
  customInstructions?: string;
}

interface GhostlyStore {
  // ── Session
  currentSolution: string;
  isStreaming: boolean;
  screenshots: string[];
  currentScreenshot: string | null;
  isRegionSelecting: boolean;
  error: string | null;

  // ── Transcription
  isInterviewActive: boolean;
  isTranscribing: boolean;
  transcript: string;
  whisperStatus: string;

  // ── History
  history: Solution[];

  // ── Settings
  settings: Settings;

  // ── Mouse state
  mouseEnabled: boolean;

  // Actions — session
  setCurrentSolution: (text: string) => void;
  appendToSolution: (chunk: string) => void;
  setIsStreaming: (v: boolean) => void;
  setCurrentScreenshot: (b64: string | null) => void;
  addScreenshot: (b64: string) => void;
  clearScreenshots: () => void;
  removeScreenshot: (index: number) => void;
  setIsRegionSelecting: (v: boolean) => void;
  setError: (err: string | null) => void;
  /** Clears solution, screenshots AND transcript */
  clearSolution: () => void;
  setMouseEnabled: (v: boolean) => void;

  // Actions — transcription
  setIsInterviewActive: (v: boolean) => void;
  setIsTranscribing: (v: boolean) => void;
  setTranscript: (text: string) => void;
  appendToTranscript: (chunk: string) => void;
  clearTranscript: () => void;
  setWhisperStatus: (status: string) => void;

  // Actions — history
  addToHistory: (s: Solution) => void;
  removeFromHistory: (id: string) => void;
  clearHistory: () => void;
  setHistory: (history: Solution[]) => void;

  // Actions — settings
  updateSettings: (partial: Partial<Settings>) => void;
  setApiKey: (provider: ProviderName, key: string) => void;
  setSettings: (settings: Settings) => void;
}

export const useStore = create<GhostlyStore>((set) => ({
  // ── State
  currentSolution: "",
  isStreaming: false,
  screenshots: [],
  currentScreenshot: null,
  isRegionSelecting: false,
  error: null,
  history: [],
  mouseEnabled: false,
  settings: {
    activeProvider: "gemini",
    activeModel: "gemini-2.0-flash",
    interviewType: "dsa",
    language: "python",
    apiKeys: { gemini: "", openai: "", anthropic: "", groq: "" },
    customInstructions: "",
  },

  // ── Transcription state
  isInterviewActive: false,
  isTranscribing: false,
  transcript: "",
  whisperStatus: "idle",

  // ── Session actions
  setCurrentSolution: (text) => set({ currentSolution: text }),
  appendToSolution: (chunk) =>
    set((s) => ({ currentSolution: s.currentSolution + chunk })),
  setIsStreaming: (v) => set({ isStreaming: v }),
  setCurrentScreenshot: (b64) => set({ currentScreenshot: b64 }),
  addScreenshot: (b64) =>
    set((s) => ({
      screenshots: [...s.screenshots, b64],
      currentScreenshot: b64,
    })),
  clearScreenshots: () => set({ screenshots: [], currentScreenshot: null }),
  removeScreenshot: (index) =>
    set((s) => {
      const next = s.screenshots.filter((_, i) => i !== index);
      return {
        screenshots: next,
        currentScreenshot: next.length > 0 ? next[next.length - 1] : null,
      };
    }),
  setIsRegionSelecting: (v) => set({ isRegionSelecting: v }),
  setError: (err) => set({ error: err }),
  // Ctrl+G clears solution, screenshots AND transcript simultaneously
  clearSolution: () =>
    set({
      currentSolution: "",
      screenshots: [],
      currentScreenshot: null,
      error: null,
      transcript: "",
    }),
  setMouseEnabled: (v) => set({ mouseEnabled: v }),

  // ── Transcription actions
  setIsInterviewActive: (v) => set({ isInterviewActive: v }),
  setIsTranscribing: (v) => set({ isTranscribing: v }),
  setTranscript: (text) => set({ transcript: text }),
  appendToTranscript: (chunk) =>
    set((s) => ({ transcript: s.transcript + chunk })),
  clearTranscript: () => set({ transcript: "" }),
  setWhisperStatus: (status) => set({ whisperStatus: status }),

  // ── History actions
  addToHistory: (s) => set((state) => ({ history: [s, ...state.history] })),
  removeFromHistory: (id) =>
    set((state) => ({ history: state.history.filter((s) => s.id !== id) })),
  clearHistory: () => set({ history: [] }),
  setHistory: (history) => set({ history }),

  // ── Settings actions
  updateSettings: (partial) =>
    set((s) => ({ settings: { ...s.settings, ...partial } })),
  setApiKey: (provider, key) =>
    set((s) => ({
      settings: {
        ...s.settings,
        apiKeys: { ...s.settings.apiKeys, [provider]: key },
      },
    })),
  setSettings: (settings) => set({ settings }),
}));
