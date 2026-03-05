/// <reference types="vite/client" />

interface Window {
  ghostly: {
    getDesktopSources: () => Promise<{ id: string; name: string }[]>;
    enableMouse: () => void;
    disableMouse: () => void;
    hide: () => void;
    show: () => void;
    captureFullscreen: () => Promise<string>;

    // Settings
    getSettings: () => Promise<any>;
    saveSettings: (settings: any) => Promise<void>;

    // History
    getHistory: () => Promise<any[]>;
    saveHistory: (history: any[]) => Promise<void>;

    // Events
    onScreenshot: (cb: (b64: string) => void) => () => void;
    onSolve: (cb: () => void) => () => void;
    onStartOver: (cb: () => void) => () => void;
  };
}
