/// <reference types="vite/client" />

interface Window {
  ghostly: {
    getDesktopSources: () => Promise<{ id: string; name: string }[]>;
    enableMouse: () => void;
    disableMouse: () => void;
    hide: () => void;
    show: () => void;

    /**
     * Ghostly's own window opacity — NOT the Region Picker's dim overlay.
     *
     * Read on mount to show the persisted value, written on every slider change
     * so a restart restores it. `percent` comes from the main process so the UI
     * never rounds differently from the value actually applied to the window.
     */
    getOverlayOpacity: () => Promise<{
      opacity: number;
      percent: number;
      hidden: boolean;
    }>;
    setOverlayOpacity: (
      value: number,
    ) => Promise<{ opacity: number; percent: number; hidden: boolean }>;
    captureFullscreen: () => Promise<string>;

    // Settings
    getSettings: () => Promise<any>;
    saveSettings: (settings: any) => Promise<void>;

    // History
    getHistory: () => Promise<any[]>;
    saveHistory: (history: any[]) => Promise<void>;

    // Events
    onScreenshot: (cb: (b64: string) => void) => () => void;
    /**
     * The global `Ctrl+Shift+S` Capture Screen shortcut, forwarded from the
     * main process so the shortcut and the Capture Screen BUTTON run the SAME
     * renderer callback → same `ghostly:capture-fullscreen` IPC → same capture
     * function. One implementation, two triggers.
     */
    onCaptureScreen: (cb: () => void) => () => void;
    /**
     * The main process' wall-clock instant of the `Ctrl+Enter` press.
     *
     * Sent because `performance.now()` origins differ between processes: the
     * renderer cannot otherwise measure `hotkey_pressed -> committed`. Both ends
     * are `Date.now()` on one machine, so the difference is meaningful to within
     * the system clock rather than to `performance.now()`'s resolution.
     */
    onSolve: (cb: (payload: { pressedAt: number | null }) => void) => () => void;
    onStartOver: (cb: () => void) => () => void;
    onInterviewType: (type: string, cb: () => void) => () => void;

    // Start / Stop Interview (Ctrl+I) and Next Question (Ctrl+N).
    onToggleInterview: (cb: () => void) => () => void;
    onNextQuestion: (cb: () => void) => () => void;

    // Deepgram (optional second ASR engine).
    //
    // Note what is ABSENT: there is no `getDeepgramKey`. The renderer can
    // only learn whether a key exists, and can request a short-lived token.
    deepgramHasKey: () => Promise<boolean>;
    deepgramToken: () => Promise<
      | { ok: true; token: string; expiresIn: number }
      | { ok: false; code: string; message: string }
    >;

    // ── Groq Whisper (optional THIRD ASR engine, comparison only) ──────
    //
    // As with Deepgram, there is NO method that returns the long-lived key.
    // The renderer can learn whether a key is configured and can SET one, but
    // the request itself is performed in the main process.
    groqAsrHasKey: () => Promise<boolean>;
    groqSetKey: (value: string) => Promise<{ ok: boolean; configured: boolean }>;
    groqTranscribe: (payload: {
      wav: ArrayBuffer;
      model?: string;
      language?: string;
      prompt?: string;
    }) => Promise<
      | {
          ok: true;
          result: {
            provider: "groq";
            model: string;
            text: string;
            audioSeconds: number;
            latencyMs: number;
            firstResultMs: number | null;
            segments: Array<{
              id: number;
              start: number;
              end: number;
              text: string;
            }>;
          };
          telemetry: {
            provider: "groq";
            model: string;
            audioSeconds: number;
            requestStartMs: number;
            firstResultMs: number | null;
            totalMs: number;
            httpStatus: number | null;
            success: boolean;
            failureReason: string | null;
            chars: number;
            segmentCount: number;
          };
          httpStatus: number;
        }
      | {
          ok: false;
          code: string;
          httpStatus: number | null;
          telemetry: {
            provider: "groq";
            model: string;
            audioSeconds: number;
            requestStartMs: number;
            firstResultMs: number | null;
            totalMs: number;
            httpStatus: number | null;
            success: boolean;
            failureReason: string | null;
            chars: number;
            segmentCount: number;
          };
          message: string;
        }
    >;

    // ── Dev-only ASR comparison export ────────────────────────────────
    // Writes engine text + numbers to a JSON file at a path chosen by the MAIN
    // process. There is no audio in this path.
    writeAsrComparisonExport: (json: string) => Promise<{
      ok: boolean;
      path?: string;
      bytes?: number;
      message?: string;
    }>;

    // ── Dev-only: save captured debug clips ───────────────────────────
    // Writes WAV clips + the comparison JSON to `debug-audio/<session>/`.
    // User-triggered only; nothing is written automatically or uploaded.
    saveDebugClips: (payload: {
      session?: string;
      files: Array<{ name: string; data: Uint8Array }>;
      exportJson?: string;
    }) => Promise<{
      ok: boolean;
      dir?: string;
      written?: number;
      message?: string;
    }>;

    // ── Parakeet (DEVELOPMENT COMPARISON ENGINE ONLY) ────────────────
    //
    // Mirrors the ASR-engine pattern: the renderer hands over audio it has
    // already captured and receives a transcript. There is no handle to the
    // model, no path to it, and no way to make it part of the live pipeline.
    // The main process refuses all of this unless the dev setting is on and
    // the app is not packaged.
    parakeetStatus: () => Promise<{
      status: "disabled" | "missing" | "loading" | "ready" | "error";
      mode?: "primary" | "comparison";
    }>;
    parakeetLoad: () => Promise<{
      ok: boolean;
      loadMs?: number;
      breakdown?: {
        spawn: number | null;
        require: number | null;
        read: number | null;
        construct: number | null;
        total: number;
        endToEnd: number;
        modelBytes: number | null;
      };
      rssMb?: number;
      code?: string;
      message?: string;
      status?: string;
    }>;
    parakeetUnload: () => Promise<{ ok: boolean }>;
    parakeetTranscribe: (payload: {
      samples: Float32Array;
      sampleRate: number;
    }) => Promise<{
      ok: boolean;
      text?: string;
      decodeMs?: number;
      loadMs?: number;
      rssMb?: number;
      rtf?: number;
      code?: string;
      message?: string;
    }>;
    parakeetDiagnostics: () => Promise<{
      status: string;
      loadMs: number | null;
      breakdown?: {
        spawn: number | null;
        require: number | null;
        read: number | null;
        construct: number | null;
        total: number;
        endToEnd: number;
        modelBytes: number | null;
      } | null;
      rssMb: number | null;
      decodeMs?: number | null;
      rtf?: number | null;
      mode?: "primary" | "comparison";
      queued: number;
      inFlight: number;
      consecutiveFailures: number;
    }>;
    // System memory, numbers only: available/total physical RAM in MB, read by
    // the ASR fallback guard to refuse a Moonshine load under
    // MIN_FALLBACK_AVAILABLE_MB. No processes, no paths, no transcripts.
    getSystemMemory: () => Promise<{ availableMb: number; totalMb: number }>;

    // ── Model download ────────────────────────────────────────────────
    //
    // The renderer drives this and displays it, but performs none of it. The
    // download, the extraction and every integrity check happen in the main
    // process, which is the only side with filesystem access.
    //
    // Typed inline rather than imported: this file is a global `declare`
    // script, and adding a top-level import would turn it into a module and
    // silently break the `Window` augmentation for every consumer.
    parakeetModelStatus: () => Promise<{
      status: "missing" | "downloading" | "verifying" | "ready" | "error";
      progress: number | null;
      bytesDownloaded: number;
      bytesTotal: number;
      message: string | null;
      dir: string;
    }>;
    parakeetModelDownload: () => Promise<{
      status: "missing" | "downloading" | "verifying" | "ready" | "error";
      progress: number | null;
      bytesDownloaded: number;
      bytesTotal: number;
      message: string | null;
      dir: string;
    }>;
    parakeetModelCancel: () => Promise<{ ok: boolean }>;
    parakeetModelRemove: () => Promise<{
      status: "missing" | "downloading" | "verifying" | "ready" | "error";
      progress: number | null;
      bytesDownloaded: number;
      bytesTotal: number;
      message: string | null;
      dir: string;
    }>;

    // ── Dev-only screen visibility ────────────────────────────────────
    // Runtime-only (not persisted) and refused by the main process in a
    // packaged build.
    setVisibility: (
      mode: "visible" | "hidden",
    ) => Promise<{ ok: boolean; mode: "visible" | "hidden" }>;
    getVisibility: () => Promise<"visible" | "hidden">;

    // ── One-shot local screen text ────────────────────────────────
    //
    // OCR of an image the renderer already holds (an attached screenshot).
    // Returns TEXT and never pixels, and writes nothing to disk. Used when
    // building a prompt for an attached screenshot; cloud providers still
    // receive the image itself. The automatic screen watcher that used this
    // channel for polling was removed.
    ocrImageText: (payload: { dataUrl: string }) => Promise<{
      ok: boolean;
      text?: string;
      code?: string;
      message?: string;
      width?: number;
      height?: number;
    }>;
  };
}
