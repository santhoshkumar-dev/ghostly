import React, { useEffect, useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useStore, type Solution } from "../store/useStore";
import { ProviderBadge } from "../components/ProviderBadge";

export const History: React.FC = () => {
  const { history, setHistory, removeFromHistory, clearHistory } = useStore();
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Load history from persistent storage
  useEffect(() => {
    window.ghostlyAPI.getHistory().then((stored) => {
      if (stored && stored.length > 0) {
        setHistory(stored);
      }
    });
  }, [setHistory]);

  // Filter history by search
  const filteredHistory = useMemo(() => {
    if (!searchQuery.trim()) return history;
    const q = searchQuery.toLowerCase();
    return history.filter(
      (s) =>
        s.solution.toLowerCase().includes(q) ||
        s.interviewType.toLowerCase().includes(q) ||
        s.language.toLowerCase().includes(q) ||
        s.provider.toLowerCase().includes(q),
    );
  }, [history, searchQuery]);

  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      /* clipboard may be denied */
    }
  };

  const handleDelete = async (id: string) => {
    removeFromHistory(id);
    const updated = history.filter((s) => s.id !== id);
    await window.ghostlyAPI.saveHistory(updated);
  };

  const handleClearAll = async () => {
    clearHistory();
    await window.ghostlyAPI.saveHistory([]);
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const interviewTypeLabels: Record<string, string> = {
    dsa: "🧮 DSA",
    system_design: "🏗️ System Design",
    frontend: "🎨 Frontend",
    sql: "🗄️ SQL",
    behavioral: "🗣️ Behavioral",
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-dark-100">History</h1>
            <p className="text-xs text-dark-500 mt-1">
              {history.length} session{history.length !== 1 ? "s" : ""}
            </p>
          </div>
          {history.length > 0 && (
            <button
              onClick={handleClearAll}
              className="btn-ghost text-xs text-red-400 hover:text-red-300"
            >
              Clear All
            </button>
          )}
        </div>

        {/* Search */}
        {history.length > 0 && (
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-dark-500 text-sm">
              🔍
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search sessions..."
              className="input-field pl-9"
            />
          </div>
        )}
      </div>

      {/* History List */}
      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
        {filteredHistory.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <span className="text-4xl mb-4">📋</span>
            <p className="text-sm text-dark-400">
              {searchQuery ? "No matching sessions" : "No sessions yet"}
            </p>
            <p className="text-xs text-dark-600 mt-1">
              {searchQuery
                ? "Try a different search term"
                : "Capture a screen region to get started"}
            </p>
          </div>
        )}

        <AnimatePresence>
          {filteredHistory.map((session, index) => (
            <motion.div
              key={session.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -100 }}
              transition={{ delay: index * 0.05 }}
              className="card group cursor-pointer"
              onClick={() =>
                setExpandedId(expandedId === session.id ? null : session.id)
              }
            >
              {/* Card Header */}
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs">
                      {interviewTypeLabels[session.interviewType] ||
                        session.interviewType}
                    </span>
                    <span className="text-xs text-dark-600">·</span>
                    <span className="text-xs text-dark-400">
                      {session.language}
                    </span>
                  </div>
                  <p className="text-xs text-dark-500 truncate">
                    {session.solution
                      .slice(0, 100)
                      .replace(/[#*`]/g, "")
                      .trim()}
                    ...
                  </p>
                </div>
                <div className="flex items-center gap-2 ml-2 shrink-0">
                  <ProviderBadge provider={session.provider} size="sm" />
                </div>
              </div>

              {/* Metadata */}
              <div className="flex items-center justify-between mt-2 pt-2 border-t border-dark-800">
                <span className="text-[10px] text-dark-600">
                  {formatDate(session.timestamp)}
                </span>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      copyToClipboard(session.solution, session.id);
                    }}
                    className="px-2 py-0.5 rounded text-[10px] text-dark-400 hover:text-ghostly-400 hover:bg-dark-800 transition-colors no-drag"
                  >
                    {copiedId === session.id ? "✓" : "📋"}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(session.id);
                    }}
                    className="px-2 py-0.5 rounded text-[10px] text-dark-400 hover:text-red-400 hover:bg-dark-800 transition-colors no-drag"
                  >
                    🗑️
                  </button>
                </div>
              </div>

              {/* Expanded Solution */}
              {expandedId === session.id && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  className="mt-3 pt-3 border-t border-dark-800"
                >
                  {/* Screenshot */}
                  {session.screenshotBase64 && (
                    <img
                      src={session.screenshotBase64}
                      alt="Screenshot"
                      className="w-full max-h-[150px] object-contain rounded-lg bg-dark-950 mb-3"
                    />
                  )}
                  {/* Solution preview */}
                  <pre className="text-xs text-dark-300 whitespace-pre-wrap font-mono max-h-[300px] overflow-y-auto">
                    {session.solution}
                  </pre>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      copyToClipboard(session.solution, `full-${session.id}`);
                    }}
                    className="btn-primary text-xs w-full mt-3 py-2"
                  >
                    {copiedId === `full-${session.id}`
                      ? "✓ Copied"
                      : "📋 Copy Full Solution"}
                  </button>
                </motion.div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
};
