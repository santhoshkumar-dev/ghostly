import { create } from "zustand";
import type { ProviderName } from "../lib/ai";
import type { InterviewTurn } from "../lib/interviewAgent";
import type { DeepgramTelemetry } from "../lib/deepgramProtocol";
import type { GroqAsrTelemetry } from "../lib/groqWhisper";
import { DEFAULT_PRIMARY_ASR, type PrimaryAsr } from "../lib/primaryAsr";
import {
  DEFAULT_ANSWER_INSTRUCTIONS,
} from "../lib/prompts";
import {
  EMPTY_SESSION_CONTEXT,
  type SessionContext,
} from "../lib/sessionContext";
import { capTurns, type TurnTimings } from "../lib/stageTiming";

/**
 * Transcription engines. `moonshine` is local and default; `deepgram` is the
 * optional cloud engine used only for A/B comparison.
 */
export type AsrEngine = "moonshine" | "deepgram";

/**
 * Which engine produces the transcript that reaches the question gate and the
 * AI. See `lib/primaryAsr.ts` for why this is a real setting and why the code
 * default is Moonshine.
 */
export type { PrimaryAsr } from "../lib/primaryAsr";

export interface Solution {
  id: string;
  timestamp: number;
  screenshotBase64?: string;
  solution: string;
  provider: ProviderName;
  model: string;
  interviewType: string;
  language: string;
}

export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  /**
   * What the model was actually SENT — for a screenshot/follow-up turn that is
   * the fully assembled prompt (screen text fence + candidate context). It is
   * INTERNAL: it exists so the next screenshot solve can send its own history
   * verbatim, and it must never be rendered.
   */
  content: string;
  /**
   * The DISPLAY text for a user message, when `content` is not display-safe.
   *
   * The answer panel renders this instead of `content` when present, so the
   * request prompt (OCR text, `<<<SCREEN_TEXT_START>>>`, resume/JD context) can
   * never appear inside the visible Answer. Absent means `content` is already a
   * short label and is safe to show.
   */
  displayText?: string;
  screenshotBase64?: string;
}

/** One applied ASR repair, kept for debugging / evaluation. */
export interface TranscriptCorrectionDetail {
  from: string;
  to: string;
  confidence: number;
  reason: string;
}

/** Raw-vs-corrected bookkeeping for a committed transcript. */
export interface TranscriptCorrection {
  applied: boolean;
  confidence: number;
  details: TranscriptCorrectionDetail[];
  reason: string;
}

export interface TranscriptMessage {
  id: string;
  source: "mic" | "system";
  /**
   * The transcript the pipeline uses (corrected). The raw ASR text is never
   * overwritten — it is preserved in `rawText` for debugging and evaluation.
   */
  text: string;
  timestamp: number;
  audioUrl?: string;
  /** Verbatim ASR output before any repair. Equal to `text` when unchanged. */
  rawText?: string;
  /** What the correction engine changed, if anything. */
  correction?: TranscriptCorrection;
}

/**
 * What the question-detection gate locked onto for the turn currently being
 * answered (or about to be). Shown in the overlay so the user can verify it
 * before/while the answer streams.
 */
export interface DetectedQuestion {
  text: string;
  /** `auto` = fired by the auto-answer mode, `manual` = hotkey / Ask Copilot. */
  mode: "auto" | "manual";
  /** True when the gate said WAIT and the user insisted anyway. */
  forced?: boolean;
  /** Provider currently answering this question (updates on failover). */
  provider?: string;
  model?: string;
  /** Human-readable failover state, e.g. "Groq failed → switching to Gemini". */
  note?: string;
}

/**
 * One engine-vs-engine comparison for a single captured segment.
 *
 * Developer-only. Held in its own store slice, NOT in `interviewMessages`,
 * so a Deepgram transcript can never reach the question gate, the prompt or
 * the answer path by accident. Only the hotkey — and only the Moonshine-side
 * transcript — feeds the AI.
 */
export interface AsrComparison {
  id: string;
  /** Segment duration in seconds, identical for both engines by construction. */
  audioSeconds: number;
  moonshineText: string;
  deepgramText: string;
  /** Comparison telemetry from the Deepgram run. */
  deepgramTelemetry: DeepgramTelemetry | null;
  /** Moonshine decode latency in ms, for a like-for-like comparison. */
  moonshineMs: number | null;
  /** Raw Groq Whisper transcript for this segment (comparison only). */
  groqText?: string;
  /** Groq transcript after the SHARED correction engine (never Groq-specific). */
  groqCorrectedText?: string;
  /** Telemetry from the Groq Whisper run. */
  groqTelemetry?: GroqAsrTelemetry | null;
  /**
   * Raw Parakeet transcript for this segment (DEVELOPMENT COMPARISON ONLY).
   *
   * Never read by the question gate, the correction path, the prompt builder
   * or the AI. It lives in this developer-only slice and nowhere else.
   */
  parakeetText?: string;
  /** Parakeet decode latency in ms, for a like-for-like comparison. */
  parakeetMs?: number | null;
  /**
   * Why the Parakeet cell is what it is: a status while loading, or the
   * failure reason when there is no text (`timeout`, `model_missing`, ...).
   * A failed comparison must be visible as a failure, never silently blank.
   */
  parakeetStatus?: string;
  timestamp: number;
}

/**
 * What local OCR read off the LAST screenshot solve.
 *
 * Held in its own slice, never persisted: it is the recognised screen text plus
 * the numbers that produced the GOOD/POOR verdict. The text is editable in the
 * overlay (see the "Text read from screen" preview) so an OCR slip such as
 * `==` → `=` can be corrected and resent without re-capturing.
 *
 * In-memory only, like the screenshots themselves. Never written to disk and
 * never logged (only its character COUNT is).
 */
export interface ScreenshotOcr {
  text: string;
  quality: "good" | "poor";
  /** Closed-vocabulary reason from the quality gate. Safe to log. */
  reason: string;
  /** Byte length of the image OCR read. Never the pixels. */
  imageBytes: number;
  /** OCR duration in ms. */
  ocrMs: number;
}

/** A run that produced nothing usable — surfaced with a Retry action. */
export interface AnswerIssue {
  /** `empty` = no provider returned text, `partial` = text was kept after a failure. */
  kind: "empty" | "partial";
  message: string;
}

export interface Settings {
  activeProvider: ProviderName;
  /**
   * One model per provider. Deliberately NOT a single shared `activeModel`:
   * with provider failover, a Groq model id must never be written into the
   * Gemini slot (or vice versa).
   */
  models: Record<ProviderName, string>;
  /**
   * Providers live interview answers try, in order (first with a key wins).
   *
   * Default: `gemini → openrouter`. Groq is optional — it is kept out of the
   * chain unless the user turns it on (see `lib/providerDiagnostics.ts`),
   * because every member of the chain is waited on and a broken member taxes
   * every question. Whichever providers are actually attempted is filtered per
   * run to the ones that have an API key. The Local Qwen fallback and NVIDIA
   * no longer exist in the registry, so a persisted order containing them is
   * filtered out by `isProviderName` on load.
   */
  providerOrder: ProviderName[];
  /**
   * Which generation of the default chain policy this store was last migrated
   * to. See `CURRENT_CHAIN_POLICY_VERSION` in `App.tsx`. Opaque to every
   * consumer; it exists purely so the one-time migration cannot repeat.
   */
  chainPolicyVersion?: number;
  interviewType:
    | "dsa"
    | "system_design"
    | "frontend"
    | "sql"
    | "behavioral"
    | "general";
  language: "python" | "javascript" | "typescript" | "java" | "cpp" | "go";
  apiKeys: Record<ProviderName, string>;
  /**
   * Key slots 2 and 3, per provider.
   *
   * ── Why slot 1 lives in `apiKeys` instead of here ────────────────────────
   * `apiKeys` predates the pool and is read by the settings migration, the
   * provider-chain diagnostics and the "does this provider have a key" filter.
   * Keeping it as slot 1 means none of those had to change, and
   * `keyPool()` in `lib/keyHealth.ts` is the single place that joins the two.
   *
   * Slot 0 of this map is intentionally ignored for that reason — the array here
   * holds SLOTS 2 AND 3 ONLY.
   */
  apiKeyPool?: Partial<Record<ProviderName, string[]>>;
  // Pre-interview context (set before "Start Interview" in the overlay)
  resumeText?: string;
  companyName?: string;
  jobDescription?: string;
  /**
   * PROJECT & INTERNSHIP CONTEXT — free-form detail the resume omits or
   * shortens.
   *
   * ── Why this is separate from the resume ──────────────────────────────────
   * A resume is a summary, and the follow-up question that decides an interview
   * is almost always about the part the summary left out: what the candidate
   * personally built, which problem it solved, what broke, what the trade-off
   * was. Without a place to put that, the model's only options are to be vague
   * or to invent — and inventing candidate experience is the single worst
   * failure this app can produce.
   *
   * Persisted locally with the rest of the settings. Never logged, and never
   * uploaded anywhere except as part of a prompt the user's own action produced.
   */
  projectContext?: string;
  /** Shapes how the answer is rendered on screen (tone, length, format). */
  answerInstructions?: string;
  micDeviceId?: string;
  /** ASR model id. Now a Moonshine ONNX repo (was `Xenova/whisper-*`). */
  whisperModel?: string;
  /**
   * Which engine transcribes the interviewer.
   *
   * `moonshine` is the default and is fully local. `deepgram` is an optional
   * second opinion used for A/B comparison — it requires a key and a network
   * call, so it is never selected implicitly.
   */
  asrEngine: AsrEngine;
  /**
   * Developer-only: transcribe every captured segment with BOTH engines and
   * show the two results side by side. Deliberately not a UI-facing setting
   * in the shipped app — it costs a second paid API call per utterance.
   */
  asrCompareMode: boolean;
  /**
   * Deepgram API key for the optional cloud ASR engine.
   *
   * Deliberately NOT part of `apiKeys`: that map is `Record<ProviderName,..>`
   * and is typed by the AI provider registry. Deepgram transcribes audio and
   * never answers anything, so making it look like an AI provider would invite
   * it into the answer failover chain.
   *
   * Persisted to electron-store and read ONLY in the main process.
   */
  deepgramKey?: string;
  /**
   * Developer-only: additionally transcribe every segment with Groq Whisper
   * (`whisper-large-v3`) for the three-way comparison. Defaults off and is off
   * in production builds. The API key is NOT part of this object — it lives in
   * the main process only (see electron/groqAsr.ts).
   */
  asrCompareGroq?: boolean;
  /** Configurable Whisper model id. Defaults to `whisper-large-v3`. */
  groqAsrModel?: string;
  /**
   * Developer-only: additionally transcribe every segment with local NVIDIA
   * Parakeet (sherpa-onnx, CPU) for a fourth comparison column.
   *
   * Defaults OFF, and the main process additionally refuses it in a packaged
   * build, so the ~631 MB model is never even resolved unless a developer asks
   * for it. Moonshine remains the production engine and there is no fallback
   * between them in either direction.
   */
  asrCompareParakeet?: boolean;
  /**
   * The engine whose transcript becomes `interviewMessages` — the one the
   * question gate, the prompt and the answer all read.
   *
   * `'moonshine'` (the default, and the value a settings blob written before
   * this phase resolves to) keeps the existing behaviour exactly. `'parakeet'`
   * routes local Parakeet through the SAME downstream pipeline — raw preserved,
   * `correctTranscript`, quality gate, question gate, AI — with no second code
   * path and no engine-specific correction.
   *
   * When Parakeet fails for a segment, the fallback is Moonshine and nothing
   * else. There is deliberately no path from here to Groq or Deepgram: audio
   * must not leave the machine without the user choosing to send it.
   */
  primaryAsr?: PrimaryAsr;
  /**
   * Load the local Parakeet model as soon as the Live Interview panel opens,
   * instead of on Start Interview.
   *
   * ── Why it exists ─────────────────────────────────────────────────────────
   * The model takes 6.5 s to load standalone and 14.7–23.8 s inside the app.
   * Loaded on Start, that window is exactly when the interviewer begins
   * speaking, so the first one or two questions are buffered rather than
   * transcribed. Preloading moves the cost to a moment when the user is reading
   * the panel instead of talking.
   *
   * ── Why it is OFF by default ─────────────────────────────────────────────
   * The cost is real and permanent for the session: ~740 MB of resident memory
   * in a separate utility process (measured — see `PARAKEET_PRELOAD_RAM_MB`),
   * held until the 5-minute idle unload or Stop Interview. A user who opens the
   * panel to read their resume and closes it again must not be charged 740 MB
   * for it.
   */
  parakeetPreload?: boolean;
  /**
   * Developer-only: when Parakeet is primary, ALSO run Moonshine over the same
   * buffer and fill the Moonshine column of the comparison grid.
   *
   * Off by default, and off in production builds. Moonshine costs a ~22 s model
   * load, which is the entire reason Parakeet is primary in the first place, so
   * this is opt-in per session and never happens implicitly.
   */
  asrCompareMoonshine?: boolean;
  /**
   * Close the open VAD phrase when `Ctrl+Enter` is pressed, instead of waiting
   * out the remaining silence.
   *
   * The drain barrier only waits for finals that ALREADY exist in the worker
   * queue. A phrase the VAD has not yet closed is not a final, so the barrier
   * reports `alreadyIdle` and the submit proceeds with the tail of the
   * question missing — the worst failure mode in the whole app, because the
   * answer is confidently wrong rather than visibly broken. This setting
   * closes that race.
   *
   * Applies ONLY when Parakeet is the primary engine; Moonshine's path is left
   * byte-for-byte unchanged. `undefined` is treated as ON (see the consumer in
   * `useInterviewAudio`) so a settings blob written before this key existed
   * gets the intended default rather than silently keeping the old behaviour.
   * Turning it OFF restores exactly the previous behaviour.
   */
  forceEndpointOnHotkey?: boolean;
  /**
   * Developer-only: override for {@link PARAKEET_PADDING_MS}, in ms. `0` disables
   * padding entirely, which is what the padded-vs-unpadded A/B on saved real
   * clips flips. Unset means the provisional 300 ms default.
   */
  parakeetPaddingMs?: number;
  /**
   * Optional model directory override, read by the main process when spawning
   * the utility process. Unset means the default location for the install.
   */
  parakeetModelDir?: string;
  /**
   * When on, the answering agent fires by itself as soon as the interviewer
   * finishes a clear question — no hotkey. Manual triggers keep working.
   *
   * (Audio auto-answer only. The screen-watcher setting `autoDetectQuestion`
   * and the local-model settings were removed with their features.)
   */
  autoAnswer?: boolean;
}

interface GhostlyStore {
  // Session
  currentSolution: string;
  isStreaming: boolean;
  screenshots: string[]; // accumulated screenshots (multiple Ctrl+H)
  /**
   * Wall-clock capture instant for each entry of `screenshots`, same index,
   * kept in lockstep by every mutator below.
   *
   * Diagnostic only — recorded so a capture's age can be logged, and so the
   * strip can order entries. The solve target is NOT derived from these; it is
   * derived from `screenshotArmed` (see `lib/solveTarget.ts`).
   */
  screenshotTimestamps: number[];
  /**
   * True when the user has explicitly captured a screenshot that no Solve has
   * consumed yet.
   *
   * ── Why an arm and not a timestamp comparison ─────────────────────────────
   * "Which input is newer" looks like it answers "did the user just capture
   * something?", and it does not. ASR commits an utterance only after it has
   * decoded, so the interviewer's last sentence routinely lands in the
   * transcript AFTER the user pressed Capture. A recency comparison then hands
   * Solve to a sentence that was already on screen when the capture happened,
   * and the capture is ignored — the exact "screenshot taken, audio won, no
   * answer" failure. An explicit capture is a deliberate user ACTION, so it is
   * recorded as a flag that the Solve run consumes.
   *
   * Cleared by `consumeScreenshotArm` when a Solve targets the screenshot, by
   * Clear Chat / Reset Interview, and when the last screenshot is removed — so
   * a stale capture can never hijack a later, purely-spoken question.
   * IN-MEMORY ONLY, never persisted, like the screenshots themselves.
   */
  screenshotArmed: boolean;
  /**
   * OCR result for the most recent screenshot solve (recognised text + the
   * numbers behind the GOOD/POOR verdict). In-memory only, like the
   * screenshots; powers the "Text read from screen" preview and Resend.
   */
  screenshotOcr: ScreenshotOcr | null;
  /**
   * The ACTIVE problem context, as recognised text from the screen.
   *
   * ── Why this is a SEPARATE slice from `screenshots` ──────────────────────
   * They have different lifetimes, and that difference is the whole point:
   *
   *   screenshots[]      the IMAGE. Consumed by the Solve run that answers it,
   *                      kept afterwards only as a thumbnail.
   *   activeScreenText   the TEXT. Consumed by nothing — it survives the solve
   *                      that produced it and answers every later follow-up.
   *
   * Deriving one from the other is what produced the reported failure: because a
   * screenshot kept existing after its solve, every later interview request
   * re-attached that image (`solveTarget=interview` with `image=image/png`), and
   * no follow-up could ever refer to the problem the screen had shown.
   *
   * So `screenshotPresent` says nothing about this, and consuming an image says
   * nothing about it either. A new screenshot REPLACES it (never merges), an
   * Edit REPLACES it, and Ctrl+G / Clear drops it — but an ordinary Solve that
   * consumes the image does not.
   *
   * Holds only text that was good enough to reason about (a GOOD read, or the
   * user's edited version). A POOR read stays visible in `screenshotOcr` for the
   * preview and the manual "Retry with image", and never becomes context.
   *
   * IN-MEMORY ONLY and never persisted, like the screenshots themselves: a stale
   * problem surviving a restart would be worse than none.
   */
  activeScreenText: string | null;
  currentScreenshot: string | null; // latest screenshot (for backward compat)
  error: string | null;
  sessionMessages: SessionMessage[];
  interviewMessages: TranscriptMessage[];
  /** In-progress utterance shown live while Moonshine is still transcribing it. */
  interviewInterim: { source: "mic" | "system"; text: string } | null;

  /** Side-by-side engine comparison, newest first. Developer-only. */
  asrComparisons: AsrComparison[];
  /**
   * Set when the answering agent declined to answer (no clear question yet).
   * Holds the human-readable reason; the UI renders it as `WAIT · <reason>`.
   */
  agentNotice: string | null;
  /** The question the agent is answering right now (null when idle). */
  detectedQuestion: DetectedQuestion | null;
  /** Set when an answer could not be produced (empty) or was cut short. */
  answerIssue: AnswerIssue | null;
  /**
   * The active problem a follow-up question may refer to.
   *
   * ── Why this is a SEPARATE slice, not part of `interviewMessages` ─────────
   * `interviewMessages` is the visible transcript and is cleared constantly:
   * Clear chat, Next Question, panel open and panel close all wipe it. If the
   * problem statement lived there it would be gone before the follow-up arrived,
   * which is the exact failure this slice exists to fix.
   *
   * The separation is what makes the semantics expressible at all: "Clear chat"
   * clears the transcript and NOT this; "Reset interview" clears both. Neither
   * can be expressed if they share a slice.
   *
   * IN-MEMORY ONLY and never persisted: a stale problem surviving a restart
   * would be worse than none, because the next question would be answered as
   * though it referred to it.
   */
  sessionContext: SessionContext;
  /**
   * Which backend OpenRouter actually routed the last answer to (e.g. "groq",
   * "google"). Runtime-only, deliberately NOT part of `settings`: it changes
   * on every answer and must not trigger settings persistence or recreate the
   * `runAIStream` callback (which `settings` is a dependency of).
   */
  openRouterBackendProvider: string | null;

  /**
   * Per-turn latency records — the input to the Debug panel's Latency report.
   *
   * Capped at `LATENCY_TURN_LIMIT` and in-memory only, like every other
   * diagnostic: numbers, stage names and closed-vocabulary reasons, never
   * transcript text, prompt text, an answer or a key. Keeping it out of
   * `settings` matters for the same reason as `openRouterBackendProvider` —
   * writing a turn must not trigger settings persistence.
   */
  latencyTurns: TurnTimings[];

  // History
  history: Solution[];

  // Settings
  settings: Settings;

  // Mouse state
  mouseEnabled: boolean;

  // Actions — session
  setCurrentSolution: (text: string) => void;
  appendToSolution: (chunk: string) => void;
  setIsStreaming: (v: boolean) => void;
  setCurrentScreenshot: (b64: string | null) => void;
  /** Record a capture AND arm it, so the next Solve answers this image. */
  addScreenshot: (b64: string) => void;
  /** Remember the OCR result for the screenshot answer preview / resend. */
  setScreenshotOcr: (v: ScreenshotOcr | null) => void;
  /**
   * Replace the recognised text AND the active problem context in one write.
   *
   * This is the user's Edit. It deliberately cannot update only the preview: an
   * edited OCR text that the follow-ups do not use would mean the answer on
   * screen and the answer to the next question came from different problems.
   */
  updateScreenshotOcrText: (text: string) => void;
  /**
   * Set (or clear, with `null`) the active screen problem context.
   *
   * The ONLY write path a screenshot solve uses, so "which problem the follow-ups
   * are about" has exactly one answer in the store.
   */
  setActiveScreenText: (text: string | null) => void;
  /**
   * Consume the explicit-capture arm. Called by Solve once a run has targeted
   * the screenshot, so the NEXT Solve with no new capture returns to the live
   * transcript rather than answering a stale image forever.
   */
  consumeScreenshotArm: () => void;
  clearScreenshots: () => void;
  removeScreenshot: (index: number) => void;
  setError: (err: string | null) => void;
  clearSolution: () => void;
  setMouseEnabled: (v: boolean) => void;
  addSessionMessage: (msg: SessionMessage) => void;

  // Actions — live interview transcript (shared between overlay + interview panel)
  addInterviewMessage: (msg: TranscriptMessage) => void;
  clearInterviewMessages: () => void;
  /** Replace the whole session context (the only write path). */
  setSessionContext: (ctx: SessionContext) => void;
  /** Drop the problem, the approach summary and the user notes. */
  clearSessionContext: () => void;
  /** Record one engine-vs-engine comparison. Developer-only diagnostics. */
  addAsrComparison: (comparison: AsrComparison) => void;
  /** Append one turn's latency record, evicting the oldest past the cap. */
  addLatencyTurn: (turn: TurnTimings) => void;
  /** Drop every latency record (the Debug panel's "Clear"). */
  clearLatencyTurns: () => void;
  /** Drop all comparison records. */
  clearAsrComparisons: () => void;
  setInterviewInterim: (
    value: { source: "mic" | "system"; text: string } | null,
  ) => void;
  /**
   * The current interview turn: committed (finalized) utterances plus the
   * in-progress one. This is the single source the answering agent reads, so
   * partial transcripts can never be mistaken for a finished question.
   */
  getInterviewTurn: () => InterviewTurn;
  setAgentNotice: (reason: string | null) => void;
  setDetectedQuestion: (value: DetectedQuestion | null) => void;
  setAnswerIssue: (value: AnswerIssue | null) => void;
  /** Records which backend OpenRouter actually routed the last answer to. */
  setOpenRouterBackendProvider: (value: string | null) => void;

  // Actions — history
  addToHistory: (s: Solution) => void;
  removeFromHistory: (id: string) => void;
  clearHistory: () => void;
  setHistory: (history: Solution[]) => void;

  // Actions — settings
  updateSettings: (partial: Partial<Settings>) => void;
  setApiKey: (provider: ProviderName, key: string) => void;
  setSettings: (settings: Settings) => void;
}

export const useStore = create<GhostlyStore>((set, get) => ({
  // State
  currentSolution: "",
  isStreaming: false,
  screenshots: [],
  screenshotTimestamps: [],
  screenshotArmed: false,
  screenshotOcr: null,
  activeScreenText: null,
  currentScreenshot: null,
  error: null,
  sessionMessages: [],
  interviewMessages: [],
  interviewInterim: null,
  asrComparisons: [],
  agentNotice: null,
  detectedQuestion: null,
  answerIssue: null,
  sessionContext: EMPTY_SESSION_CONTEXT,
  openRouterBackendProvider: null,
  latencyTurns: [],
  history: [],
  mouseEnabled: false,
  settings: {
    // The default chain is Gemini → OpenRouter (see
    // `lib/providerDiagnostics.ts`). Groq stays fully integrated and
    // configurable, but is OPTIONAL: not in the chain unless the user adds it,
    // because a provider that fails on every request costs every question an
    // attempt slot and a timeout for nothing. Local Qwen and NVIDIA are gone.
    activeProvider: "gemini",
    models: {
      // The registry's own curated default for Gemini (`listModels()[0]`) —
      // VERIFIED against the live API with the app's exact streaming path
      // (HTTP 200, first text 1.2–1.4s). Never chosen from memory.
      gemini: "gemini-2.5-flash",
      openai: "gpt-4o",
      anthropic: "claude-3-5-sonnet-20241022",
      groq: "openai/gpt-oss-120b",
      // The free ROUTER, not a fixed model: OpenRouter resolves it to a
      // concrete available free model per request, so a single unavailable
      // model can no longer take the interview path down.
      openrouter: "openrouter/free",
    },
    providerOrder: ["gemini", "openrouter"],
    interviewType: "dsa",
    language: "python",
    apiKeys: {
      gemini: "",
      openai: "",
      anthropic: "",
      groq: "",
      openrouter: "",
    },
    // Slots 2 and 3 only — see the `apiKeyPool` doc comment. Empty by default:
    // extra credentials are something the user authorizes, never something the
    // app assumes.
    apiKeyPool: {},
    resumeText: "",
    companyName: "",
    jobDescription: "",
    projectContext: "",
    // Seeded with the documented default guidance so the field is useful out of
    // the box. It is a normal editable string from here on — the user owns it.
    answerInstructions: DEFAULT_ANSWER_INSTRUCTIONS,
    micDeviceId: "default",
    whisperModel: "onnx-community/moonshine-base-ONNX",
    asrEngine: "moonshine",
    asrCompareMode: false,
    asrCompareGroq: false,
    // Dev-only, and OFF by default: the Parakeet model is ~631 MB and costs
    // several hundred MB of resident memory.
    asrCompareParakeet: false,
    // Parakeet is the code default (see src/lib/primaryAsr.ts). Moonshine is
    // kept as the local fallback for any segment Parakeet cannot decode, and an
    // explicit "moonshine" selection is preserved. A pre-Parakeet settings blob
    // with no `primaryAsr` key resolves to Parakeet.
    primaryAsr: DEFAULT_PRIMARY_ASR,
    // Off by default: ~740 MB of resident memory for a panel the user may only
    // glance at. See the `parakeetPreload` doc comment for the measurement.
    parakeetPreload: false,
    asrCompareMoonshine: false,
    forceEndpointOnHotkey: true,
    groqAsrModel: "whisper-large-v3",
    autoAnswer: false,
  },

  // Session actions
  setCurrentSolution: (text) => set({ currentSolution: text }),
  appendToSolution: (chunk) =>
    set((s) => ({ currentSolution: s.currentSolution + chunk })),
  setIsStreaming: (v) => set({ isStreaming: v }),
  setCurrentScreenshot: (b64) => set({ currentScreenshot: b64 }),
  addScreenshot: (b64) =>
    set((s) => {
      // An empty payload must never enter the list. A screenshot entry that is
      // not an image is worse than no screenshot at all: the strip renders it,
      // `screenshots.length > 0` satisfies the "you forgot to capture" guard,
      // and the provider is asked to read a picture that was never sent.
      if (typeof b64 !== "string" || b64.length === 0) {
        return {};
      }
      return {
        screenshots: [...s.screenshots, b64],
        screenshotTimestamps: [...s.screenshotTimestamps, Date.now()],
        // ARMED. Every capture path (Capture Screen, Ctrl+Shift+S, Ctrl+H, and
        // the tray) funnels through this action, so this is the one place that
        // has to record the explicit user instruction "answer what I just
        // captured". It is what a Solve press then consumes.
        screenshotArmed: true,
        currentScreenshot: b64,
      };
    }),
  consumeScreenshotArm: () => set({ screenshotArmed: false }),
  setScreenshotOcr: (v) => set({ screenshotOcr: v }),
  setActiveScreenText: (text) =>
    set({ activeScreenText: typeof text === "string" && text.trim() ? text : null }),
  updateScreenshotOcrText: (text) =>
    set((s) =>
      s.screenshotOcr
        ? {
            screenshotOcr: { ...s.screenshotOcr, text },
            // The edit IS the user's correction of the problem statement, so the
            // follow-ups must reason about the corrected text. Written together so
            // the preview and the context can never disagree.
            activeScreenText:
              typeof text === "string" && text.trim() ? text : null,
          }
        : {},
    ),
  clearScreenshots: () =>
    set({
      screenshots: [],
      screenshotTimestamps: [],
      screenshotArmed: false,
      currentScreenshot: null,
      // NOT cleared. Removing the IMAGE does not retract the problem the screen
      // showed: the thumbnail is a display concern, `activeScreenText` is the
      // conversation's subject, and a follow-up must still be answerable after
      // the picture is gone.
    }),
  removeScreenshot: (index) =>
    set((s) => {
      const next = s.screenshots.filter((_, i) => i !== index);
      return {
        screenshots: next,
        screenshotTimestamps: s.screenshotTimestamps.filter(
          (_, i) => i !== index,
        ),
        // Removing the LAST screenshot removes the thing the arm points at, so
        // the arm goes with it rather than lingering over an empty strip.
        screenshotArmed: next.length > 0 ? s.screenshotArmed : false,
        currentScreenshot: next.length > 0 ? next[next.length - 1] : null,
      };
    }),
  setError: (err) => set({ error: err }),
  clearSolution: () =>
    set({
      currentSolution: "",
      screenshots: [],
      screenshotTimestamps: [],
      screenshotArmed: false,
      screenshotOcr: null,
      activeScreenText: null,
      currentScreenshot: null,
      error: null,
      sessionMessages: [],
      interviewMessages: [],
      interviewInterim: null,
      agentNotice: null,
      detectedQuestion: null,
      answerIssue: null,
    }),
  setMouseEnabled: (v) => set({ mouseEnabled: v }),
  addSessionMessage: (msg) => 
    set((state) => ({ sessionMessages: [...state.sessionMessages, msg] })),
  addInterviewMessage: (msg) =>
    set((state) => ({ interviewMessages: [...state.interviewMessages, msg] })),
  clearInterviewMessages: () =>
    set({
      interviewMessages: [],
      interviewInterim: null,
      agentNotice: null,
      detectedQuestion: null,
      answerIssue: null,
    }),
  setInterviewInterim: (value) => set({ interviewInterim: value }),
  // Capped so a long session cannot grow this slice without bound. This is a
  // developer diagnostic, not a transcript log.
  // Upsert by id: a comparison row is created by one engine and completed by
  // the others (all keyed on the same phraseId), so writing the same id must
  // UPDATE the row rather than prepend a duplicate.
  addAsrComparison: (comparison) =>
    set((state) => {
      const index = state.asrComparisons.findIndex((c) => c.id === comparison.id);
      if (index >= 0) {
        const next = state.asrComparisons.slice();
        next[index] = comparison;
        return { asrComparisons: next };
      }
      return {
        asrComparisons: [comparison, ...state.asrComparisons].slice(0, 20),
      };
    }),
  clearAsrComparisons: () => set({ asrComparisons: [] }),
  addLatencyTurn: (turn) =>
    set((state) => ({ latencyTurns: capTurns([...state.latencyTurns, turn]) })),
  clearLatencyTurns: () => set({ latencyTurns: [] }),
  setAgentNotice: (reason) => set({ agentNotice: reason }),
  setDetectedQuestion: (value) => set({ detectedQuestion: value }),
  setAnswerIssue: (value) => set({ answerIssue: value }),
  // ── Session context ────────────────────────────────────────────────────
  //
  // Deliberately ONE writer. `clearInterviewMessages` is on the hot path for
  // several unrelated UI actions, and any of them clearing this slice by
  // accident is exactly the bug this slice is meant to prevent. Nothing else in
  // the store may touch it.
  setSessionContext: (ctx) => set({ sessionContext: ctx }),
  clearSessionContext: () => set({ sessionContext: EMPTY_SESSION_CONTEXT }),
  setOpenRouterBackendProvider: (
    v: string | null,
  ) => set({ openRouterBackendProvider: v }),
  getInterviewTurn: () => ({
    finals: get().interviewMessages.map((m) => ({
      source: m.source,
      text: m.text,
    })),
    interim: get().interviewInterim,
  }),


  // History actions
  addToHistory: (s) => set((state) => ({ history: [s, ...state.history] })),
  removeFromHistory: (id) =>
    set((state) => ({ history: state.history.filter((s) => s.id !== id) })),
  clearHistory: () => set({ history: [] }),
  setHistory: (history) => set({ history }),

  // Settings actions
  updateSettings: (partial) =>
    set((s) => ({ settings: { ...s.settings, ...partial } })),
  setApiKey: (provider, key) =>
    set((s) => ({
      settings: {
        ...s.settings,
        apiKeys: { ...s.settings.apiKeys, [provider]: key },
      },
    })),
  setSettings: (settings) => set({ settings }),
}));
