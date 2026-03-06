import { ipcMain, desktopCapturer } from "electron";
import { captureFullScreen } from "./capture";
import Store from "electron-store";

const store = new Store({
  name: "ghostly-data",
  encryptionKey: "ghostly-secure-key-v1",
  defaults: {
    settings: {
      activeProvider: "gemini",
      activeModel: "gemini-2.0-flash",
      interviewType: "dsa",
      language: "python",
      apiKeys: {
        gemini: "",
        openai: "",
        anthropic: "",
        groq: "",
      },
    },
    history: [],
  },
});

export function registerIpcHandlers(): void {
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

  // Full-screen capture
  ipcMain.handle("ghostly:capture-fullscreen", async () => {
    try {
      return await captureFullScreen();
    } catch (error) {
      console.error("Failed to capture fullscreen:", error);
      throw error;
    }
  });

  // Legacy capture handlers (kept for compatibility)
  ipcMain.handle("capture-screen", async () => {
    try {
      return await captureFullScreen();
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
}
