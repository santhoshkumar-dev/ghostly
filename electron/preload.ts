import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ghostly", {
  // Mouse click-through control
  enableMouse: (): void => ipcRenderer.send("ghostly:enable-mouse"),
  disableMouse: (): void => ipcRenderer.send("ghostly:disable-mouse"),

  // Window control
  hide: (): void => ipcRenderer.send("ghostly:hide"),
  show: (): void => ipcRenderer.send("ghostly:show"),

  // Capture
  captureFullscreen: (): Promise<string> =>
    ipcRenderer.invoke("ghostly:capture-fullscreen"),

  // Settings persistence
  getSettings: (): Promise<any> => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings: any): Promise<void> =>
    ipcRenderer.invoke("save-settings", settings),

  // History persistence
  getHistory: (): Promise<any[]> => ipcRenderer.invoke("get-history"),
  saveHistory: (history: any[]): Promise<void> =>
    ipcRenderer.invoke("save-history", history),

  // Events from main process (hotkeys)
  onScreenshot: (cb: (b64: string) => void): (() => void) => {
    const listener = (_: any, b64: string): void => cb(b64);
    ipcRenderer.on("ghostly:screenshot", listener);
    return () => ipcRenderer.removeListener("ghostly:screenshot", listener);
  },

  onSolve: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("ghostly:solve", listener);
    return () => ipcRenderer.removeListener("ghostly:solve", listener);
  },

  onStartOver: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("ghostly:start-over", listener);
    return () => ipcRenderer.removeListener("ghostly:start-over", listener);
  },
});
