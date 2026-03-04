/// <reference types="vite/client" />

interface GhostlyAPI {
  enableMouse: () => void;
  disableMouse: () => void;
  hide: () => void;
  show: () => void;
  captureFullscreen: () => Promise<string>;
  getSettings: () => Promise<any>;
  saveSettings: (settings: any) => Promise<void>;
  getHistory: () => Promise<any[]>;
  saveHistory: (history: any[]) => Promise<void>;
  onScreenshot: (cb: (b64: string) => void) => () => void;
  onSolve: (cb: () => void) => () => void;
  onStartOver: (cb: () => void) => () => void;
}

declare global {
  interface Window {
    ghostly: GhostlyAPI;
  }
}

export {};
