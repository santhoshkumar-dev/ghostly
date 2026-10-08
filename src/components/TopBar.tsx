import React from "react";
import { AudioStatusBar } from "./AudioStatusBar";
import { OpacityControl } from "./OpacityControl";
import logo from "../assets/logo.png";

interface TopBarProps {
  onOpenSettings: () => void;
  settingsOpen: boolean;
  onStartInterview: () => void;
  /** Full-screen capture, identical to the Ctrl+H hotkey. */
  onCaptureScreen: () => void;
}

/**
 * The main overlay bar.
 *
 * ── What is deliberately NOT here any more ──────────────────────────────────
 * The question-category dropdown and the General-mode instruction box are both
 * gone. Ghostly has exactly one mode: the question itself decides what shape the
 * answer takes, and the one instructions field lives in Settings and Interview
 * Context. Two instruction mechanisms and a category the candidate had to pick
 * before knowing the questions was the single most confusing part of the old
 * overlay.
 *
 * ── What is here ───────────────────────────────────────────────────────────
 * Start Interview, ONE Capture Screen button (Ctrl+Shift+S), the Solve/Hide
 * hotkey hints, opacity and Settings — the controls the candidate actually
 * reaches for mid-interview. The visible Interview Context box and the
 * duplicate capture control were removed.
 */
export const TopBar: React.FC<TopBarProps> = ({
  onOpenSettings,
  settingsOpen,
  onStartInterview,
  onCaptureScreen,
}) => {
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
        {/* NOTE: the visible "Interview Context" box used to sit here. It was
            removed with the user's cleanup; the settings it edited still feed
            every prompt (Settings → Answer Context). */}

        {/* Live interviewer-audio health: state + level, straight off the
            system-loopback stream that feeds the ASR. */}
        <AudioStatusBar />

        <div
          className="
            relative z-50
            flex items-center gap-3
            gs gs-b
            backdrop-blur-2xl
            rounded-full
            px-4 py-2
            shadow-lg shadow-black/50
            text-[11px] font-mono text-white/80
            pointer-events-auto
          "
          style={
            {
              "--gs-rgb": "30 30 30",
              "--gs-a": "0.92",
              "--gs-b": "0.08",
              WebkitAppRegion: "drag",
            } as React.CSSProperties
          }
        >
          {/* Ghost icon + Start Interview pill */}
          <div
            onClick={onStartInterview}
            onMouseEnter={handleGearEnter}
            onMouseLeave={handleGearLeave}
            className="flex items-center gap-2 bg-[#ff9f43] hover:bg-[#ffb067] transition-colors rounded-full px-3 py-1 text-[11px] text-black font-semibold cursor-pointer"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <img
              src={logo}
              className="w-4 h-4 object-contain brightness-0 opacity-80"
              alt="Ghostly"
            />
            <span>Start Interview</span>
          </div>

          {/* Separator */}
          <div className="w-px h-4 bg-white/10" />

          {/*
            Capture Screen — THE ONE visible capture action.

            The second copy (ScreenCapturePanel) and the visible "Capture
            hotkey" hint were removed. This button and the Ctrl+Shift+S global
            shortcut both run the SAME `onCaptureScreen` callback → same
            `ghostly:capture-fullscreen` IPC → same capture function.
          */}
          <button
            onClick={() => {
              window.ghostly.enableMouse();
              onCaptureScreen();
            }}
            onMouseEnter={handleGearEnter}
            onMouseLeave={handleGearLeave}
            className="bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.12] rounded-full px-3 py-1 text-[11px] text-white/80 font-mono outline-none cursor-pointer transition-colors"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            title="Capture the whole screen and use it as the question. Shortcut: Ctrl+Shift+S."
          >
            ⛶ Capture Screen
          </button>

          {/* Separator */}
          <div className="w-px h-4 bg-white/10" />

          {/* Hotkey hints. The "Capture" hint (the Capture hotkey control)
              is gone — the Capture Screen button's tooltip and Settings'
              shortcut list carry Ctrl+Shift+S instead. */}
          <Hotkey label="Solve" keys={["Ctrl", "↵"]} />
          <Hotkey label="Hide" keys={["Ctrl", "B"]} />

          {/* Separator */}
          <div className="w-px h-4 bg-white/10" />

          {/*
            Opacity lives HERE, in the always-mounted TopBar, rather than in
            Settings. It has to be reachable while the interview is running —
            the moment the user actually wants to make Ghostly less in the way —
            and the TopBar is the one surface that is on screen at every moment,
            including while an answer is streaming and while Settings is open.
          */}
          <OpacityControl />

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
