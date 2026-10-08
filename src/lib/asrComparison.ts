/**
 * Comparison-engine gating for interview ASR.
 *
 * ── The rule ─────────────────────────────────────────────────────────────
 * Normal production/interview mode is the PRIMARY engine only (Parakeet).
 * Deepgram, Groq Whisper and the extra Parakeet/Moonshine comparison columns
 * are diagnostics: they must not receive audio, make network requests or
 * allocate processing resources unless the user explicitly enables
 * comparison/debug mode.
 *
 * Every comparison call site reads through {@link isAsrComparisonEnabled},
 * so "off by default" is one predicate rather than four flags re-checked in
 * four places that can drift. Explicit opt-in still works at any time: the
 * callers read the CURRENT settings on every phrase, so flipping a toggle
 * mid-session takes effect on the next phrase without a restart.
 *
 * Nothing here touches the primary path, the fallback, correction, the gate
 * or the answer pipeline.
 */

/** The settings flags that opt into comparison engines. Structural so no store import is needed. */
export interface AsrComparisonFlags {
  asrCompareMode?: boolean;
  asrCompareGroq?: boolean;
  asrCompareParakeet?: boolean;
  asrCompareMoonshine?: boolean;
}

/** Short names of the comparison engines explicitly enabled in settings. Names only — never audio, keys or transcripts. */
export function enabledComparisonEngines(
  settings: AsrComparisonFlags | undefined | null,
): string[] {
  if (!settings) return [];
  const out: string[] = [];
  if (settings.asrCompareMode === true) out.push("deepgram");
  if (settings.asrCompareGroq === true) out.push("groq");
  if (settings.asrCompareParakeet === true) out.push("parakeet");
  if (settings.asrCompareMoonshine === true) out.push("moonshine");
  return out;
}

/**
 * Whether any comparison engine may run right now.
 *
 * Explicit opt-in AND a dev build: the comparison toggles live behind the dev
 * gate everywhere they are consumed, so a shipped app never spends CPU, RAM
 * or network on a diagnostic even if a stale settings blob has a flag set.
 */
export function isAsrComparisonEnabled(
  settings: AsrComparisonFlags | undefined | null,
  isDev: boolean = import.meta.env.DEV,
): boolean {
  return isDev && enabledComparisonEngines(settings).length > 0;
}
