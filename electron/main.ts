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
import { registerHotkeys, unregisterHotkeys } from "./hotkeys";
import { registerIpcHandlers } from "./ipc";
import { applyStealthMode } from "./stealth";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

/**
 * Re-apply stealth mode. Called on every show event to ensure
 * the window stays invisible to screen capture at all times.
 */
function enforceStealthOnWindow(win: BrowserWindow): void {
  // Apply on every 'show' event — affinity can be lost on hide/show cycles
  win.on("show", () => {
    console.log("[Ghostly] Window shown — re-applying stealth");
    applyStealthMode(win);
  });

  // Also re-apply on focus (belt-and-suspenders)
  win.on("focus", () => {
    applyStealthMode(win);
  });

  // Apply on restore from minimize
  win.on("restore", () => {
    console.log("[Ghostly] Window restored — re-applying stealth");
    applyStealthMode(win);
  });
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

  win.once("ready-to-show", () => {
    win.show();
    // Initial stealth application (also triggers via 'show' event above)
    applyStealthMode(win);
  });

  return win;
}

function toggleWindowVisibility() {
  if (mainWindow) {
    const isHidden = mainWindow.getOpacity() === 0;
    if (isHidden) {
      mainWindow.setOpacity(1);
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
      mainWindow.focus();
    } else {
      mainWindow.setOpacity(0);
      mainWindow.blur();
      mainWindow.setIgnoreMouseEvents(true, { forward: false });
    }
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
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send("ghostly:screenshot");
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
  registerIpcHandlers();
  mainWindow = createMainWindow();
  tray = createTray();
  registerHotkeys(mainWindow);

  // Mouse enable/disable for click-through
  ipcMain.on("ghostly:enable-mouse", () => {
    // Only enable if window is actually "visible"
    if (mainWindow && mainWindow.getOpacity() > 0) {
      mainWindow.setIgnoreMouseEvents(false);
    }
  });

  ipcMain.on("ghostly:disable-mouse", () => {
    // Only forward hover events if window is actually "visible"
    if (mainWindow) {
      const isVisible = mainWindow.getOpacity() > 0;
      mainWindow.setIgnoreMouseEvents(true, { forward: isVisible });
    }
  });

  // Window control
  ipcMain.on("ghostly:hide", () => {
    if (mainWindow) {
      mainWindow.setOpacity(0);
      mainWindow.blur();
      mainWindow.setIgnoreMouseEvents(true, { forward: false });
    }
  });

  ipcMain.on("ghostly:show", () => {
    if (mainWindow) {
      mainWindow.setOpacity(1);
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
      mainWindow.focus();
    }
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
  unregisterHotkeys();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow();
  }
});
