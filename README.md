# 👻 Ghostly — Stealth AI Coding Assistant

A desktop app that runs as an invisible overlay, captures screen regions, and streams AI-powered solutions — completely invisible to screen share, Zoom, OBS, and Teams.

## ✨ Features

- **Invisible Overlay** — Window excluded from all screen capture via `setContentProtection(true)`
- **Click-Through Transparency** — Doesn't interfere with your workflow
- **Region Selector** — Crosshair drag UI to capture specific areas
- **AI Vision Streaming** — Screenshot → AI → streamed solution in real-time
- **Multi-Provider** — Gemini (default), OpenAI, Anthropic, Groq
- **Dark Glassmorphism UI** — Beautiful, minimal, and professional
- **Encrypted Storage** — API keys and history stored securely via electron-store
- **Global Hotkeys** — Works even when the window is hidden

## ⌨️ Keyboard Shortcuts

| Shortcut           | Action                 |
| ------------------ | ---------------------- |
| `Ctrl+Shift+Space` | Capture region & solve |
| `Ctrl+Shift+H`     | Toggle show/hide       |
| `Ctrl+Shift+R`     | Clear current solution |

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- npm 9+

### Install & Run

```bash
# Install dependencies
npm install

# Start in development mode
npm run dev
```

### Build for Production

```bash
# Build
npm run build

# Package (.exe / .dmg)
npm run package
```

## ⚙️ Configuration

1. Launch Ghostly
2. Navigate to **Settings** (⚙️ tab)
3. Expand your chosen provider
4. Paste your API key
5. Click **Set as Active Provider**
6. Select your preferred model, interview type, and language

## 🤖 Supported Providers

| Provider        | Free Tier   | Vision     | Speed        | Get Key                                                              |
| --------------- | ----------- | ---------- | ------------ | -------------------------------------------------------------------- |
| **Gemini** ✦    | ✅ Generous | ✅         | ⚡ Fast      | [aistudio.google.com](https://aistudio.google.com/app/apikey)        |
| **OpenAI** ◈    | ❌ Paid     | ✅         | ⚡ Fast      | [platform.openai.com](https://platform.openai.com/api-keys)          |
| **Anthropic** ◉ | ❌ Paid     | ✅         | 🐢 Moderate  | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| **Groq** ⚡     | ✅ Free     | ⚠️ Limited | ⚡⚡ Fastest | [console.groq.com](https://console.groq.com/keys)                    |

## 📁 Project Structure

```
ghostly/
├── electron/          # Electron main process
│   ├── main.ts        # App entry, tray, window management
│   ├── overlay.ts     # Invisible overlay window
│   ├── capture.ts     # Screen capture (full + region)
│   ├── hotkeys.ts     # Global shortcuts
│   ├── ipc.ts         # IPC handlers + electron-store
│   └── preload.ts     # contextBridge API
├── src/               # React renderer
│   ├── App.tsx        # Root with router + nav
│   ├── pages/         # Home, Settings, History
│   ├── components/    # SolutionCard, RegionSelector, etc.
│   ├── hooks/         # useCapture, useAIStream
│   ├── lib/ai/        # Provider implementations
│   ├── store/         # Zustand state management
│   └── styles/        # Tailwind + custom CSS
├── electron-builder.yml
├── electron.vite.config.ts
├── tailwind.config.ts
└── package.json
```

## 🛡️ Stealth Features

- `setContentProtection(true)` — invisible to all screen recording
- `alwaysOnTop: 'screen-saver'` — stays above all windows
- `skipTaskbar: true` — hidden from taskbar
- `transparent: true` + `frame: false` — no window chrome
- System tray icon for quick access

## 📄 License

MIT
