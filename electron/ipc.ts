import { ipcMain, desktopCapturer, session, app } from "electron";
import { captureFullScreen } from "./capture";
import type { SelfExcludingCapture } from "./captureSelfExclusion";
import { registerDeepgramHandlers } from "./deepgram";
import { registerGroqAsrHandlers } from "./groqAsr";
import { registerParakeetHandlers, resolveModelDir } from "./parakeetAsr";
import { registerAsrExportHandlers } from "./asrExport";
import { registerDebugClipHandlers } from "./debugClipWriter";
import { readImageText } from "./screenOcr";
import { DEFAULT_OVERLAY_OPACITY } from "./overlayOpacity";
import { readSystemMemory } from "../src/lib/systemMemory";
import Store from "electron-store";

const store = new Store({
  name: "ghostly-data",
  encryptionKey: "ghostly-secure-key-v1",
  defaults: {
    // NOTE: these defaults must stay in sync with `useStore`'s defaults.
    // They used to say `providerOrder: ["groq", "gemini"]` with no OpenRouter
    // entry at all, which meant a store that had never been written to handed
    // the renderer a Groq-first chain — the live interview path then ran on
    // Groq while the UI claimed OpenRouter was configured.
settings: {
      activeProvider: "gemini",
      models: {
        // VERIFIED against the live API with the app's exact streaming path
        // (HTTP 200, first text 1.2–1.4s). Retired ids like
        // `gemini-2.5-flash-lite` answer HTTP 404 and were removed.
        gemini: "gemini-2.5-flash",
        openai: "gpt-4o",
        anthropic: "claude-3-5-sonnet-20241022",
        groq: "openai/gpt-oss-120b",
        // Free ROUTER — OpenRouter picks the concrete model per request.
        openrouter: "openrouter/free",
      },
      // MUST stay in sync with `useStore`'s defaults and with
      // `INTERVIEW_PROVIDER_ORDER`. Local Qwen and NVIDIA no longer exist in
      // the registry, so a persisted order containing them is filtered out by
      // `isProviderName` when the renderer loads.
      providerOrder: ["gemini", "openrouter"],
      interviewType: "dsa",
      language: "python",
      apiKeys: {
        gemini: "",
        openai: "",
        anthropic: "",
        groq: "",
        openrouter: "",
      },
      // Ghostly's own window opacity, 0.2–1.0. Lives HERE, in the main-process
      // store, rather than in the renderer's `Settings` object, because the
      // window has to be at the right opacity before the first renderer paint —
      // a value that round-tripped through React would show a full-opacity frame
      // first. Read by `main.ts` at boot and written on every slider change.
      // See `electron/overlayOpacity.ts`.
      overlayOpacity: DEFAULT_OVERLAY_OPACITY,
      // Optional second ASR engine. Ghostly runs fully on local Moonshine
      // without this. Read ONLY in the main process (see electron/deepgram.ts).
      deepgramKey: "",
      // MUST stay in sync with `useStore`. Parakeet is the default interview
      // ASR; Moonshine remains the local fallback. See src/lib/primaryAsr.ts.
      primaryAsr: "parakeet",
    },
    history: [],
    // Groq Whisper ASR key — TOP-LEVEL, deliberately outside `settings`.
    // The renderer persists the whole settings object, so nesting a secret in
    // it would round-trip the key through the renderer. See electron/groqAsr.ts.
    groqAsrKey: "",
  },
});

/**
 * The persisted Ghostly window opacity.
 *
 * Exposed for `main.ts`, which needs it BEFORE the renderer exists: the window
 * must be created at the user's chosen opacity rather than flashing fully opaque
 * and correcting a frame later. Returns `undefined` for a store that has never
 * been written, which the controller normalizes to the default.
 */
export function readPersistedOverlayOpacity(): unknown {
  const settings = store.get("settings") as
    | { overlayOpacity?: unknown }
    | undefined;
  return settings?.overlayOpacity;
}

/**
 * Persist the chosen opacity.
 *
 * Writes the WHOLE `settings` object, so the read-modify-write is done here in
 * one place. The renderer also writes `settings` wholesale via `save-settings`,
 * so the two writers must agree on the shape — hence this goes through the same
 * `store.set("settings", …)` key rather than a second store.
 */
export function persistOverlayOpacity(opacity: number): void {
  const settings = (store.get("settings") ?? {}) as Record<string, unknown>;
  if (settings.overlayOpacity === opacity) return;
  store.set("settings", { ...settings, overlayOpacity: opacity });
}

export function registerIpcHandlers(
  /**
   * The self-excluding capture wrapper built by `main.ts` from the overlay's own
   * opacity controller and stealth binding.
   *
   * It is REQUIRED rather than optional: the renderer-driven capture route (the
   * Capture Screen button and Ctrl+Shift+S) used to call `captureFullScreen()`
   * directly, so Ghostly's own window was composited into the image that local OCR
   * then read. See `captureSelfExclusion.ts` for the full failure. Making it a
   * required argument means a caller cannot silently reintroduce that.
   */
  selfExcludingCapture: SelfExcludingCapture,
): void {
  // Grants navigator.mediaDevices.getDisplayMedia() a screen with system-audio
  // loopback, so the renderer can transcribe the interviewer's voice. Using
  // this handler avoids the flaky legacy `chromeMediaSource: 'desktop'` path.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"], fetchWindowIcons: false })
        .then((sources) => {
          const screenSource =
            sources.find((s) => s.name.includes("Screen")) ?? sources[0];
          if (!screenSource) {
            console.error("No screen source available for display capture");
            callback({});
            return;
          }
          callback({ video: screenSource, audio: "loopback" });
        })
        .catch((error) => {
          console.error("Failed to resolve display media source:", error);
          callback({});
        });
    },
  );

  // Desktop sources for audio capture
  ipcMain.handle("ghostly:get-desktop-sources", async () => {
    try {
      const sources = await desktopCapturer.getSources({ 
        types: ["screen", "window"],
        fetchWindowIcons: false 
      });
      return sources.map((s) => ({ id: s.id, name: s.name }));
    } catch (error) {
      console.error("Failed to get desktop sources:", error);
      throw error;
    }
  });

  // ── Local screen text (LOCAL fallback only) ──────────────────────────────
  //
  // The local model is text-only, so a screenshot has to become text before it
  // can use one. The renderer hands over the image it already captured and gets
  // back TEXT — never pixels — and nothing is written to disk. See
  // electron/screenOcr.ts for the privacy contract.
  ipcMain.handle("ghostly:ocr-image", (_event, payload: { dataUrl?: unknown }) =>
    readImageText(payload?.dataUrl),
  );

  // ── System memory for the renderer's ASR fallback guard ────────────────
  //
  // NUMBERS ONLY (available/total MB, no processes, no paths). The renderer
  // uses this to REFUSE a Moonshine fallback load when RAM is too low
  // (`MIN_FALLBACK_AVAILABLE_MB`), so a fallback can never push the machine
  // into severe memory pressure. It is a point-in-time reading for a resource
  // decision, not a transcript, a key or audio — nothing sensitive crosses.
  ipcMain.handle("ghostly:get-system-memory", () => {
    const mem = readSystemMemory();
    return { availableMb: mem.availableMb, totalMb: mem.totalMb };
  });

  // Full-screen capture.
  //
  // The Capture Screen button and Ctrl+Shift+S both arrive here, and BOTH go
  // through `selfExcludingCapture` so the image Ghostly's OCR reads can never
  // contain Ghostly. `captureFullScreen` is unchanged underneath: this is the
  // same capture, wrapped so the window is out of the composited picture while
  // the pixels are read.
  ipcMain.handle("ghostly:capture-fullscreen", async () => {
    try {
      return await selfExcludingCapture.run(() => captureFullScreen());
    } catch (error) {
      console.error("Failed to capture fullscreen:", error);
      throw error;
    }
  });

  // Legacy capture handlers (kept for compatibility). Same wrapper, so a legacy
  // caller cannot be the one route that photographs Ghostly.
  ipcMain.handle("capture-screen", async () => {
    try {
      return await selfExcludingCapture.run(() => captureFullScreen());
    } catch (error) {
      console.error("Failed to capture screen:", error);
      throw error;
    }
  });

  // Settings
  ipcMain.handle("get-settings", () => {
    return store.get("settings");
  });

  ipcMain.handle("save-settings", (_event, settings: any) => {
    store.set("settings", settings);
  });

  // History
  ipcMain.handle("get-history", () => {
    return store.get("history") || [];
  });

  ipcMain.handle("save-history", (_event, history: any[]) => {
    store.set("history", history);
  });

  // Deepgram short-lived token minting. The long-lived API key is read from the
  // store HERE and only a 30s JWT crosses the IPC boundary. See electron/deepgram.ts.
  registerDeepgramHandlers(store);

  // Groq Whisper ASR (comparison only). The long-lived key never crosses the
  // IPC boundary — the main process performs the request. See electron/groqAsr.ts.
  registerGroqAsrHandlers(store);

  // Dev-only: write captured debug clips + the comparison JSON into a
  // timestamped `debug-audio/<session>/` folder (gitignored). Only ever called
  // by the explicit "Save all debug clips" button — nothing is written
  // automatically, and nothing is uploaded.
  registerDebugClipHandlers();

  // Dev-only: write the `asrComparisons` export to JSON for offline
  // benchmarking. Moonshine runs in a Web Worker and cannot be driven from the
  // Node harness, so its results have to come out of a live session — this is
  // the only path that gets them out. Engine text and numbers, never audio.
  registerAsrExportHandlers({
    resolveDir: () => app.getPath("userData"),
  });

  // ── Parakeet ─────────────────────────────────────────────────────────────
  //
  // Two INDEPENDENT ways in, read from the same persisted `settings` blob the
  // renderer writes — not from zustand, which lives in the renderer and never
  // crosses the process boundary. That was the original bug: the toggle updated
  // a renderer-side store and the main process, which is what actually decides,
  // never saw it.
  //
  //   1. `primaryAsr !== "moonshine"` — Parakeet is the default engine (see
  //      src/lib/primaryAsr.ts), so this fires for a default store. Allowed in a
  //      packaged build, because the model is downloaded into userData at the
  //      user's own request rather than shipped in the installer.
  //
  //   2. `asrCompareParakeet === true` — the dev-only comparison column. Still
  //      hard-disabled when packaged, so a shipped app never resolves a model
  //      directory it has no business touching.
  //
  // Note (1) is deliberately allowed in production. The code default IS
  // Parakeet now, so this is the normal path; an explicit `"moonshine"` stored
  // by the user is the only thing that turns the Parakeet host off.
  registerParakeetHandlers({
    isEnabled: () => {
      const settings = store.get("settings") as
        | { asrCompareParakeet?: boolean; primaryAsr?: string }
        | undefined;
      if (!settings) return false;
      // Parakeet is the DEFAULT: only an explicit "moonshine" turns it off.
      // This must match `normalizePrimaryAsr`, or the renderer would ask the
      // main process to load an engine it refuses to load.
      if (settings.primaryAsr !== "moonshine") return true;
      return (
        !app.isPackaged &&
        process.env.NODE_ENV !== "production" &&
        settings.asrCompareParakeet === true
      );
    },
    isPrimary: () => {
      const settings = store.get("settings") as
        | { primaryAsr?: string }
        | undefined;
      return settings ? settings.primaryAsr !== "moonshine" : false;
    },
    modelDir: resolveModelDir({
      override: store.get("parakeetModelDir") as string | undefined,
      userDataDir: app.getPath("userData"),
    }),
    paddingMs: () =>
      (store.get("settings") as { parakeetPaddingMs?: number } | undefined)
        ?.parakeetPaddingMs,
  });
}
