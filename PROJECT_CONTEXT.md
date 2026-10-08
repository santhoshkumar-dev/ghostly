# Ghostly — Project Context for Review

> Hand this whole file to another AI. It is self-contained: architecture, file map,
> enforced pipeline, hard invariants, and the open bug we want suggestions on.

---

## 1. What this is

**Ghostly** is a desktop "stealth interview copilot". It sits as a transparent,
always-on-top overlay over whatever else is on screen (Zoom, Meet, a code editor),
listens to the interview through the system audio loopback, transcribes it, decides
whether a real question was asked, and answers it in a second or two.

It is deliberately **not** a screen-scraping "solve this DSA problem" tool only —
there are two entry paths that share one AI engine:

| Path | Trigger | Prompt source |
|---|---|---|
| **Live interview** (primary) | `Ctrl+Enter`, or auto-answer mode | transcript → gate → labelled prompt |
| **Screenshot solve** | `Ctrl+H` then `Ctrl+Enter`, or a typed follow-up | `buildPrompt(interviewType)` / raw query + image |

### Stack

- Electron 33 (Chromium 130) + electron-vite 2.3 + Vite 5.4
- React 18 + TypeScript 5.7 + Tailwind 3.4 + zustand 5
- Renderer-only ML: `@huggingface/transformers` 3.8 (Moonshine ONNX via WebGPU/WASM)
- No server. No telemetry. All state in `electron-store` (`%APPDATA%/ghostly`, encrypted).
- Node 24.x on Windows; shell is bash (Git Bash), never PowerShell.

### Layout

Transparent, click-through (`pointer-events-none`) until hovered. Top-centre
`TopBar` pill (~900px), content column `w-[860px]`:

```
TopBar  [Start Interview]  [General ▾]  [Screenshot Ctrl+H] [Solve Ctrl+↵] [Hide Ctrl+B]
  ├── InterviewModal          (live transcript panel, collapsible while answering)
  ├── Detected-question banner ("Auto · detected question" / "Using Groq")
  ├── Answer-issue banner      ("No answer received" / "Answer cut off — partial kept" + Retry)
  ├── Error banner
  ├── WAIT banner              ("WAIT · <reason>")
  ├── Screenshot strip
  └── Chat: user bubble  →  SolutionCard (assistant, react-markdown)  + follow-up input
```

---

## 2. HARD INVARIANTS — do not break these

These are deliberate, were each added to fix a real observed failure, and are the
thing most likely to be accidentally regressed by a suggested change.

1. **One authoritative result per transcript.** A turn is either `answer` or `WAIT`.
   Never show a detected-question banner *and* a WAIT banner at once.
   - WAIT → `setDetectedQuestion(null)`
   - answer → `setAgentNotice(null)` **and** `setAnswerIssue(null)`
2. **No LLM is used for question detection.** The gate is deterministic and local.
   Suspicious transcripts must never reach the network.
3. **Never save an empty answer and never render an empty `SolutionCard`.**
   `SolutionCard` returns `null` when `content.trim()` is empty; an empty run sets
   `answerIssue {kind:"empty"}` + Retry instead.
4. **Partial-kept, never-replaced.** If any text reached the screen and the stream then
   failed, keep it and offer Retry. Never overwrite a half answer with another
   provider's answer. Only a failure *before* any visible text may fail over.
5. **`requestId` / `isStale()`** — a superseded run must never write to the UI or
   history, even while its HTTP stream is still draining.
6. **`turnSignature` / `isDuplicateSubmit`** — the hotkey pressed twice on the same
   transcript fires one request. A `failed`/`partial` run stays re-submittable.
   `Retry` is the one intentional bypass.
7. **`AbortSignal` must be passed into `fetch`**, so an abort cancels the real network
   request rather than just dropping the response.
8. **Normalization runs before the gate**, and **only on FINAL transcripts.** Interim
   /partial transcripts are display-only; they are never normalized and never reach
   the AI.
9. **Never log API keys or resume content.**
10. **Model IDs must be verified against the real catalog** — never invented from memory.
11. **Normalization must be context-safe.** No blind rewrites of ordinary English words
    (`hook→hooks`, `render→render`, `state→state` are all explicitly forbidden).

---

## 3. Architecture / data flow

```
MIC + system loopback audio
  │
  ├─ AudioWorklet VAD            (inline `vadWorkletCode` in useInterviewAudio.ts)
  │    time-based, not frame-based:
  │      SILENCE_THRESHOLD 0.008 | MAX_SILENCE 1.0s | MIN_SPEECH 0.35s
  │      partial snapshot every 0.7s (interim, display-only)
  │      MAX_PARTIAL 20s | MAX_PHRASE 30s force-flush
  │    silence is buffered, so word tails aren't clipped
  │
  ├─ resample to 16 kHz via OfflineAudioContext (anti-aliased)
  │
  ├─ asr.worker.ts               Moonshine ONNX (onnx-community/moonshine-base-ONNX)
  │    transformers.js v3; WebGPU fp16 when `shader-f16` is supported, else WASM q8
  │    `finals` / `pendingPartial` scheduler; MIN_SAMPLES = 1600
  │
  ├─ FINAL only → normalizeTechnicalTerms() → logNormalization()
  │                                      │
  │                                      ▼
  │                          store.addInterviewMessage()
  │
  ├─ getInterviewTurn() ──► normalizeTurn() ──► evaluateInterviewTurn()   [LOCAL GATE]
  │                                                                     │
  │                                    ┌────────────────────────────────┘
  │                          WAIT  ─────┴─────  {action:"answer", question, questionIndex}
  │
  └─ buildInterviewSystemPrompt()  (system slot: rules + candidate profile)
     buildInterviewUserPrompt()    (user slot: labelled sections)
        │
        ▼
     runAnswerStream()  ──►  provider.streamSolution()  ──►  onText() ──► appendToSolution
     (answerRunner.ts)        (openrouter / groq / gemini / openai / anthropic)
                                    │
                                    ▼
                            SolutionCard + sessionMessages + history
```

### Two independent layers stop the model answering questions nobody asked

1. `evaluateInterviewTurn()` — deterministic, local, runs **before any network call**.
2. `INTERVIEW_SYSTEM_PROMPT` — the rules sit in the provider's **system** slot (highest
   priority), so even a forced-through input must come back as exactly `WAIT`.

---

## 4. File map

### Renderer — orchestration
| File | Responsibility |
|---|---|
| `src/pages/Home.tsx` | **The orchestrator.** `runAIStream()` builds the attempt chain, runs the gate, applies the duplicate guard, wires `onText` / `onProvider` / `onModelHealed`, handles WAIT / empty / partial outcomes, saves session + history, and renders the whole overlay. Also the auto-answer effect (`AUTO_ANSWER_SETTLE_MS = 600`) and all hotkey subscriptions. **Most likely home of any answer-content bug.** |
| `src/store/useStore.ts` | zustand store. `currentSolution`, `isStreaming`, `sessionMessages`, `interviewMessages`, `interviewInterim`, `agentNotice`, `detectedQuestion`, `answerIssue`, `openRouterBackendProvider`, `settings`, `history`, `getInterviewTurn()`. |
| `src/App.tsx` | Loads + **sanitises/migrates** persisted settings on mount (see §7 — it has a real bug here). |
| `src/main.tsx` | React root. |
| `src/env.d.ts` | `window.ghostly` typing. |

### Renderer — interview brain
| File | Responsibility |
|---|---|
| `src/lib/interviewAgent.ts` | `normalizeTurn()`, `analyseUtterance()`, `evaluateInterviewTurn()`, `isDuplicateSubmit()`, `turnSignature()`, `isWaitResponse()`, `INTERVIEW_SYSTEM_PROMPT`, `buildInterviewSystemPrompt()`, `buildInterviewUserPrompt()`. **Read this before touching prompts or the gate.** |
| `src/lib/normalization.ts` | Two-pass deterministic technical-term repair. Exports `normalizeTechnicalTerms()`, `logNormalization()`. |
| `src/lib/prompts.ts` | `buildPrompt(interviewType, language)` for the screenshot path, `buildInterviewContext(settings)` (company / JD / resume block). |
| `src/hooks/useInterviewAudio.ts` | VAD worklet source string, capture, resample, ASR worker lifecycle, and the `final` handler that normalizes **before** `addInterviewMessage`. |
| `src/lib/asr.worker.ts` | Moonshine ONNX worker. |

### Renderer — AI layer
| File | Responsibility |
|---|---|
| `src/lib/ai/answerRunner.ts` | Streaming engine with provider failover. `HOLD_CHARS = 8`, `FIRST_BYTE_TIMEOUT_MS = 4500`, per-attempt `AbortController`, `failovers[]`, `providerBackend`. |
| `src/lib/ai/openrouter.ts` | The intended single gateway. `OpenRouterProvider`, `parseOpenRouterEvent()`, `openRouterListModels()`, `fetchModels()`. |
| `src/lib/ai/groq.ts` | Still present and **still reachable at runtime** — see §7. Handles `delta.reasoning` models; `groqReasoningEffort()` returns `"low"` only for `openai/gpt-oss-*`. |
| `src/lib/ai/gemini.ts`, `openai.ts`, `anthropic.ts` | Retained. Gemini has `geminiGenerationConfig` thinking-budget logic. |
| `src/lib/ai/fetchWithDiagnostics.ts` | `fetchWithDiagnostics()`, `isModelUnavailableError()`, `withModelHint()`. |
| `src/lib/ai/index.ts` | Provider registry + `ProviderName` type. |
| `src/lib/ai/types.ts` | `AIProvider`, `AIRequestOptions`, `AIStreamMeta` (has `provider` = the OpenRouter backend). |

### Renderer — UI
`src/components/SolutionCard.tsx` (returns `null` on empty; react-markdown),
`TopBar.tsx`, `SettingsPanel.tsx`, `InterviewModal.tsx`, `InterviewContext.tsx`,
`ErrorBoundary.tsx`.

### Main process
`electron/main.ts` (window, always-on-top, click-through, tray),
`electron/hotkeys.ts` (global shortcuts),
`electron/ipc.ts` (settings/history persistence via `electron-store`),
`electron/preload.ts` (`window.ghostly` bridge).

---

## 5. The question gate (`interviewAgent.ts`)

Conservative by design — when in doubt it returns WAIT rather than guessing.

`normalizeTurn()` re-joins utterances the 1s VAD pause split apart ("Can you explain"
+ "… the CAP theorem"), but **only** when the fragment is a continuation and the
previous utterance is visibly unfinished, and **never** across a change of speaker.
A fully-formed question always starts a new turn.

`evaluateInterviewTurn()` returns WAIT when:

- no finals yet;
- interim text ≥ 4 chars (interviewer still speaking);
- the last thing said was the *candidate's* (`source !== "system"`);
- `analyseUtterance()` says the utterance is filler / unfinished / too short /
  speaker narration ("let me walk you through…") / self-directed ("I've seen this
  before…") with no explicit request.

`analyseUtterance()` accepts a question when it starts with a question word, or
contains a **strong request** ("explain", "walk me through", "pros and cons",
"difference between", …), or has a weak question word that isn't self-directed.
Every question word also accepts the ASR's dropped apostrophe ("whats", "hows").

---

## 6. Prompt architecture (this matters a lot — see §7)

**System slot** — `buildInterviewSystemPrompt(settings)`:

```
INTERVIEW_SYSTEM_PROMPT
  - absolute rules: answer exactly one thing; never invent a question;
    never answer an earlier question; WAIT if unclear; never fabricate
    facts about the candidate; 2-5 spoken sentences; never print labels
    like "Answer:" / "Analysis:" / never mention being an AI
--- (joined with "\n\n---\n\n")
# Candidate context      ## Company / ## Job Description / ## Candidate Resume
--- (joined with "\n\n---\n\n")
# Answer style requested by the candidate
```

The candidate profile lives in the **system** slot on purpose: the model needs the real
facts to avoid fabricating them, and putting them in the user role is what previously
caused the model to echo the transcript back as a fake question.

**User slot** — `buildInterviewUserPrompt(turn, {questionIndex, previousAnswers})`:

```
# Latest interviewer utterance — the ONLY question you may answer
<text>

# Earlier conversation (background only — do NOT answer anything here)
Interviewer: …
Candidate: …

# Your earlier answers (background only — do not repeat or continue them)
…

Now do the following: if the latest interviewer utterance above is a clear,
complete question or request, answer ONLY it in a natural spoken interview
style. Otherwise reply with exactly:
WAIT
```

Two deliberate properties:

- prior Q&A is embedded as **text**, not as chat history — `historyContext` is `[]` on
  the interview path — so no old assistant turn can act as a continuation prompt;
- the user bubble stores only `🎙️ <latest text>`, never the full template.

`isWaitResponse()` tolerates stray quotes/emphasis/trailing period and a short
`WAIT because …` explanation.

---

## 7. Provider situation — **migration to OpenRouter is INCOMPLETE**

Intent: OpenRouter is the single gateway for every AI call.

Default store values (`src/store/useStore.ts`) do say
`activeProvider: "openrouter"`, `providerOrder: ["openrouter"]`.

> **STATUS: FIXED.** See §14. Both causes below are closed; the allow-list is now derived
> from the provider registry and a one-time migration moves live interview answers onto
> the OpenRouter gateway.

**Two independent causes, both real:**

**(a) `electron/ipc.ts` electron-store defaults were never updated.** They still said

```ts
activeProvider: "gemini",
providerOrder: ["groq", "gemini"],
models: { gemini, openai, anthropic, groq },   // no openrouter
apiKeys: { gemini, openai, anthropic, groq },  // no openrouter
```

A store that had never been overwritten therefore handed the renderer a **Groq-first**
chain — this alone explains `providerChain=groq → gemini`.

**(b) `src/App.tsx` had a hardcoded allow-list that omitted `"openrouter"`:**

```ts
const PROVIDER_NAMES: ProviderName[] = ["gemini","openai","anthropic","groq"];
```

so `savedOrder = rest.providerOrder.filter(...)` could never keep `openrouter` from disk,
and `models.openrouter` was reset to the default on every launch.

### Attempt chain construction (`Home.tsx`)

```ts
isInterview ? settings.providerOrder.map(p => ({provider:p, apiKey: settings.apiKeys[p]}))
            : [{provider: settings.activeProvider, apiKey: settings.apiKeys[...]}]
  .filter(a => a.apiKey.trim())          // ← no key ⇒ provider dropped
  .map(a => ({
      model: settings.models[a.provider] || provider.listModels()[0],
      maxTokens: 4096,
      fallbackModels: provider.listModels().filter(m => m !== configured),
  }))
```

⚠️ `fallbackModels` for OpenRouter is the **entire curated catalog**
(`openai/gpt-oss-120b`, `google/gemini-2.5-flash`, `anthropic/claude-haiku-4.5`,
`meta-llama/llama-4-scout`). A "model unavailable" error mid-interview can therefore
silently swap to a completely different model with a different answer style.

### `answerRunner` semantics

`HOLD_CHARS = 8`: the first 8 non-whitespace chars are withheld, which is what makes
"failed before anything was displayed" a meaningful state — an empty/blocked first
attempt fails over with no visible flicker. `FIRST_BYTE_TIMEOUT_MS = 4500` aborts the
*attempt* (not the run) via a per-attempt `AbortController`.

Result flags returned: `displayed`, `partial`, `empty`, `aborted`, `provider`,
`providerBackend`, `finishReason`, `blockReason`, `failovers[]`.

---

## 8. THE OPEN BUG — answer card contains a prompt heading, not an answer

Screenshot state (the bug report):

- Banner: `Why they use Java as our best backack language?` (ASR heard "backend" → "backack")
- `DETECTED QUESTION` panel: same text, right side says **`Using Groq`**
- User bubble: 🎙️ `Why they use Java as our best backack language?`
- **SolutionCard body: `Previously mentioned interview questions or requests`**

That string appears **nowhere in the repository** (`rg -i "previouslymentioned"` → 0 hits),
so it is model output, not something the app wrote.

> **STATUS: FIXED.** See §14 — neutral `<<<>>>` delimiters replaced the Markdown headings,
> and `src/lib/outputValidation.ts` now rejects this class of output deterministically.

### Ranked hypotheses

**H1 — prompt-structure imitation by an open-weight reasoning model.**
`buildInterviewUserPrompt()` puts markdown `#` headings in the **user** message.
`openai/gpt-oss-120b` (the default for both `groq` and `openrouter` in the store) is
notably structure-following and heading-heavy. Rule 8 forbids labels, but rule 8 is a
prohibition in a long system prompt while the user message *demonstrates* heading
structure three times. The model imitated the template and emitted a heading.
Supporting evidence needed: the `[AI] final answer:` log line (truncates to 80 chars)
should show that exact string.

**H2 — the run was Groq, not OpenRouter** (see §7). Groq's `gpt-oss-*` path sets
`reasoning_effort: "low"` and Groq puts chain-of-thought in `delta.reasoning`, which
`parseGroqEvent` **drops entirely** (only `delta.content` is read). So the visible answer
is content-only, and any leftover reasoning budget or a mid-stream routing change can
leave a stub. `[GroQ] HTTP request` logs the full `messages` array — that log line
settles H2 definitively.

**H3 — `finish_reason: "length"` right after the first line.** `maxTokens: 4096` is
shared with reasoning models that spend budget before emitting content.

**H4 — no output validation.** This is the architectural gap regardless of which
trigger fired. The pipeline has a careful deterministic **input** gate
(`evaluateInterviewTurn`) but **zero deterministic output gate**. `Home.tsx` only
rejects *empty* text and the literal `WAIT`; anything else non-empty — a bare markdown
heading, an echoed prompt section label, a restated question — is accepted, streamed,
saved to `sessionMessages`, written to `history`, and offered to the model as
"previousAnswers" for the next turn (which then propagates the garbage).

### What we want suggestions on

1. An **output validator** mirroring the input gate — e.g. reject a response that is
   only a markdown heading, that matches a known prompt section label
   (`/^(#\s*)?(latest interviewer utterance|earlier conversation|your earlieranswers|now do the following)/i`),
   that is a near-copy of the question, or that has < N words for a technical question.
   Where should it live — `answerRunner` (generic) or the interview branch of
   `runAIStream` (interview-specific)? It must not trip H4-b "legitimately short answer".
2. Whether the user prompt should stop using markdown headings (e.g. `<<<LATEST>>>` /
   `<transcript>` delimiters, or plain `QUESTION:` labels) to remove the structural
   template the model is copying.
3. Whether reasoning models (`openai/gpt-oss-*`) should even be the interview default,
   and whether `maxTokens` should be raised / reasoning disabled for them.
4. Whether `fallbackModels` should be a short curated list (or empty) for a gateway
   instead of the whole catalog, so a mid-interview model swap can't happen silently.
5. Whether the "Using Groq" class of bug should be structurally impossible (registry-
   derived allow-list + a startup log line printing the resolved chain) rather than
   patched.

### Diagnostics that already exist (no new instrumentation needed for H1/H2)

```
[AI:turn-…] transcript=… | gate=answer question="…"
[AI:turn-…] starting answer stream — attempts=N providerChain=groq → …
[GroQ] HTTP request — model=… messages=[{"role":"system",…},{"role":"user",…}]
[GroQ] HTTP: 200 OK
[AI] groq finishReason: stop
[AI] final answer: Previously mentioned interview questions or requests
[AI:turn-…] final provider=groq model=… finishReason=… displayed=true partial=false
[STT RAW] / [STT NORMALIZED]   (only when normalization changed something)
```
Renderer console is forwarded to the dev terminal as `[Renderer:level] message`.

---

## 9. Normalization (`src/lib/normalization.ts`)

Deterministic, no LLM, no network. Two passes:

1. **Corrections only**, and only where the left-hand side is meaningless in an
   engineering interview: `virtual down|doom|dom → Virtual DOM`, `post grass → PostgreSQL`,
   `spring boat → Spring Boot`, `mongo dee → MongoDB`, `node jay ess → Node.js`,
   `rest ape → REST API`, `use eh-fekt → useEffect`, `kube retes → Kubernetes`, …
2. **Guarded casing** for acronyms/proper nouns that never appear as ordinary English
   words (API, REST, JWT, JVM, SQL, DOM, MongoDB, PostgreSQL, JavaScript, …).

`specificity()` sorts patterns longest-first so `virtual down` is never partially eaten
by a bare `dom` rule. The function is **idempotent** (verified 38/38 in a temporary
harness, since deleted).

Known gap: it fixes *vocabulary* mishearings only. `backend → "backack"` is a plain
phonetic mishearing outside the vocabulary and is not covered — the screenshot shows
this reaching the model verbatim.

---

## 10. Build & verify

```bash
npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.node.json
npm run build
```

Dev loop:

```bash
rm -f /tmp/ghostly-dev.log; timeout 60 npm run dev > /tmp/ghostly-dev.log 2>&1
tail -3 /tmp/ghostly-dev.log ; grep '\[Renderer' /tmp/ghostly-dev.log
```

- **Do NOT open `http://localhost:5173` in a browser** — blank, it needs `window.ghostly`.
- Quit the app fully between dev runs (tray icon + `Ctrl+B`); stale instances hold the
  port and the store lock.
- Hotkeys: `Ctrl+H` screenshot, `Ctrl+Enter` solve, `Ctrl+G` start over, `Ctrl+B` hide,
  `Ctrl+Shift+1..6` interview type.

**Testing reality:** there is no unit-test suite and no automated e2e. Everything to date
is verified by typecheck + build + unit-level harnesses. The live interview path has
**never** been run end-to-end in this environment — it needs real system loopback audio
and a real provider API key. Any suggestion that "just run it and see" must be
acknowledged as unverified here.

---

## 11. Known caveats / risky areas

1. `App.tsx PROVIDER_NAMES` missing `"openrouter"` → persisted Groq order survives,
   saved OpenRouter model choice is discarded (§7).
2. `fallbackModels` = the whole OpenRouter catalog → silent mid-interview model swap.
3. No output validator → a degenerate model response is accepted, saved to history, and
   fed back as `previousAnswers` for the next turn.
4. `parseGroqEvent` discards `delta.reasoning`, so Groq reasoning models cost budget
   invisibly.
5. `maxTokens: 4096` for every provider, including reasoning models.
6. `previousAnswers` sends the last 2 assistant answers at 1200 chars each into the user
   prompt — a source of contamination if one of those answers was garbage.
7. Normalization is vocabulary-only; ordinary phonetic mishearings ("backack") pass through.
8. The gate is regex-based and English-only; it will mis-handle code-switched speech.
9. `runAIStream` depends on `settings` + `sessionMessages`, so it is re-created on every
   settings/history change — this is why `openRouterBackendProvider` was deliberately kept
   **out of** `settings` (a disk write and a re-arm would both result).
10. Audio is transcribed but never sent anywhere; still, resume text is a privacy
    consideration for on-device model choice.

---

## 12. Recent history (for context on *why* things are the way they are)

1. **WAIT vs detected-question conflict** — the UI could show both at once. Fixed: WAIT
   clears `detectedQuestion`, an answer result clears `agentNotice` + `answerIssue`, and
   `onProvider` refuses to update when `detectedQuestion` is null. Added `turnId` logging.
2. **OpenRouter as single gateway** — new provider + registry entry + `AIStreamMeta.provider`
   + `AnswerRunResult.providerBackend` + store slots + SettingsPanel entry + banner label
   `OpenRouter • <backend>`. **Migration is not live** (§7).
3. **Deterministic STT normalization** — first version violated the "don't blindly
   replace common words" rule (it mapped `hook→hooks`, `state→state`, `render→render`)
   and was rewritten around corrections-only + guarded casing.

`dailylog.md` is the running project log, including past bug post-mortems.

---

## 13. What we want back

A prioritised list of concrete, surgical changes. Please:

- respect the invariants in §2 (call out explicitly if you think one of them is wrong
  and should be relaxed — that is a valid answer);
- point at `file → symbol → line` rather than describing things abstractly;
- never invent model IDs or provider behaviour — verify against the real catalog;
- say explicitly which suggestions are safe to make without a live interview run, and
  which need one (we cannot test that path here).
---

## 14. Changes landed since this document was written

All verified: `tsc --noEmit` (web + node), `npm run build`, and a new 117-check
harness at `scripts/verify-pipeline.ts` (`npx tsx scripts/verify-pipeline.ts`).

### Provider architecture — closed
- `electron/ipc.ts`: store defaults now include `openrouter` and default to it.
- `src/lib/ai/index.ts`: exports `PROVIDER_NAMES` and `isProviderName()` **derived
  from the registry** — never hardcode the list again.
- `src/App.tsx`: registry-derived allow-list; `models.openrouter` now persists; a
  one-time migration prepends `openrouter` when a key exists, and **logs that it did**
  (`[Ghostly] settings migration — inserted "openrouter" at the front of providerOrder`).
- `src/pages/Home.tsx`: prints the resolved chain before every run —
  `[AI] resolved interview provider chain: openrouter (model) → …`.

### Output validation — closed
- `src/lib/outputValidation.ts` (new): `validateAnswerOutput(text, {question})`.
  Rejects empty, prompt-label echoes, `<<<>>>` delimiter echoes, heading-only output,
  label-shaped fragments, and bare question restatement. Uses **multiple structural
  signals and no word blacklist**, and has **no minimum-word rule** — `Yes.`, `No.`,
  `Yes, I have.` and `Because it is immutable.` all pass.
- Wired into `Home.tsx` after the WAIT check and **before** the partial/history block,
  so degenerate output is never saved and never becomes `previousAnswers`.

### Prompt — closed
- `buildInterviewUserPrompt()` uses `<<<LATEST_QUESTION>>>` / `<<<BACKGROUND>>>` /
  `<<<PREVIOUS_ANSWERS>>>` delimiters instead of `#` headings. The candidate profile
  stays in the system message.

### Transcript quality — closed
- `src/lib/transcriptQuality.ts` (new): structure-only artefact detection (ASR
  sentinels, no alphabetic content, exact doubled phrase, repetition loop). Called
  from the gate **and** from the ASR `final` handler, so artefacts never even reach
  the store. Never inspects words for meaning.

### Gate over-corrections found by the harness and fixed
`Why should we hire you?`, `What is your trade on?`, `And why?`, `And why not?`
all returned WAIT and now return `answer`. Fixed with shape-based exemptions
(strong interrogative opener, question-shaped hard tail, second-person address).

### Audio — changed, NOT verified on real capture
- VAD now **downmixes all input channels** (it previously read only `input[0]`).
- `endPhrase()` now always posts `phraseClosed`, fixing a permanent-WAIT bug where a
  discarded phrase left its interim text on screen forever.
- RMS/peak floor before sending to ASR (`MIN_SEND_RMS = 0.003`).
- Device resilience: `track.onended` + `devicechange` trigger one automatic,
  idempotent reacquire; teardown is a single idempotent function; stop-during-reacquire
  is guarded.
- `[ASR]` diagnostics per segment: source, sampleRate, channels, durationMs, rms,
  samples, asrMs, chars, text. No keys, no resume content.
- `use eh-fekt` normalization repair.

**Still requires a real Windows run with both earbuds and laptop speakers, across
device swaps, before any claim about transcription quality is honest.**
