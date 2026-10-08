import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  screen,
  ipcMain,
} from "electron";
import path from "path";
import { registerHotkeys, unregisterHotkeys, captureAndSendScreenshot } from "./hotkeys";
import {
  registerIpcHandlers,
  readPersistedOverlayOpacity,
  persistOverlayOpacity,
} from "./ipc";
import { applyStealthMode, removeStealthMode } from "./stealth";
import { createSelfExcludingCaptureForWindow } from "./captureSelfExclusion";
import {
  createOverlayOpacityController,
  formatOpacityLog,
  opacityFromSliderValue,
  opacityToPercent,
  type OverlayOpacityController,
} from "./overlayOpacity";
import {
  createVisibilityController,
  STEALTH_REAPPLY_EVENTS,
  type VisibilityController,
  type VisibilityMode,
} from "./visibilityPolicy";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

/**
 * Ghostly's own window opacity.
 *
 * ── Why this replaces the old `setOpacity(0/1)` ─────────────────────────────
 * Hide and show used to be expressed as window opacity: `0` meant hidden and `1`
 * meant shown. That made the one knob the window had unavailable for the thing
 * the user actually asked for — seeing the interview app THROUGH Ghostly — and
 * it made "am I visible?" a question that had to be answered by reading the
 * opacity back.
 *
 * The controller keeps the two concerns apart (see `overlayOpacity.ts`) and every
 * caller below asks it instead of touching `setOpacity` directly.
 */
let opacityController: OverlayOpacityController;

/** Whether Ghostly is on screen. Never inferred from the opacity any more. */
function isOverlayVisible(): boolean {
  return opacityController?.isVisible() ?? false;
}

/** Push the window's hide/show opacity onto the window, if it exists yet. */
function setWindowOpacity(windowOpacity: number): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setOpacity(windowOpacity);
  }
}

/**
 * Push the surface alpha into the renderer as `--ghostly-alpha`.
 *
 * Sent as a CSS custom property rather than as a number the components read,
 * because a custom property is inherited: one write rescales every panel in the
 * overlay, and a component added later is automatically correct instead of
 * having to remember to consume a context value.
 *
 * The renderer ALSO reads the persisted value over IPC on mount. Both paths
 * exist on purpose: this one wins if it arrives first (no first-frame flash at
 * the wrong alpha after a restart), and the IPC read is what makes the value
 * correct even if this push is lost to a reload.
 */
function setChromeAlpha(alpha: number): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const script = `document.documentElement.style.setProperty("--ghostly-alpha", ${JSON.stringify(alpha)})`;
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", () => {
      if (!win.isDestroyed()) void win.webContents.executeJavaScript(script);
    });
  } else {
    void win.webContents.executeJavaScript(script).catch(() => undefined);
  }
}

/**
 * Re-apply stealth mode. Called on every show event to ensure
 * the window stays invisible to screen capture at all times.
 */
/**
 * Every registered window gets a visibility controller.
 *
 * The controller owns the current mode; the re-apply handlers ask it what to
 * do rather than calling `applyStealthMode` directly. That is what makes
 * show/focus/restore respect the mode — while `visible`, a re-assert clears
 * capture exclusion instead of re-adding it, which is what would otherwise
 * silently un-hide the window the moment it was shown.
 */
const visibilityControllers = new WeakMap<BrowserWindow, VisibilityController>();

function controllerFor(win: BrowserWindow): VisibilityController {
  const existing = visibilityControllers.get(win);
  if (existing) return existing;
  const controller = createVisibilityController({
    apply: () => applyStealthMode(win),
    remove: () => removeStealthMode(win),
    // The single canonical visibility log line. Never any other content.
    log: (line) => console.log(line),
  });
  visibilityControllers.set(win, controller);
  return controller;
}

function enforceStealthOnWindow(win: BrowserWindow): void {
  // Assert the current mode immediately, so the window starts in the mode it
  // is actually in rather than assuming `hidden`.
  controllerFor(win);

  // Re-apply on every event that can drop the window affinity. Iterating the
  // shared list keeps this in step with the tested policy.
  //
  // Electron types `BrowserWindow.on` as a long list of per-event overloads
  // with no generic string fallback, so the literal union from
  // `STEALTH_REAPPLY_EVENTS` matches none of them individually. The cast is
  // safe: every value in that list IS a real BrowserWindow event, and the list
  // is asserted in `verify-stealth.mts`.
  const reapply = () => controllerFor(win).reapply();
  for (const event of STEALTH_REAPPLY_EVENTS) {
    win.on(event as "show", reapply);
  }
}

function createMainWindow(): BrowserWindow {
  const primary = screen.getPrimaryDisplay().workAreaSize;
  const BAR_WIDTH = 900;
  const BAR_HEIGHT = 900;

  const win = new BrowserWindow({
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    x: Math.floor((primary.width - BAR_WIDTH) / 2),
    y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Workspace & z-order
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, "screen-saver");

  // Click-through by default — only settings gear + solution panel enable mouse
  win.setIgnoreMouseEvents(true, { forward: true });

  // *** CRITICAL: re-apply stealth on EVERY show/focus/restore ***
  enforceStealthOnWindow(win);

  // Load renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  // Forward renderer console/errors to terminal for debugging
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[Renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`[Renderer] Load FAILED: ${errorCode} - ${errorDescription}`);
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[Renderer] Process GONE: ${details.reason} (exitCode=${details.exitCode})`);
  });

  win.on("ready-to-show", () => {
    const bounds = win.getBounds();
    // Assert the persisted opacity at the moment the window first appears, and
    // re-assert the capture-exclusion mode. Both can be dropped by the window
    // manager between construction and first paint.
    opacityController?.reapply();
    console.log(
      `[Ghostly] Window ready — bounds: ${JSON.stringify(bounds)}, opacity: ${win.getOpacity()}`,
    );
    win.show();
    console.log(
      `[Ghostly] After show — visible: ${win.isVisible()}, opacity: ${win.getOpacity()}`,
    );
    // Assert the current visibility mode (also re-applied via the show event).
    controllerFor(win).reapply();
  });

  return win;
}

function toggleWindowVisibility() {
  if (!mainWindow) return;
  if (opacityController.toggleHidden()) {
    mainWindow.blur();
    mainWindow.setIgnoreMouseEvents(true, { forward: false });
  } else {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    mainWindow.focus();
  }
}

function createTray(): Tray {
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAY0lEQVR4nGNgGAXDBTAiC/z//5/h////DIyMjAxMTEwMYPr/fwYGBgYGBkZGRgYmRiADyIYJMDExAeUYGRmgcowgGsgGqWFkZASpYWJiAqthBOrBAKgaGA3igzCQP7xdMwoAAD6OI0GqswYnAAAAAElFTkSuQmCC",
  );

  const t = new Tray(icon);
  t.setToolTip("Ghostly — Stealth AI Assistant");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show/Hide Ghostly",
      click: toggleWindowVisibility,
    },
    {
      label: "Capture Screen",
      // Must go through the SAME capture the Ctrl+H hotkey uses. This used to
      // emit `ghostly:screenshot` with no payload, which appended `undefined`
      // to the renderer's screenshot list: Solve then sent a prompt that asked
      // for "the problem in the screenshot" while attaching no screenshot at
      // all, so no answer ever arrived.
      click: () => {
        if (mainWindow) {
          void captureAndSendScreenshot(mainWindow);
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit Ghostly",
      click: () => app.quit(),
    },
  ]);

  t.setContextMenu(contextMenu);
  t.on("click", toggleWindowVisibility);

  return t;
}

app.whenReady().then(() => {
  // Created BEFORE the window so the persisted opacity can be asserted on the
  // very first paint. `applyOverlayOpacity` is a no-op until `mainWindow`
  // exists, and `ready-to-show` re-asserts it afterwards.
  opacityController = createOverlayOpacityController({
    setWindowOpacity,
    setChromeAlpha,
    persist: persistOverlayOpacity,
    initial: readPersistedOverlayOpacity(),
    log: (line) => console.log(line),
  });
  // The controller deliberately stays silent when a value does not CHANGE, which
  // is right for the slider but leaves no record of what was restored at boot.
  // That record matters: "Ghostly looks wrong and I don't know why" is answered
  // by this one line.
  console.log(
    formatOpacityLog(opacityController.opacity(), opacityController.hidden()),
  );
  // ── The capture wrapper every capture route shares ──────────────────────
  //
  // `mainWindow` is read lazily inside the closures because it does not exist
  // yet at this point: the window is created on the next line. The wrapper only
  // touches it when a capture actually runs, by which time it does.
  const selfExcludingCapture = createSelfExcludingCaptureForWindow(
    opacityController,
    {
      blur: () => mainWindow?.blur(),
      focus: () => mainWindow?.focus(),
    },
    // Re-asserting the exclusion is what makes a capture correct even when the
    // dev-only visibility control has cleared the flag.
    () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        applyStealthMode(mainWindow);
      }
    },
    (line) => console.log(line),
  );
  registerIpcHandlers(selfExcludingCapture);
  // NOTE: the automatic screen watcher ("Auto-detect new question") and the
  // local Qwen sidecar were removed entirely — there is no initLiveScreen /
  // disposeLocalAi any more. Screenshots are MANUAL only (Capture Screen
  // button / Ctrl+Shift+S), and no child process is spawned at startup.
  mainWindow = createMainWindow();
  tray = createTray();
  registerHotkeys(mainWindow, opacityController);

  // Mouse enable/disable for click-through
  ipcMain.on("ghostly:enable-mouse", () => {
    // Only enable if Ghostly is actually on screen. Asks the controller rather
    // than reading the opacity back, so a 20%-opacity window — which is very
    // much visible — is never mistaken for a hidden one.
    if (mainWindow && isOverlayVisible()) {
      mainWindow.setIgnoreMouseEvents(false);
    }
  });

  ipcMain.on("ghostly:disable-mouse", () => {
    // Only forward hover events if Ghostly is actually on screen.
    if (mainWindow) {
      mainWindow.setIgnoreMouseEvents(true, { forward: isOverlayVisible() });
    }
  });

  // Window control
  ipcMain.on("ghostly:hide", () => {
    if (mainWindow) {
      opacityController.setHidden(true);
      mainWindow.blur();
      mainWindow.setIgnoreMouseEvents(true, { forward: false });
    }
  });

  ipcMain.on("ghostly:show", () => {
    if (mainWindow) {
      // Restores the CHOSEN opacity, not 1. Showing Ghostly used to silently
      // discard the user's transparency setting; that is exactly the "my
      // opacity reset itself" class of bug.
      opacityController.setHidden(false);
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
      mainWindow.focus();
    }
  });

  // ── Ghostly's own window opacity ────────────────────────────────────────
  //
  // Two channels only: read the current value, set a new one. There is
  // deliberately no "set hidden" channel here — hide/show stay bound to Ctrl+B
  // and the tray so that adjusting transparency can never be mistaken for
  // hiding the app, or vice versa.
  ipcMain.handle("ghostly:get-overlay-opacity", () => {
    const state = opacityController.current();
    return {
      opacity: state.opacity,
      percent: opacityToPercent(state.opacity),
      hidden: state.hidden,
    };
  });

  ipcMain.handle("ghostly:set-overlay-opacity", (_event, value: unknown) => {
    // The channel speaks WHOLE PERCENT (what a range input produces), while the
    // controller and the persisted setting speak a 0–1 fraction. Parsing with
    // `opacityFromSliderValue` rather than the fraction normalizer is what stops
    // "50%" from being read as 50 and clamped to fully opaque.
    const applied = opacityController.setOpacity(opacityFromSliderValue(value));
    return {
      opacity: applied,
      percent: opacityToPercent(applied),
      hidden: opacityController.hidden(),
    };
  });

  // ── Dev-only screen-visibility toggle ───────────────────────────────────
  //
  // RUNTIME-ONLY by design (requirement: persistence is only safe if the
  // existing architecture allows it, and it does not). Persisting this would
  // mean a developer could ship a build that is visible in screen capture and
  // only discover it after restarting. Runtime-only also guarantees the app
  // comes back `hidden` on every launch, which is the safe default.
  //
  // Gated on a dev build so it cannot be driven in production at all. The
  // renderer toggle is hidden too, but this is the enforcing half: a
  // tampered renderer cannot flip it in a release build.
  ipcMain.handle("ghostly:set-visibility", (_event, requested: unknown) => {
    if (!app.isPackaged && process.env.NODE_ENV !== "production") {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) {
        return { ok: false as const, mode: "hidden" as VisibilityMode };
      }
      // Unknown input normalizes to `hidden` — see visibilityPolicy.
      const mode = controllerFor(win).set(requested);
      return { ok: true as const, mode };
    }
    // Production: report the current (always hidden) mode, change nothing.
    return { ok: false as const, mode: "hidden" as VisibilityMode };
  });

  ipcMain.handle("ghostly:get-visibility", () => {
    const win = BrowserWindow.getAllWindows()[0];
    return win ? controllerFor(win).current() : "hidden";
  });

  // Move window
  ipcMain.on("ghostly:move", (_event, dx: number, dy: number) => {
    if (mainWindow) {
      const [x, y] = mainWindow.getPosition();
      mainWindow.setPosition(x + dx, y + dy);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // Unregisters EVERY global shortcut, including Ctrl+Shift+S (Capture
  // Screen), so a quitting Ghostly never leaves a bound accelerator behind.
  unregisterHotkeys();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow();
  }
});
