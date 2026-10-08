/**
 * Interview shortcut registry, conflict detection and keyboard guards.
 *
 * Pure and Electron-free so it can be unit-tested by the `scripts/verify-*`
 * harnesses and reasoned about without the main process. The actual global
 * registration lives in `electron/hotkeys.ts`; this module owns the *policy*
 * (what the shortcuts are, whether two of them collide, and when a keyboard
 * event is allowed to trigger one).
 *
 * ── Why a registry rather than scattered constants ──────────────────────────
 * The app has several mutually-exclusive global actions (Start/Stop Interview,
 * Next Question, Ask AI, Screenshot, Hide, Start Over). Two of them silently
 * sharing a key is a real bug — one action would shadow the other with no
 * visible error. `findShortcutConflicts()` makes that impossible to miss.
 */

export type ShortcutActionId =
  | "toggle-interview"
  | "next-question"
  | "ask-ai"
  | "screenshot"
  | "hide"
  | "start-over";

export interface ShortcutDefinition {
  id: ShortcutActionId;
  /** Human label shown in Settings. */
  label: string;
  /** Electron accelerator used by the main process. */
  accelerator: string;
  /** Key caps shown in the UI. */
  keys: string[];
}

/**
 * The single source of truth for the app's global interview shortcuts.
 *
 * `Ctrl+I` and `Ctrl+N` are deliberately NEW keys: they collide with none of
 * the existing global accelerators (Ctrl+Enter / Ctrl+H / Ctrl+B / Ctrl+G /
 * Ctrl+Shift+1-6 / Ctrl+arrows), and neither is used for text entry in the
 * overlay. `Ctrl+Enter` keeps meaning Ask AI.
 */
export const INTERVIEW_SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    id: "toggle-interview",
    label: "Start / Stop Interview",
    accelerator: "CommandOrControl+I",
    keys: ["Ctrl", "I"],
  },
  {
    id: "next-question",
    label: "Next Question",
    accelerator: "CommandOrControl+N",
    keys: ["Ctrl", "N"],
  },
  {
    id: "ask-ai",
    label: "Ask AI",
    accelerator: "CommandOrControl+Return",
    keys: ["Ctrl", "↵"],
  },
  {
    id: "screenshot",
    label: "Screenshot",
    accelerator: "CommandOrControl+H",
    keys: ["Ctrl", "H"],
  },
  {
    id: "hide",
    label: "Show / Hide",
    accelerator: "CommandOrControl+B",
    keys: ["Ctrl", "B"],
  },
  {
    id: "start-over",
    label: "Start Over",
    accelerator: "CommandOrControl+G",
    keys: ["Ctrl", "G"],
  },
];

export interface ShortcutConflict {
  accelerator: string;
  ids: ShortcutActionId[];
}

/** Canonical form for comparing accelerators (case/space insensitive). */
export function normalizeAccelerator(accelerator: string): string {
  return accelerator.toLowerCase().replace(/\s+/g, "");
}

/**
 * Return every accelerator used by more than one action. Empty means "safe".
 * Never silently overwrites anything — callers surface the result.
 */
export function findShortcutConflicts(
  definitions: readonly ShortcutDefinition[] = INTERVIEW_SHORTCUTS,
): ShortcutConflict[] {
  const byAccelerator = new Map<string, ShortcutActionId[]>();
  for (const def of definitions) {
    const key = normalizeAccelerator(def.accelerator);
    const ids = byAccelerator.get(key) ?? [];
    ids.push(def.id);
    byAccelerator.set(key, ids);
  }
  return [...byAccelerator.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([accelerator, ids]) => ({ accelerator, ids }));
}

/**
 * True when the event target is a place where the user is typing. A shortcut
 * must not fire there. Accepts a plain object shape so tests can pass a fake.
 */
export function isEditableTarget(
  target: { tagName?: string; isContentEditable?: boolean } | null | undefined,
): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable === true;
}

/**
 * Per-action guard that rejects key auto-repeat, editable targets, and rapid
 * double-fires of the SAME action. Deterministic (caller supplies the clock),
 * so it is fully testable.
 */
export function createShortcutGuard(cooldownMs = 400) {
  const lastFiredAt = new Map<string, number>();
  return {
    shouldHandle(
      action: ShortcutActionId | string,
      opts: {
        /** `KeyboardEvent.repeat` — true for held-key auto-repeat. */
        repeat?: boolean;
        /** `event.target`. */
        target?: { tagName?: string; isContentEditable?: boolean } | null;
        /** Injectable clock for tests. */
        now?: number;
      } = {},
    ): boolean {
      if (opts.repeat) return false;
      if (isEditableTarget(opts.target)) return false;
      const now = opts.now ?? Date.now();
      const previous = lastFiredAt.get(action);
      if (previous !== undefined && now - previous < cooldownMs) return false;
      lastFiredAt.set(action, now);
      return true;
    },
    reset(): void {
      lastFiredAt.clear();
    },
  };
}
