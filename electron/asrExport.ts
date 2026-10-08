import { ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Write an `asrComparisons` export to a JSON file.
 *
 * ── Why the main process does this ──────────────────────────────────────────
 * The renderer has no filesystem access at all. Writing the export from the
 * renderer would mean either an exposed arbitrary-write bridge (a serious hole
 * in a preload surface) or round-tripping the data through the user. Both are
 * worse than one narrow, dev-only, fixed-purpose handler.
 *
 * ── Where it writes ─────────────────────────────────────────────────────────
 * The app's own userData directory, under a fixed filename. Not an arbitrary
 * path from the renderer: the caller cannot choose where this lands, because an
 * export feature that accepts a destination path is a file-write primitive with
 * extra steps.
 *
 * The path is returned to the caller so it can be printed or opened. Nothing is
 * written anywhere else, and no audio is involved — see
 * `src/lib/asrComparisonExport.ts`.
 */

export const ASR_EXPORT_FILENAME = "asr-comparison-export.json";

export interface AsrExportPayload {
  /** The already-serialised export JSON, built in the renderer. */
  json: string;
}

export interface AsrExportResult {
  ok: boolean;
  /** Absolute path written, or null on failure. */
  path?: string;
  bytes?: number;
  message?: string;
}

export function registerAsrExportHandlers(options: {
  /** Injected for tests. Defaults to the Electron app's userData path. */
  resolveDir?: () => string;
}): { getExportPath: () => string } {
  const resolveDir = options.resolveDir ?? (() => os.tmpdir());

  const getExportPath = (): string =>
    path.join(resolveDir(), ASR_EXPORT_FILENAME);

  ipcMain.handle(
    "asr:write-export",
    async (_event, payload: AsrExportPayload): Promise<AsrExportResult> => {
      try {
        if (!payload || typeof payload.json !== "string") {
          return { ok: false, message: "no export payload supplied" };
        }
        // A size ceiling: this is a diagnostic export of a capped 20-row slice,
        // so anything near this limit means the wrong thing was sent.
        if (payload.json.length > 5_000_000) {
          return { ok: false, message: "export payload is implausibly large" };
        }
        // Parse before writing. A file that is not valid JSON would be found
        // later, by whoever tries to benchmark from it.
        JSON.parse(payload.json);

        const target = getExportPath();
        await writeFile(target, payload.json, "utf8");
        return {
          ok: true,
          path: target,
          bytes: Buffer.byteLength(payload.json, "utf8"),
        };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  return { getExportPath };
}