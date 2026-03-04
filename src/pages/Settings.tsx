import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { useStore } from "../store/useStore";
import { getProvider, type ProviderName } from "../lib/ai";
import { ProviderBadge } from "../components/ProviderBadge";

const PROVIDERS = [
  {
    id: "gemini" as ProviderName,
    label: "Google Gemini",
    icon: "✦",
    docsUrl: "https://aistudio.google.com/app/apikey",
    description: "Free tier available · Fast · Great for vision",
    color: "blue",
  },
  {
    id: "openai" as ProviderName,
    label: "OpenAI GPT-4o",
    icon: "◈",
    docsUrl: "https://platform.openai.com/api-keys",
    description: "Paid only · Excellent vision · Fast",
    color: "emerald",
  },
  {
    id: "anthropic" as ProviderName,
    label: "Anthropic Claude",
    icon: "◉",
    docsUrl: "https://console.anthropic.com/settings/keys",
    description: "Paid only · Strong reasoning · Moderate speed",
    color: "orange",
  },
  {
    id: "groq" as ProviderName,
    label: "Groq",
    icon: "⚡",
    docsUrl: "https://console.groq.com/keys",
    description: "Free tier · Limited vision models · Ultra fast",
    color: "purple",
  },
];

const INTERVIEW_TYPES = [
  { id: "dsa", label: "DSA / Algorithms", icon: "🧮" },
  { id: "system_design", label: "System Design", icon: "🏗️" },
  { id: "frontend", label: "Frontend", icon: "🎨" },
  { id: "sql", label: "SQL", icon: "🗄️" },
  { id: "behavioral", label: "Behavioral", icon: "🗣️" },
];

const LANGUAGES = [
  { id: "python", label: "Python", icon: "🐍" },
  { id: "javascript", label: "JavaScript", icon: "🟨" },
  { id: "typescript", label: "TypeScript", icon: "🔷" },
  { id: "java", label: "Java", icon: "☕" },
  { id: "cpp", label: "C++", icon: "⚙️" },
  { id: "go", label: "Go", icon: "🐹" },
];

export const Settings: React.FC = () => {
  const { settings, updateSettings, setApiKey } = useStore();
  const [expandedProvider, setExpandedProvider] = useState<ProviderName | null>(
    settings.activeProvider,
  );
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState(false);

  // Persist settings whenever they change
  useEffect(() => {
    const timer = setTimeout(() => {
      window.ghostlyAPI.saveSettings(settings);
    }, 500);
    return () => clearTimeout(timer);
  }, [settings]);

  const handleSave = async () => {
    await window.ghostlyAPI.saveSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleSetActive = (providerId: ProviderName) => {
    const provider = getProvider(providerId);
    const models = provider.listModels();
    updateSettings({
      activeProvider: providerId,
      activeModel: models[0],
    });
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-4 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-dark-100">Settings</h1>
            <p className="text-xs text-dark-500 mt-1">
              Configure AI providers and preferences
            </p>
          </div>
          <button onClick={handleSave} className="btn-primary text-xs">
            {saved ? "✓ Saved" : "Save"}
          </button>
        </div>

        {/* AI Providers */}
        <section>
          <h2 className="text-sm font-semibold text-dark-300 uppercase tracking-wider mb-3">
            AI Providers
          </h2>
          <div className="space-y-2">
            {PROVIDERS.map((provider) => {
              const isActive = settings.activeProvider === provider.id;
              const isExpanded = expandedProvider === provider.id;
              const hasKey = !!settings.apiKeys[provider.id];
              const models = getProvider(provider.id).listModels();

              return (
                <motion.div
                  key={provider.id}
                  layout
                  className={`rounded-xl overflow-hidden transition-all duration-200 ${
                    isActive
                      ? "glass ghostly-border ghostly-glow"
                      : "glass-light border border-transparent"
                  }`}
                >
                  {/* Provider Header */}
                  <button
                    onClick={() =>
                      setExpandedProvider(isExpanded ? null : provider.id)
                    }
                    className="w-full px-4 py-3 flex items-center justify-between no-drag"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-lg">{provider.icon}</span>
                      <div className="text-left">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-dark-100">
                            {provider.label}
                          </span>
                          {isActive && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-ghostly-500/20 text-ghostly-400">
                              Active
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-dark-500 mt-0.5">
                          {provider.description}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {hasKey && (
                        <span
                          className="w-2 h-2 rounded-full bg-emerald-500"
                          title="API key set"
                        />
                      )}
                      <span
                        className={`text-dark-500 transition-transform ${
                          isExpanded ? "rotate-180" : ""
                        }`}
                      >
                        ▾
                      </span>
                    </div>
                  </button>

                  {/* Expanded Content */}
                  {isExpanded && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="px-4 pb-4 space-y-3 border-t border-dark-800"
                    >
                      {/* API Key */}
                      <div className="pt-3">
                        <label className="text-xs font-medium text-dark-400 mb-1.5 block">
                          API Key
                        </label>
                        <div className="flex gap-2">
                          <div className="relative flex-1">
                            <input
                              type={showKeys[provider.id] ? "text" : "password"}
                              value={settings.apiKeys[provider.id]}
                              onChange={(e) =>
                                setApiKey(provider.id, e.target.value)
                              }
                              placeholder={`Enter ${provider.label} API key`}
                              className="input-field pr-10"
                            />
                            <button
                              onClick={() =>
                                setShowKeys((s) => ({
                                  ...s,
                                  [provider.id]: !s[provider.id],
                                }))
                              }
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-dark-500 hover:text-dark-300 no-drag"
                            >
                              {showKeys[provider.id] ? "🙈" : "👁️"}
                            </button>
                          </div>
                        </div>
                        <a
                          href={provider.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 mt-1.5 text-xs text-ghostly-400 hover:text-ghostly-300 transition-colors no-drag"
                        >
                          🔑 Get API Key →
                        </a>
                      </div>

                      {/* Model Selection */}
                      <div>
                        <label className="text-xs font-medium text-dark-400 mb-1.5 block">
                          Model
                        </label>
                        <select
                          value={isActive ? settings.activeModel : models[0]}
                          onChange={(e) => {
                            if (isActive) {
                              updateSettings({ activeModel: e.target.value });
                            }
                          }}
                          className="input-field no-drag"
                          disabled={!isActive}
                        >
                          {models.map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Set Active Button */}
                      {!isActive && (
                        <button
                          onClick={() => handleSetActive(provider.id)}
                          className="btn-primary w-full text-xs py-2"
                          disabled={!hasKey}
                          title={!hasKey ? "Add an API key first" : ""}
                        >
                          Set as Active Provider
                        </button>
                      )}
                    </motion.div>
                  )}
                </motion.div>
              );
            })}
          </div>
        </section>

        {/* Interview Type */}
        <section>
          <h2 className="text-sm font-semibold text-dark-300 uppercase tracking-wider mb-3">
            Interview Type
          </h2>
          <div className="grid grid-cols-2 gap-2">
            {INTERVIEW_TYPES.map((type) => (
              <button
                key={type.id}
                onClick={() =>
                  updateSettings({ interviewType: type.id as any })
                }
                className={`px-3 py-2.5 rounded-lg text-left transition-all duration-200 no-drag ${
                  settings.interviewType === type.id
                    ? "glass ghostly-border bg-ghostly-500/10"
                    : "glass-light hover:bg-dark-700/50"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">{type.icon}</span>
                  <span className="text-xs font-medium text-dark-200">
                    {type.label}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Language */}
        <section>
          <h2 className="text-sm font-semibold text-dark-300 uppercase tracking-wider mb-3">
            Programming Language
          </h2>
          <div className="grid grid-cols-3 gap-2">
            {LANGUAGES.map((lang) => (
              <button
                key={lang.id}
                onClick={() => updateSettings({ language: lang.id as any })}
                className={`px-3 py-2.5 rounded-lg text-center transition-all duration-200 no-drag ${
                  settings.language === lang.id
                    ? "glass ghostly-border bg-ghostly-500/10"
                    : "glass-light hover:bg-dark-700/50"
                }`}
              >
                <span className="text-lg block">{lang.icon}</span>
                <span className="text-xs text-dark-300 mt-1 block">
                  {lang.label}
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* Hotkeys Reference */}
        <section>
          <h2 className="text-sm font-semibold text-dark-300 uppercase tracking-wider mb-3">
            Keyboard Shortcuts
          </h2>
          <div className="card space-y-2">
            {[
              { keys: "Ctrl+Shift+Space", action: "Capture & Solve" },
              { keys: "Ctrl+Shift+H", action: "Toggle Visibility" },
              { keys: "Ctrl+Shift+R", action: "Clear Solution" },
            ].map(({ keys, action }) => (
              <div
                key={keys}
                className="flex items-center justify-between py-1.5"
              >
                <span className="text-xs text-dark-400">{action}</span>
                <kbd className="px-2 py-0.5 rounded bg-dark-800 text-xs font-mono text-dark-300">
                  {keys}
                </kbd>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
