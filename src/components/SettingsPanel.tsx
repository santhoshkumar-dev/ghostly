import React, { useEffect } from "react";
import { useStore } from "../store/useStore";
import { getProvider, type ProviderName } from "../lib/ai";

const INTERVIEW_TYPES = [
  { id: "dsa", label: "DSA / Algorithms" },
  { id: "system_design", label: "System Design" },
  { id: "frontend", label: "Frontend" },
  { id: "sql", label: "SQL" },
  { id: "behavioral", label: "Behavioral" },
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
  const [showKey, setShowKey] = React.useState(false);

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

        {/* Manage Prompts */}
        <div className="mt-4 p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
          <div className="flex items-center justify-between">
            <span className="text-white/60">Manage Prompts</span>
            <span className="text-[9px] px-2 py-0.5 rounded-full bg-accent/15 text-accent/80 font-semibold">
              Open
            </span>
          </div>
        </div>

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
        <div className="mt-5 pt-4 border-t border-white/[0.06] grid grid-cols-2 gap-2">
          <BottomButton label="Dashboard" />
          <BottomButton label="Tutorial" />
          <BottomButton label="Log out" />
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
