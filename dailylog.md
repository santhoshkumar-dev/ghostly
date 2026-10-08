# Ghostly Project — Daily Development Log

> **Purpose:** Context handoff file for AI agents / future sessions.
> **Project:** Ghostly — Stealth AI coding assistant (Electron + React + TypeScript)
> **Location:** `D:\ghostly`
> **Platform:** Windows 11, Node v24.17.0, npm 12.0.1
> **Last updated:** 2026-10-06

---

## 1. Project Overview

Ghostly is an Electron desktop app that runs as an invisible overlay during technical interviews. It captures screen regions, transcribes live audio (Whisper), and streams AI-powered answers from multiple providers (Gemini, OpenAI, Anthropic, Groq).

**Key architecture:**
- `electron/` — main process (hotkeys, capture, stealth, IPC)
- `src/` — React renderer (pages, components, hooks, AI providers)
- `src/lib/asr.worker.ts` — Moonshine streaming ASR in a Web Worker
- State: Zustand (`src/store/useStore.ts`)
- Persistence: electron-store (encrypted, `%APPDATA%\ghostly`)

**How to run:**
```bash
npm install
npm run dev      # development
npm run build    # production build
npm run package  # create .exe
```

**IMPORTANT:** `localhost:5173` in a browser is ALWAYS blank — the app only works inside Electron (needs `window.ghostly` APIs). The real app is the transparent overlay window at top-center of screen (y=0, ~900px wide, small pill-shaped TopBar).

---

## 2. Session 1 — Setup & Environment Fixes

### 2.1 npm install failed with `ERR_SSL_CIPHER_OPERATION_FAILED`
- **Cause:** Node v24 + OpenSSL 3 incompatible with some old packages; network issues
- **Fix:**
  ```powershell
  npm cache clean --force
  npm config set registry https://registry.npmmirror.com   # Chinese mirror
  npm install
  ```
- Also approved blocked install scripts:
  ```powershell
  npm install-scripts approve electron esbuild koffi protobufjs sharp
  npm rebuild electron
  ```

### 2.2 Electron binary missing ("Error: Electron uninstall")
- **Cause:** Electron postinstall script was blocked → binary never downloaded
- **Fix:** Manually downloaded via `@electron/get` + extracted with `adm-zip`:
  ```powershell
  npm install adm-zip
  node -e "const AdmZip=require('adm-zip'); const z=new AdmZip('C:/Users/FORTUNE SYSTEMS/AppData/Local/electron/Cache/<hash>/electron-v33.4.11-win32-x64.zip'); z.extractAllTo('D:/ghostly/node_modules/electron/dist', true);"
  # Then write path.txt ('electron.exe') and dist/version ('33.4.11')
  ```
- **Result:** `npm run dev` works, all hotkeys register, stealth mode applies.

---

## 3. Session 2 — Bug Fixes Round 1 (User-Reported Issues)

User reported: (1) transcript not working, (2) no AI answers, (3) shortcuts not working, (4) settings panel vanishes, (5) hand cursor visible on invisible panel, (6) need shortcuts for interview type + quick recapture.

### 3.1 Settings Panel vanishes on click
- **Files:** `src/components/SettingsPanel.tsx`, `src/pages/Home.tsx`
- Added `pointer-events-auto` to the motion.div wrapper in Home.tsx
- Added `WebkitAppRegion: "no-drag"` to settings panel
- Consolidated duplicate mouse-enable useEffects

### 3.2 Hand cursor visible (recruiter could see it)
- **File:** `src/pages/Home.tsx`
- Added `cursor: "default"` to screenshot strip + chat container style objects

### 3.3 Interview type shortcuts (NEW)
- **Files:** `electron/hotkeys.ts`, `electron/preload.ts`, `src/pages/Home.tsx`, `src/env.d.ts`
- `Ctrl+Shift+1` → DSA, `+2` → System Design, `+3` → Frontend, `+4` → SQL, `+5` → Behavioral, `+6` → General
- hotkeys.ts sends `ghostly:interview-type-${type}` channel
- preload.ts exposes `onInterviewType(type, cb)` listener
- Home.tsx useEffect registers listeners → `updateSettings({ interviewType: type })`

### 3.4 Quick capture shortcut (NEW)
- **File:** `electron/hotkeys.ts`
- `Ctrl+Shift+C` → captures full screen WITHOUT hiding window (for when interviewer changes question)

### 3.5 Hotkey race conditions
- **File:** `electron/hotkeys.ts` (rewritten)
- Added `isBusy` mutex to prevent overlapping captures
- Helper functions `showWindow()` / `hideWindow()`
- Always restores window visibility on errors (try/catch/finally)

### 3.6 Transcription improvements (VAD)
- **File:** `src/hooks/useInterviewAudio.ts`
- Silence threshold: 0.005 → 0.01 (filters noise)
- Max silence frames: 5 → 10 (~2.5s before concluding speech ended)
- Added `MIN_SPEECH_FRAMES = 4` (discards tiny noise bursts)
- Better Windows screen source detection + detailed logging

### 3.7 Bug: IPC channel mismatch (interview shortcuts broken)
- hotkeys.ts sent `"ghostly:interview-type"` but preload listened on `ghostly:interview-type-${type}`
- **Fix:** hotkeys.ts now sends `ghostly:interview-type-${type}` (Option A — separate channels)

### 3.8 Bug: Missing TypeScript declaration
- **Fix:** Added `onInterviewType: (type: string, cb: () => void) => () => void;` to `src/env.d.ts`

---

## 4. Session 3 — Window Invisible / React Crash Debugging

### 4.1 Problem: Electron window not visible on screen
- Console showed "Window shown" + stealth applied, but user couldn't find window
- `localhost:5173` in browser was blank white (expected — no `window.ghostly`)

### 4.2 Added diagnostics
- **File:** `electron/main.ts`
  - `win.webContents.on("console-message")` → forwards renderer logs to terminal as `[Renderer:level]`
  - `did-fail-load`, `render-process-gone` handlers
  - Logs window bounds + opacity at startup
- **Result:** Window confirmed at `x:317, y:0, width:904, height:816, opacity:1, visible:true`

### 4.3 Added React ErrorBoundary (NEW file)
- **File:** `src/components/ErrorBoundary.tsx` (created)
- Wraps app in `src/main.tsx`
- Shows full-screen red error UI with stack trace + "Reload App" button instead of invisible blank window
- Logs crash via `console.error("[Ghostly] React crashed: ...")`

### 4.4 Bug: Missing `updateSettings` in Home.tsx
- Interview-type listeners called `updateSettings(...)` but it wasn't destructured from `useStore()`
- **Fix:** Added `updateSettings` to destructuring in `src/pages/Home.tsx`

### 4.5 Safety guards
- `Home.tsx` useEffect: early return if `!window.ghostly`
- `App.tsx`: guard + sanitize settings on load (merge with defaults instead of blind overwrite)

### 4.6 Bug: SettingsPanel crashes with "Cannot read properties of undefined (reading 'listModels')"
- **Cause:** Saved settings had invalid `activeProvider` → `getProvider()` returned `undefined`
- **Fixes:**
  - `src/lib/ai/index.ts`: `getProvider()` falls back to `providers.gemini` (`?? providers.gemini`)
  - `src/components/SettingsPanel.tsx`: Safe fallback for `activeModels`
  - `src/App.tsx`: Sanitize saved settings — merge `{...defaults, ...savedSettings, apiKeys: {...}}`

---

## 5. Current Outstanding Issues (NOT YET FIXED)

### ✅ Issue A: "Failed to fetch" error on AI call — FIXED (Session 4)
- **Symptom:** Red banner "Failed to fetch" when submitting (screenshot or interview)
- **Cause:** Network-level failure — `fetch()` couldn't reach AI server at all
  - NOT an API rejection (that would show "Gemini API error: ...")
  - Possible: transient network, system proxy interference, invalid/missing API key, or provider blocked in user's region
  - User had SSL/network issues earlier (needed npmmirror registry) → restricted network likely
- **Fix applied:**
  - New file `src/lib/ai/fetchWithDiagnostics.ts` — shared wrapper around `fetch()`
  - Wired into all 4 providers (`gemini.ts`, `openai.ts`, `anthropic.ts`, `groq.ts`)
  - Validates API key presence before the request → `"{provider} API key is missing. Add it in Settings → API Keys."`
  - Logs context to terminal: `[AI:gemini] → POST host model=... apiKeyPresent=true` and `← HTTP <status>`
  - Catches network-level failures (TypeError from `fetch`) and rethrows a classified message:
    `Cannot reach {host} ({provider} / {model}). Network error: {detail}. Check your internet/VPN, or switch provider in Settings.`
  - Preserves `AbortError` untouched
  - `npm run build` passes (all 3 bundles)
- **Still open:** verify with a real request; user config default model is `gemini-2.0-flash` but `listModels()[0]` = `gemini-3.1-flash-lite-preview` (may not exist!)

### ✅ Issue B: Own mic audio is transcribed — FIXED (Session 4)
- **Fix applied:**
  - `useInterviewAudio.ts` `startInterview()` now captures **system/desktop audio only** — mic capture removed entirely
  - If no screen source or system capture fails → recording stops with a clear log (no mic fallback)
  - `stopInterview()` updated to close the single stream + AudioContext
  - `InterviewModal.tsx` header now reads `| System audio (Interviewer only)`
  - `settings.micDeviceId` is now unused by capture (setting still present in UI — harmless)

### ✅ Issue C: Ctrl+Enter submits interview transcript — FIXED (Session 4)
- **Fix applied:**
  - Interview messages lifted to Zustand store: `interviewMessages`, `addInterviewMessage`, `clearInterviewMessages`, `getInterviewTranscript()`
  - `useInterviewAudio` now reads/writes the store (was local `useState`) — transcript is reachable from Home
  - `Home.tsx` `onSolve` (Ctrl+Enter): if interview panel is open, builds transcript via `getInterviewTranscript()` and calls `runAIStream(shots, transcript)`; otherwise `runAIStream(shots)`
  - New `interviewOpenRef` avoids stale-closure issues in the global hotkey listener
  - Transcript is cleared on interview open/close/toggle (`Ctrl+G` also clears via `clearSolution`)
  - Transcript alone passes the runAIStream validation (no screenshot required)
  - **Flow now:** interviewer speaks → question appears in panel → user presses `Ctrl+Enter` → AI answer streams into main chat

### 🟡 Issue D: Question pending — which provider?
- Asked user to confirm intended AI provider (Gemini/Groq/OpenAI/Anthropic) + valid API key
- Awaiting response; diagnostics (Issue A fix) will reveal cause on next test

### ✅ Issue E: "model does not exist or you do not have access to it" — FIXED (Session 4)
- **Symptom:** `Groq API error: The model 'meta-llama/llama-4-scout-17b-16e-instruct' does not exist or you do not have access to it.`
- **Cause:** each provider hard-coded `listModels()` with fixed ids. Groq **deprecated Llama 4 Scout**, so the saved `activeModel` pointed at a retired id. This is an HTTP 400 (correctly surfaced by the provider code, not the network path).
- **Fix (3 layers):**
  1. **Live model discovery** — new optional `AIProvider.fetchModels(apiKey)` hitting each provider's `/models` endpoint (Groq/OpenAI `openai/v1/models`, Anthropic `v1/models`, Gemini `v1beta/models`). `SettingsPanel` now populates the Model dropdown from the live list, falling back to curated ids when there is no key / offline / CORS-blocked.
  2. **Auto-heal stale selection** — when the live list loads and `settings.activeModel` isn't in it, it is replaced with the first valid model.
  3. **Transparent retry** — if a stream fails with a model-unavailable error, `Home.runAIStream` retries once with `provider.listModels()[0]`, persists it, and re-streams. Also added `withModelHint()` so the error text tells the user to open Settings and pick another model.
  - Updated curated Groq list → `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`; removed bogus Gemini `gemini-3.1-flash-lite-preview`.
- **Note:** `src/pages/Settings.tsx` (separate route page) still uses curated lists only — benefits from the corrected ids but has no live discovery.

### ✅ Issue F: Live transcription not working after Start — FIXED (Session 4)
- **Symptom:** interviewer (Google Meet) asks a question, nothing appears in the transcript after pressing Start. (This surfaced right after Issue B removed mic capture — the mic had been doing all the work.)
- **Root causes:**
  1. The code **stopped the desktop video track** (`sysStream.getVideoTracks().forEach(t => t.stop())`) before building the audio graph. On Windows, tearing down desktop capture's video track can silence/kill the loopback **audio** track.
  2. It used the legacy `chromeMediaSource: "desktop"` constraint instead of Electron's supported loopback route.
  3. `AudioContext` was never resumed, and the worklet was routed to `audioCtx.destination` (would echo the captured audio).
- **Fix applied:**
  - `electron/ipc.ts`: added `session.defaultSession.setDisplayMediaRequestHandler(...)` granting `{ video: screenSource, audio: "loopback" }` (no system picker → stays stealthy).
  - `useInterviewAudio.ts` `startInterview()`: now uses `navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })` as the primary path, with the legacy desktop constraint kept as a fallback. Video track is **never stopped**; only the audio track feeds the graph while the full stream is retained.
  - `AudioContext.resume()` is awaited; worklet now routes through a **0-gain sink** instead of `destination` (no echo).
  - VAD worklet now reports a peak `level` ~2×/sec; the hook logs transitions → "System audio detected (level …)" / "System audio is silent … — no sound is reaching Ghostly." Visible in the Debug panel.
  - Diagnostics log video/audio track counts, audio track label/enabled/muted, and AudioContext state/sample rate.
- **Testing:** if Debug shows "System audio is silent", the interviewer's voice isn't reaching the default output device (or Meet outputs to a device Ghostly isn't capturing).

### ✅ Issue G: Transcription slow + inaccurate — FIXED (Session 4)
- **Symptom:** long delay before text appears; transcript is wrong/fragmented.
- **Root causes (4):**
  1. **VAD timing off by ~94×** — an AudioWorklet `process()` gets a fixed 128-sample render quantum (~2.67 ms @48 kHz), but the worklet counted frames as if each were ~0.25 s. `MAX_SILENCE_FRAMES=10` ended a phrase after **~27 ms** of silence (comment claimed 2.5 s), and `MIN_SPEECH_FRAMES=4` meant ~11 ms. VAD chopped speech at word boundaries; the hook then discarded everything under 0.5 s → missing text + context-free fragments → Whisper hallucinations.
  2. **No worker queue** — the worker's `message` listener was `async`, so every chunk started its own transcription concurrently on the same pipeline (CPU contention + out-of-order results).
  3. **CPU/WASM Whisper** — `Xenova/whisper-base.en` with no `device` option → ONNX WASM on CPU, often slower than real time.
  4. **Lossy resampling + high threshold** — naive N-sample decimation (no anti-alias filter) plus `SILENCE_THRESHOLD=0.01` dropping quiet loopback audio.
- **Fixes applied:**
  - VAD is now **time-based** (uses the worklet's `sampleRate` global): `MAX_SILENCE_SECONDS=1.0`, `MIN_SPEECH_SECONDS=0.35`, threshold `0.008`. Silence is buffered too, so word tails aren't clipped.
  - `AudioContext` is requested at **16 kHz** (with fallback) so Whisper gets its native rate directly; `resampleTo16k()` (OfflineAudioContext, anti-aliased) covers the fallback case.
  - Handlers use the worklet-reported speech duration instead of the padded buffer length.
  - `whisper.worker.ts`: transcriptions are **serialized through a promise queue**; clips under 0.1 s are skipped; `chunk_length_s: 30` / `stride_length_s: 5` for long speech; removed the noisy raw-output log.
- **Still open (optional upgrades for Parakeet-like speed):**
  - WebGPU: `@huggingface/transformers` v3 with `device: 'webgpu'` (10–50× faster than WASM).
  - Streaming/local: **Moonshine** via transformers.js for interim text (real-time, free).
  - Cloud/free tier: **Groq `whisper-large-v3-turbo`** (~$0.04/hr, near-instant) — user already has a Groq key.
  - Consider defaulting Whisper to `Xenova/whisper-small.en` for accuracy once the pipeline is correct.

### ✅ Issue H: Pre-interview context inputs (resume / company / JD / answer style) — ADDED (Session 4)
- **Request:** before the "Start Interview" button, collect resume upload, company name, job description, and an instruction box that controls how the answer appears on screen.
- **Implementation:**
  - New component `src/components/InterviewContext.tsx` — a collapsible "📋 Interview Context" pill rendered directly **above** the Start Interview pill in `TopBar.tsx`. Shows an orange dot when any field is populated.
  - Fields: **Resume** (⬆ Upload for `.txt`/`.md`/`.json`/`.csv`/`.rtf`/`.tex`/`.yml` + paste textarea, capped at 20 000 chars), **Company Name**, **Job Description**, **How should answers appear on screen?**.
  - PDF/DOCX cannot be parsed without a dependency, so the upload button tells the user to open the file and paste the text (the textarea accepts a straight paste).
  - New `Settings` fields (auto-persisted, defaults merged on load by `App.tsx`): `resumeText`, `companyName`, `jobDescription`, `answerInstructions`.
  - New `buildInterviewContext(settings, { includeResume })` in `src/lib/prompts.ts` renders a `# Interview Context` block (Company / Job Description / Candidate Resume / Answer Style).
  - `Home.runAIStream` appends the block to **every** prompt (screenshot, live-transcript and follow-up paths). The resume is omitted on follow-ups (already in the first user message) to save tokens; company/JD/style always apply so formatting stays consistent.
- **Note:** `settings.customInstructions` is unchanged and still serves as the General-mode prompt; `answerInstructions` is the new cross-mode style directive.
- **Verified:** `tsc` (both projects) + `npm run build` pass.

### ✅ Issue I: Parakeet-style live transcription via Moonshine — DONE (Session 4)
- **Goal:** transcript appears *while the interviewer is speaking* instead of only after a full second of silence.
- **Engine swap (Whisper → Moonshine):**
  - `@xenova/transformers` **v2 removed**; `@huggingface/transformers` **v3.8.1** added (Moonshine was added in v3.2; v2 has no Moonshine support at all).
  - `src/lib/whisper.worker.ts` → **`src/lib/asr.worker.ts`** (deleted + recreated).
  - Models: `onnx-community/moonshine-base-ONNX` (default) and `onnx-community/moonshine-tiny-ONNX`. Both verified to contain `encoder_model_fp16.onnx`, `decoder_model_merged_fp16.onnx`, `encoder_model_quantized.onnx`, `decoder_model_merged_quantized.onnx`.
  - **WebGPU first, WASM fallback:** tries `{ device: "webgpu", dtype: "fp16" }`, catches, then falls back to `{ dtype: "q8" }` (WASM). Model size in fp32 would be ~240 MB; fp16/q8 cuts the first-run download roughly in half/quarter.
- **Streaming architecture:**
  - The VAD worklet now emits a **partial snapshot every 0.7 s while speech is ongoing** (`STREAM_INTERVAL_SECONDS`), in addition to the full clip when a phrase ends. Snapshots stop past `MAX_PARTIAL_SECONDS = 20`; a monologue is force-flushed at `MAX_PHRASE_SECONDS = 30`.
  - Each phrase carries an incrementing `phraseId`; partials arriving after their phrase was finalized are ignored.
  - The worker scheduler runs **finals with priority** and keeps only the newest partial (`pendingPartial`), so a slow machine never builds a backlog of stale interim transcriptions.
  - Worker now posts `partial` / `final` (instead of `result`); a final is always posted so the interim line can be cleared even when nothing was recognised.
- **UI:** new store state `interviewInterim` + `setInterviewInterim`; `useInterviewAudio` returns `interim`; `InterviewModal` renders a dashed “transcribing…” line with a blinking cursor that is replaced by the final message. `getInterviewTranscript()` and the “Ask Copilot 🚀” button both include the in-progress line, so submitting mid-sentence is not lossy.
- **Migration:** `App.tsx` rewrites any saved `Xenova/whisper-*` model id to the Moonshine default on load (the old ids are no longer offered in Settings). Settings section renamed **Whisper Model → Transcription Model**.
- **Verified end-to-end (Session 4, measured on the dev machine):**
  - Network probe: `huggingface.co` reachable at **~1 MB/s**, `hf-mirror.com` also works (~1.2 MB/s) — the HF CDN does *not* need a local mirror.
  - `npm run dev` with a temporary self-test proved the whole chain: `Model ready in 22.1s` → `WASM (q8)` → inference **0.23s** for a 1 s buffer → a real captured utterance `Transcribed system in 0.59s`.
  - **Important gotcha found:** a WebGPU adapter *is* present on this machine but reports *“The device (webgpu) does not support fp16.”* The first probe only checked for an adapter and therefore attempted the (doomed) fp16 path. `webgpuSupportsFp16()` now asks for the **`shader-f16` feature** specifically, so the app goes straight to WASM/q8. (q8 is already ~1.7× faster than real-time here, so GPU is not needed for the streaming cadence.)
  - Because q8/WASM is proven and fast, **WASM q8 is the effective default**; the WebGPU fp16 path only engages where `shader-f16` exists.
  - Temp scaffolding (self-test block + auto-open interview panel) was removed afterwards; no `TEMP-` markers remain.
- **Still unverified:** transcript *accuracy* on real interview speech (needs a live session).

### ✅ Issue J: PDF & DOCX resume extraction — ADDED (Session 4)
- New `src/lib/fileText.ts` with `extractTextFromFile()`: plain text read directly; **`.pdf` via `pdfjs-dist`**, **`.docx` via `mammoth`**, both loaded with dynamic `import()` so they stay out of the initial bundle. Legacy `.doc` returns a clear “save as .docx/PDF” message.
- `InterviewContext.tsx` now accepts PDF/DOCX (button shows “Reading…”), reports a friendly error for scans with no text layer, and keeps the 20 000-char cap.
- **Note:** scanned/image-only PDFs have no text layer — the message tells the user to paste instead. OCR is not implemented.
- **⚠️ BUG FIXED — resume upload failed with `n.toHex is not a function`.**
  - **Cause:** `pdfjs-dist` was installed at **v6.3.x**, which requires `Uint8Array.prototype.toHex` / `.toBase64` (Chrome 140+). **Electron 33 is Chromium 130**, so the call blew up at runtime. The v6 code calls `arr.toHex()` **without a guard**.
  - **Fix:** pin `pdfjs-dist` to the **v4 line (`^4.10.38`)**, which guards both: `if (Uint8Array.prototype.toHex) return arr.toHex(); return Array.from(arr, num => hexNumbers[num]).join("");`. Do **not** upgrade pdfjs-dist past v4 while the app is on Electron 33.
  - **Also:** `extractTextFromFile()` now wraps parser failures so the panel shows *“Couldn't read <file>: <reason>. Try pasting the resume text instead.”* instead of a minified internal error.
  - **Verified end-to-end:** a temporary self-test built a minimal PDF in the renderer and ran it through the real extraction path — `[PDFTEST] OK -> "HELLO GHOSTLY RESUME"`. Self-test removed afterwards.
  - **Still untested:** DOCX extraction (mammoth has no `toHex` usage, so it was not the failing path).

### ✅ Issue K: Interview agent invented unanswered questions / rambled — FIXED (Session 5)
- **Symptom:** the overlay sometimes answered a question nobody asked, or echoed its own instructions, e.g. *“With regards to the fastest language wars, let's compare Java and Python. Here's why Java would be faster: Interview Preparation In a real-world scenario…”*.
- **Root causes (all in code):**
  1. `Home.runAIStream()` built the live prompt as *“Here is a live interview transcript. Please provide a brief, excellent answer to the interviewer's **most recent question**…”* — with **no check that a question existed**. Any empty/incomplete transcript still asked for “the most recent question”, so the model produced one.
  2. With an empty transcript the transcript branch collapsed to `undefined` and execution **fell through to the screenshot prompt** (`buildPrompt(interviewType, language)` = “Analyze the problem in the screenshot…”) with **no screenshot** — a literal question generator. The same happened on Ctrl+Enter with no screenshot whenever session history existed.
  3. The candidate context (Company / JD / Resume / Answer Style) was appended to the **user** message on every call, so the model could quote its own instruction text back as content.
  4. `sessionMessages.slice(-6)` were replayed as real chat turns, letting an old assistant answer act as a continuation prompt.
  5. There was no system-instruction layer at all — every rule lived in a user message.
  6. `abortControllerRef.abort()` was called before a new stream, but an already in-flight older response could still append to the screen and overwrite the newer answer.
- **Fix — new `src/lib/interviewAgent.ts` implements the required pipeline:**
  - `evaluateInterviewTurn(turn)` = deterministic **end-of-utterance + question-detection gate** that runs *before any network call*. It refuses when: no interviewer speech yet; a non-empty interim (interviewer **still speaking**); the last utterance was the candidate's; the text is filler-only (“Okay… yes… right…”, “thanks”); it ends mid-thought (“I have worked with Node.js and recently”); it is the interviewer narrating (“Let me explain the problem”); or it simply contains no question shape. Abbreviations/ASR quirks are handled (`whats`, `hows`, `dont`).
  - `INTERVIEW_SYSTEM_PROMPT` holds the 8 absolute rules (never invent/assume/generate a question, never answer an earlier question, never fabricate resume facts, no labels, no AI mentions, spoken-style brevity) and is sent through each provider's **native system slot** (new `AIRequestOptions.system` → Gemini `systemInstruction`, Anthropic top-level `system`, OpenAI/Groq leading `system` message). The model is additionally told to reply with exactly `WAIT` for anything unclear.
  - `buildInterviewUserPrompt()` structures the user message as **`# Latest interviewer utterance — the ONLY question you may answer`** + `# Earlier conversation (background only)` + `# Your earlier answers (background only)` + an explicit “…otherwise reply with exactly: WAIT”.
  - Candidate context (resume/company/JD/answer style) now travels in the **system** prompt, so the user message contains nothing the model could mistake for a question. `answerInstructions` *and* `customInstructions` are both honoured (previously `customInstructions` was ignored on the interview path).
- **`Home.tsx`:** the transcript path never reaches `buildPrompt()` any more (the screenshot prompt is only used when a screenshot exists); **`WAIT` replies are discarded** — never shown, never added to `sessionMessages`, never written to history — and surface as a small amber `WAIT · <reason>` pill instead. The first ~8 characters of every stream are held back so a `WAIT` reply can't flash on screen.
- **Stale/concurrent responses:** every run takes `++requestIdRef.current` and an `isStale()` check gates *every* append, the history save, and the `finally` cleanup — a superseded run can no longer overwrite a newer answer or clear its UI. Ctrl+G also bumps the id.
- **Partial transcripts:** the agent only ever reads **finalized** utterances (`getInterviewTurn()` = `finals` + `interim`; the old lossy `getInterviewTranscript()` string helper was removed). A non-empty interim blocks answering. `useInterviewAudio` now ignores partials whose `phraseId` was already finalized and only clears the live line for its own phrase, so a late partial can no longer leave the gate stuck on “still speaking”.
- **Escape hatch:** pressing the hotkey twice in a row on the *exact same* transcript (within 30 s) counts as an explicit override and forwards it to the model, which still applies the WAIT rules.
- **Verified:** 32/32 detection assertions pass (positive: “Can you explain what REST API is?”, “walk me through your resume”, “whats the time complexity of this”, … / negative: “I have worked with Node.js and recently”, “Okay… yes… right…”, “Let me explain the problem”, “thanks”, …), plus turn-level and `isWaitResponse` cases, driven through esbuild + node. `tsc` (both configs), `npm run build` and `npm run dev` are clean.
- **UI unchanged** otherwise: Ctrl+Enter and “Ask Copilot 🚀” still trigger an answer exactly as before.

### ✅ Issue L: Auto-answer mode (settings toggle) — ADDED (Session 5)
- **Settings → “Live Answering”** has a new switch: *“Auto-answer when a question ends”* (new persisted `Settings.autoAnswer`, default `false`; the whole settings blob is already saved, so no IPC change was needed).
- **How it fires (`Home.tsx`):** an effect watches the **last finalized transcript message**. When it comes from the interviewer (`source: "system"`), it waits `AUTO_ANSWER_SETTLE_MS = 600ms`, then runs the **same gate** as the manual path (`normalizeTurn` → `evaluateInterviewTurn`). Only `action === "answer"` triggers the stream — incomplete/conversational speech is silently ignored and it keeps listening. Already-handled finals are tracked by message id, so a re-render can never double-answer.
- **Partial transcripts are still impossible to answer:** an in-progress (`interim`) line is not a finalized message, and the gate treats a non-empty interim as “the interviewer is still speaking”. Auto mode adds no new LLM trigger — it reuses `runAIStream`, so the system prompt, `WAIT` discard and request-id/stale-response guards all apply unchanged.
- **Split questions are re-joined first** (`normalizeTurn()` in `interviewAgent.ts`). The VAD cuts on ~1s pauses, so a question can arrive as two finals. Two finals are merged when either:
  - the new one is a *fragment* (starts with `and / also / so / but / …` **and** is not itself a question) — e.g. `"Can you explain"` + `"and then compare it"`;
  - the previous one is visibly unfinished (`HARD_TAIL`/`SOFT_TAIL`, or ends on a request verb with no object: `"Can you explain"`, `"How would you design"`, `"…and recently"`).
  **and** the new utterance is *not* a complete standalone question — so a real follow-up like `"and why is that?"` or a new question `"What is a REST API"` is never glued onto the previous one (which would make the model re-answer an old question). Never merges across the candidate speaking.
- **Toggle off ⇒ behaviour is exactly the previous manual flow** (Ctrl+Enter / “Ask Copilot 🚀”).
- **Verified:** the detection suite was extended to 47 assertions — positives (including merged turns like `"How would you design a URL shortener"`), negatives, turn-level gate cases, merge cases (`"Explain the design" + "What is a REST API"` must stay separate) and `isWaitResponse` — all passing. `tsc` (both configs), `npm run build`, `npm run dev` clean. **Still to verify live:** real interviewer audio with the toggle on.

---

## 6. Key Files Reference

| File | Purpose | Status |
|------|---------|--------|
| `electron/main.ts` | Window creation, tray, IPC, diagnostics | Modified — added renderer logging |
| `electron/hotkeys.ts` | Global shortcuts (rewritten with mutex) | Modified |
| `electron/preload.ts` | contextBridge API + `onInterviewType` | Modified |
| `electron/stealth.ts` | Win32 `SetWindowDisplayAffinity` (WDA_EXCLUDEFROMCAPTURE) | Unchanged |
| `electron/capture.ts` | Full-screen capture | Unchanged |
| `src/main.tsx` | React entry + ErrorBoundary wrapper | Modified |
| `src/App.tsx` | Loads persisted settings (sanitized) | Modified |
| `src/pages/Home.tsx` | Main UI, hotkey listeners, AI streaming, Ctrl+Enter transcript path, question gate + request-id/stale-response guards + `WAIT` notice | Modified |
| `src/components/SettingsPanel.tsx` | Settings UI (provider, keys, mic, transcription model, **Live Answering / auto-answer switch**) | Modified |
| `src/components/InterviewModal.tsx` | Live interview UI — submits a structured turn (`finals` + `interim`), not a joined string | Modified (header: interviewer-only) |
| `src/components/InterviewContext.tsx` | Collapsible pre-interview context (resume upload/paste, company, JD, answer style) above Start Interview | Created |
| `src/components/TopBar.tsx` | Overlay pill — hosts `InterviewContext` above the Start Interview button | Modified |
| `src/lib/prompts.ts` | Prompt builders + `buildInterviewContext()` | Modified |
| `src/components/ErrorBoundary.tsx` | React crash UI | Created |
| `src/hooks/useInterviewAudio.ts` | System-audio-only capture + VAD + Moonshine streaming; transcript from store; per-phrase (`phraseId`) ordering guard for partials/finals | Modified |
| `src/hooks/useAIStream.ts` | AI streaming hook (partially unused) | Unchanged |
| `src/lib/ai/*.ts` | Provider implementations + `AIRequestOptions.system` mapped to each provider's native system slot | Modified (`getProvider` fallback + diagnostics wrapper + system instruction) |
| `src/lib/interviewAgent.ts` | The answering agent: question/end-of-utterance detection gate, `normalizeTurn()` continuation merge, system prompt, prompt builders, `WAIT` helpers | Created |
| `src/lib/ai/fetchWithDiagnostics.ts` | Shared fetch wrapper: key check, context logging, network-error + model-error classification | Created |
| `src/components/SettingsPanel.tsx` | Settings UI + live model discovery / auto-heal | Modified |
| `src/lib/asr.worker.ts` | Moonshine ASR worker — finals-priority queue + latest-partial coalescing, WebGPU→WASM fallback | Created (replaced `whisper.worker.ts`) |
| `src/lib/fileText.ts` | Resume text extraction: plain text, PDF (`pdfjs-dist`), DOCX (`mammoth`) | Created |
| `src/store/useStore.ts` | Zustand state + shared interview transcript + `getInterviewTurn()` / `agentNotice` / `Settings.autoAnswer` | Modified |
| `src/env.d.ts` | Window.ghostly type declarations | Modified |

---

## 7. Keyboard Shortcuts (Current)

| Shortcut | Action |
|----------|--------|
| `Ctrl+H` | Capture screenshot (briefly hides window) |
| `Ctrl+Shift+C` | Quick capture (no window hide) |
| `Ctrl+Enter` | Ask AI / Solve |
| `Ctrl+B` | Show / Hide overlay |
| `Ctrl+G` | Start over / clear session |
| `Ctrl+Shift+1..6` | Interview type: DSA / SysDesign / Frontend / SQL / Behavioral / General |
| `Ctrl+Arrows` | Move window 25px |
| Tray click | Show/Hide toggle |

---

## 8. Testing Status

### ✅ Passed
- `npm run build` — all 3 bundles compile (main, preload, renderer)
- `npm run dev` — app launches, all hotkeys register `true`
- Window diagnostics: visible, opacity 1, correct bounds
- Stealth: `WDA_EXCLUDEFROMCAPTURE applied`
- Renderer logs forwarded to terminal
- ErrorBoundary catches crashes (verified with SettingsPanel crash)

### ⏳ Not yet tested / pending fixes
- Interview type shortcuts end-to-end (topbar dropdown update)
- Settings panel opens without crash
- Cursor shows arrow (not hand) on overlay
- AI answer streaming (blocked by Issue A — "Failed to fetch")
- Interview transcription (B + C fixed — pending live end-to-end test)
- **Issue K agent behaviour in a real interview**: the gate + system prompt were verified offline (47 detection assertions, prompts inspected); the *live* path still needs a real interviewer voice + a valid API key
- **Issue L auto-answer mode with real speech** — including that it does *not* fire on mid-sentence pauses

---

## 9. Testing Guide (Quick Reference)

```powershell
cd D:\ghostly
npm run dev
# DO NOT use localhost:5173 in browser — always blank
# Real app = transparent overlay at TOP-CENTER of screen
# If not visible: press Ctrl+B or click tray ghost icon
```

**Bug report template:**
```
Test: [description]
Expected: [what should happen]
Actual: [what happened]
Console: [copy terminal lines, esp. [Renderer:*] lines]
```

**Reset app data (clean slate):**
```powershell
# Quit app first
Remove-Item -Recurse -Force "$env:APPDATA\ghostly"
Remove-Item -Recurse -Force out -ErrorAction SilentlyContinue
```

---

## 10. Next Steps (Priority Order)

1. ~~**Fix Issue A** — Add network error diagnostics to 4 AI providers~~ ✅ DONE (Session 4)
2. ~~**Fix Issue B** — Remove mic capture; interviewer (system) audio only~~ ✅ DONE (Session 4)
3. ~~**Fix Issue C** — Lift interview messages to store; Ctrl+Enter submits transcript~~ ✅ DONE (Session 4)
4. **Test end-to-end** — interview flow: interviewer speaks → Ctrl+Enter → answer streams
5. **Verify the answering agent live** — incomplete/mid-sentence speech must show `WAIT · <reason>` instead of an answer, and the answer must match only the last interviewer question
6. **Verify all shortcuts** — especially `Ctrl+Shift+1-6` topbar updates
7. **Confirm provider** — user to confirm which AI provider + valid API key

---

## 11. Environment Notes

- **Node:** v24.17.0 (OpenSSL 3 — caused initial SSL errors)
- **npm registry:** set to `https://registry.npmmirror.com` (may need to restore: `npm config delete registry`)
- **Electron:** v33.4.11 (binary manually extracted to `node_modules/electron/dist`)
- **adm-zip + koffi:** installed (electron extraction + Win32 FFI)
- **User location/network:** likely restricted (SSL issues, npmmirror) — some AI providers may be blocked
- **App data:** `%APPDATA%\ghostly\ghostly-data.json` (encrypted electron-store)

---

## Session: ASR + provider-architecture fixes (audio brief + AI pipeline brief)

### Root causes found (not assumed — traced from the runtime path)

1. **Provider chain ran on Groq, not OpenRouter.** TWO causes, both real:
   - `electron/ipc.ts` electron-store **defaults** still said
     `providerOrder: ["groq","gemini"]` with no `openrouter` key at all. A store
     that had never been overwritten therefore handed the renderer a Groq-first
     chain.
   - `src/App.tsx` had a hardcoded `PROVIDER_NAMES = ["gemini","openai","anthropic","groq"]`
     that omitted `"openrouter"`, so the migration filter could never keep it.
   - Confirmed empirically at boot: the new migration logged
     `Previous order: [groq, gemini]`. This is what produced
     `providerChain=groq → gemini` / `model=allam-2-7b` (a model id only ever
     written by a live `fetchModels()` into persisted settings).
   - Fixed: registry-derived `PROVIDER_NAMES` exported from `src/lib/ai/index.ts`,
     store defaults updated, and a one-time migration that prepends `openrouter`
     when a key exists — logged, never silent.

2. **Answer card contained a prompt heading.** `Previously mentioned interview
   questions or requests` exists nowhere in the repo. The user prompt used
   Markdown `#` headings (`# Latest interviewer utterance`, …) which a
   structure-following open-weight model imitated. Fixed with neutral `<<<>>>`
   delimiters **and** a deterministic output validator.

3. **VAD read only `input[0]`** — the right channel of a stereo loopback stream
   was silently discarded. With Bluetooth profiles that carry voice in the right
   channel, left-only RMS fell below `SILENCE_THRESHOLD` and the phrase was never
   detected ("no speech recognised").

4. **Discarded phrases never cleared their interim line.** `endPhrase()` advanced
   `phraseId` but posted no message when the phrase was too short, so the renderer
   kept the stale interim text, which satisfied the gate's "interviewer is still
   speaking" check — a permanent WAIT behind every later question.

5. **No RMS gate before ASR.** Near-silent buffers were sent to Moonshine, which
   reliably hallucinates on them.

6. **No output-device resilience.** Windows loopback follows the default render
   device; nothing listened for `track.onended` / `devicechange`, so plugging
   earbuds in or out killed capture silently for the rest of the interview.

7. **Gate over-corrected and rejected real questions** (found by the new harness):
   - `Why should we hire you?` → WAIT (5 words + soft tail "you")
   - `What is your trade on?` → WAIT (ended on hard-tail preposition "on")
   - `And why?` / `And why not?` → WAIT (`words.length < 3`)
   All three fixed with narrow, shape-based exemptions.

### Files changed
- `electron/ipc.ts` — store defaults include `openrouter`
- `src/lib/ai/index.ts` — `PROVIDER_NAMES` + `isProviderName` from the registry
- `src/App.tsx` — registry-derived allow-list, preserved `models.openrouter`, order migration
- `src/lib/outputValidation.ts` — NEW: deterministic output validator
- `src/lib/transcriptQuality.ts` — NEW: structure-only ASR artefact detection
- `src/lib/interviewAgent.ts` — `<<<>>>` delimiters, quality gate, gate fixes
- `src/pages/Home.tsx` — resolved-chain diagnostic, output validator call
- `src/hooks/useInterviewAudio.ts` — mono downmix, `phraseClosed`, RMS gate, `[ASR]` logs, device resilience
- `src/lib/asr.worker.ts` — per-segment `[ASR]` diagnostics
- `src/lib/normalization.ts` — `use eh-fekt` repair
- `scripts/verify-pipeline.ts` — NEW: 117-check regression harness (kept)

### Verification
- `npx tsc --noEmit -p tsconfig.json` ✅
- `npx tsc --noEmit -p tsconfig.node.json` ✅
- `npm run build` ✅
- `npx tsx scripts/verify-pipeline.ts` → **117 passed, 0 failed**
- Dev boot clean; migration confirmed against the real on-disk store.

### NOT verified (needs a real Windows interview run)
- Actual audio capture with earbuds and with laptop speakers.
- Device-change reacquisition in practice.
- Any real end-to-end ASR quality improvement.

---

## Session: audio observability + provider routing (two briefs)
### 1. AudioContext double-close — exact cause
`InvalidStateError: Cannot close a closed AudioContext` came from **four** independent
paths able to `close()` the same context, none state-checked:
1. session `teardown` (device change / stop / unmount),
2. `startInterview`'s `catch` block (`await audioCtx?.close()`),
3. `stopInterview`'s legacy `(window as any)._interviewStreams[1].close()`,
4. the unmount effect.
`close()` is async and `state` only becomes `"closing"` after the promise settles, so two
paths in the same tick both saw `"running"`.
**Fix = ownership, not a swallowed error:** one `createIdempotentContextCloser(ctx)` per
context, `done` set synchronously, `state` checked, and every other path routed through it.

### 2. Live audio status bar
- New `src/lib/audioStatus.ts` — external store. Discrete state via
  `useSyncExternalStore`; level written to a module variable and read in a
  `requestAnimationFrame` loop that sets `style.width` directly → **zero React renders**
  for the meter (the worklet emits ~20 samples/s).
- New `src/components/AudioStatusBar.tsx`, mounted in `TopBar`.
- States: LISTENING / SPEECH / TRANSCRIBING / NO AUDIO / DISCONNECTED / ERROR.
- Level is the RMS of the **system-loopback stream the ASR actually consumes**, never the
  mic. dB mapping (-60 dBFS → 0, 0 dBFS → 100), fast attack / slow release.
- Worklet level cadence 0.5 s → **0.05 s**, now carrying `rms` + `speaking`.
- `resolveAudioState()` is a pure function so the time-based silence branch is testable.

### 3. Gate — short imperative requests
`"Explain Docker"` → `wait: too short`. Fix in `analyseUtterance`: the `< 3 words` rule now
also exempts `STRONG_REQUESTS` (structural request verbs). **No topic whitelist** — any
domain word behaves identically.
Also found by the harness: `"What is this tape being?"` was WAITed (5 words + soft tail
"being"). Added `WH_AUX_OPENER` (wh-word + auxiliary) which rescues it without rescuing
`"what i was saying is"`.

### 4. Provider routing
- **`openrouter/free`** is a real router (verified in OpenRouter docs). Now the OpenRouter
  default; the response's top-level `model` field is parsed into `AIStreamMeta.model` and
  surfaced as `resolvedModel` in the UI + logs.
- Free mode gets **no** catalog-wide `fallbackModels` — if the free router is down the run
  goes to the next provider, which is the configured policy, not a hidden substitution.
- **New direct NVIDIA provider** (`src/lib/ai/nvidia.ts`). Contract verified against
  NVIDIA docs, not invented: `POST https://integrate.api.nvidia.com/v1/chat/completions`,
  `Bearer` auth, OpenAI-compatible SSE. Distinct from "an NVIDIA model via OpenRouter".
- Chain default `["openrouter","nvidia"]`, filtered to providers that actually have keys.
- `FIRST_BYTE_TIMEOUT_MS` **unchanged at 4500**. Added real measurements instead:
  `http`, `firstChunk`, `total`, `outcome` per attempt → `[AI:{turnId}] timings: …`.

### 5. Verification
- harness **169 passed, 0 failed**
- `tsc --noEmit` (web + node) ✅ · `npm run build` ✅ · dev boot clean ✅
- Migration confirmed against the real store:
  `OpenRouter model "openai/gpt-oss-120b" → "openrouter/free"`

### Still unverified (needs real hardware/keys)
- Earbuds vs speakers, device swap, `AudioContext` error absent in a real device cycle.
- Whether 4500 ms is right — needs the new `timings` line from a live run.
- `openrouter/free` availability, rate limits and answer quality.

---

## Review follow-up: full 4-provider chain + AudioContext wording correction

### Gap found in review: chain was incomplete
`providerOrder` defaulted to `["openrouter","nvidia"]` — Groq and Gemini were absent
from the architecture entirely, so the intended
`OpenRouter → Groq → NVIDIA → Gemini` chain was not expressed.

**Fixed:**
- `INTERVIEW_PROVIDER_ORDER = ["openrouter","groq","nvidia","gemini"]` is now the
  canonical order in `src/lib/providerDiagnostics.ts`.
- `providerOrder` defaults updated in **both** `useStore.ts` and `electron/ipc.ts`
  (they must stay in sync).
- `normalizeProviderOrder()` now always emits the canonical order. `providerOrder` is
  the user's *enabled* chain, not "what works today" — so all four providers stay
  visible in Settings and the order is stable when a key is added later.
  Whether a provider is attempted is still decided per run by the key filter.
- Settings gained an **Interview Answer Chain** control: all four providers, ordered,
  individually toggleable, each showing `ready` / `no key · skipped` / `off · skipped`.

### New startup diagnostic (reviewer's requested shape, produced)
```
[AI] configured provider chain: openrouter(openrouter/free) → groq(allam-2-7b) → nvidia(meta/llama-3.3-70b-instruct) → gemini(gemini-2.5-flash)
[AI] resolved interview provider chain: ...
[AI] provider status:
  OPENROUTER [openrouter/free] — ready (free router — model chosen per request)
  GROQ [allam-2-7b] — SKIPPED: no API key
  NVIDIA [meta/llama-3.3-70b-instruct] — ready
  GEMINI [gemini-2.5-flash] — SKIPPED: no API key
```
Emitted on settings load AND before every interview run. Three states are
distinguished: `ready`, `missing-api-key`, `not-in-chain`.

Verified live against the real on-disk store — all four providers now appear.

### Wording correction (reviewer was right)
`AudioContextState` is `"suspended" | "running" | "closed"` (+ `"interrupted"` in newer
specs). There is **no** `"closing"` state — my earlier report and one code comparison
were wrong. `close()` is async and `state` does not change until the promise settles,
so the real race is two paths both observing `"running"`.

Removed the invalid `=== "closing"` comparison and corrected the comment. The
implementation was already correct: the **synchronous `done` flag** is what prevents the
second close, because it flips before any await point. The `state === "closed"` check
remains only as a cheap fast-path.

### Verification
- harness **186 passed, 0 failed** (17 new chain/diagnostics checks)
- `tsc --noEmit` web + node ✅ · `npm run build` ✅ · dev boot clean, 0 errors ✅

---

## Session: manual-hotkey answer orchestration (hedge + fallback)

### What changed
Replaced the "wait FIRST_BYTE_TIMEOUT_MS (4500ms) then fail over" model with a
**soft hedge**:

```
0ms    OpenRouter Free starts
       └─ produces ≥12 non-ws chars of useful text  → HEDGE DISARMED, wait for completion
       └─ hard failure (http/network/stream/abort) → next provider IMMEDIATELY
~1800ms still no useful text, not complete, not failed → start Groq alongside (max 2 concurrent)
       first provider to COMPLETE with an answer that PASSES the validator wins
       every loser is aborted via its own AbortController
       never more than 2 providers in flight (hedgeFired guard — the timer fires once)
```

### The rule that matters
**FIRST USEFUL TEXT, NOT TOTAL TIME.** A healthy stream that takes 3.4s in total but
produced its first useful text at 1.5s is never hedged. `disarmHedge()` fires on the
first meaningful chunk.

### Completed-answer-only UX
The orchestrator buffers internally; nothing is streamed to the screen. This is what
makes "first VALID COMPLETE answer wins" meaningful and makes a cross-provider overwrite
structurally impossible — the old "partial kept, never replaced" rule becomes vacuous
because no partial is ever visible. The streaming SolutionCard was replaced by an
"ANSWERING… · <provider>" line in the detected-question banner.

### Files
- **NEW** `src/lib/ai/orchestrator.ts` — hedge, concurrency cap, winner selection,
  cancellation, telemetry. `OPENROUTER_HEDGE_MS = 1800`, `MAX_CONCURRENT_PROVIDERS = 2`,
  `MEANINGFUL_CHARS = 12`.
- **REMOVED** `src/lib/ai/answerRunner.ts` (superseded; `FIRST_BYTE_TIMEOUT_MS` gone).
- `src/pages/Home.tsx` — uses `orchestrateAnswer`, validator passed in as the win
  condition, `onStatus` → banner, no `appendToSolution` streaming.
- **NEW** `scripts/verify-orchestration.mts` — 74 deterministic checks with scripted
  fake providers (no network).
- `src/lib/ai/openrouter.ts` / `nvidia.ts` / `groq.ts` — expose `meta.httpMs`.

### Deliberately dropped
The per-provider "retry this gateway on a different model id" list (`fallbackModels` +
`onModelHealed`). With hedging, starting the next provider is a faster answer than
retrying the same gateway on another model. Reverting a retired model now happens via
Settings.

### Verification
- orchestration harness **74 passed, 0 failed**
- pipeline harness **186 passed, 0 failed**
- `tsc --noEmit` web + node ✅ · `npm run build` ✅ · dev boot clean, 0 errors ✅

Two test failures during development were caused by the fake answers being correctly
rejected by `validateAnswerOutput` (label-shaped text with no terminal punctuation) —
a useful confirmation that the validator is doing its job.

### NOT verified
No live latency numbers. `OPENROUTER_HEDGE_MS = 1800` is a starting constant, not a
tuned value — it must be adjusted from real `firstTextMs` telemetry over ~10 real
questions before it should be trusted.

---

## Session: interview-readiness pass — 17-item TODO list

Goal: make Ghostly usable for a real 1-hour interview. Overlays, region picking,
provider chain, key pools, latency policy.

**Status: 15 of 17 DONE. 1 partial (16). 1 is this log (17).**
Full status table and tomorrow's remaining work are in section **L** at the end of this file.

### A. Baseline taken BEFORE any change (this is what made the work trustworthy)

There is no `npm test`. Tests are 36 standalone harnesses in `scripts/verify-*.ts|mts`
run through `npx tsx`. Baseline:

```
2711 passed, 0 failed, 32/32 harnesses exit 0
```

Recorded up front so every later number could be compared against it instead of
assumed good. Final: **3125 passed, 0 failed, 36/36**. Zero pre-existing failures were
"fixed" along the way.

---

### B. Overlay opacity (TODO 1) — the control could not exist before

**Root cause:** `main.ts` already used `BrowserWindow.setOpacity()` for something else —
`0` meant HIDDEN, `1` meant SHOWN. The one knob the window had was already spoken for,
so there was no opacity control to add. Hijacking it would have made "hide" and "see the
interview behind Ghostly" the same gesture.

**Decision, and why it deviates from requirement 9.** Requirement 9 said "prefer
BrowserWindow opacity"; requirements 6 + 7 said "the app behind must stay visible" AND
"answer text must stay readable". Those are **not simultaneously satisfiable** through
one window-level scalar: `setOpacity` scales everything inside the window by the same
factor, so 0.2 means 20%-white text. Requirement 10's renderer path is the only one that
meets both, so:

- `setOpacity` keeps its original job — `0` = hidden, `1` = shown.
- The user's alpha is applied to Ghostly's **surfaces only** via `--ghostly-alpha`;
  text colours are left at full strength.

**Files**
- **NEW** `electron/overlayOpacity.ts` — pure policy: MIN 0.2 / MAX 1.0 / DEFAULT 0.85,
  `normalizeOverlayOpacity`, `opacityFromSliderValue`, `createOverlayOpacityController`.
  Split `hidden` from `opacity`; `windowOpacity()` is derived as `hidden ? 0 : 1`.
- **NEW** `src/components/OpacityControl.tsx` — the slider, rendered in the
  **always-mounted TopBar** (requirement 23: reachable mid-interview, no Settings needed).
- **NEW** `src/lib/overlaySurfaces.ts` — `gs()` helper. Most panels use inline
  `background:`/`border:` shorthands, which beat any stylesheet, so the `.gs` CSS class
  could not reach them; this produces the same `rgb(... / calc(a * var(--ghostly-alpha)))`
  expression for those sites.
- `src/styles/global.css` — `:root { --ghostly-alpha }`, `.gs`, `.gs-b`, `.gs-control`.
- `electron/main.ts` / `electron/hotkeys.ts` — every `getOpacity() > 0` "is it visible?"
  probe replaced with `isOverlayVisible()`. A 20% window is `0.2` and very much visible,
  so Ctrl+B would otherwise have failed to hide it.
- New IPC: `ghostly:get-overlay-opacity` / `ghostly:set-overlay-opacity`.

`.gs-control` gives the control itself an alpha **floor** (`max(0.82, alpha)`) — a
control you cannot read or aim at is not a usable control.

**Bugs found while testing this**
- `Number(null)` is `0`, so a missing persisted value clamped to the MINIMUM (20%) instead
  of the default. Ghostly would have been nearly invisible on every cold start.
- The IPC channel unit mismatch: the renderer sends **percent**, main read it as a
  fraction, so dragging to 50% set **100%**. Fixed with `opacityFromSliderValue`
  (a fraction can never exceed 1, so magnitude is a sound discriminator).

---

### C. Select Region (TODO 2) — the click path worked; three things around it did not

Built `scripts/verify-select-region-click.mts` FIRST, against the unmodified app, to find
the actual defect instead of guessing. It drives the **real** app and clicks with
`webContents.sendInputEvent` (Chromium's own input pipeline), not a dispatched event —
a synthetic `click` bypasses hit-testing and would pass while the button stayed unclickable.

**Finding: the raw click path was already sound.** Button hit-testable, picker created,
visible, focused, always-on-top, drag produced W x H, region reached the watcher at
exactly the device-pixel size displayed, Escape closed it, button usable afterwards.

The reported symptom came from three defects *around* that path:

1. **OCR gated region selection.** `disabled = busy || !status.ocrAvailable`. Choosing a
   rectangle and reading text are independent — on a machine with no Windows OCR language
   pack the button was **permanently dead**. Split into `regionDisabled = picking` and
   `toggleDisabled` (OCR still correctly gates the On/Off toggle).
2. **No timeout on the pick.** `busy` fed the `disabled` attribute, so any unsettled pick
   disabled the button **for the rest of the session** with no way back. That *is* the
   reported symptom. Added `PICK_TIMEOUT_MS = 90_000`, a `Promise.race`, a visible
   `pickError`, and an unconditional `finally`.
3. **Unbounded screen capture.** `pickScreenRegion` awaited `desktopCapturer.getSources`
   with no bound before creating the window, so on a large display the click looked dead.
   Added `CAPTURE_TIMEOUT_MS = 1500`; on timeout the picker opens transparent. A capture
   arriving *after* the timeout is deliberately discarded — applying it late would paint
   the picker into its own backdrop.

---

### D. The "+" cursor (TODO 3) — located, not guessed

Source: `electron/regionPicker.ts` declared an **unconditional** `cursor: crosshair` on
`html, body`. Two consequences:
- it was active while the picker was merely OPEN, before any drag — signalling something untrue;
- Ctrl+H captures the **whole screen**, so any screenshot taken with the picker up
  photographed the crosshair. That is how the artefact reached the reported screenshots.

The main overlay never had one: `global.css` pins `cursor: default !important` on every
element. That guard is load-bearing and is now asserted.

Fix: `cursor: default` at rest; `body.selecting` (set on mousedown, cleared on mouseup,
on a release outside the window, and on Escape) is the only place a crosshair appears.
Cleared *before* teardown, so no frame exists in which a slow-closing picker leaves a "+"
over the desktop.

---

### E. Region Picker (TODO 4) — verified, not rewritten

Requirements 1-12 were already met. Only real gaps were closed, plus the live-Electron
probe was upgraded: the 1px border was previously only a **source grep**, and there was no
live pointer-events check. Now asserted from computed style in a real run.

Note: a `border: 1px solid` computes to **0.8px** on this 125%-scaled display — Chromium
snaps used border widths to whole DEVICE pixels. The assertion is scale-tolerant; the
"hairline was painted" property is what matters.

---

### F. Provider chain (TODO 5, 6, 9) — Gemini, then OpenRouter

```
DEFAULT   gemini -> openrouter
OPTIONAL  groq, nvidia   (integrated, configurable, NOT attempted by default)
```

`INTERVIEW_PROVIDER_ORDER` used to force-include **every** known provider, which is how
NVIDIA — 404 on the model, CORS on the model listing, every call — ended up waited on by
every interview. Anything in the chain is waited on; a broken member is a tax per question.

- `normalizeProviderOrder` now emits the default chain first and retains an optional
  provider **only if the user's saved order already had it** — so opting in survives a
  restart but is never opted into by default.
- New availability state `optional`, so "you turned it off" and "never on by default" are
  distinguishable in the log.
- **One-time, logged migration** in `App.tsx` guarded by `chainPolicyVersion = 2` strips
  the auto-added optional providers from an old store once. Without the version guard the
  migration would either re-run forever or silently undo the user later.
- `describeProviderChain` gained `primary`, reported from the CONFIGURED chain not the
  resolved one: with no Gemini key the UI must still say Gemini leads, or the user's next
  action is to add a key to the wrong provider.
- Removed the hardcoded `"OpenRouter slow -> ..."` in the hedge note and the banner — the
  primary is Gemini now, so it would have named the wrong provider.
- Gemini model left at `gemini-2.5-flash` — the registry's own `listModels()[0]`, not
  hardcoded from memory.

---

### G. Latency policy (TODO 10) — the 27.5s wait, bounded

Three **separate** deadlines, because collapsing them into one "timeout" is what produced
the observed wait:

| Constant | Value | Disarmed by real text? |
|---|---|---|
| `FIRST_TOKEN_TIMEOUT_MS` | 5000 | **yes** — a slow-but-healthy stream is never touched |
| `TOTAL_PROVIDER_TIMEOUT_MS` | 12000 | no — a trickle of chars forever must still end |
| `ABORT_SETTLE_GRACE_MS` | 1500 | n/a |

Failing past the cap is safe **because nothing is streamed to the screen** — an answer is
shown only once complete and validated, so an attempt abandoned at 12s costs nothing
visible.

**Two real bugs found here, both from tests that exposed them:**
- A **timeout was reported as a cancellation**, which reads as a clean exit and left a
  provider that just burned 12s looking healthy. `timedOut` now takes precedence.
- A **stream that ignores its abort signal held the interview open for 60s** after the
  answer was decided. Two fixes: the deadline now retires the attempt from the *scheduler's*
  view and calls `notify()` (the main loop was parked on a `waiter()` that a non-settling
  attempt never fires), and the settle is capped.

Failure-classification tests now assert elapsed `< hedge window` for 429 / 500 / 502 / 503 /
network / unavailable model / empty / validation rejection — i.e. handover is **immediate**.

---

### H. Key pool (TODO 7, 8)

**NEW** `src/lib/keyHealth.ts` — pure, clock-injected. Four statuses
(`healthy` / `cooldown` / `failed` / `not-configured`), 30s refusal window, 15s timeout
window, 3 consecutive failures means `failed` until edited.

**The safety property:** only **credential-shaped** failures move to another key
(400/401/403/429, timeout). A provider 500, a network blip, a validation rejection or a
bad model id are properties of the *provider or the request* — retrying them on a second
key would spend three of the user's keys on one outage and end the interview.

`apiKeys` was **kept as slot 1** rather than replaced: it is read by the settings
migration, the chain diagnostics and the "has a key" filter, none of which care how many
keys exist. `keyPool()` re-joins the halves in one place.

**Bug found:** the orchestrator's in-flight map was keyed by **provider**, so a pool's
attempts for the same provider overwrote each other — under-counting concurrency, letting
the cap be exceeded, and leaving one attempt un-abandoned. Now keyed per attempt id.

Also: a success is the **only** thing that clears a slot, and it never reorders the pool
(asserted — if that ever fails the pool has become a round-robin). Cooldown state is
deliberately **not persisted**. Key material is never logged: swept for `${apiKey}` while
explicitly still permitting `${!!apiKey}` (boolean presence is required — the existing
`verify-orchestration` test 18 already depended on it).

UI: masked `type="password"` x 3 per default-chain provider, plus a status line limited to
five fixed words. Editing a slot clears its health record.

---

### I. Validation (TODO 11) — untouched, and proven not weakened by the pool

`outputValidation.ts` and `interviewAgent.ts` were **not modified**. The new risk is that
a key pool multiplies attempts, and "another key" and "another chance at a bad answer" are
the same mechanism — so that is now asserted directly: slot 1 emits a `<<<LATEST_TASK>>>`
artefact, slot 2 emits a valid answer, and only slot 2 may win. An incomplete stream wins
nothing no matter how many keys exist.

### J. Screenshot / Live Screen / ASR (TODO 12, 13, 14)

**NEW** `scripts/verify-interview-readiness.mts` — real Electron capture (351 KB PNG
through the production handler), delivered via the real event, and confirmed **decoded**
(`naturalWidth > 0`). `undefined`/empty payloads proven not to count anywhere.
Live Screen privacy proven by **enumerating the renderer bridge at runtime**: seven
Live-Screen capabilities, all on an allow-list, none named like a pixel reader.
**Parakeet deliberately NOT made the default** — it is Moonshine by design (a pre-Parakeet
settings blob must resolve to a working engine) and switching it would be the ASR redesign
this task forbids. Asserted *intact*, not flipped.

---

### K. Verification

```
tsc --noEmit (web + node)  OK - clean
npm run build              OK - clean
36/36 harnesses            OK - exit 0
3125 passed, 0 failed      (baseline 2711 / 32)
```

Four new harnesses: `verify-overlay-opacity.mts` (114), `verify-select-region-click.mts`
(60), `verify-key-pool.mts` (88), `verify-interview-readiness.mts` (64).

**Tooling note worth keeping:** `executeJavaScript` returns its result over IPC via
structured clone. Returning an object containing anything unclonable fails the whole call
with a bare `An object could not be cloned` and no hint which property caused it. Return a
`JSON.stringify(...)` **string** instead. Also: a bare assignment expression
(`window.x = function(){}`) evaluates to the function, which is unclonable.

**Known flake:** `verify-region-picker` timed out once at 123s under full-suite load and
passed on re-run (37/0, 11s). It grabs the real desktop, so it is timing-sensitive under
load. Not caused by these changes.

`tests/fixtures/asr/manifest.json` gets rewritten as a side effect of running
`verify-asr-bench.mts`. Reverted — it is a benchmark artefact, not a task change.

---

### L. TODO STATUS

**DONE — 15 of 17**

| # | Item | Verified by |
|---|---|---|
| 1 | Overlay opacity control | `verify-overlay-opacity.mts` 114 — real app, 20/50/85/100 applied + persisted + hit-testable at each |
| 2 | Select Region click | `verify-select-region-click.mts` 60 — real OS-level click, picker created, Escape closes |
| 3 | Crosshair / "+" cursor | `verify-select-region-click.mts` A21-A24 — crosshair only while dragging |
| 4 | Region Picker | `verify-region-picker.ts` 52 — live computed style, not a source grep |
| 5 | Gemini primary | `verify-pipeline.ts` + real-launch log `[AI] primary provider=gemini` |
| 6 | OpenRouter fallback | `verify-orchestration.mts` — handover immediate for all 8 listed conditions |
| 7 | Multiple key slots | `verify-key-pool.mts` 88 — pool shape, masking, no key in logs |
| 8 | Key health / failover | `verify-key-pool.mts` — 4 statuses, cooldown boundary to the ms |
| 9 | NVIDIA out of default chain | `verify-pipeline.ts` — `optional`, absent from configured chain |
| 10 | Latency policy | `verify-orchestration.mts` — first-token / total / settle |
| 11 | Strict validation | `verify-orchestration.mts` — pool cannot bypass validation |
| 12 | Screenshot -> Solve | `verify-interview-readiness.mts` — real capture, decoded thumbnail |
| 13 | Live Screen privacy | `verify-interview-readiness.mts` — bridge enumerated at runtime |
| 14 | Parakeet intact | `verify-interview-readiness.mts` Part D + `verify-primary-asr.mts` 182 |
| 15 | Full regression | 3125 / 0, tsc clean, build clean |

**NOT DONE — carry into the next session**

#### [ ] TODO 16 — Real interview run (the only genuinely unverified thing)

Sections **A-I are machine-verified under real Electron.** Section **J was not run**:

> Run at least several real questions. Record ASR latency, provider first-token latency,
> provider total latency, accepted answer latency, fallback count.

**Status after the 2026-10-06 verification attempt (the earlier blocker was FALSE).**
`npm run dev` boots the real app on this machine and it logs `[AI] primary provider=gemini`,
`GEMINI [gemini-3.5-flash] — ready` and `OPENROUTER [openrouter/free] — ready`, so both keys
DO exist and hardware audio devices are present. The REAL blocker is different: TODO 16 asks
for **T0 (interviewer stops speaking)** and **T6 (answer visible)**, which are human-observed
events in a live spoken interview. An autonomous agent cannot produce truthful T0–T6 for a
live interview, so **no interview-latency number is claimed here.** A real **provider-only**
probe WAS run (numbers in the 2026-10-06 session note at the end of this file).
`FIRST_TOKEN_TIMEOUT_MS = 5000` and `TOTAL_PROVIDER_TIMEOUT_MS = 12000` remain **unchanged**,
as instructed.

Steps for tomorrow:

1. Put a Gemini key in **API Key 1** and an OpenRouter key in **API Key 1** (Settings ->
   Key Pool). Add a second Gemini key as **API Key 2** to exercise the pool.
2. **Opacity** — drag to 20 / 50 / 85 / 100 with the interview app behind it. Confirm
   Ghostly's panels go see-through and the answer text stays fully readable (that is the
   whole reason the alpha is applied to surfaces and not to the window).
3. **Select region** — click Select region, drag, confirm W x H, Escape. Confirm no "+" in
   the normal UI.
4. **Gemini first** — start an interview; confirm the banner shows `Using Gemini`.
5. **Gemini failure** — revoke the Gemini key, answer one question, confirm OpenRouter
   takes over quickly. Then revoke both and confirm a **clean** failure with the
   "no answer" banner rather than a hang.
6. **Key pool** — watch the log for `GEMINI API Key 1 -> cooldown Ns (rate limited)`.
7. **The run** — answer ~10 questions and capture from the Latency panel:
   ASR ms / `firstText` / provider `total` / accepted-answer ms / fallback count.
8. **Tune from those numbers only.** If median `firstText` for Gemini is > 2s, lower
   `FIRST_TOKEN_TIMEOUT_MS`. If accepted-answer p95 is near 12s, the total cap is too tight.

#### [ ] TODO 17 — Final interview-ready configuration report

Written and delivered at the end of this session (chat), with the provider/key-pool/test
numbers. Re-issue it **after** TODO 16, because until real latency exists the honest
verdict is still **NOT interview-ready** — one critical TODO remains unchecked.

### M. Deliberate deviations — revisit if you disagree

1. **Window opacity was NOT used for the transparency.** One window-level scalar cannot
   keep both the app behind visible and the answer readable. `setOpacity` still means
   hidden/shown. If you want literal window opacity and accept 20%-white text, that is a
   small change in `overlayOpacity.ts`.
2. **Parakeet was NOT made the default.** See section J.
3. **NVIDIA/Groq were dropped from the default chain** rather than left parked-by-cooldown.
   They remain fully selectable in Settings.

### N. Encoding warning for the next session

`dailylog.md` is UTF-8 **without** BOM but contains multi-byte characters (em-dashes,
box-drawing, arrows). Do NOT edit it with PowerShell `File.WriteAllText` / `-replace` —
that path re-encodes and silently drops them. Use an editor or the file-edit tool, then
confirm the byte count grew rather than changed encoding:

```powershell
[System.IO.File]::ReadAllBytes("D:\ghostly\dailylog.md")[0..3]   # expect 23 20 47 68  ("# Gh")
```

---

## Session: real-interview verification attempt (2026-10-06) — TODO 16 still NOT done

Objective was the real-interview run (TODO 16). **It was not completed, and nothing below
should be read as a completed TODO 16.** What was actually done, and what is real vs not:

### 1. The real app was booted (REAL, live evidence)

`npm run dev` launched the actual Electron app. Live renderer log:

```
[AI] primary provider=gemini
[AI] configured provider chain: gemini(gemini-3.5-flash) → openrouter(openrouter/free)
[AI] resolved interview provider chain: gemini(gemini-3.5-flash) → openrouter(openrouter/free)
[AI] provider status:
  GEMINI [gemini-3.5-flash] — ready
  OPENROUTER [openrouter/free] — ready (free router — model chosen per request)
  GROQ [allam-2-7b] — SKIPPED: optional — add it in Settings to enable it
  NVIDIA [nvidia/llama-3.1-nemotron-70b-instruct] — SKIPPED: optional
```

- **Gemini is attempted first** — confirmed live; `primary provider=gemini`.
- **OpenRouter is the fallback** — confirmed live; present and `ready`.
- **Groq and NVIDIA are NOT in the default chain** — confirmed live; both `SKIPPED: optional`.
- No key material is ever printed (presence only).

### 2. Deterministic harnesses (REAL, offline)

`verify-orchestration.mts` **129/0**, `verify-stage-timing.mts` **108/0**,
`verify-pipeline.ts` **200/0**, `verify-provider-cooldown.mts` **89/0** — 526 checks, 0 failed.

### 3. A REAL provider probe was run (numbers ARE measured)

A temporary probe drove the **real provider modules** with the **real stored keys**
(keys never printed). Single real request each, real network:

| Provider | Model | first token | total | outcome |
|---|---|---|---|---|
| Gemini | gemini-3.5-flash | ~1695 ms | ~2836 ms | HTTP 200 |
| OpenRouter | openai/gpt-oss-120b | ~2291 ms | ~3378 ms | HTTP 200 (backend DeepInfra) |

Fallback handover, real orchestration with a deliberately invalid Gemini key:

```
provider=gemini FAILED (http)  — HTTP 400 "API key not valid"  at 129 ms → handover immediate
provider=openrouter SUCCESS winner — firstText=2307 ms total=3354 ms
fallback events (non-winner attempts) = 1
```

**What this does and does NOT prove:** it proves the **provider leg** is fast (~1.7–3.4 s) and
that a recoverable Gemini error hands over to OpenRouter **immediately** (~130 ms to failure,
not a 5 s wait). It does **not** measure the interview path (ASR → gate → provider →
validation → render). The **5000 / 12000 ms timeout values were NOT changed.**

### 4. ASR engine: Parakeet is now the default (changed + verified)

At the time of the verification run the engine was **Moonshine** (`DEFAULT_PRIMARY_ASR =
"moonshine"`, Parakeet primary only when explicitly selected). The user then made the explicit
decision to make **Parakeet the default interview ASR, with Moonshine only as the local
fallback**, and that change was applied and verified in the real app — see the session note at
the end of this file.

### 5. Why TODO 16 still cannot be closed here

TODO 16 as specified needs, per question, T0 (interviewer finishes speaking) and T6 (answer
visible in the overlay) in a **live interview**. Both are human-observed events. No latency
figure for the interview path is truthful without a human present, so none is reported.
**TODO 16 stays `[ ]` and TODO 17 stays `[ ]`.**

---

## Session: Parakeet made the DEFAULT interview ASR (2026-10-06)

Explicit user decision, applied as a scoped change. No other architecture was touched, and
Moonshine was kept (as fallback only).

### What changed
- `src/lib/primaryAsr.ts` — `DEFAULT_PRIMARY_ASR` is now `"parakeet"`; `normalizePrimaryAsr()`
  now preserves an **explicit `"moonshine"`** and resolves everything else (absent, `""`,
  garbage) to Parakeet. Moonshine is not removed — it stays the local fallback.
- `electron/ipc.ts` — the **required integration change**. The main-process Parakeet gate was
  `settings.primaryAsr === "parakeet"`, but a saved settings object has NO `primaryAsr` key, so
  flipping only the code default would have left Parakeet DISABLED in the main process while the
  renderer treated it as the default. The gate now treats anything other than an explicit
  `"moonshine"` as Parakeet, and `primaryAsr: "parakeet"` was added to the electron-store
  defaults for shape parity with `useStore`.
- `src/store/useStore.ts` — default still derived from `DEFAULT_PRIMARY_ASR`; comment corrected.
- Tests updated to assert the NEW policy (a required behaviour change, not a weakened
  assertion): `scripts/verify-primary-asr.mts` (checks 1–9, 78, 80, 82, 83) and
  `scripts/verify-interview-readiness.mts` Part D (D1–D4, D14).

### Verification (all real)
- `npx tsc --noEmit -p tsconfig.json` OK · `-p tsconfig.node.json` OK · `npm run build` OK
- `verify-primary-asr.mts` **183/0** · `verify-asr-readiness.mts` **82/0** ·
  `verify-interview-readiness.mts` **65/0**
- **Real app (boot + Ctrl+I), live log:**
  `[Parakeet] model ready loadMs=19910 modelMb=631` ·
  `[Parakeet-DIAG][Parakeet-only] mode=primary status=ready decodeMs=927` ·
  `[STT] final (system, parakeet): What is Java 15?` ·
  `[ASR] Parakeet -> Moonshine fallback: it returned no text` →
  `[ASR] Loading model: onnx-community/moonshine-base-ONNX` →
  `[STT] final (system, moonshine): (no speech recognised)`.
  I.e. **Parakeet primary, Moonshine only as fallback.** App then stopped.

### Not done (deliberately)
- TODO 16 (live interview latency) and TODO 17 remain `[ ]`.
- The pasted “Personal Interview Context + Answer Instructions” spec was NOT implemented —
  it is out of scope for this instruction.

---

## Session: universal interview mode (master interview-experience prompt)

**Status: the feature set is implemented and machine-verified. TODO 16 and TODO 17
remain `[ ]`.** The honest gap is unchanged: nothing here measures a real spoken
interview, because that needs a human in a live interview.

### The state I found, and why this session started with repair

The working tree was **mid-refactor and did not compile or boot**. Most of the
requested feature set was already written but half-wired. The baseline was
measured against a throwaway worktree at `HEAD` rather than assumed, which
mattered: **`HEAD` itself does not typecheck cleanly (28 errors)**, so the
`dailylog` claim “tsc clean” was stale.

WIP-introduced failures fixed here, all of which blocked the app from running:
- `DEFAULT_ANSWER_INSTRUCTIONS` was imported by `src/store/useStore.ts`,
  `SettingsPanel.tsx` and `InterviewContext.tsx` but **never exported** by
  `src/lib/prompts.ts`. The store module failed to load, so **the app rendered
  nothing at all**. Now defined in `prompts.ts`.
- `src/components/InterviewReportPanel.tsx` **did not exist** but was imported by
  `Home.tsx`. Written.
- `Home.tsx` referenced three undefined names (`Settings`, `ProviderName`,
  `isGeneral`) and was missing the `onCaptureScreen` prop. Fixed; `isGeneral` was
  a category relic and is simply gone.
- `src/lib/localModel.ts` was missing from `tsconfig.node.json`'s include list.
- `App.tsx` had two implicit-`any` callbacks in the chain migration.

### Two REAL bugs found by writing the tests (not by reading the code)

1. **`projectContext` never reached the interview system prompt.**
   `interviewAgent.ts` pushed the *Project & Internship Context* block into
   `profile` **after** `profile.join()` had already been emitted, so it was
   silently discarded. Every project/internship question was answered from the
   resume alone — the exact case the field exists to fix. Fixed by moving the
   push before the join.

2. **The coding drill-down chain broke the conversation thread.** Requirement 7
   gives this exact sequence, and all three follow-ups dropped the thread:
   `Write a function to reverse a string.` → `Can you optimize the solution?` →
   `What is the time complexity?` → `What edge cases should I handle?`
   Two independent causes: none of the follow-ups shares a content word with the
   first question, so topic overlap scored 0; and `What is the time complexity?`
   matches `NEW_SUBJECT_CUES` (it opens like “What is Docker?”), so it was read as
   a topic switch. Fixed by adding one technology-neutral **drill-down cue
   group** — not by touching `NEW_SUBJECT_CUES`. Cues are tested before the
   new-subject check by design, so “What is the time complexity?” now attaches
   while “What is Docker?” still opens a new subject.

   A related inconsistency surfaced at the same time: `conversationThread` treated
   “trade-offs” as a follow-up cue but `sessionContext` did not, so the same
   sentence attached the thread and not the active problem. The cue is now in
   both layers.

### A design decision I made, and the invariant I had to rewrite

`verify-interview-readiness.mts` C9–C11 asserted that screen-OCR text could
**never** reach a prompt without a click. That was the contract of the
region-based Live Screen panel. Requirement 8 removes that panel and requirement
10 replaces it with an opt-in full-screen watcher that does answer automatically,
so “never automatic” became the wrong invariant.

I did not simply delete the checks. The underlying risk is real — OCR can misread
a code comment as a question — so the risk is now pinned by a **stronger, more
specific** contract: the automatic path needs **two** opt-ins (`autoDetectQuestion`
AND `autoAnswer`), is **OFF** by default in both the store and the main process,
can only be triggered by the debounced/stability-gated/RAM-guarded read channel,
sends **text only** (never a frame), and reuses the **one** interview answer path
so the resume, project context, answer instructions and thread all still apply.

**If the double opt-in is not what you want, this is the one decision to revisit.**

### Pre-existing type debt: 28 → 11

Fixed 17 real errors (including two latent runtime crashes: `openrouter.ts` and
`nvidia.ts` wrote to an **optional** `meta` without a guard — fine only because
the orchestrator happens to always pass it; and `orchestrator.ts` narrowed
`winner` to `never` because it is assigned inside a closure).

The remaining **11** are all in four **unreferenced** files that reference a
`window.ghostlyAPI` which has never existed — not even at `HEAD`:
`src/hooks/useAIStream.ts`, `src/hooks/useCapture.ts`, `src/pages/History.tsx`,
`src/pages/Settings.tsx`. They were left in place deliberately: deleting four
files is not this task's job. `tsconfig.node.json` (main + preload) is **clean**,
and `npm run build` is **clean** — `electron-vite` does not typecheck, so this
debt never blocked a build.

### TODO CHECKLIST — this session

Implemented AND tested (`[x]`):

- [x] **Add Project & Internship Context** — persistent multiline field, editable,
      clearable, survives restart (proved by typing into it in real Electron and
      re-reading the store). `SettingsPanel.tsx:970`, `InterviewContext.tsx`.
- [x] **Add Answer Instructions** — one field, replaces the old per-mode box;
      `customInstructions` is migrated and deleted by `App.tsx`.
- [x] **Remove category dropdown** — `INTERVIEW_TYPE_GROUPS`/`INTERVIEW_TYPES`
      deleted from `SettingsPanel.tsx`; no category can reach the answer path.
- [x] **Remove old General custom-instruction box** — migrated, not duplicated.
- [x] **Simplify screenshot workflow** — one gesture, no rectangle.
- [x] **Replace region selection with full-screen capture** — `LiveScreenPanel`
      unmounted; `captureScreen` is one implementation shared by the button and
      the Ctrl+H hotkey.
- [x] **Add optional screen-change detection** — “Auto-detect new question”, OFF by
      default; the setting now actually reaches the main process (it never did).
- [x] **Add lightweight local fallback** — Qwen3 1.7B, last leg only, never primary.
- [x] **Integrate Qwen3 1.7B Q4_K_M** — llama.cpp sidecar, memory-guarded, warm.
- [x] **Verify universal conversation continuity** — coding / SQL / Redis /
      system-design / project / behavioural follow-ups plus topic switch.
- [x] **Regression verification** — 38/38 harnesses, 3255 checks, 0 failed.

Deliberately NOT done:

- [ ] **TODO 16 — Real interview latency verification.** Still open, and **not**
      advanced by this session. A real provider probe, a green build, a booting
      app and scripted audio are **not** a live interview. T0 (interviewer stops
      speaking) and T6 (answer visible) are human-observed events. **No latency
      number is claimed anywhere in this log.**
- [ ] **TODO 17 — Final report.** Still open; it depends on TODO 16.

### Verification (all real, no fabrication)

- `npx tsc --noEmit -p tsconfig.node.json` **0 errors** ·
  `-p tsconfig.web.json` **11 errors, all pre-existing dead files** ·
  `npm run build` **clean**
- **38/38 harnesses exit 0 — 3255 checks, 0 failed** (baseline was 36 harnesses;
  `verify-universal-interview.mts` +126 and `verify-universal-electron.mts` +34
  are new)
- **REAL Electron** (`verify-universal-electron.mts`, 34/34) — the app boots and
  paints; the overlay shows *Start Interview / Capture Screen / Auto-detect new
  question: OFF / End Interview / View report / Opacity 85%* and **no** category
  and **no** “Select region”; all three context fields render and **Answer
  Instructions arrives pre-filled** with the shipped guidance; typing into all
  three **persists and survives a store reload**; `Capture Screen` returns a real
  PNG that Chromium **decoded at 1920×1080**; turning auto-detect ON starts the
  main-process watcher on the **whole 1920×1080 display** and OFF stops it; no
  bridge method is named like a frame/pixel reader.

What the real-Electron run did **not** prove, stated plainly: that an **answer
appears** for a spoken question, that **audio → Parakeet → AI → answer** works
end to end, or that a **screen change produces a new answer**. Those need real
audio, real keys and a human — TODO 16.

### Three harnesses were failing and were repaired, not weakened

- `verify-pipeline.ts` (9) asserted the 2-provider chain. `local` is now a real
  third leg, so the chain assertions were updated **and a new one added**:
  `local` must be **LAST**, never primary. Groq/NVIDIA are still asserted absent
  from the default chain.
- `verify-live-screen.ts` 13k flagged the word `dataUrl` anywhere in the preload
  block, which matched `ocrImageText(payload: { dataUrl: string })` — an image
  going **in** and **text** coming out, not a pixel channel. Rewritten to test
  what it meant, plus three new guards. **The first rewrite passed
  vacuously** (its regex matched 0 of 8 methods); caught by probing, then fixed
  with an explicit `13k-pre` count guard so it can never pass by absence again.
- `verify-screenshot-solve.ts` (2) asserted a renamed variable and the removed
  category prompt builder. Updated, plus a **new** assertion that the per-category
  builder is now unreachable from the app.
- `verify-features.ts` Part 3 asserted all six categories still existed and were
  selectable. **Inverted**: it now asserts the selector cannot come back and that
  the one thing it carried (answer style) survived.
- `verify-select-region-click.mts` drove a real OS-level click on the “Select
  region” button — an affordance requirement 8 orders removed. Rewritten as a
  guard that the region workflow stays out of the UI **while the picker module
  stays intact**; the picker's own behaviour is still proven under real Electron
  by `verify-region-picker.ts` (52/52, untouched and still green).

