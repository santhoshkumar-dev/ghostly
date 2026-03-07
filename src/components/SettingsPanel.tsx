import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { getProvider, type ProviderName } from "../lib/ai";

export const INTERVIEW_TYPES = [
  { id: "dsa", label: "DSA / Algorithms" },
  { id: "system_design", label: "System Design" },
  { id: "frontend", label: "Frontend" },
  { id: "sql", label: "SQL" },
  { id: "behavioral", label: "Behavioral" },
  { id: "general", label: "General" },
];

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
];

const WHISPER_MODELS = [
  { id: "Xenova/whisper-tiny.en", label: "Tiny (English-only, fastest)" },
  { id: "Xenova/whisper-base.en", label: "Base (English-only, balanced)" },
  { id: "Xenova/whisper-small.en", label: "Small (English-only, accurate)" },
  { id: "Xenova/whisper-tiny", label: "Tiny (Multilingual)" },
  { id: "Xenova/whisper-base", label: "Base (Multilingual)" },
  { id: "Xenova/whisper-small", label: "Small (Multilingual)" },
];

const SHORTCUTS = [
  { label: "Ask AI", keys: ["Ctrl", "↵"] },
  { label: "Start Over", keys: ["Ctrl", "G"] },
  { label: "Screenshot", keys: ["Ctrl", "H"] },
  { label: "Show / Hide", keys: ["Ctrl", "B"] },
  { label: "Move Up", keys: ["Ctrl", "↑"] },
  { label: "Move Left", keys: ["Ctrl", "←"] },
  { label: "Move Down", keys: ["Ctrl", "↓"] },
  { label: "Move Right", keys: ["Ctrl", "→"] },
];

interface SettingsPanelProps {
  onClose: () => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ onClose }) => {
  const { settings, updateSettings, setApiKey } = useStore();
  const [showKey, setShowKey] = useState(false);

  // Microphone selection state
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [micDropdownOpen, setMicDropdownOpen] = useState(false);
  const micDropdownRef = useRef<HTMLDivElement>(null);

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

  const handleProviderChange = (id: ProviderName) => {
    const provider = getProvider(id);
    const models = provider.listModels();
    updateSettings({ activeProvider: id, activeModel: models[0] });
  };

  const activeModels = getProvider(settings.activeProvider).listModels();

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
        style={{ pointerEvents: "auto" }}
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

        {/* Model */}
        <Section label="Model">
          <select
            value={settings.activeModel}
            onChange={(e) => updateSettings({ activeModel: e.target.value })}
            className="settings-select"
          >
            {activeModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Section>

        {/* Output Language (Interview Type) */}
        <Section label="Output Language">
          <select
            value={settings.interviewType}
            onChange={(e) =>
              updateSettings({ interviewType: e.target.value as any })
            }
            className="settings-select"
          >
            {INTERVIEW_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
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

        {/* Whisper Model */}
        <Section label="Whisper Model">
          <select
            value={settings.whisperModel ?? "Xenova/whisper-base.en"}
            onChange={(e) => updateSettings({ whisperModel: e.target.value })}
            className="settings-select"
          >
            {WHISPER_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <p className="text-[9px] text-white/30 mt-1">
            Changing the model will reload the AI engine.
          </p>
        </Section>

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
