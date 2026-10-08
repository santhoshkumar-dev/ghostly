import type { AsrComparison } from "../store/useStore";

/**
 * Export live `asrComparisons` records for offline benchmarking.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Moonshine is a Web Worker running `@huggingface/transformers`. It cannot run
 * in the Node benchmark harness, so its accuracy and latency can ONLY come from
 * a real session in the app. This module is that bridge: it exports what the
 * live comparison actually measured, so the benchmark can score Moonshine
 * against Parakeet on the same clips.
 *
 * Explicitly NOT a Node Moonshine adapter. Nothing here re-implements Moonshine
 * or guesses at its output; it only copies numbers and engine text that the
 * running app produced.
 *
 * ── What is deliberately excluded ───────────────────────────────────────────
 * No audio, no `audioUrl`, no blob reference. Those are object URLs that die
 * with the session and cannot be written to a file anyway. The export is text
 * and numbers only, so it is safe to commit, attach to an issue, or paste
 * somewhere else.
 */

/** One exported comparison row. */
export interface ExportedComparison {
  /**
   * The comparison row's id, which is `${phraseId}-${timestamp}`.
   *
   * This is the join key back to a saved clip. See {@link parsePhraseId}.
   */
  id: string;
  /** Numeric phrase id, parsed from {@link id}. */
  phraseId: number;
  /** Segment duration in seconds. Identical for every engine by construction. */
  audioSeconds: number;
  moonshineText: string;
  moonshineMs: number | null;
  parakeetText: string;
  parakeetMs: number | null;
  parakeetStatus: string;
  groqText: string;
  groqCorrectedText: string;
  groqMs: number | null;
  /** ISO timestamp of the row. Ordering aid only; not a join key. */
  timestamp: string;
}

export interface AsrExportFile {
  /** Schema marker, so a later reader can tell what produced the file. */
  kind: "ghostly-asr-comparison-export";
  version: 1;
  exportedAt: string;
  /**
   * Engines present in this session. Recorded so a reader never has to infer
   * that a missing column means "off" rather than "failed".
   */
  engines: string[];
  count: number;
  rows: ExportedComparison[];
}

/** Pull the numeric phraseId out of a `${phraseId}-${timestamp}` id. */
export function parsePhraseId(id: string): number | null {
  const match = /^(\d+)-\d+$/.exec(id);
  return match ? Number(match[1]) : null;
}

/**
 * Build the export payload from live comparison rows.
 *
 * Rows whose id cannot yield a phraseId are kept but flagged, rather than
 * dropped: silently discarding a row would make the export look cleaner than
 * the session actually was, and a missing row is exactly what makes a
 * benchmark quietly wrong.
 */
export function buildAsrComparisonExport(
  rows: AsrComparison[],
  now: Date = new Date(),
): AsrExportFile {
  const exported = rows.map((row) => {
    const phraseId = parsePhraseId(row.id);
    return {
      id: row.id,
      // `-1` rather than null: the column stays numeric so it can be sorted and
      // matched, and an unparseable id is visible instead of silently absent.
      phraseId: phraseId ?? -1,
      audioSeconds: Number.isFinite(row.audioSeconds) ? row.audioSeconds : 0,
      moonshineText: row.moonshineText ?? "",
      moonshineMs: row.moonshineMs ?? null,
      parakeetText: row.parakeetText ?? "",
      parakeetMs: row.parakeetMs ?? null,
      parakeetStatus: row.parakeetStatus ?? "",
      groqText: row.groqText ?? "",
      groqCorrectedText: row.groqCorrectedText ?? "",
      groqMs: row.groqTelemetry?.totalMs ?? null,
      timestamp: new Date(row.timestamp).toISOString(),
    };
  });

  // Newest first, matching the on-screen order, so "top of the export" and
  // "top of the list" are the same segment for a human checking their work.
  exported.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const engines: string[] = ["moonshine"];
  if (exported.some((r) => r.parakeetText || r.parakeetStatus)) engines.push("parakeet");
  if (exported.some((r) => r.groqText)) engines.push("groq");

  return {
    kind: "ghostly-asr-comparison-export",
    version: 1,
    exportedAt: now.toISOString(),
    engines,
    count: exported.length,
    rows: exported,
  };
}

/**
 * Render the export as pretty JSON.
 *
 * Pretty rather than minified on purpose: this file is meant to be opened and
 * read when matching clips to rows, and a single unreadable line would make
 * that harder rather than easier.
 */
export function serializeAsrComparisonExport(
  rows: AsrComparison[],
  now?: Date,
): string {
  return `${JSON.stringify(buildAsrComparisonExport(rows, now), null, 2)}\n`;
}

/**
 * Match exported rows to saved clips, and report every ambiguity instead of
 * guessing.
 *
 * Two candidate keys, in order of confidence:
 *
 *  1. **phraseId**, when the clip's filename carries the `phraseId` (e.g.
 *     `real-01-12.wav` for phraseId 12). Exact and unambiguous.
 *  2. **audioSeconds**, within a tolerance. Weaker: two segments can round to
 *     the same duration, so a duration match that fits more than one row is
 *     reported as ambiguous instead of being picked.
 *
 * Returning the ambiguous cases is the point. A benchmark that silently
 * attaches a transcript to the wrong clip produces a plausible, completely
 * wrong WER — the exact failure this whole evaluation is meant to avoid.
 */
export interface ClipMatch {
  clipFile: string;
  /** Row the clip was matched to, or null when unmatched/ambiguous. */
  row: ExportedComparison | null;
  status: "phraseId" | "audioSeconds" | "ambiguous" | "unmatched";
  /** When ambiguous, the candidate rows a human must choose between. */
  candidates?: ExportedComparison[];
  detail: string;
}

/** Default duration tolerance, in seconds. */
export const CLIP_MATCH_TOLERANCE_SECONDS = 0.35;

export function matchClipsToRows(
  clips: Array<{ file: string; audioSeconds: number | null }>,
  rows: ExportedComparison[],
  tolerance: number = CLIP_MATCH_TOLERANCE_SECONDS,
): ClipMatch[] {
  return clips.map((clip) => {
    // 1. Explicit phraseId in the filename: `-<digits>.wav` after a known prefix.
    const byId = /phrase[-_]?(\d+)/i.exec(clip.file) ?? /(?:^|[-_])(\d+)\.wav$/i.exec(clip.file);
    if (byId) {
      const wanted = Number(byId[1]);
      const hit = rows.find((r) => r.phraseId === wanted);
      if (hit) {
        return {
          clipFile: clip.file,
          row: hit,
          status: "phraseId" as const,
          detail: `matched on phraseId=${wanted}`,
        };
      }
    }

    if (clip.audioSeconds === null) {
      return {
        clipFile: clip.file,
        row: null,
        status: "unmatched" as const,
        detail: "clip duration unknown, so it cannot be matched by duration",
      };
    }

    // 2. Duration within tolerance.
    // The `null` check above does not narrow the closure, so re-assert it here.
    const clipSeconds = clip.audioSeconds;
    const near = rows.filter(
      (r) =>
        clipSeconds !== null &&
        Math.abs(r.audioSeconds - clipSeconds) <= tolerance,
    );
    if (near.length === 1) {
      return {
        clipFile: clip.file,
        row: near[0],
        status: "audioSeconds" as const,
        detail: `matched on audioSeconds ${(clipSeconds as number).toFixed(2)} (phraseId=${near[0].phraseId})`,
      };
    }
    if (near.length > 1) {
      return {
        clipFile: clip.file,
        row: null,
        status: "ambiguous" as const,
        candidates: near,
        detail:
          `audioSeconds ${(clipSeconds as number).toFixed(2)} matches ${near.length} rows ` +
          `(phraseIds ${near.map((r) => r.phraseId).join(", ")}) — needs a human decision`,
      };
    }

    return {
      clipFile: clip.file,
      row: null,
      status: "unmatched" as const,
      detail: `no row within ${tolerance}s of ${(clipSeconds as number).toFixed(2)}s`,
    };
  });
}