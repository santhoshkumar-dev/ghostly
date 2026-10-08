import React, { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { getProvider, type ProviderName } from "../lib/ai";
import {
  INTERVIEW_PROVIDER_ORDER,
  ALL_INTERVIEW_PROVIDERS,
} from "../lib/providerDiagnostics";
import {
  describeKeySlot,
  keyPool,
  summarizeKeys,
  KEY_SLOTS_PER_PROVIDER,
} from "../lib/keyHealth";
import { useKeyHealth } from "../lib/useKeyHealth";
import {
  findShortcutConflicts,
  INTERVIEW_SHORTCUTS,
} from "../lib/interviewShortcuts";
import { normalizePrimaryAsr, type PrimaryAsr } from "../lib/primaryAsr";
import { DEFAULT_ANSWER_INSTRUCTIONS } from "../lib/prompts";
import { extractTextFromFile, MAX_RESUME_CHARS } from "../lib/fileText";
import {
  MODEL_INTEGRITY_NOTE,
  canRetryDownload,
  cancelParakeetModelDownload,
  describeModelState,
  downloadParakeetModel,
  formatBytes,
  getParakeetModelStatus,
  isTransferInProgress,
  removeParakeetModel,
  type ParakeetModelState,
} from "../lib/parakeetModelClient";
import {
  PARAKEET_ARCHIVE_BYTES,
  PARAKEET_UNPACKED_BYTES,
} from "../lib/parakeetModelFacts";
import { describeParakeetPreloadCost } from "../lib/parakeetModelFacts";

/*
 * ── The question-category selector is GONE ──────────────────────────────────
 *
 * `INTERVIEW_TYPE_GROUPS` and `INTERVIEW_TYPES` used to live here, backing a
 * dropdown that asked the candidate to classify their own interview before it
 * started. There is nothing to select any more: Ghostly has one universal mode
 * and the question itself decides the shape of the answer (see
 * `buildUniversalPrompt`, which describes the shapes to the model rather than
 * selecting one from a list).
 *
 * A real interview mixes a coding question, a project question and a
 * system-design question in the same ten minutes, so a single pre-selected
 * category was wrong for most of it.
 *
 * The answer style the old "General" mode carried is NOT lost — it moved to the
 * one "Answer Instructions" field further down this panel, and a store written by
 * the old build is migrated by `App.tsx`.
 */


const LANGUAGES = [
  { id: "python", label: "Python" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "java", label: "Java" },
  { id: "cpp", label: "C++" },
  { id: "go", label: "Go" },
];

const PROVIDERS = [
  {
    id: "gemini" as ProviderName,
    label: "Google Gemini",
    docsUrl: "https://aistudio.google.com/app/apikey",
  },
  {
    id: "openai" as ProviderName,
    label: "OpenAI",
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic" as ProviderName,
    label: "Anthropic",
    docsUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "groq" as ProviderName,
    label: "Groq",
    docsUrl: "https://console.groq.com/keys",
  },
  {
    id: "openrouter" as ProviderName,
    label: "OpenRouter (primary gateway)",
    docsUrl: "https://openrouter.ai/keys",
  },
  // Local Qwen and NVIDIA are gone entirely — no provider entry, no model
  // picker, no key field, no status. Parakeet ASR (Speech recognition below) is
  // a completely separate system and was not touched.
];

/**
 * The OpenRouter free router.
 *
 * `openrouter/free` is NOT a model — OpenRouter resolves it to a concrete
 * available free model on every request. It is presented separately so it is
 * never mistaken for a fixed, selectable model.
 */
const OPENROUTER_FREE_OPTION = {
  value: "openrouter/free",
  label: "OpenRouter Free (auto-selects a free model)",
};

// Moonshine ONNX repos (transformers.js v3). Moonshine is purpose-built for
// real-time / on-device ASR — much faster than Whisper at the short chunks a
// live interview produces, and it is what powers the live interim transcript.
/** Shared styling for the dev-only screen-visibility segmented control. */
const VIS_ACTIVE =
  "px-4 py-1.5 text-[10px] font-mono transition-colors bg-white/20 text-white";
const VIS_INACTIVE =
  "px-4 py-1.5 text-[10px] font-mono transition-colors bg-transparent text-white/40 hover:bg-white/[0.06]";

const ASR_MODELS = [
  {
    id: "onnx-community/moonshine-tiny-ONNX",
    label: "Moonshine Tiny (fastest)",
  },
  {
    id: "onnx-community/moonshine-base-ONNX",
    label: "Moonshine Base (balanced)",
  },
];

const SHORTCUTS = [
  { label: "Start / Stop Interview", keys: ["Ctrl", "I"] },
  { label: "Next Question", keys: ["Ctrl", "N"] },
  { label: "Ask AI", keys: ["Ctrl", "↵"] },
  { label: "Start Over", keys: ["Ctrl", "G"] },
  // The ONE documented capture shortcut. It triggers the same Capture Screen
  // path as the button (see `electron/hotkeys.ts`).
  { label: "Capture Screen", keys: ["Ctrl", "Shift", "S"] },
  { label: "Show / Hide", keys: ["Ctrl", "B"] },
  { label: "Move Up", keys: ["Ctrl", "↑"] },
  { label: "Move Left", keys: ["Ctrl", "←"] },
  { label: "Move Down", keys: ["Ctrl", "↓"] },
  { label: "Move Right", keys: ["Ctrl", "→"] },
];

/** Any two global actions sharing a key. Empty in a healthy build. */
const SHORTCUT_CONFLICTS = findShortcutConflicts(INTERVIEW_SHORTCUTS);

interface SettingsPanelProps {
  onClose: () => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ onClose }) => {
  const { settings, updateSettings, setApiKey } = useStore();
  /**
   * Live key-pool health for the Key Pool section below.
   *
   * The SAME hook the interview path uses (see Home.tsx), so the panel and the
   * run read one source of truth for which slot is healthy / cooling / failed
   * and can never disagree. Previously this call was missing while the section
   * below still read `keyHealth`, which crashed the panel on render.
   */
  const keyHealth = useKeyHealth();
  const [showKey, setShowKey] = useState(false);

  // ── Resume upload (moved here from the removed overlay box) ───────────
  // The visible "Interview Context" panel is gone; its useful half — attaching
  // a resume — lives here, using the SAME `extractTextFromFile` parser.
  const resumeFileRef = useRef<HTMLInputElement>(null);
  const [resumeReading, setResumeReading] = useState(false);
  const [resumeNote, setResumeNote] = useState<string | null>(null);
  const handleResumeFile = async (file: File) => {
    setResumeReading(true);
    setResumeNote(null);
    try {
      const text = (await extractTextFromFile(file)).trim();
      if (!text) {
        setResumeNote(
          `No text found in ${file.name} (is it a scanned image?).`,
        );
        return;
      }
      updateSettings({ resumeText: text.slice(0, MAX_RESUME_CHARS) });
      setResumeNote(
        text.length > MAX_RESUME_CHARS
          ? `Loaded ${file.name} (trimmed to ${MAX_RESUME_CHARS} characters).`
          : `Loaded ${file.name}.`,
      );
    } catch (err) {
      setResumeNote(
        err instanceof Error ? err.message : `Could not read ${file.name}.`,
      );
    } finally {
      setResumeReading(false);
    }
  };

  // Models for the active provider. Starts from the curated fallback list and
  // is upgraded to the provider's live list as soon as we have an API key.
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const activeProviderName = settings.activeProvider;
  const apiKeyForProvider = settings.apiKeys[activeProviderName] ?? "";
  // Per-provider model — never a shared one, so failover can't cross models.
  const activeModelForProvider = settings.models?.[activeProviderName] ?? "";
  const setModelForProvider = (model: string) =>
    updateSettings({
      models: { ...settings.models, [activeProviderName]: model },
    });
  const failoverChain = (settings.providerOrder ?? [])
    .filter((p) => (settings.apiKeys[p] ?? "").trim())
    .map((p) => PROVIDERS.find((x) => x.id === p)?.label ?? p);

  // ── Interview answer chain (ordered, independently toggleable) ──────────
  // The DEFAULT chain is Gemini → OpenRouter. Groq and NVIDIA are optional:
  // fully integrated, shown here, but not enabled unless the user turns them on
  // — because every member of the chain is waited on, so a broken member costs
  // latency on every question.
  //
  // Ordering: adding the primary gateway back puts it immediately after the
  // current primary, and any other provider is appended at the end, so a chain
  // can never silently reorder itself out from under the user.
  const chainOrder = settings.providerOrder ?? [];
  const isInChain = (p: ProviderName) => chainOrder.includes(p);
  const hasKey = (p: ProviderName) =>
    keyPool(settings.apiKeys, settings.apiKeyPool, p).some((k) => k.trim());
  /**
   * Write one slot of one provider's pool.
   *
   * Slot 0 is the long-standing `apiKeys` map; slots 1..n go to `apiKeyPool`.
   * Splitting them keeps every existing reader of `apiKeys` correct without
   * having to teach each one about pools, and `keyPool()` re-joins them in one
   * place so the halves can never disagree.
   *
   * Editing a slot CLEARS its health record: the credential just changed, so any
   * cooldown recorded against the old value no longer describes anything.
   */
  const setPoolKey = (p: ProviderName, index: number, value: string) => {
    if (index === 0) {
      setApiKey(p, value);
    } else {
      const current = settings.apiKeyPool?.[p] ?? [];
      const next = [...current];
      while (next.length < KEY_SLOTS_PER_PROVIDER - 1) next.push("");
      next[index - 1] = value;
      updateSettings({
        apiKeyPool: { ...settings.apiKeyPool, [p]: next },
      });
    }
    keyHealth.clear(p, index);
  };
  const toggleInChain = (p: ProviderName) => {
    const without = chainOrder.filter((x) => x !== p);
    const withIt = isInChain(p)
      ? without
      : INTERVIEW_PROVIDER_ORDER.includes(p)
        ? // A default-chain provider always sits in the documented position.
          [...INTERVIEW_PROVIDER_ORDER.filter((x) => without.includes(x)), p]
        : [...without, p];
    updateSettings({ providerOrder: withIt });
  };

  // ── Per-chain-provider model lists ───────────────────────────────────────
  //
  // ── Why this is separate from the single "Model" picker above ─────────────
  // The interview path runs EVERY provider in the chain, each with its own
  // `settings.models[p]`. The picker above is bound to `activeProvider`, which
  // only governs the screenshot / follow-up flow — so before this, the ONLY way
  // to change the model an interview would use on Groq was to make Groq the
  // active provider, configure it, and switch back. Everything else in the chain
  // was pinned to whatever the defaults said.
  //
  // That is how `groq/allam-2-7b` ended up being used at all: it was a stale
  // default, not a choice anybody could see or change.
  //
  // Each list is fetched LIVE from the provider (never hard-coded), and only
  // when that provider has a key — exactly the same rule the main picker uses,
  // so the two cannot disagree about where a model name comes from.
  const [chainModels, setChainModels] = useState<
    Partial<Record<ProviderName, string[]>>
  >({});
  const [chainModelsLoading, setChainModelsLoading] = useState<
    Partial<Record<ProviderName, boolean>>
  >({});

  const setChainModel = (provider: ProviderName, model: string) =>
    updateSettings({
      models: { ...settings.models, [provider]: model },
    });

  useEffect(() => {
    let cancelled = false;
    // Every provider the interview path can use, including the optional ones —
// their model lists must stay fetchable or they could not be turned on.
    for (const p of ALL_INTERVIEW_PROVIDERS) {
      const key = (settings.apiKeys[p] ?? "").trim();
      if (!key) continue;
      const provider = getProvider(p);
      if (typeof provider?.fetchModels !== "function") continue;

      setChainModelsLoading((s) => ({ ...s, [p]: true }));
      provider
        .fetchModels(key)
        .then((models) => {
          if (cancelled || models.length === 0) return;
          setChainModels((s) => ({ ...s, [p]: models }));
        })
        .catch((err) => {
          // Best-effort: the curated list below stays usable offline, and a
          // live-list failure must never block Settings.
          console.warn(`[Ghostly] live model list failed for ${p}:`, err);
        })
        .finally(() => {
          if (!cancelled) setChainModelsLoading((s) => ({ ...s, [p]: false }));
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.apiKeys]);

  // Microphone selection state
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [micDropdownOpen, setMicDropdownOpen] = useState(false);
  // ── Dev-only screen visibility ──────────────────────────────────────
  // Runtime-only: deliberately NOT in the settings store, so nothing is
  // persisted and a restart always returns to `hidden`.
  const [visibility, setVisibility] = useState<"visible" | "hidden">("hidden");

  const applyVisibility = async (mode: "visible" | "hidden") => {
    const res = await window.ghostly.setVisibility(mode);
    // Adopt the mode the MAIN process says took effect, not the one we asked
    // for — a packaged build refuses, and the UI must not lie about it.
    setVisibility(res.mode);
  };

  // ── Groq Whisper ASR key (dev-only comparison) ──────────────────────
  // The key is NEVER held in the settings store. It is typed into a local
  // draft, sent straight to the main process, and only a boolean comes back.
  const [groqKeyDraft, setGroqKeyDraft] = useState("");
  const [groqKeyConfigured, setGroqKeyConfigured] = useState(false);
  const [groqKeySaving, setGroqKeySaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.ghostly.groqAsrHasKey().then((v) => {
      if (alive) setGroqKeyConfigured(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  const saveGroqKey = async () => {
    if (!groqKeyDraft.trim()) return;
    setGroqKeySaving(true);
    try {
      const res = await window.ghostly.groqSetKey(groqKeyDraft);
      setGroqKeyConfigured(res.configured);
      setGroqKeyDraft("");
    } finally {
      setGroqKeySaving(false);
    }
  };

  const clearGroqKey = async () => {
    setGroqKeySaving(true);
    try {
      const res = await window.ghostly.groqSetKey("");
      setGroqKeyConfigured(res.configured);
    } finally {
      setGroqKeySaving(false);
    }
  };

  const micDropdownRef = useRef<HTMLDivElement>(null);

  // ── Primary ASR engine ──────────────────────────────────────────────────
  // Read through the store's own normaliser rather than casting, so a
  // hand-edited settings file with a nonsense value cannot reach a branch that
  // expects two engines.
  const primaryAsr = normalizePrimaryAsr(useStore((s) => s.settings.primaryAsr));
  const parakeetPreload = useStore((s) => s.settings.parakeetPreload === true);
  // `!== false`, not `=== true`: a settings blob written before this key existed
  // must get the intended default (ON) rather than silently keeping the old
  // truncating behaviour. See the `forceEndpointOnHotkey` doc comment.
  const forceEndpointOnHotkey = useStore(
    (s) => s.settings.forceEndpointOnHotkey !== false,
  );
  /** One-line confirmation of the last engine change, shown under the picker. */
  const [engineNote, setEngineNote] = useState<string | null>(null);

  // ── Model download state ────────────────────────────────────────────────
  // Polled while the picker is on Parakeet. A poll is cheap — the main process
  // stats four files — and polling is what makes the progress bar move, because
  // the download call itself does not resolve until the transfer finishes.
  const [modelState, setModelState] = useState<ParakeetModelState>(() => ({
    status: "missing",
    progress: null,
    bytesDownloaded: 0,
    bytesTotal: PARAKEET_ARCHIVE_BYTES,
    message: null,
    dir: "",
  }));
  const [modelBusy, setModelBusy] = useState(false);
  /** Set once a download has been started, so polling does not spam the log. */
  const modelStartedRef = useRef(false);

  useEffect(() => {
    if (primaryAsr !== "parakeet") return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      const next = await getParakeetModelStatus();
      if (cancelled) return;
      setModelState(next);
      // While a transfer is running, poll fast enough to animate the bar. Once
      // it settles, back off to a slow heartbeat so an idle Settings page is
      // not stat-ing files four times a second forever.
      timer = window.setTimeout(
        () => void poll(),
        isTransferInProgress(next) ? 400 : 4000,
      );
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [primaryAsr]);

  const startDownload = useCallback(async () => {
    if (modelBusy) return;
    setModelBusy(true);
    if (!modelStartedRef.current) {
      modelStartedRef.current = true;
      setEngineNote(
        "Downloading the speech model. It is stored in this app's data folder, never bundled with the installer, and can be deleted at any time.",
      );
    }
    try {
      // The poll above renders progress; this call only reports the OUTCOME, so
      // its result is deliberately not used to drive the bar.
      const finalState = await downloadParakeetModel();
      setModelState(finalState);
      if (finalState.status === "ready") {
        setEngineNote(
          "Speech model installed. It loads on Start Interview (~7 s).",
        );
      }
    } finally {
      setModelBusy(false);
    }
  }, [modelBusy]);

  const cancelDownload = useCallback(async () => {
    await cancelParakeetModelDownload();
    setModelState(await getParakeetModelStatus());
  }, []);

  const removeModel = useCallback(async () => {
    const next = await removeParakeetModel();
    setModelState(next);
    setEngineNote(
      "Speech model deleted. If Parakeet is selected it will fall back to Moonshine until it is downloaded again.",
    );
  }, []);

  /**
   * Change the primary engine AND persist it immediately.
   *
   * ── Why the explicit write-through, when auto-save already exists ─────────
   * The 500 ms debounced auto-save effect further down this file is the
   * mechanism that actually works, and this component is the only reason it does.
   *
   * The earlier Parakeet comparison toggle lived in a different component, had
   * no auto-save, updated zustand, and therefore never reached electron-store —
   * so the main process, which is the thing that actually decides, never saw it
   * and the feature could not be switched on at all. Writing through here makes
   * the ordering irrelevant: even if the debounce is still pending, or the panel
   * is closed, the main process already knows.
   */
  const selectPrimaryAsr = useCallback(
    (next: PrimaryAsr) => {
      const settings = useStore.getState().settings;
      updateSettings({ primaryAsr: next });
      void window.ghostly.saveSettings({ ...settings, primaryAsr: next });
      if (next === "parakeet") {
        setEngineNote(
          "Parakeet selected. It loads on Start Interview (~7 s, a few hundred MB). Moonshine stays unloaded unless a single segment needs it.",
        );
      } else {
        setEngineNote(
          "Moonshine selected. It loads on Start Interview and streams words as the interviewer speaks.",
        );
      }
    },
    [],
  );

  // Fetch microphones
  useEffect(() => {
    const getMics = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        const devices = await navigator.mediaDevices.enumerateDevices();
        setMics(devices.filter((d) => d.kind === "audioinput"));
        stream.getTracks().forEach((track) => track.stop());
      } catch (err) {
        console.error("Microphone access denied or error:", err);
        const devices = await navigator.mediaDevices.enumerateDevices();
        setMics(devices.filter((d) => d.kind === "audioinput"));
      }
    };
    getMics();
  }, []);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        micDropdownRef.current &&
        !micDropdownRef.current.contains(event.target as Node)
      ) {
        setMicDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Enable mouse for the ENTIRE time the settings panel is open
  // This is the authoritative mouse state controller while visible
  useEffect(() => {
    // Force enable — overrides any other disable calls
    window.ghostly.enableMouse();

    // Re-enable periodically to combat any race conditions
    const interval = setInterval(() => {
      window.ghostly.enableMouse();
    }, 200);

    return () => {
      clearInterval(interval);
      window.ghostly.disableMouse();
    };
  }, []);

  // Auto-save settings
  useEffect(() => {
    const timer = setTimeout(() => {
      window.ghostly.saveSettings(settings);
    }, 500);
    return () => clearTimeout(timer);
  }, [settings]);

  // Resolve the model list whenever the provider or its key changes.
  useEffect(() => {
    let cancelled = false;
    const provider = getProvider(activeProviderName);
    const fallback = provider ? provider.listModels() : [];
    setAvailableModels(fallback);

    if (
      !provider ||
      typeof provider.fetchModels !== "function" ||
      !apiKeyForProvider.trim()
    ) {
      return;
    }

    setModelsLoading(true);
    provider
      .fetchModels(apiKeyForProvider)
      .then((models) => {
        if (cancelled || models.length === 0) return;
        setAvailableModels(models);
        // Auto-heal a stale selection (e.g. a model the provider retired) — for
        // THIS provider only.
        const current = useStore.getState().settings.models?.[activeProviderName];
        if (!current || !models.includes(current)) {
          updateSettings({
            models: { ...useStore.getState().settings.models, [activeProviderName]: models[0] },
          });
        }
      })
      .catch((err) => {
        // Live discovery is best-effort; the fallback list stays in place.
        console.warn(
          `[Ghostly] Could not fetch live models for ${activeProviderName}:`,
          err,
        );
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // The stored model is intentionally omitted from the deps: including it
    // would refetch on every auto-heal. The heal above reads it at fetch time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProviderName, apiKeyForProvider, updateSettings]);

  const handleProviderChange = (id: ProviderName) => {
    const provider = getProvider(id);
    const models = provider ? provider.listModels() : [];
    // Only ever fills in this provider's own slot.
    updateSettings({
      activeProvider: id,
      models: {
        ...settings.models,
        [id]: settings.models?.[id] || models[0] || "",
      },
    });
  };

  const activeModels = availableModels;
  const isOpenRouterActive = settings.activeProvider === "openrouter";
  const isOpenRouterFree = isOpenRouterActive && activeModelForProvider === OPENROUTER_FREE_OPTION.value;

  // Live discovery returns the whole catalog; for free mode that list would be
  // misleading because we never pick from it ourselves — OpenRouter does.
  const modelOptions = isOpenRouterActive
    ? [
        OPENROUTER_FREE_OPTION.value,
        ...availableModels.filter((m) => m !== OPENROUTER_FREE_OPTION.value),
      ]
    : availableModels;

  return (
    <div
      className="fixed inset-0 flex justify-center pt-16 z-50"
      onClick={(e) => {
        // Close if clicking the backdrop (outside the panel)
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ pointerEvents: "auto" }}
    >
      <div
        className="
          bg-[rgba(25,25,28,0.97)]
          backdrop-blur-2xl
          border border-white/[0.08]
          rounded-2xl
          w-[380px]
          max-h-[75vh]
          overflow-y-auto
          p-5
          text-xs font-mono text-white/80
          shadow-2xl shadow-black/60
        "
        onClick={(e) => e.stopPropagation()}
        style={{ pointerEvents: "auto", WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <span className="text-sm font-semibold text-white/90">Settings</span>
          <button
            onClick={onClose}
            className="text-white/30 hover:text-white/70 text-sm transition-colors"
          >
            ✕
          </button>
        </div>

        {/* AI Provider */}
        <Section label="AI Provider">
          <select
            value={settings.activeProvider}
            onChange={(e) =>
              handleProviderChange(e.target.value as ProviderName)
            }
            className="settings-select"
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Section>

        {/* API Key */}
        <Section label="API Key">
          <div className="flex gap-2">
            <input
              type={showKey ? "text" : "password"}
              value={settings.apiKeys[settings.activeProvider]}
              onChange={(e) =>
                setApiKey(settings.activeProvider, e.target.value)
              }
              placeholder={`Enter ${settings.activeProvider} API key`}
              className="settings-input flex-1"
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="text-white/40 hover:text-white/70 text-[10px] px-2 transition-colors"
            >
              {showKey ? "🙈" : "👁"}
            </button>
          </div>
          <a
            href={
              PROVIDERS.find((p) => p.id === settings.activeProvider)?.docsUrl
            }
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-accent/60 hover:text-accent/90 mt-1 inline-block transition-colors"
          >
            Get API key →
          </a>
        </Section>

        {/*
          ── Key pool (failover credentials) ──────────────────────────────
          Three masked slots per provider for the providers that are actually
          in the interview chain. A second key means one refused credential
          costs a single immediate hop instead of a fallback to another
          provider — which is the difference between an interview that keeps
          answering and one that goes silent for a few seconds per question.

          Two properties are enforced here rather than merely intended:
          • every field is `type="password"` by default, and the reveal toggle
            is per-section and off on mount;
          • the status line next to each box is one of five fixed words, derived
            from `describeKeyStatus`, which by construction cannot echo any part
            of the key.
        */}
        <Section label="Key Pool (failover)">
          <div className="space-y-2">
            {INTERVIEW_PROVIDER_ORDER.map((p) => {
              const keys = keyPool(
                settings.apiKeys,
                settings.apiKeyPool,
                p,
              );
              const label =
                PROVIDERS.find((x) => x.id === p)?.label ?? p;
              const tally = summarizeKeys(
                keyHealth.state,
                p,
                keys,
                Date.now(),
              );
              return (
                <div key={p} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-mono text-white/60">
                      {label}
                    </span>
                    <span className="text-[9px] font-mono text-white/35">
                      {tally.configured}/{tally.total} configured
                      {tally.cooldown > 0 ? ` · ${tally.cooldown} cooling` : ""}
                      {tally.failed > 0 ? ` · ${tally.failed} failed` : ""}
                    </span>
                  </div>
                  {keys.map((key, index) => (
                    <div
                      key={index}
                      className="flex items-center gap-2"
                    >
                      <span className="w-[52px] flex-none text-[9px] font-mono text-white/35">
                        {describeKeySlot(index)}
                      </span>
                      <input
                        type="password"
                        value={key}
                        onChange={(e) =>
                          setPoolKey(p, index, e.target.value)
                        }
                        placeholder={
                          index === 0
                            ? `Enter ${label} key`
                            : `${label} key ${index + 1} (optional)`
                        }
                        aria-label={`${label} ${describeKeySlot(index)}`}
                        data-ghostly={`key-${p}-${index}`}
                        className="settings-input flex-1"
                      />
                      <span
                        data-ghostly={`key-status-${p}-${index}`}
                        className={`w-[86px] flex-none text-right text-[9px] font-mono ${
                          keyHealth.statusOf(p, index, key) === "healthy"
                            ? "text-emerald-300/70"
                            : keyHealth.statusOf(p, index, key) ===
                                "not-configured"
                              ? "text-white/25"
                              : "text-amber-300/70"
                        }`}
                      >
                        {keyHealth.statusOf(p, index, key)}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          <p className="text-[9px] font-mono text-white/30 mt-1.5 leading-snug">
            Extra keys are failover credentials you have authorized Ghostly to
            use. A key that is refused is skipped for a short cooldown and the
            next healthy one is used; a key that works is never rotated away.
          </p>
        </Section>

        {/* Model */}
        <Section label="Model">
          <select
            value={activeModelForProvider}
            onChange={(e) => setModelForProvider(e.target.value)}
            className="settings-select"
          >
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m === OPENROUTER_FREE_OPTION.value ? OPENROUTER_FREE_OPTION.label : m}
              </option>
            ))}
          </select>
          <p className="text-[9px] text-white/30 mt-1">
            {isOpenRouterFree
              ? "OpenRouter Free is a ROUTER, not a model — OpenRouter picks whichever free model is available for each request. The live model and backend are shown in the overlay and in the log."
              : modelsLoading
                ? "Checking available models…"
                : apiKeyForProvider.trim()
                  ? "Models available to your API key."
                  : "Add an API key to load models available to your account."}
          </p>
          <p className="text-[9px] text-white/25 mt-1">
            Saved per provider — changing provider keeps its own model.
          </p>
          <p className="text-[9px] text-white/25 mt-1">
            Live interview answers try:{" "}
            {failoverChain.length > 0
              ? failoverChain.join(" → ")
              : `add an API key for ${PROVIDERS.find((x) => x.id === INTERVIEW_PROVIDER_ORDER[0])?.label ?? INTERVIEW_PROVIDER_ORDER[0]}`}
            . An error, timeout or empty reply falls back to the next one — but
            never once answer text is already on screen.
          </p>
        </Section>

        {/* Interview Answer Chain — which providers are eligible, in order */}
        <Section label="Interview Answer Chain">
          <div className="flex flex-col gap-1">
            {/* Every provider is listed, INCLUDING the optional ones — they must remain
              reachable, otherwise "optional" would mean "removed". */}
            {ALL_INTERVIEW_PROVIDERS.map((p) => {
              const on = isInChain(p);
              const keyed = hasKey(p);
              const isPrimary = p === INTERVIEW_PROVIDER_ORDER[0];
              const isOptional = !INTERVIEW_PROVIDER_ORDER.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  role="switch"
                  aria-checked={on}
                  onClick={() => toggleInChain(p)}
                  className="w-full flex items-center justify-between gap-2 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-[10px] font-mono text-white/75 outline-none cursor-pointer transition-colors"
                >
                  <span className="flex items-center gap-1.5 truncate text-left">
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-none ${
                        on && keyed
                          ? "bg-emerald-400"
                          : on
                            ? "bg-amber-400"
                            : "bg-white/20"
                      }`}
                    />
                    <span className="truncate">
                      {PROVIDERS.find((x) => x.id === p)?.label ?? p}
                    </span>
                    {isPrimary && (
                      <span className="text-[8px] text-accent/70 flex-none">
                        primary
                      </span>
                    )}
                    {isOptional && (
                      <span className="text-[8px] text-white/30 flex-none">
                        optional
                      </span>
                    )}
                  </span>
                  <span className="flex-none text-[9px] text-white/35">
                    {!keyed
                      ? "no key · skipped"
                      : on
                        ? "ready"
                        : "off · skipped"}
                  </span>
                </button>
              );
            })}
          </div>
          {/* ── The model each provider will actually use ──────────────────
              Rendered per provider rather than once for "the active provider",
              because the interview runs ALL of them and each has its own saved
              model. The list is fetched live from the provider and only falls
              back to its curated defaults when there is no key or the request
              fails — no model name is ever hard-coded as if it were the only
              option. */}
          {ALL_INTERVIEW_PROVIDERS.filter(hasKey).length > 0 && (
            <div className="mt-2 space-y-1.5">
              {ALL_INTERVIEW_PROVIDERS.filter((p) => hasKey(p)).map((p) => {
                const live = chainModels[p];
                const curated = getProvider(p)?.listModels() ?? [];
                const options =
                  live && live.length > 0 ? live : curated;
                const current = settings.models?.[p] ?? "";
                // A saved model that has left the live list would silently stay
                // selected and produce "model does not exist" every turn, so it
                // is surfaced rather than hidden.
                const stale =
                  !!current && options.length > 0 && !options.includes(current);
                return (
                  <div key={p} className="flex items-center gap-2">
                    <span className="text-[9px] text-white/35 w-20 flex-none truncate">
                      {PROVIDERS.find((x) => x.id === p)?.label ?? p}
                    </span>
                    <select
                      value={current}
                      onChange={(e) => setChainModel(p, e.target.value)}
                      className="settings-select flex-1 text-[10px] py-1"
                    >
                      {!current && <option value="">unset</option>}
                      {stale && (
                        <option value={current}>
                          {current} (not in the live list)
                        </option>
                      )}
                      {options.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <span className="text-[8px] text-white/25 w-14 flex-none text-right">
                      {chainModelsLoading[p]
                        ? "loading…"
                        : live
                          ? `${live.length} live`
                          : "default list"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-[9px] text-white/30 mt-1">
            Tried top to bottom. A provider is skipped when it has no API key or is
            switched off here — the startup log prints the reason for each one.
          </p>
          <p className="text-[9px] text-white/30 mt-1">
            Each provider keeps its own model, listed live from that provider. A
            name shown as &ldquo;not in the live list&rdquo; has been retired —
            pick another one, because it will fail on every turn.
          </p>
        </Section>

        {/*
          ── Answer Context ──────────────────────────────────────────

          Everything here shapes an answer. The visible "Interview Context"
          overlay box (and its context chip) were removed with the user's
          cleanup — the settings themselves remain because the answer pipeline
          still reads them: the resume and the answer instructions are prompt
          inputs, not UI.
        */}
        <Section label="Answer Context">
          <label className="text-[9px] text-white/40 block mb-0.5">Resume</label>
          <div className="flex items-center gap-2 mb-1">
            <button
              type="button"
              onClick={() => resumeFileRef.current?.click()}
              disabled={resumeReading}
              className="rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.1] px-2.5 py-1 text-[10px] text-white/70 hover:text-white/90 disabled:opacity-40 transition-colors"
            >
              {resumeReading ? "Reading…" : "⬆ Upload"}
            </button>
            <span className="text-[9px] text-white/25 truncate">
              PDF, DOCX, .txt, .md — or paste below
            </span>
            <input
              ref={resumeFileRef}
              type="file"
              accept=".txt,.md,.markdown,.rst,.json,.csv,.rtf,.tex,.yml,.yaml,.html,.pdf,.doc,.docx"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleResumeFile(file);
                // Reset so re-selecting the same file fires onChange again.
                e.target.value = "";
              }}
            />
          </div>
          {resumeNote && (
            <p className="text-[9px] text-white/35 mb-1">{resumeNote}</p>
          )}
          <textarea
            value={settings.resumeText ?? ""}
            onChange={(e) => updateSettings({ resumeText: e.target.value })}
            placeholder="Paste your resume here…"
            rows={3}
            className="settings-input w-full resize-none"
          />

          <label className="text-[9px] text-white/40 block mt-2.5 mb-0.5">
            Answer Instructions
          </label>
          <textarea
            value={settings.answerInstructions ?? ""}
            onChange={(e) =>
              updateSettings({ answerInstructions: e.target.value })
            }
            placeholder="Tell the AI how you want interview answers written."
            rows={4}
            className="settings-input w-full resize-none"
          />
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[9px] text-white/30 flex-1">
              Style and structure only. It can never override the app's
              factuality, validation or artifact rules.
            </span>
            <button
              type="button"
              onClick={() =>
                updateSettings({
                  answerInstructions: DEFAULT_ANSWER_INSTRUCTIONS,
                })
              }
              className="flex-none px-2 py-1 rounded bg-white/[0.06] hover:bg-white/[0.12] text-[9px] text-white/60"
            >
              Reset
            </button>
          </div>

          <ToggleRow
            label="Auto-answer when a question ends"
            on={!!settings.autoAnswer}
            onToggle={() => updateSettings({ autoAnswer: !settings.autoAnswer })}
            hint="Answers fire on their own the moment the interviewer stops talking on a clear question. Incomplete or conversational speech is still ignored (WAIT). Ctrl+Enter / Ask Copilot keep working either way."
          />

          <p className="text-[9px] text-white/30 mt-2">
            Stored on this machine only. Never logged.
          </p>
        </Section>

        {/* Code Language */}
        <Section label="Code Language">
          <select
            value={settings.language}
            onChange={(e) =>
              updateSettings({ language: e.target.value as any })
            }
            className="settings-select"
          >
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </Section>

        {/* ── Speech recognition engine (primary) ─────────────────────────── */}
        {/*
         * The one switch that decides which engine's transcript reaches the
         * question gate and the AI. It lives HERE, inside SettingsPanel, rather
         * than in a debug panel for a specific reason: the auto-save effect at
         * the bottom of this file mirrors `settings` to electron-store, which is
         * the ONLY store the main process reads. A control anywhere else updates
         * zustand and the main process never learns about it — which is exactly
         * the bug that made the Parakeet comparison toggle appear dead.
         */}
        <Section label="Speech Recognition">
          <div className="inline-flex rounded-lg overflow-hidden border border-white/[0.12]">
            <button
              type="button"
              onClick={() => selectPrimaryAsr("moonshine")}
              aria-pressed={primaryAsr === "moonshine"}
              className={primaryAsr === "moonshine" ? VIS_ACTIVE : VIS_INACTIVE}
            >
              Moonshine (local)
            </button>
            <button
              type="button"
              onClick={() => selectPrimaryAsr("parakeet")}
              aria-pressed={primaryAsr === "parakeet"}
              className={primaryAsr === "parakeet" ? VIS_ACTIVE : VIS_INACTIVE}
            >
              Parakeet (local)
            </button>
          </div>
          <p className="text-[9px] text-white/30 mt-1">
            {primaryAsr === "parakeet" ? (
              <>
                Parakeet runs entirely on this machine and is more accurate than
                Moonshine on interview speech. It needs a one-time ~631 MB model
                download and about 700 MB of memory while an interview runs, and
                it takes ~7 s to start the first time. Moonshine is NOT loaded
                while Parakeet is healthy — it starts only if a single segment
                fails, and that fallback stays local too. Audio is never sent to
                a cloud service by either engine.
              </>
            ) : (
              <>
                Moonshine runs locally and shows words as the interviewer
                speaks. It needs no download beyond the model itself and is the
                default for new installs.
              </>
            )}
          </p>
          {engineNote && (
            <p className="text-[9px] text-white/35 mt-1">{engineNote}</p>
          )}
        </Section>

        {/* ── Parakeet model download ───────────────────────────────────── */}
        {/*
         * Shown whenever Parakeet is selected. The model is NEVER bundled: it
         * is ~631 MB unpacked, and shipping it would put half a gigabyte into
         * every installer for a feature that is off by default and make the
         * installer the thing that decides which engine you get.
         *
         * Every button here is retry-safe. "Retry" is hidden while a transfer
         * is running (a retry would just join the in-flight one and look inert),
         * and the main process joins a concurrent download rather than starting
         * a second 460 MB transfer.
         */}
        {primaryAsr === "parakeet" && (
          <Section label="Speech model (local)">
            <p className="text-[9px] text-white/40">
              {describeModelState(modelState)}
            </p>

            {isTransferInProgress(modelState) && (
              <div className="mt-1.5">
                <div className="h-1.5 rounded bg-white/[0.08] overflow-hidden">
                  <div
                    className="h-full bg-white/40 transition-all"
                    style={{ width: `${modelState.progress ?? 0}%` }}
                    role="progressbar"
                    aria-valuenow={modelState.progress ?? 0}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  />
                </div>
                <p className="text-[9px] text-white/30 mt-1">
                  {modelState.status === "verifying"
                    ? "Unpacking and checking files…"
                    : `${modelState.progress ?? 0}% · ${formatBytes(modelState.bytesDownloaded)} of ${formatBytes(modelState.bytesTotal)}`}
                </p>
              </div>
            )}

            {modelState.status === "error" && modelState.message && (
              <p className="text-[9px] text-red-300/80 mt-1.5">
                {modelState.message}
              </p>
            )}

            {modelState.status === "error" && (
              <p className="text-[9px] text-amber-200/70 mt-1.5">
                Moonshine will be used for every segment until this is fixed —
                still entirely on this machine.
              </p>
            )}

            <div className="flex flex-wrap gap-2 mt-2">
              {canRetryDownload(modelState) && (
                <button
                  type="button"
                  onClick={() => void startDownload()}
                  disabled={modelBusy}
                  className="px-2 py-1 rounded bg-white/[0.08] hover:bg-white/[0.14] text-white/70 text-[9px] disabled:opacity-40"
                >
                  {modelState.status === "error" ? "Retry download" : "Download the model"}
                </button>
              )}
              {isTransferInProgress(modelState) && (
                <button
                  type="button"
                  onClick={() => void cancelDownload()}
                  className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-white/60 text-[9px]"
                >
                  Cancel
                </button>
              )}
              {modelState.status === "ready" && (
                <button
                  type="button"
                  onClick={() => void removeModel()}
                  className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-white/50 text-[9px]"
                >
                  Delete the {formatBytes(PARAKEET_UNPACKED_BYTES)} model
                </button>
              )}
              {/* ── The way out ───────────────────────────────────────────
                  Always present, and not only on failure: the clean recovery
                  from "this model will not install on my machine" must be
                  obvious without reading an error message first. Moonshine
                  needs no download and is already installed. */}
              <button
                type="button"
                onClick={() => selectPrimaryAsr("moonshine")}
                className="px-2 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-white/60 text-[9px]"
              >
                Switch back to Moonshine
              </button>
            </div>

            {modelState.status === "ready" && (
              <p className="text-[9px] text-white/25 mt-1.5">{MODEL_INTEGRITY_NOTE}</p>
            )}
            {modelState.dir && (
              <p className="text-[9px] text-white/20 mt-1 break-all">
                Installed in {modelState.dir}
              </p>
            )}

            {/* ── Preload ──────────────────────────────────────────────────
                Only meaningful once the model is INSTALLED: preloading a
                missing model would show a red banner the moment the panel
                opens, which is a worse first impression than the slow load it
                was meant to hide. */}
            {modelState.status === "ready" && (
              <label className="flex items-start gap-2 mt-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={forceEndpointOnHotkey}
                  onChange={(e) => {
                    const on = e.target.checked;
                    updateSettings({ forceEndpointOnHotkey: on });
                    // Written straight through, like the preload toggle: the
                    // submit path reads this from the store, so a debounced save
                    // would leave the first hotkey press on the old behaviour.
                    void window.ghostly.saveSettings({
                      ...useStore.getState().settings,
                      forceEndpointOnHotkey: on,
                    });
                  }}
                  className="mt-0.5 accent-white/70"
                />
                <span>
                  <span className="text-[10px] text-white/75">
                    Close the open phrase when I press Ctrl+Enter
                  </span>
                  <span className="block text-[9px] text-white/40 mt-0.5">
                    The drain barrier can only wait for phrases the VAD has already
                    closed, so pressing the hotkey within 1.5s of the last word
                    used to submit the question with its tail missing. This closes
                    the open phrase first. Applies only when the local speech model
                    is primary
                    {primaryAsr !== "parakeet"
                      ? " — it is not primary right now, so this has no effect"
                      : ""}
                    .
                  </span>
                </span>
              </label>
            )}

            {modelState.status === "ready" && (
              <label className="flex items-start gap-2 mt-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={parakeetPreload}
                  onChange={(e) => {
                    const on = e.target.checked;
                    updateSettings({ parakeetPreload: on });
                    // Written straight through, like the engine switch: the
                    // main process owns the model, and a debounced save would
                    // leave the load racing a stale setting.
                    void window.ghostly.saveSettings({
                      ...useStore.getState().settings,
                      parakeetPreload: on,
                    });
                  }}
                  className="mt-0.5 accent-white/70"
                />
                <span>
                  <span className="text-[10px] text-white/75">
                    Preload the speech model when this panel opens
                  </span>
                  <span className="block text-[9px] text-white/40 mt-0.5">
                    {describeParakeetPreloadCost()}
                  </span>
                </span>
              </label>
            )}
          </Section>
        )}

        {/* Transcription Model (Moonshine only) */}
        <Section label="Transcription Model">
          <select
            value={settings.whisperModel ?? "onnx-community/moonshine-base-ONNX"}
            onChange={(e) => updateSettings({ whisperModel: e.target.value })}
            className="settings-select"
            disabled={primaryAsr === "parakeet"}
          >
            {ASR_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <p className="text-[9px] text-white/30 mt-1">
            {primaryAsr === "parakeet"
              ? "Moonshine is not loaded while Parakeet is the primary engine. This still chooses which Moonshine model starts if it ever has to load as the fallback."
              : "Moonshine runs locally and streams text as the interviewer speaks. Switching reloads the engine (~first run downloads the model)."}
          </p>
        </Section>

        {/* ── Screen visibility (dev/test only) ────────────────────────── */}
        {/*
         * Lets Ghostly be screenshotted and screen-shared while testing.
         * Dev builds only, and runtime-only: it is not part of the persisted
         * settings, so a restart always comes back hidden. Both modes route
         * through the SAME Win32 `SetWindowDisplayAffinity` mechanism — there
         * is no second capture-exclusion path.
         */}
        {import.meta.env.DEV && (
          <Section label="Screen Visibility (dev only)">
            <div className="inline-flex rounded-lg overflow-hidden border border-white/[0.12]">
              <button
                type="button"
                onClick={() => void applyVisibility("visible")}
                aria-pressed={visibility === "visible"}
                className={visibility === "visible" ? VIS_ACTIVE : VIS_INACTIVE}
              >
                Visible
              </button>
              <button
                type="button"
                onClick={() => void applyVisibility("hidden")}
                aria-pressed={visibility === "hidden"}
                className={visibility === "hidden" ? VIS_ACTIVE : VIS_INACTIVE}
              >
                Hidden
              </button>
            </div>
            <p className="text-[9px] text-white/30 mt-1">
              Visible lets Ghostly appear in screen capture. Hidden (default)
              keeps it excluded. Resets on restart and never affects the
              interview, audio or AI.
            </p>
          </Section>
        )}

        {/* ── Second ASR engine (optional, Deepgram) ──────────────────── */}
        {/*
         * Deepgram is a COMPARISON engine, not a replacement. The default
         * engine (Moonshine, local) is untouched and fully functional without
         * any key. Everything here is developer-only and is hidden outside a
         * dev build.
         */}
        {import.meta.env.DEV && (
          <Section label="ASR Comparison (dev only)">
            <p className="text-[9px] text-white/30 mb-1">
              Moonshine (local) is the default and always runs. The engines
              below are COMPARISON-ONLY: the same captured audio is sent to
              each, and results are shown side by side. They never reach the
              AI, and failures never affect the interview.
            </p>

            <input
              type="password"
              value={settings.deepgramKey ?? ""}
              onChange={(e) => updateSettings({ deepgramKey: e.target.value })}
              placeholder="Deepgram API key (optional)"
              className="settings-input w-full"
              autoComplete="off"
            />
            <label className="flex items-center gap-2 mt-2 text-[10px] text-white/50 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={settings.asrCompareMode ?? false}
                onChange={(e) =>
                  updateSettings({ asrCompareMode: e.target.checked })
                }
              />
              <span>Compare with Deepgram Nova-3</span>
            </label>
            <p className="text-[9px] text-white/30 mt-1">
              Sends the same captured audio to Deepgram Nova-3. Costs one API
              call per utterance. The key is stored on disk but is only ever
              read by the main process, which hands the renderer a 30-second
              token.
            </p>

            {/* ── Groq Whisper (comparison only) ─────────────────────── */}
            <div className="mt-3 pt-3 border-t border-white/[0.06]">
              <input
                type="password"
                value={groqKeyDraft}
                onChange={(e) => setGroqKeyDraft(e.target.value)}
                placeholder={
                  groqKeyConfigured
                    ? "Groq API key (configured — type to replace)"
                    : "Groq API key (optional)"
                }
                className="settings-input w-full"
                autoComplete="off"
              />
              <div className="flex items-center gap-2 mt-1.5">
                <button
                  type="button"
                  onClick={() => void saveGroqKey()}
                  disabled={!groqKeyDraft.trim() || groqKeySaving}
                  className="px-2 py-1 text-[10px] rounded bg-white/10 hover:bg-white/20 disabled:opacity-30 text-white"
                >
                  Save key
                </button>
                {groqKeyConfigured && (
                  <button
                    type="button"
                    onClick={() => void clearGroqKey()}
                    disabled={groqKeySaving}
                    className="px-2 py-1 text-[10px] rounded bg-white/5 hover:bg-white/10 disabled:opacity-30 text-white/70"
                  >
                    Clear
                  </button>
                )}
                <span className="text-[9px] text-white/40">
                  {groqKeyConfigured ? "key configured" : "no key"}
                </span>
              </div>

              <label className="flex items-center gap-2 mt-2 text-[10px] text-white/50 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={settings.asrCompareGroq ?? false}
                  onChange={(e) =>
                    updateSettings({ asrCompareGroq: e.target.checked })
                  }
                />
                <span>Compare with Groq Whisper</span>
              </label>

              <input
                type="text"
                value={settings.groqAsrModel ?? "whisper-large-v3"}
                onChange={(e) =>
                  updateSettings({ groqAsrModel: e.target.value })
                }
                placeholder="whisper-large-v3"
                className="settings-input w-full mt-1.5"
                autoComplete="off"
              />
              <p className="text-[9px] text-white/30 mt-1">
                Sends the same captured audio to Groq Whisper
                (whisper-large-v3). The key is stored in the main process only
                and is never exposed to the app UI or bundled JavaScript.
              </p>
            </div>
          </Section>
        )}

        {/* Audio Input (Mic) */}
        <Section label="Audio Input (Mic)">
          <div
            className="relative"
            ref={micDropdownRef}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <button
              onClick={() => setMicDropdownOpen(!micDropdownOpen)}
              className="w-full bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.12] rounded-lg px-3 py-2.5 text-[11px] text-white/80 font-mono outline-none cursor-pointer transition-colors flex items-center justify-between gap-2"
            >
              <span className="truncate">
                {settings.micDeviceId === "default" || !settings.micDeviceId
                  ? "Default Microphone"
                  : mics.find((m) => m.deviceId === settings.micDeviceId)
                      ?.label || "Unknown Microphone"}
              </span>
              <span className="text-[8px] opacity-60">▼</span>
            </button>

            {micDropdownOpen && (
              <div
                className="absolute top-full mt-2 left-0 w-full bg-[rgba(30,30,30,0.95)] backdrop-blur-md border border-white/[0.12] rounded-xl shadow-xl overflow-hidden z-50 flex flex-col pointer-events-auto max-h-48 overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  onClick={() => {
                    updateSettings({ micDeviceId: "default" });
                    setMicDropdownOpen(false);
                  }}
                  className={`text-left px-3 py-2 text-[11px] font-mono transition-colors hover:bg-white/[0.08] truncate ${
                    settings.micDeviceId === "default" || !settings.micDeviceId
                      ? "bg-white/[0.04] text-white"
                      : "text-white/70"
                  }`}
                >
                  Default Microphone
                </button>
                {mics.map((t) => (
                  <button
                    key={t.deviceId}
                    onClick={() => {
                      updateSettings({ micDeviceId: t.deviceId });
                      setMicDropdownOpen(false);
                    }}
                    className={`text-left px-3 py-2 text-[11px] font-mono transition-colors hover:bg-white/[0.08] truncate ${
                      settings.micDeviceId === t.deviceId
                        ? "bg-white/[0.04] text-white"
                        : "text-white/70"
                    }`}
                  >
                    {t.label || `Microphone (${t.deviceId.slice(0, 5)}...)`}
                  </button>
                ))}
              </div>
            )}
          </div>
        </Section>

        {/* Manage Prompts */}
        {/* <div className="mt-4 p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
          <div className="flex items-center justify-between">
            <span className="text-white/60">Manage Prompts</span>
            <span className="text-[9px] px-2 py-0.5 rounded-full bg-accent/15 text-accent/80 font-semibold">
              Open
            </span>
          </div>
        </div> */}

        {/* Shortcuts */}
        <div className="mt-5">
          <span className="text-[10px] text-white/40 uppercase tracking-wider">
            Keyboard Shortcuts
          </span>
          <div className="mt-2 space-y-1.5">
            {SHORTCUTS.map((s) => (
              <ShortcutRow key={s.label} label={s.label} keys={s.keys} />
            ))}
          </div>
          {/* Surfaced rather than silently overwritten: if two actions were
              ever assigned the same key, the user sees it here. */}
          {SHORTCUT_CONFLICTS.length > 0 && (
            <div className="mt-2 p-2 rounded-lg bg-red-500/10 border border-red-500/25">
              {SHORTCUT_CONFLICTS.map((c) => (
                <p key={c.accelerator} className="text-[10px] text-red-300/90 font-mono">
                  Shortcut conflict: {c.accelerator} is assigned to {c.ids.join(" and ")}.
                </p>
              ))}
            </div>
          )}
        </div>

        {/* Bottom buttons */}
        <div className="mt-5 pt-4 border-t border-white/[0.06] grid grid-cols-1 gap-2">
          <BottomButton label="Quit" onClick={() => window.close()} />
        </div>
      </div>
    </div>
  );
};

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <label className="text-[10px] text-white/40 uppercase tracking-wider mb-1.5 block">
        {label}
      </label>
      {children}
    </div>
  );
}

function ShortcutRow({ label, keys }: { label: string; keys: string[] }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-white/55">{label}</span>
      <div className="flex items-center gap-1">
        {keys.map((k, i) => (
          <kbd
            key={`${k}-${i}`}
            className="bg-black/40 border border-white/[0.12] rounded px-1.5 py-0.5 text-[10px] text-white/70 font-mono"
          >
            {k}
          </kbd>
        ))}
      </div>
    </div>
  );
}

/** One labelled switch. Shared by the two Interview Context automations. */
function ToggleRow({
  label,
  on,
  onToggle,
  hint,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
  /** Shown under the row. States the trade-off, not just the behaviour. */
  hint?: string;
}) {
  return (
    <div className="mt-3">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.12] rounded-lg px-3 py-2.5 text-[11px] font-mono text-white/80 outline-none cursor-pointer transition-colors"
      >
        <span className="truncate text-left">{label}</span>
        <span
          className={`flex-none w-8 h-4 rounded-full p-0.5 transition-colors ${
            on ? "bg-accent/70" : "bg-white/[0.12]"
          }`}
        >
          <span
            className={`block w-3 h-3 rounded-full bg-white transition-transform ${
              on ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </span>
      </button>
      {hint && <p className="text-[9px] text-white/30 mt-1">{hint}</p>}
    </div>
  );
}

function BottomButton({
  label,
  onClick,
}: {
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-[11px] text-white/50 hover:text-white/70 transition-all"
    >
      {label}
    </button>
  );
}
