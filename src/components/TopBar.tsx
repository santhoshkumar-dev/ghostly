import React, { useState, useRef, useEffect } from "react";
import { useStore } from "../store/useStore";
import { INTERVIEW_TYPES } from "./SettingsPanel";

interface TopBarProps {
  onOpenSettings: () => void;
  settingsOpen: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({
  onOpenSettings,
  settingsOpen,
}) => {
  const { mouseEnabled, settings, updateSettings } = useStore();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setDropdownOpen(false);
      }
    }
    if (dropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [dropdownOpen]);

  const handleGearClick = () => {
    // Enable mouse first, then open settings
    window.ghostly.enableMouse();
    onOpenSettings();
  };

  const handleGearEnter = () => {
    // Only enable mouse on hover if settings is NOT already open
    // (SettingsPanel manages its own mouse state when open)
    if (!settingsOpen) {
      window.ghostly.enableMouse();
    }
  };

  const handleGearLeave = () => {
    // Only disable mouse if settings is NOT open
    if (!settingsOpen) {
      window.ghostly.disableMouse();
    }
  };

  return (
    <div className="w-full flex justify-center mt-3 pointer-events-none">
      <div className="flex flex-col items-center gap-2 pointer-events-none">
        <div
          className="
            flex items-center gap-3
            bg-[rgba(30,30,30,0.92)]
            backdrop-blur-2xl
            rounded-full
            px-4 py-2
            border border-white/[0.08]
            shadow-lg shadow-black/50
            text-[11px] font-mono text-white/80
            pointer-events-auto
          "
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        >
          {/* Ghost icon + Start Interview pill */}
          <div
            className="flex items-center gap-2 bg-[#ff9f43] rounded-full px-3 py-1 text-[11px] text-black font-semibold cursor-default"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <span>👻</span>
            <span>Start Interview</span>
          </div>

          {/* Separator */}
          <div className="w-px h-4 bg-white/10" />

          {/* New Custom Output Language Select */}
          <div
            className="relative"
            ref={dropdownRef}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            onMouseEnter={handleGearEnter}
            onMouseLeave={handleGearLeave}
          >
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.12] rounded-full px-3 py-1 text-[11px] text-white/80 font-mono outline-none cursor-pointer transition-colors flex items-center gap-2"
            >
              {INTERVIEW_TYPES.find((t) => t.id === settings.interviewType)
                ?.label || "Select Mode"}
              <span className="text-[8px] opacity-60">▼</span>
            </button>

            {dropdownOpen && (
              <div
                className="absolute top-full mt-2 left-0 w-36 bg-[rgba(30,30,30,0.95)] backdrop-blur-md border border-white/[0.12] rounded-xl shadow-xl overflow-hidden z-50 flex flex-col pointer-events-auto"
                onClick={(e) => e.stopPropagation()}
              >
                {INTERVIEW_TYPES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      updateSettings({ interviewType: t.id as any });
                      setDropdownOpen(false);
                    }}
                    className={`text-left px-3 py-2 text-[11px] font-mono transition-colors hover:bg-white/[0.08] ${
                      settings.interviewType === t.id
                        ? "bg-white/[0.04] text-white"
                        : "text-white/70"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Separator */}
          <div className="w-px h-4 bg-white/10" />

          {/* Hotkey hints */}
          <Hotkey label="Screenshot" keys={["Ctrl", "H"]} />
          <Hotkey label="Solve" keys={["Ctrl", "↵"]} />
          <Hotkey label="Hide" keys={["Ctrl", "B"]} />

          {/* Separator */}
          <div className="w-px h-4 bg-white/10" />

          {/* Settings gear — ONLY clickable element */}
          <button
            onMouseEnter={handleGearEnter}
            onMouseLeave={handleGearLeave}
            onClick={handleGearClick}
            className={`h-7 w-7 flex items-center justify-center rounded-full text-sm transition-all duration-150 ${
              settingsOpen
                ? "bg-white/20 text-white"
                : "bg-white/[0.06] hover:bg-white/[0.12] text-white/60 hover:text-white/90"
            }`}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            ⚙
          </button>
        </div>

        {/* Text area for general mode */}
        {settings.interviewType === "general" && (
          <div
            className="w-full max-w-[500px] pointer-events-auto"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            onMouseEnter={handleGearEnter}
            onMouseLeave={handleGearLeave}
          >
            <textarea
              value={settings.customInstructions || ""}
              onChange={(e) =>
                updateSettings({ customInstructions: e.target.value })
              }
              placeholder="Enter custom instructions for general mode..."
              className="w-[500px] bg-[rgba(30,30,30,0.92)] backdrop-blur-2xl border border-white/[0.08] rounded-2xl px-4 py-3 text-[12px] text-white/80 font-mono focus:outline-none focus:border-white/20 shadow-lg shadow-black/50 resize-none transition-colors"
              rows={2}
            />
          </div>
        )}
      </div>
    </div>
  );
};

function Hotkey({ label, keys }: { label: string; keys: string[] }) {
  return (
    <div
      className="flex items-center gap-1.5 text-[11px] text-white/50"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <span>{label}</span>
      {keys.map((k, i) => (
        <kbd
          key={`${k}-${i}`}
          className="bg-black/50 border border-white/[0.12] rounded px-1.5 py-0.5 text-[10px] text-white/70 font-mono"
        >
          {k}
        </kbd>
      ))}
    </div>
  );
}
