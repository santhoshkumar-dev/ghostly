import { globalShortcut, BrowserWindow } from "electron";
import { captureFullScreen } from "./capture";
import { applyStealthMode } from "./stealth";
import {
  createSelfExcludingCapture,
  type SelfExcludingCapture,
} from "./captureSelfExclusion";
import type { OverlayOpacityController } from "./overlayOpacity";

const MOVE_STEP = 25;

// Simple mutex to prevent race conditions between hotkeys
let isBusy = false;

/**
 * Ghostly's window opacity, owned by `main.ts`.
 *
 * ── Why the hotkeys need it at all ──────────────────────────────────────────
 * Hide/show used to be `setOpacity(0)` / `setOpacity(1)`. Once the window has a
 * real, user-chosen opacity, that encoding is ambiguous in two directions:
 *
 *   • `win.getOpacity() > 0` no longer means "visible" — a 20%-opacity window is
 *     `0.2` and very much on screen, so Ctrl+B would fail to hide it and the
 *     screenshot path would think it needed no hiding at all.
 *   • `setOpacity(1)` to restore would silently discard the user's transparency.
 *
 * So every show/hide below goes through the controller, which owns the
 * `hidden` flag and knows the opacity to restore. Held in module scope rather
 * than threaded through every call site because `captureAndSendScreenshot` is
 * also invoked from the tray menu in `main.ts`.
 */
let overlay: OverlayOpacityController | null = null;

/**
 * The one self-excluding capture implementation, shared by BOTH capture routes.
 *
 * Ctrl+H / the tray used to hide the window inline here, and the renderer's
 * Capture Screen button / Ctrl+Shift+S did not hide it at all — which is exactly
 * how Ghostly's own interface ended up in the image local OCR reads. Both now go
 * through `createSelfExcludingCapture`, so "keep Ghostly out of the picture" is
 * one tested function instead of one behaviour and one gap.
 *
 * Held in module scope because `captureAndSendScreenshot` is also invoked from
 * the tray menu in `main.ts`, exactly like the opacity controller above it.
 */
let selfExcludingCapture: SelfExcludingCapture | null = null;

const isOverlayVisible = (): boolean => (overlay ? overlay.isVisible() : true);

const setOverlayHidden = (hidden: boolean): void => {
  if (overlay) overlay.setHidden(hidden);
};

/**
 * Build the shared capture wrapper for a window. Called once from
 * `registerHotkeys`, which `main.ts` invokes after the controller exists.
 */
export function initSelfExcludingCapture(win: BrowserWindow): void {
  selfExcludingCapture = createSelfExcludingCapture({
    isOverlayVisible,
    hide: () => {
      // With no opacity controller (a caller that registered hotkeys without
      // one) the old `setOpacity(0/1)` pair still applies, so the fallback
      // behaviour of that path is unchanged.
      if (overlay) setOverlayHidden(true);
      else win.setOpacity(0);
      win.blur();
      win.setIgnoreMouseEvents(true, { forward: false });
    },
    restore: () => {
      if (overlay) setOverlayHidden(false);
      else win.setOpacity(1);
      win.setIgnoreMouseEvents(true, { forward: true });
      win.focus();
    },
    // `main.ts` re-applies the same flag on every show/focus/restore; asserting
    // it here too is what makes the capture self-excluding rather than
    // incidentally-excluded.
    forceCaptureExclusion: () => applyStealthMode(win),
    log: (line) => console.log(line),
  });
}

/**
 * Capture the full screen and hand the image to the renderer.
 *
 * Shared by the Ctrl+H hotkey and the tray's "Capture Screen" item so both take
 * the SAME screenshot. The tray item used to send `ghostly:screenshot` with no
 * payload at all: the renderer appended `undefined` to its screenshot list, so
 * Solve asked the provider to "analyze the problem in the screenshot" with no
 * screenshot attached. That is how a screenshot could be "taken" and no answer
 * ever arrive.
 *
 * The window is hidden for the capture when it is currently visible, so
 * Ghostly never photographs its own overlay — and restored to the user's chosen
 * opacity rather than to fully opaque. The hide/restore/settle itself lives in
 * the shared `selfExcludingCapture`, which the renderer-driven capture route uses
 * too.
 *
 * @returns true when an image was captured and sent.
 */
export async function captureAndSendScreenshot(
  win: BrowserWindow,
): Promise<boolean> {
  const capture = (): Promise<string> =>
    selfExcludingCapture
      ? selfExcludingCapture.run(() => captureFullScreen())
      : captureFullScreen();
  try {
    const base64 = await capture();
    win.webContents.send("ghostly:screenshot", base64);
    console.log("[Ghostly] Screenshot captured and sent to renderer");
    return true;
  } catch (err) {
    console.error("[Ghostly] Failed to capture screen:", err);
    // The overlay is restored by the wrapper's own `finally`, so there is no
    // state to repair here: deciding from the current opacity would restore a
    // window the user had already hidden before the capture started.
    return false;
  }
}

export function registerHotkeys(
  win: BrowserWindow,
  controller?: OverlayOpacityController,
): void {
  if (controller) overlay = controller;
  initSelfExcludingCapture(win);

  // Helper: show window
  const showWindow = () => {
    setOverlayHidden(false);
    if (!overlay) win.setOpacity(1);
    win.setIgnoreMouseEvents(true, { forward: true });
    win.focus();
  };

  // Helper: hide window
  const hideWindow = () => {
    setOverlayHidden(true);
    if (!overlay) win.setOpacity(0);
    win.blur();
    win.setIgnoreMouseEvents(true, { forward: false });
  };

  // Screenshot — Ctrl+H (hides window briefly, captures, restores)
  globalShortcut.register("CommandOrControl+H", async () => {
    if (isBusy) return;
    isBusy = true;
    try {
      await captureAndSendScreenshot(win);
    } finally {
      isBusy = false;
    }
  });

  // ── Capture Screen — Ctrl+Shift+S ──────────────────────────────────────
  //
  // Registered on the MAIN process through `globalShortcut`, after app ready
  // (`registerHotkeys` is called from `app.whenReady()`), so it fires even when
  // Ghostly does not have keyboard focus.
  //
  // It deliberately does NOT capture here. It forwards ONE event to the
  // renderer, where the handler runs the very same `captureScreen` callback the
  // Capture Screen BUTTON runs — same function, same `ghostly:capture-fullscreen`
  // IPC route, same `captureFullScreen()`. Two triggers, one implementation;
  // there is no second screenshot code path anywhere in this file for it.
  //
  // Registration can legitimately fail: Windows reserves some combos
  // system-wide (a snipping tool commonly holds Ctrl+Shift+S). The result is
  // logged either way and a failed registration never breaks startup. Nothing
  // about the image is ever logged — only the registration and trigger events.
  const captureShortcut = "CommandOrControl+Shift+S";
  if (globalShortcut.isRegistered(captureShortcut)) {
    // Restart/reload safety: replace rather than stack a duplicate handler.
    globalShortcut.unregister(captureShortcut);
  }
  const captureRegistered = globalShortcut.register(captureShortcut, () => {
    console.log("[Shortcut] Capture Screen triggered");
    win.webContents.send("ghostly:capture-screen");
  });
  console.log(
    captureRegistered
      ? "[Shortcut] Capture Screen registered: Ctrl+Shift+S"
      : "[Shortcut] Capture Screen registration FAILED: Ctrl+Shift+S is held by another application",
  );

  // Quick Capture — Ctrl+Shift+C.
  //
  // It used to capture WITHOUT hiding, and to call `captureFullScreen()`
  // directly, so it was the one route guaranteed to photograph Ghostly's own
  // overlay into the image the local OCR then reads. It now calls the SAME
  // function as Ctrl+H and the tray, so there is one capture implementation
  // behind every trigger.
  globalShortcut.register("CommandOrControl+Shift+C", async () => {
    if (isBusy) return;
    isBusy = true;
    try {
      await captureAndSendScreenshot(win);
    } finally {
      isBusy = false;
    }
  });

  // Solve / Ask AI — Ctrl+Enter (shows window if hidden, then solves)
  globalShortcut.register("CommandOrControl+Return", () => {
    if (!isOverlayVisible()) {
      showWindow();
    }
    win.focus();
    // `pressedAt` is the wall-clock instant of the keypress in THIS process.
    //
    // It exists because `performance.now()` has a different origin in the main
    // process than in the renderer, so a renderer-side duration can never reach
    // back to the press. `Date.now()` is the same clock on both sides of an IPC
    // hop, so the one cross-process metric —
    // `hotkey_pressed -> final transcript committed` — can be computed by
    // subtracting two `Date.now()` values. The accuracy of that subtraction is
    // the system clock's, not `performance.now()`'s, and the Latency report says
    // so rather than quoting a sub-millisecond figure it cannot deliver.
    win.webContents.send("ghostly:solve", { pressedAt: Date.now() });
  });

  // Show / Hide — Ctrl+B
  globalShortcut.register("CommandOrControl+B", () => {
    if (isOverlayVisible()) {
      hideWindow();
    } else {
      showWindow();
    }
  });

  // Start Over — Ctrl+G
  globalShortcut.register("CommandOrControl+G", () => {
    win.webContents.send("ghostly:start-over");
  });

  // Start / Stop Interview — Ctrl+I
  // Toggles the existing capture lifecycle. When the interview panel is closed
  // the renderer opens it and starts as soon as the ASR model is ready; it
  // never opens a second capture stream. Deliberately NOT Ctrl+Enter (Ask AI).
  globalShortcut.register("CommandOrControl+I", () => {
    win.webContents.send("ghostly:toggle-interview");
  });

  // Next Question — Ctrl+N
  // Resets the current interview question state only. It never starts/stops
  // capture and never submits the question to the AI.
  globalShortcut.register("CommandOrControl+N", () => {
    win.webContents.send("ghostly:next-question");
  });

  // Interview Type Shortcuts — Ctrl+Shift+1/2/3/4/5/6
  const interviewTypes: Record<string, string> = {
    "1": "dsa",
    "2": "system_design",
    "3": "frontend",
    "4": "sql",
    "5": "behavioral",
    "6": "general",
  };

  for (const [key, type] of Object.entries(interviewTypes)) {
    const reg = globalShortcut.register(`CommandOrControl+Shift+${key}`, () => {
      win.webContents.send(`ghostly:interview-type-${type}`);
      console.log(`[Ghostly] Interview type set to: ${type}`);
    });
    console.log(`[Ghostly] Ctrl+Shift+${key} registered for ${type}:`, reg);
  }

  // Move Up/Down/Left/Right (Ctrl + arrow keys)
  globalShortcut.register("CommandOrControl+Up", () => {
    const [x, y] = win.getPosition();
    win.setPosition(x, y - MOVE_STEP);
  });
  globalShortcut.register("CommandOrControl+Down", () => {
    const [x, y] = win.getPosition();
    win.setPosition(x, y + MOVE_STEP);
  });
  globalShortcut.register("CommandOrControl+Left", () => {
    const [x, y] = win.getPosition();
    win.setPosition(x - MOVE_STEP, y);
  });
  globalShortcut.register("CommandOrControl+Right", () => {
    const [x, y] = win.getPosition();
    win.setPosition(x + MOVE_STEP, y);
  });

  console.log("[Ghostly] All hotkeys registered");
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll();
}
