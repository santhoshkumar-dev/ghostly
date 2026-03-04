import React from "react";
import { useStore } from "../store/useStore";
import { ProviderBadge } from "./ProviderBadge";

export const StatusBar: React.FC = () => {
  const { settings, isStreaming, error } = useStore();

  return (
    <div className="flex items-center justify-between px-4 py-2 border-t border-dark-800 bg-dark-950/80">
      <div className="flex items-center gap-3">
        <ProviderBadge
          provider={settings.activeProvider}
          isActive={isStreaming}
        />
        <span className="text-xs text-dark-500 font-mono">
          {settings.activeModel}
        </span>
      </div>

      <div className="flex items-center gap-2">
        {error && (
          <span
            className="text-xs text-red-400 max-w-[200px] truncate"
            title={error}
          >
            ⚠ {error}
          </span>
        )}
        {isStreaming && (
          <div className="flex items-center gap-1.5">
            <div className="flex gap-0.5">
              <span
                className="w-1 h-1 rounded-full bg-ghostly-400 animate-bounce"
                style={{ animationDelay: "0ms" }}
              />
              <span
                className="w-1 h-1 rounded-full bg-ghostly-400 animate-bounce"
                style={{ animationDelay: "150ms" }}
              />
              <span
                className="w-1 h-1 rounded-full bg-ghostly-400 animate-bounce"
                style={{ animationDelay: "300ms" }}
              />
            </div>
          </div>
        )}
        {!isStreaming && !error && (
          <span className="flex items-center gap-1.5 text-xs text-dark-500">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            Ready
          </span>
        )}
      </div>
    </div>
  );
};
