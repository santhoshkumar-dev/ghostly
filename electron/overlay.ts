import { BrowserWindow, screen } from "electron";
import path from "path";
import { applyStealthMode } from "./stealth";

export function createOverlayWindow(): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  const overlay = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  overlay.setIgnoreMouseEvents(false);
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setAlwaysOnTop(true, "screen-saver");

  // Apply strongest stealth — WDA_EXCLUDEFROMCAPTURE on Win10 2004+
  applyStealthMode(overlay);

  return overlay;
}
