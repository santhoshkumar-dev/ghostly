/**
 * Naming and manifest helpers for the dev-only "Save all debug clips" button.
 *
 * ── Why the filename carries the phraseId ───────────────────────────────────
 * Every clip must be joinable to the transcript the live session measured for
 * it. Duration is not a safe key: two segments can round to the same length,
 * and a mis-paired clip yields a confident, meaningless WER. The phraseId is
 * exact and unique per captured phrase, so it is the filename's identity.
 *
 * The format is `<phraseId>_<audioSeconds>s.wav` — human-readable when sorting
 * a folder, and parseable by the importer without guessing.
 *
 * Pure functions only: no filesystem, no Electron. The actual writing happens
 * in the main process, so all of this is directly unit-testable.
 */

/** One captured debug clip held in memory for the session. */
export interface DebugClip {
  /** Human label shown in the panel, e.g. "system - 4.2s". */
  name: string;
  /** Object URL for the in-panel player. Dies with the session. */
  url: string;
  /** The encoded 16 kHz mono 16-bit WAV. Undefined if bytes were not kept. */
  blob?: Blob;
  /** The phrase this clip belongs to. The join key. */
  phraseId?: number;
  /** Segment duration in seconds, as measured by the VAD. */
  audioSeconds?: number;
}

/**
 * Filename for one clip: `<phraseId>_<audioSeconds>s.wav`.
 *
 * `audioSeconds` is fixed to two decimals so the name is stable and so a
 * reverse parse recovers the same value. A clip with no phraseId cannot be
 * joined to anything, so it is refused rather than named — a file that cannot
 * be matched is worse than no file, because it looks like data.
 */
export function debugClipFileName(
  phraseId: number,
  audioSeconds: number,
): string {
  if (!Number.isFinite(phraseId) || phraseId < 0) {
    throw new Error(`cannot name a clip for phraseId=${String(phraseId)}`);
  }
  if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) {
    throw new Error(
      `cannot name a clip for audioSeconds=${String(audioSeconds)}`,
    );
  }
  return `${phraseId}_${audioSeconds.toFixed(2)}s.wav`;
}

/**
 * Recover the phraseId from a clip filename produced by
 * {@link debugClipFileName}.
 *
 * Returns null for anything it cannot parse, so an unrelated WAV dropped into
 * the folder is skipped rather than mis-numbered.
 */
export function parseClipPhraseId(fileName: string): number | null {
  const match = /^(\d+)_[\d.]+s\.wav$/i.exec(fileName.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Session folder name: a sortable timestamp, e.g. `2026-10-03T21-38-12`.
 *
 * Colons are illegal in Windows filenames, so they are replaced. Sorting by
 * name therefore orders sessions chronologically.
 */
export function sessionFolderName(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  );
}

/** Fixed name of the comparison JSON written beside the clips. */
export const DEBUG_CLIP_EXPORT_FILENAME = "comparison-export.json";

/** Folder, relative to the project root, where saved sessions land. */
export const DEBUG_CLIP_ROOT_DIR = "debug-audio";

/** Format the folder the user will actually see, for the button label. */
export function describeSessionFolder(now: Date = new Date()): string {
  return `${DEBUG_CLIP_ROOT_DIR}/${sessionFolderName(now)}/`;
}