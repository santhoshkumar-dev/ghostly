import { contextBridge, ipcRenderer } from "electron";

/**
 * What the main process sends with the solve hotkey.
 *
 * `pressedAt` is a `Date.now()` instant in the MAIN process. It is the only
 * value that crosses the process boundary for latency purposes, precisely
 * because `performance.now()` origins differ between main and renderer and can
 * never be subtracted across them.
 */
export interface SolveHotkeyPayload {
  pressedAt: number | null;
}

contextBridge.exposeInMainWorld("ghostly", {
  // System Audio source fetcher
  getDesktopSources: (): Promise<{id: string, name: string}[]> =>
    ipcRenderer.invoke("ghostly:get-desktop-sources"),

  // Mouse click-through control
  enableMouse: (): void => ipcRenderer.send("ghostly:enable-mouse"),
  disableMouse: (): void => ipcRenderer.send("ghostly:disable-mouse"),

  // Window control
  hide: (): void => ipcRenderer.send("ghostly:hide"),
  show: (): void => ipcRenderer.send("ghostly:show"),

  // ── Ghostly's own window opacity ────────────────────────────────────────
  //
  // NOT the Region Picker's dim overlay: that is a separate window with its own
  // slider and its own range. This controls how see-through Ghostly's own window
  // is, so the interview app stays visible behind it.
  //
  // Read on mount so the slider shows the persisted value, and written on every
  // change so a restart restores it. `percent` is supplied so the UI never has to
  // do its own rounding (and therefore never disagrees with the main process).
  getOverlayOpacity: (): Promise<{
    opacity: number;
    percent: number;
    hidden: boolean;
  }> => ipcRenderer.invoke("ghostly:get-overlay-opacity"),

  setOverlayOpacity: (
    value: number,
  ): Promise<{ opacity: number; percent: number; hidden: boolean }> =>
    ipcRenderer.invoke("ghostly:set-overlay-opacity", value),

  // Capture
  captureFullscreen: (): Promise<string> =>
    ipcRenderer.invoke("ghostly:capture-fullscreen"),

  // ── One-shot local screen text ─────────────────────────────────────
  //
  // OCR of an image the renderer already captured (an attached screenshot).
  // Returns TEXT, never pixels, and writes nothing to disk. Used when building
  // a prompt that carries explicit screen context; cloud providers still
  // receive the image itself. The automatic watcher is gone.
  ocrImageText: (payload: { dataUrl: string }): Promise<{
    ok: boolean;
    text?: string;
    code?: string;
    message?: string;
    width?: number;
    height?: number;
  }> => ipcRenderer.invoke("ghostly:ocr-image", payload),

  // Settings persistence
  getSettings: (): Promise<any> => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings: any): Promise<void> =>
    ipcRenderer.invoke("save-settings", settings),

  // History persistence
  getHistory: (): Promise<any[]> => ipcRenderer.invoke("get-history"),
  saveHistory: (history: any[]): Promise<void> =>
    ipcRenderer.invoke("save-history", history),

  // ── Deepgram (optional second ASR engine) ──────────────────────────────
  // Deliberately exposes NO way to read the long-lived API key. The renderer
  // can ask whether one exists (boolean) and request a 30-second token minted
  // by the main process. See electron/deepgram.ts for why that indirection is
  // required rather than merely tidy: a browser WebSocket cannot send an
  // Authorization header, so a short-lived token is the only way to
  // authenticate a socket without exposing the secret.
  deepgramHasKey: (): Promise<boolean> =>
    ipcRenderer.invoke("deepgram:has-key"),

  deepgramToken: (): Promise<
    | { ok: true; token: string; expiresIn: number }
    | { ok: false; code: string; message: string }
  > => ipcRenderer.invoke("deepgram:token"),

  // ── Groq Whisper (optional third ASR engine, comparison only) ──────────
  // The long-lived key never crosses this boundary: the renderer can only ask
  // whether one is configured, set/replace one, and submit captured audio.
  groqAsrHasKey: (): Promise<boolean> =>
    ipcRenderer.invoke("groq:has-key"),

  groqSetKey: (value: string): Promise<{ ok: boolean; configured: boolean }> =>
    ipcRenderer.invoke("groq:set-key", value),

  groqTranscribe: (payload: {
    wav: ArrayBuffer;
    model?: string;
    language?: string;
    prompt?: string;
  }): Promise<any> => ipcRenderer.invoke("groq:transcribe", payload),

  // ── Dev-only ASR comparison export ─────────────────────────────────
  // Writes the `asrComparisons` records to a JSON file. The destination is
  // fixed by the main process and is NOT chosen by the renderer — an export
  // that accepts an arbitrary path is a file-write primitive. The payload is
  // engine text and numbers only; there is no audio anywhere in this path.
  writeAsrComparisonExport: (json: string): Promise<{
    ok: boolean;
    path?: string;
    bytes?: number;
    message?: string;
  }> => ipcRenderer.invoke("asr:write-export", { json }),

  // ── Dev-only: save captured debug clips ─────────────────────────────
  // Writes the session's WAV clips plus the comparison JSON into a
  // timestamped folder under `debug-audio/`. Called ONLY by the explicit
  // "Save all debug clips" button; no capture path triggers it. The folder
  // name is validated in the main process and cannot be used to write
  // anywhere else.
  saveDebugClips: (payload: {
    session?: string;
    files: Array<{ name: string; data: Uint8Array }>;
    exportJson?: string;
  }): Promise<{
    ok: boolean;
    dir?: string;
    written?: number;
    message?: string;
  }> => ipcRenderer.invoke("asr:save-debug-clips", payload),

  // ── Parakeet (DEVELOPMENT COMPARISON ENGINE ONLY) ─────────────────────
  //
  // Deliberately narrow: the renderer may ask for the model status, ask for the
  // model to be loaded or released, submit an already-captured 16 kHz segment
  // for a comparison transcript, and read dev diagnostics. It can never touch
  // the model itself, and the result is written ONLY to the isolated
  // `asrComparisons` slice — never to the transcript, the question gate, the
  // prompt, or the answer path.
  //
  // The main process refuses every call unless the dev setting is on and it is
  // not a packaged build, so these are inert in a shipped app.
  parakeetStatus: (): Promise<{
    status: "disabled" | "missing" | "loading" | "ready" | "error";
    mode?: "primary" | "comparison";
  }> => ipcRenderer.invoke("parakeet:status"),

  // ── Model download (Settings) ────────────────────────────────────────
  //
  // Safe to poll: the handler stats four files and returns a small object. The
  // download itself runs entirely in the main process — the renderer has no
  // filesystem access, and 460 MB must not be buffered in a web context.
  //
  // `modelDownload` is idempotent while a download is running, so a double
  // click joins the in-flight transfer rather than starting a second one.
  parakeetModelStatus: (): Promise<{
    status: "missing" | "downloading" | "verifying" | "ready" | "error";
    progress: number | null;
    bytesDownloaded: number;
    bytesTotal: number;
    message: string | null;
    dir: string;
  }> => ipcRenderer.invoke("parakeet:modelStatus"),

  parakeetModelDownload: (): Promise<{
    status: "missing" | "downloading" | "verifying" | "ready" | "error";
    progress: number | null;
    bytesDownloaded: number;
    bytesTotal: number;
    message: string | null;
    dir: string;
  }> => ipcRenderer.invoke("parakeet:modelDownload"),

  parakeetModelCancel: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("parakeet:modelCancel"),

  parakeetModelRemove: (): Promise<{
    status: "missing" | "downloading" | "verifying" | "ready" | "error";
    progress: number | null;
    bytesDownloaded: number;
    bytesTotal: number;
    message: string | null;
    dir: string;
  }> => ipcRenderer.invoke("parakeet:modelRemove"),

  parakeetLoad: (): Promise<{
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
  }> => ipcRenderer.invoke("parakeet:load"),

  parakeetUnload: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("parakeet:unload"),

  parakeetTranscribe: (payload: {
    samples: Float32Array;
    sampleRate: number;
  }): Promise<{
    ok: boolean;
    text?: string;
    decodeMs?: number;
    loadMs?: number;
    rssMb?: number;
    rtf?: number;
    code?: string;
    message?: string;
  }> => ipcRenderer.invoke("parakeet:transcribe", payload),

  // Counts and timings only — never audio, never model contents.
  parakeetDiagnostics: (): Promise<{
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
    queued: number;
    inFlight: number;
    consecutiveFailures: number;
    mode?: "primary" | "comparison";
  }> => ipcRenderer.invoke("parakeet:diagnostics"),

  // ── System memory, numbers only ──────────────────────────────────────
  //
  // Available/total physical RAM in MB for the renderer's ASR fallback guard:
  // a Moonshine fallback load is refused below MIN_FALLBACK_AVAILABLE_MB so it
  // can never push the machine into severe memory pressure. No processes, no
  // paths, no transcripts — nothing sensitive crosses this bridge.
  getSystemMemory: (): Promise<{ availableMb: number; totalMb: number }> =>
    ipcRenderer.invoke("ghostly:get-system-memory"),

  // ── Dev-only screen visibility ───────────────────────────────────────
  // Runtime-only and dev-gated in the main process. Returns the mode that
  // actually took effect, which may differ from the request if it was
  // rejected (production build, or malformed input).
  setVisibility: (mode: "visible" | "hidden"): Promise<{
    ok: boolean;
    mode: "visible" | "hidden";
  }> => ipcRenderer.invoke("ghostly:set-visibility", mode),

  getVisibility: (): Promise<"visible" | "hidden"> =>
    ipcRenderer.invoke("ghostly:get-visibility"),

  // Events from main process (hotkeys)
  onScreenshot: (cb: (b64: string) => void): (() => void) => {
    const listener = (_: any, b64: string): void => cb(b64);
    ipcRenderer.on("ghostly:screenshot", listener);
    return () => ipcRenderer.removeListener("ghostly:screenshot", listener);
  },

  // Ctrl+Shift+S — Capture Screen.
  //
  // The main process registers the GLOBAL shortcut and forwards it here, where
  // the renderer runs the SAME `captureScreen` callback the Capture Screen
  // BUTTON runs → same `ghostly:capture-fullscreen` IPC → same
  // `captureFullScreen()`. One implementation, two triggers — deliberately NOT
  // a second capture path like the tray/hide hotkey uses.
  onCaptureScreen: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("ghostly:capture-screen", listener);
    return () => ipcRenderer.removeListener("ghostly:capture-screen", listener);
  },

  onSolve: (cb: (payload: SolveHotkeyPayload) => void): (() => void) => {
    // The payload carries the MAIN process' wall-clock press instant, because
    // `performance.now()` origins differ across processes and the renderer
    // cannot otherwise know when the key was actually pressed.
    const listener = (_e: unknown, payload: SolveHotkeyPayload): void =>
      cb(payload ?? { pressedAt: null });
    ipcRenderer.on("ghostly:solve", listener);
    return () => ipcRenderer.removeListener("ghostly:solve", listener);
  },

  onStartOver: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("ghostly:start-over", listener);
    return () => ipcRenderer.removeListener("ghostly:start-over", listener);
  },

  onInterviewType: (type: string, cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on(`ghostly:interview-type-${type}`, listener);
    return () => ipcRenderer.removeListener(`ghostly:interview-type-${type}`, listener);
  },

  // Start / Stop Interview (Ctrl+I) and Next Question (Ctrl+N).
  onToggleInterview: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("ghostly:toggle-interview", listener);
    return () => ipcRenderer.removeListener("ghostly:toggle-interview", listener);
  },

  onNextQuestion: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("ghostly:next-question", listener);
    return () => ipcRenderer.removeListener("ghostly:next-question", listener);
  },
});
