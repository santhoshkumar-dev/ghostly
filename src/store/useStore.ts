import { create } from "zustand";
import type { ProviderName } from "../lib/ai";

export interface Solution {
  id: string;
  timestamp: number;
  screenshotBase64?: string;
  solution: string;
  provider: ProviderName;
  model: string;
  interviewType: string;
  language: string;
}

export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  screenshotBase64?: string;
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
  micDeviceId?: string;
  whisperModel?: string;
}

interface GhostlyStore {
  // Session
  currentSolution: string;
  isStreaming: boolean;
  screenshots: string[]; // accumulated screenshots (multiple Ctrl+H)
  currentScreenshot: string | null; // latest screenshot (for backward compat)
  error: string | null;
  sessionMessages: SessionMessage[];

  // History
  history: Solution[];

  // Settings
  settings: Settings;

  // Mouse state
  mouseEnabled: boolean;

  // Actions — session
  setCurrentSolution: (text: string) => void;
  appendToSolution: (chunk: string) => void;
  setIsStreaming: (v: boolean) => void;
  setCurrentScreenshot: (b64: string | null) => void;
  addScreenshot: (b64: string) => void;
  clearScreenshots: () => void;
  removeScreenshot: (index: number) => void;
  setError: (err: string | null) => void;
  clearSolution: () => void;
  setMouseEnabled: (v: boolean) => void;
  addSessionMessage: (msg: SessionMessage) => void;

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
  // State
  currentSolution: "",
  isStreaming: false,
  screenshots: [],
  currentScreenshot: null,
  error: null,
  sessionMessages: [],
  history: [],
  mouseEnabled: false,
  settings: {
    activeProvider: "gemini",
    activeModel: "gemini-2.0-flash",
    interviewType: "dsa",
    language: "python",
    apiKeys: { gemini: "", openai: "", anthropic: "", groq: "" },
    customInstructions: "",
    micDeviceId: "default",
    whisperModel: "Xenova/whisper-base.en",
  },

  // Session actions
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
  setError: (err) => set({ error: err }),
  clearSolution: () =>
    set({
      currentSolution: "",
      screenshots: [],
      currentScreenshot: null,
      error: null,
      sessionMessages: [],
    }),
  setMouseEnabled: (v) => set({ mouseEnabled: v }),
  addSessionMessage: (msg) => 
    set((state) => ({ sessionMessages: [...state.sessionMessages, msg] })),

  // History actions
  addToHistory: (s) => set((state) => ({ history: [s, ...state.history] })),
  removeFromHistory: (id) =>
    set((state) => ({ history: state.history.filter((s) => s.id !== id) })),
  clearHistory: () => set({ history: [] }),
  setHistory: (history) => set({ history }),

  // Settings actions
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
