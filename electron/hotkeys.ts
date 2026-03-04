import { globalShortcut, BrowserWindow } from "electron";
import { captureFullScreen } from "./capture";

const MOVE_STEP = 25;

export function registerHotkeys(win: BrowserWindow): void {
  // Screenshot — Ctrl+H
  const regH = globalShortcut.register("CommandOrControl+H", async () => {
    try {
      // Briefly hide window so we don't capture ourselves
      const wasVisible = win.isVisible();
      if (wasVisible) win.hide();

      // Small delay to let the window hide
      await new Promise((r) => setTimeout(r, 150));

      const base64 = await captureFullScreen();

      // Show window and send screenshot
      win.show();
      win.focus();
      win.webContents.send("ghostly:screenshot", base64);
      console.log("[Ghostly] Screenshot captured and sent to renderer");
    } catch (err) {
      console.error("[Ghostly] Failed to capture screen:", err);
      // Make sure window is visible even on error
      if (!win.isVisible()) {
        win.show();
        win.focus();
      }
    }
  });
  console.log("[Ghostly] Ctrl+H registered:", regH);

  // Solve / Ask AI — Ctrl+Enter
  const regEnter = globalShortcut.register("CommandOrControl+Return", () => {
    win.show();
    win.focus();
    win.webContents.send("ghostly:solve");
  });
  console.log("[Ghostly] Ctrl+Enter registered:", regEnter);

  // Show / Hide — Ctrl+B
  const regB = globalShortcut.register("CommandOrControl+B", () => {
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });
  console.log("[Ghostly] Ctrl+B registered:", regB);

  // Start Over — Ctrl+G
  const regG = globalShortcut.register("CommandOrControl+G", () => {
    win.webContents.send("ghostly:start-over");
  });
  console.log("[Ghostly] Ctrl+G registered:", regG);

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
