# 👻 Ghostly — Stealth AI Interview Assistant

![Ghostly App Demo](assets/read-me.png)

Ghostly is a desktop app that sits as an **invisible overlay** on top of your screen.
It listens to your interview, transcribes what the interviewer asks, and streams back
a spoken-style answer in 1–2 seconds. You can also screenshot any coding problem and
get a full solution with code.

It stays **invisible on Zoom, Google Meet, MS Teams, and OBS screen shares**.

---

## 🧠 How this application works

There are **two ways to get an answer**. Both use the same AI engine.

### 1. Live interview (primary path)

```
Mic + System audio → VAD (voice detection) → Resample 16 kHz
  → On-device transcription (Parakeet / Moonshine, nothing leaves your PC)
  → FINAL transcript only → Technical-term cleanup
  → Local question gate (deterministic, no network call)
  → WAIT  or  { answer this one question }
  → AI provider (OpenRouter by default) streams answer
  → Answer card + saved to session history
```

Key points:

- **Interim transcripts are display-only.** Only FINAL transcripts ever reach the AI.
- **The question gate runs locally before any network call.** Filler, half-sentences,
  your own voice, and background talk return `WAIT` — nothing is sent to the cloud.
- **One turn = one result.** Either an answer or `WAIT`. Never both.
- **Bad output is rejected.** Empty answers, echoed prompt headings, or a
  restated question are discarded and never saved to history.
- **Auto-answer mode** waits ~600 ms after the interviewer stops speaking, then
  answers automatically. Or press `Ctrl + Enter` to answer on demand.

### 2. Screenshot solve (coding problems)

```
Ctrl + H → drag region → OCR reads on-screen text locally
  → Screenshot + OCR text + interview context → AI vision model
  → Streams back explanation + code solution
```

- Screenshots stay on your machine until you press Solve.
- You can also type a custom follow-up question in the input box.
- Session memory keeps drill-downs on the same problem (`What about O(n)?`,
  `Explain that line`, etc.).

### 3. Where your data goes

- Transcription happens **on your device** (Parakeet / Moonshine ONNX).
- Only a confirmed interview question (or a screenshot you chose to solve) is
  sent to your AI provider.
- API keys, settings, and history are stored locally in `electron-store`
  (`%APPDATA%/ghostly` on Windows) and never leave your machine except for
  the AI request itself.

---

## ✨ Key features

- **Screen-share proof** — `setContentProtection(true)`, invisible to Zoom / Meet / Teams / OBS.
- **Click-through overlay** — mouse passes through until you hover the pill UI.
- **Hidden from taskbar** — runs from the system tray only.
- **Live transcription panel** — collapsible interview transcript modal.
- **Multi-provider** — OpenRouter (recommended gateway), Gemini, OpenAI, Anthropic, Groq.
- **API key pool** — multiple keys per provider with automatic failover + cooldown.
- **On-device OCR** — Windows OCR reads screen text locally, no cloud OCR.
- **Interview context** — optional Company / Job Description / Resume so answers match your profile.
- **Glassmorphism dark UI** — always-on-top, frameless, transparent.

---

## ⌨️ Keyboard shortcuts

| Shortcut | Action |
| -------- | ------ |
| `Ctrl + H` | Capture screenshot region |
| `Ctrl + Enter` | Solve / Answer with AI |
| `Ctrl + B` | Show / hide Ghostly |
| `Ctrl + G` | Start over / clear session |
| `Ctrl + Arrows` | Move Ghostly window |
| `Ctrl + Shift + 1..6` | Quick action (interview controls) |

Press `Ctrl + B` to hide instantly if someone looks at your screen.

---

## 📸 Screenshots

![What Interviewer Sees](assets/screenshots/screenshot1-whatinterviewersees.png)
![Screenshot 1](assets/screenshots/screenshot1.png)
![Screenshot 2](assets/screenshots/screenshot2.png)
![Screenshot 3](assets/screenshots/screenshot3.png)
![Screenshot 4](assets/screenshots/screenshot4.png)
![Screenshot 5](assets/screenshots/screenshot5.png)

---

## ✅ Requirements

- **OS:** Windows 10/11 x64 (primary), macOS / Linux work for dev but stealth + OCR paths are Windows-first.
- **Node.js:** 20+ (CI uses Node 20, dev machines use Node 24 — both work).
- **npm:** 9+ (comes with Node).
- **Git** to clone the repo.
- **An AI API key** — at least one (see Setup below). OpenRouter is the recommended default.

Check yours:

```bash
node --version
npm --version
git --version
```

---

## 📥 Install (step by step)

### 1. Clone the repository

```bash
git clone https://github.com/Pratham-Achar/ghostly.git
cd ghostly
```

### 2. Install dependencies

```bash
npm install
```

> If `npm install` fails on native modules (`sherpa-onnx`, `koffi`), delete
> `node_modules` + `package-lock.json` and run `npm install` again. On Windows,
> run the terminal as Administrator if a symlink / permission error appears.

### 3. Run in development mode

```bash
npm run dev
```

- This opens the Ghostly overlay window.
- **Do not open `http://localhost:5173` in a browser** — it renders blank there
  because the app needs Electron's `window.ghostly` bridge.
- If the port is stuck from a previous run, quit Ghostly fully (tray icon →
  Quit, plus `Ctrl + B` window) and run again.

### 4. Build the app (type-check + bundle)

```bash
npm run build
```

### 5. Package an installer

```bash
npm run package
# or: npm run dist   (build + package in one step)
```

Output goes to `dist/`:

- Windows: `Ghostly-<version>-setup.exe` + `win-unpacked/` folder
- macOS: `.dmg` — `npm run package -- --mac --x64` / `--arm64`
- Linux: `.AppImage`

Installers are also built automatically by GitHub Actions when you push a
`v*` tag (see `.github/workflows/release.yml`).

---

## ⚙️ Setup (step by step)

Do this once after first launch. Everything is in the **Settings (⚙️) tab**.

### Step 1 — Add an API key (required)

1. Launch Ghostly (`npm run dev`, or open the installed app).
2. Open the **Settings (⚙️)** tab.
3. Expand a provider and paste your key, then click **Save**.

Recommended first choice:

| Provider | Why | Get a key |
| -------- | --- | --------- |
| **OpenRouter (recommended)** | One gateway to many models + free-model option | [openrouter.ai/keys](https://openrouter.ai/keys) |
| **Google Gemini** | Great vision for screenshots, generous free tier | [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| **Groq** | Fastest text answers (limited vision) | [console.groq.com](https://console.groq.com/keys) |
| **OpenAI** | Paid, strong all-round | [platform.openai.com](https://platform.openai.com/api-keys) |
| **Anthropic** | Paid, strong reasoning | [console.anthropic.com](https://console.anthropic.com/settings/keys) |

You can add **multiple keys per provider** — Ghostly rotates through them and
cools down a key that rate-limits.

### Step 2 — Set provider order + model

1. In Settings, set **Active Provider** (used for screenshot solves).
2. Set **Provider Order** for live interviews — e.g. `openrouter → groq → gemini`.
   Only providers with a saved key are used at runtime.
3. Pick a **model per provider**. For OpenRouter you can also choose
   `OpenRouter Free (auto-selects a free model)` to avoid billing while testing.

### Step 3 — Set up audio (live interviews)

1. In Settings → **Speech recognition**, choose your input:
   - **System audio (loopback)** to hear the interviewer on Zoom/Meet, and/or
   - **Microphone** for your own voice (used to tell speakers apart).
2. Click **Start Interview** in the top bar.
3. Speak a test sentence — you should see interim text, then a FINAL line.
4. First run downloads the on-device transcription model (~600 MB) into your
   OS user-data folder. It is **not** bundled with the installer. Progress
   shows in Settings; wait for it to finish before judging latency.

### Step 4 — Set language + answer style

1. Set **Language** (e.g. Python, JavaScript, Java).
2. Edit **Answer Instructions** if you want shorter/longer or more formal answers.
3. Optionally paste **Company / Job Description / Resume** under Interview
   context so answers reference your real background instead of inventing one.

### Step 5 — Try it end to end

1. Press `Ctrl + H`, drag over any code problem.
2. Press `Ctrl + Enter` → a solution streams into the answer card.
3. For voice: play an interview question out loud → confirm the transcript
   appears → press `Ctrl + Enter` (or enable auto-answer).

---

## 🤖 Supported providers

| Provider | Free Tier | Vision | Speed | Get Key |
| -------- | --------- | ------ | ----- | ------- |
| **OpenRouter** gateway | ✅ Free models available | ✅ | ⚡ Fast | [openrouter.ai](https://openrouter.ai/keys) |
| **Gemini** | ✅ Generous | ✅ | ⚡ Fast | [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| **OpenAI** | ❌ Paid | ✅ | ⚡ Fast | [platform.openai.com](https://platform.openai.com/api-keys) |
| **Anthropic** | ❌ Paid | ✅ | 🐢 Moderate | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| **Groq** | ✅ Free | ⚠️ Limited | ⚡⚡ Fastest | [console.groq.com](https://console.groq.com/keys) |

---

## 📁 Project structure

```
ghostly/
├── electron/          # Main process (window, tray, capture, IPC, store)
│   ├── main.ts        # App entry, window, stealth flags
│   ├── capture.ts     # Screenshot capture
│   ├── hotkeys.ts     # Global shortcuts
│   ├── ipc.ts         # electron-store persistence
│   └── preload.ts     # window.ghostly bridge
├── src/               # React renderer
│   ├── pages/Home.tsx # Orchestrator (gate → stream → render)
│   ├── lib/ai/        # Providers (openrouter/groq/gemini/...) + orchestrator
│   ├── lib/           # interviewAgent, prompts, normalization, OCR, session
│   ├── hooks/         # Audio capture, ASR worker wiring
│   ├── components/    # TopBar, SettingsPanel, SolutionCard, InterviewModal
│   └── store/         # Zustand store (settings, session, history)
├── scripts/           # verify-*.mts harnesses + probes
├── models/            # NOT bundled — downloaded on demand at runtime
├── electron-builder.yml
└── package.json
```

---

## 🛡️ Stealth details

- `setContentProtection(true)` — excluded from screen capture / share.
- `alwaysOnTop: 'screen-saver'` — stays above Zoom / browser / IDE.
- `skipTaskbar: true` — no taskbar button, tray icon only.
- `transparent: true` + `frame: false` — no window chrome.
- Verified with `scripts/verify-stealth.mts`.

---

## 🧪 Verify your changes

```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.node.json
npm run build
```

There is no full unit-test suite. Behaviour is verified with the
`scripts/verify-*.mts` harnesses (pipeline, OCR, shortcuts, stealth, providers).

---

## ❓ Troubleshooting

| Problem | Fix |
| ------- | --- |
| Blank page at `localhost:5173` | Normal — run `npm run dev` and use the Electron window, not the browser. |
| Port / store locked | Quit Ghostly fully (tray → Quit), then `npm run dev` again. |
| No transcript | Check Settings → audio source; allow mic permission; wait for model download to finish. |
| `WAIT` on every question | Speak a complete question (`Can you explain…?`). Filler and half-sentences intentionally return WAIT. |
| 402 / 400 / rate-limit | Key out of credit or model unavailable — check key health in Settings, reorder providers, or use OpenRouter Free. |
| Native module install fails | Delete `node_modules` + `package-lock.json`, reinstall; on Windows use an Admin terminal. |
| Captured window shows Ghostly | You are looking at a local screenshot tool — screen *shares* (Zoom/Meet/OBS) still cannot see it. |

---

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run the type-checks + `npm run build`
before opening a PR.

## 📄 License

MIT
