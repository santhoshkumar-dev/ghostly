import React from "react";
import type { ProviderName } from "../lib/ai";

interface ProviderBadgeProps {
  provider: ProviderName;
  isActive?: boolean;
  size?: "sm" | "md";
}

const providerColors: Record<
  ProviderName,
  { bg: string; text: string; glow: string }
> = {
  gemini: {
    bg: "bg-blue-500/15",
    text: "text-blue-400",
    glow: "shadow-blue-500/20",
  },
  openai: {
    bg: "bg-emerald-500/15",
    text: "text-emerald-400",
    glow: "shadow-emerald-500/20",
  },
  anthropic: {
    bg: "bg-orange-500/15",
    text: "text-orange-400",
    glow: "shadow-orange-500/20",
  },
  groq: {
    bg: "bg-purple-500/15",
    text: "text-purple-400",
    glow: "shadow-purple-500/20",
  },
};

const providerLabels: Record<ProviderName, string> = {
  gemini: "Gemini",
  openai: "OpenAI",
  anthropic: "Claude",
  groq: "Groq",
};

const providerIcons: Record<ProviderName, string> = {
  gemini: "✦",
  openai: "◈",
  anthropic: "◉",
  groq: "⚡",
};

export const ProviderBadge: React.FC<ProviderBadgeProps> = ({
  provider,
  isActive = false,
  size = "sm",
}) => {
  const colors = providerColors[provider];
  const sizeClasses =
    size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm";

  return (
    <span
      className={`
        inline-flex items-center gap-1.5 rounded-full font-medium
        ${colors.bg} ${colors.text} ${sizeClasses}
        ${isActive ? `ring-1 ring-current shadow-lg ${colors.glow}` : ""}
        transition-all duration-200
      `}
    >
      <span>{providerIcons[provider]}</span>
      <span>{providerLabels[provider]}</span>
      {isActive && (
        <span className="relative flex h-1.5 w-1.5 ml-0.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-75" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-current" />
        </span>
      )}
    </span>
  );
};
