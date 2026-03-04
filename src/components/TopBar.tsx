import React from "react";
import { useStore } from "../store/useStore";

interface TopBarProps {
  onOpenSettings: () => void;
  settingsOpen: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({
  onOpenSettings,
  settingsOpen,
}) => {
  const { mouseEnabled } = useStore();

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
