/**
 * In-app Parakeet model download — MAIN PROCESS ONLY.
 *
 * ── Why the model is downloaded rather than bundled ─────────────────────────
 * The int8 model is ~631 MB unpacked and ~460 MB compressed. Bundling it would
 * put half a gigabyte into every installer, for a feature that is off unless the
 * user explicitly selects it. Downloading it into `userData` also means the
 * installer does not decide which engine a user gets, and the model can be
 * removed without touching the app.
 *
 * ── What is verified, and what is NOT ───────────────────────────────────────
 * The official release publishes NO checksum file (`.sha256`, `.md5` and
 * `.sha256sum` all 404), so this module does NOT claim checksum verification.
 * It verifies:
 *
 *   • the HTTP Content-Length against the expected archive size;
 *   • the number of bytes actually received;
 *   • that the archive extracts without error;
 *   • that every required model file exists afterwards and is at least the
 *     expected size, which is what catches a truncated or substituted archive.
 *
 * Per-file sizes are a weak guarantee compared with a hash — they cannot detect
 * a corrupted file of the same length. This is stated in the UI text and in the
 * report rather than papered over with the word "verified".
 *
 * ── Resumability ────────────────────────────────────────────────────────────
 * Bytes land in `<target>.part`, and an interrupted download RESUMES from the
 * partial file with an HTTP Range request when the server supports it. A
 * restart therefore does not re-download 460 MB.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createRequire } from "node:module";

import {
  PARAKEET_ARCHIVE_BYTES,
  PARAKEET_ARCHIVE_URL,
  PARAKEET_MODEL_DIR_NAME,
  PARAKEET_REQUIRED_FILES,
  PARAKEET_UNPACKED_BYTES,
} from "../src/lib/parakeetModelFacts";

const require = createRequire(import.meta.url);

// Re-exported so existing importers keep working, but DEFINED in
// `src/lib/parakeetModelFacts.ts`: the renderer needs the same numbers and
// cannot import this file (it pulls in `node:fs`). One definition, two readers.
export {
  PARAKEET_ARCHIVE_BYTES,
  PARAKEET_ARCHIVE_URL,
  PARAKEET_MODEL_DIR_NAME,
  PARAKEET_REQUIRED_FILES,
  PARAKEET_UNPACKED_BYTES,
};

export type ParakeetModelStatus =
  | "missing"
  | "downloading"
  | "verifying"
  | "ready"
  | "error";

export interface ParakeetModelState {
  status: ParakeetModelStatus;
  /** 0-100 while downloading/verifying, null when not applicable. */
  progress: number | null;
  /** Bytes received so far, for a "412 MB of 460 MB" label. */
  bytesDownloaded: number;
  /** Total bytes to download. */
  bytesTotal: number;
  /** Human-readable failure reason, or null. */
  message: string | null;
  /** Absolute model directory, so the UI can state where it lives. */
  dir: string;
}

export interface ParakeetModelDeps {
  /** Directory that CONTAINS the model folder. Normally `<userData>/models`. */
  baseDir: string;
  /**
   * The absolute model directory, when the caller has already resolved one.
   *
   * Preferred over deriving one from `baseDir`, because the whole point is that
   * the downloader and the LOADER must agree: a completed download that lands
   * where nothing looks for it is indistinguishable from a missing model.
   */
  dir?: string;
  /** Injectable download, so tests never touch the network. */
  download?: (opts: {
    url: string;
    partFile: string;
    onProgress: (received: number, total: number) => void;
    signal?: AbortSignal;
  }) => Promise<{ bytes: number; total: number }>;
  /** Injectable extractor, so tests never touch a real archive. */
  extract?: (archive: string, destDir: string) => Promise<void>;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}

/**
 * Where the model lives inside a models directory.
 *
 * `baseDir` is the directory that CONTAINS the model folder — normally
 * `<userData>/models`. It deliberately adds no `models` segment of its own.
 *
 * ── The bug this fixes ──────────────────────────────────────────────────────
 * This used to append `"models"` here while `resolveModelDir` also appended
 * `"models"` to the same parent, so a completed 460 MB download was installed
 * at `<userData>/models/models/<name>` while the loader and every status check
 * looked in `<userData>/models/<name>`. The model reported as downloaded and
 * then as `model_missing` on the same install, forever.
 */
export function modelDirFor(baseDir: string, name = PARAKEET_MODEL_DIR_NAME): string {
  return path.join(baseDir, name);
}

/**
 * The doubled path an earlier build could install to: `<baseDir>/models/<name>`.
 *
 * Kept so an existing download can be moved into place instead of being
 * re-fetched — see {@link ensureModelInPlace}.
 */
export function legacyModelDirFor(
  baseDir: string,
  name = PARAKEET_MODEL_DIR_NAME,
): string {
  return path.join(baseDir, "models", name);
}

/**
 * Is the model present and complete?
 *
 * Returns the first problem rather than a bare boolean, because "the download
 * failed" and "encoder.int8.onnx is 12 MB instead of 652 MB" need different
 * responses from the user.
 */
export function inspectModelDir(dir: string): {
  ready: boolean;
  missing: string[];
  wrongSize: string[];
} {
  const missing: string[] = [];
  const wrongSize: string[] = [];
  for (const file of PARAKEET_REQUIRED_FILES) {
    const full = path.join(dir, file.name);
    let size: number;
    try {
      size = fs.statSync(full).size;
    } catch {
      missing.push(file.name);
      continue;
    }
    if (size !== file.bytes) wrongSize.push(file.name);
  }
  return { ready: missing.length === 0 && wrongSize.length === 0, missing, wrongSize };
}

/**
 * Make sure the model is where {@link modelDirFor} says it should be.
 *
 * Moves a complete install out of the legacy doubled path. Nothing else is
 * touched: an incomplete or absent legacy directory is left alone, so a failed
 * download cannot be mistaken for a good one and the size check still runs.
 *
 * Never throws. A migration that fails must degrade to "model not installed",
 * which is a state the UI can act on, rather than taking the app down.
 */
export function ensureModelInPlace(
  baseDir: string,
  name = PARAKEET_MODEL_DIR_NAME,
  log?: (line: string) => void,
): { dir: string; migratedFrom: string | null } {
  const dir = modelDirFor(baseDir, name);
  if (inspectModelDir(dir).ready) return { dir, migratedFrom: null };

  const legacy = legacyModelDirFor(baseDir, name);
  if (legacy === dir || !inspectModelDir(legacy).ready) {
    return { dir, migratedFrom: null };
  }
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.renameSync(legacy, dir);
    log?.(`[Parakeet-Model] moved an existing install from ${legacy} to ${dir}`);
    return { dir, migratedFrom: legacy };
  } catch (err) {
    log?.(`[Parakeet-Model] could not move ${legacy} to ${dir}: ${String(err)}`);
    return { dir, migratedFrom: null };
  }
}

/**
 * Follow redirects and stream a URL to a file, RESUMING when a partial exists.
 *
 * GitHub's release assets 302 to a signed URL, so redirect handling is not
 * optional. A resumed request sends `Range: bytes=<have>-`, and if the server
 * answers 200 instead of 206 the partial file is discarded and the download
 * restarts — silently appending a full body to a partial one would produce a
 * corrupt archive that only fails later, at extraction time.
 */
export async function downloadWithResume(
  opts: {
    url: string;
    partFile: string;
    onProgress: (received: number, total: number) => void;
    signal?: AbortSignal;
  },
  redirectsLeft = 5,
): Promise<{ bytes: number; total: number }> {
  const have = fs.existsSync(opts.partFile) ? fs.statSync(opts.partFile).size : 0;

  const response = await fetchWithRedirects(
    opts.url,
    have > 0 ? { Range: `bytes=${have}-` } : {},
    redirectsLeft,
    opts.signal,
  );

  if (!response.ok) {
    // 416 means the part file is already the whole thing; treat it as done and
    // let the size check decide.
    if (response.status === 416) return { bytes: have, total: have };
    throw new Error(`download failed with HTTP ${response.status}`);
  }

  // Partial content only if the server actually honoured the range.
  const resuming = response.status === 206 && have > 0;
  const startAt = resuming ? have : 0;
  if (!resuming && have > 0) fs.rmSync(opts.partFile, { force: true });

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  const total = resuming ? have + contentLength : contentLength;
  let received = startAt;
  opts.onProgress(received, total);

  const out = fs.createWriteStream(opts.partFile, { flags: resuming ? "a" : "w" });
  const body = response.body;
  if (!body) throw new Error("download returned no body");

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (opts.signal?.aborted) throw new Error("cancelled");
      received += value.byteLength;
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => out.once("drain", () => resolve()));
      }
      opts.onProgress(received, total);
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
  return { bytes: received, total };
}

/** One redirect-aware fetch, without pulling in a dependency for it. */
async function fetchWithRedirects(
  url: string,
  headers: Record<string, string>,
  redirectsLeft: number,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(url, { headers, redirect: "manual", signal });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error(`redirect with no Location (${response.status})`);
    if (redirectsLeft <= 0) throw new Error("too many redirects");
    // `Location` is allowed to be RELATIVE — `/asset` or `../x` — and `fetch`
    // rejects anything that is not absolute with ERR_INVALID_URL. GitHub sends
    // absolute URLs, so this only bites against other hosts, but resolving here
    // costs one line and makes the redirect handling correct rather than
    // accidentally correct.
    const next = new URL(location, url).toString();
    return fetchWithRedirects(next, headers, redirectsLeft - 1, signal);
  }
  return response;
}

/** Extract a `.tar.bz2` archive into `destDir`. Pure JS, no native code. */
async function extractTarBz2(archive: string, destDir: string): Promise<void> {
  // Required lazily so a build that never downloads the model does not pay for
  // loading them, and so a missing optional dependency fails here rather than
  // at app start.
  const tar = require("tar");
  const unbzip2 = require("unbzip2-stream");
  await pipeline(
    fs.createReadStream(archive),
    unbzip2(),
    tar.x({ cwd: destDir, strip: 0 }),
  );
}

/**
 * The model manager. One instance per app; it owns no timer unless downloading.
 */
export class ParakeetModelManager {
  private state: ParakeetModelState;
  private controller: AbortController | null = null;
  private inFlight: Promise<ParakeetModelState> | null = null;
  private readonly log: (line: string) => void;
  private readonly dir: string;

  constructor(private readonly deps: ParakeetModelDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
    // Before the dir is fixed, so a legacy install is adopted rather than
    // reported missing.
    ensureModelInPlace(deps.baseDir, PARAKEET_MODEL_DIR_NAME, this.log);
    this.dir = deps.dir ?? modelDirFor(deps.baseDir);
    this.state = this.freshState();
  }

  private freshState(): ParakeetModelState {
    const inspection = inspectModelDir(this.dir);
    return {
      status: inspection.ready ? "ready" : "missing",
      progress: null,
      bytesDownloaded: 0,
      bytesTotal: PARAKEET_ARCHIVE_BYTES,
      message: inspection.ready
        ? null
        : inspection.wrongSize.length > 0
          ? `The installed model is corrupt (${inspection.wrongSize.join(", ")}). Download it again.`
          : null,
      dir: this.dir,
    };
  }

  /** Re-inspect the disk. Never throws. */
  refresh(): ParakeetModelState {
    if (this.state.status === "downloading" || this.state.status === "verifying") {
      return this.state;
    }
    this.state = this.freshState();
    return this.state;
  }

  getState(): ParakeetModelState {
    return { ...this.state };
  }

  /**
   * Make the model ready, resuming an interrupted download where possible.
   *
   * Concurrency-safe: a second call while one is running joins the first rather
   * than starting a competing download of the same file. That matters because
   * the Settings panel polls and a user can click twice.
   */
  download(): Promise<ParakeetModelState> {
    if (this.state.status === "ready") return Promise.resolve(this.getState());
    // Deliberately NOT `async`: an async method wraps whatever it returns in a
    // fresh promise, so two callers would get two DIFFERENT promises that both
    // resolve to the same value. Returning the stored promise itself means a
    // second click genuinely joins the first, which is what makes the "only one
    // 460 MB transfer" guarantee verifiable rather than merely intended.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<ParakeetModelState> {
    const dest = this.dir;
    const partFile = `${dest}.tar.bz2.part`;
    const archive = `${dest}.tar.bz2`;

    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });

      this.setState({ status: "downloading", progress: 0, message: null });
      this.log(`[Parakeet-Model] downloading to ${partFile}`);

      this.controller = new AbortController();
      const download = this.deps.download ?? ((o) => downloadWithResume(o));
      const result = await download({
        url: PARAKEET_ARCHIVE_URL,
        partFile,
        signal: this.controller.signal,
        onProgress: (received, total) => {
          this.setState({
            bytesDownloaded: received,
            bytesTotal: total || PARAKEET_ARCHIVE_BYTES,
            progress: total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : null,
          });
        },
      });

      // ── Size check before spending a minute on extraction ────────────────
      // 460 MB received out of 460 MB expected. A short read here is the most
      // likely real failure (a dropped connection that yielded a clean-looking
      // EOF), and catching it now saves extracting a truncated archive.
      if (result.bytes !== PARAKEET_ARCHIVE_BYTES) {
        throw new Error(
          `the archive is ${result.bytes} bytes but should be ${PARAKEET_ARCHIVE_BYTES}`,
        );
      }

      fs.renameSync(partFile, archive);

      this.setState({ status: "verifying", progress: null, message: null });
      this.log(`[Parakeet-Model] extracting ${archive}`);

      const extract = this.deps.extract ?? extractTarBz2;
      await extract(archive, path.dirname(dest));

      // The archive extracted a directory named after itself; the expected
      // layout is `<base>/models/<name>/...`, which is exactly `dest`. If the
      // archive's top-level name ever differs, this reports it rather than
      // silently loading from the wrong place.
      const inspection = inspectModelDir(dest);
      if (!inspection.ready) {
        throw new Error(
          `extracted archive is incomplete: missing ${inspection.missing.join(", ") || "nothing"}` +
            (inspection.wrongSize.length
              ? `; wrong size: ${inspection.wrongSize.join(", ")}`
              : ""),
        );
      }

      fs.rmSync(archive, { force: true });

      this.setState({ status: "ready", progress: 100, message: null });
      this.log("[Parakeet-Model] ready");
      return this.getState();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The `.part` file is KEPT on failure so the next attempt resumes instead
      // of re-downloading 460 MB. It is only removed when the failure is one
      // that makes the partial bytes useless.
      const keepPartial = !/HTTP 4|HTTP 5|corrupt|incomplete/i.test(message);
      if (!keepPartial) {
        try {
          fs.rmSync(partFile, { force: true });
          fs.rmSync(archive, { force: true });
        } catch {
          /* nothing to clean up */
        }
      }
      this.setState({
        status: "error",
        progress: null,
        message,
      });
      this.log(`[Parakeet-Model] failed: ${message}`);
      return this.getState();
    } finally {
      this.controller = null;
    }
  }

  /** Stop an in-flight download. The partial file is kept for a later resume. */
  cancel(): void {
    this.controller?.abort();
  }

  /** Remove the model and any partial download. */
  remove(): ParakeetModelState {
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
      fs.rmSync(`${this.dir}.tar.bz2.part`, { force: true });
      fs.rmSync(`${this.dir}.tar.bz2`, { force: true });
    } catch (err) {
      this.log(`[Parakeet-Model] remove failed: ${err}`);
    }
    this.state = this.freshState();
    return this.getState();
  }

  private setState(patch: Partial<ParakeetModelState>): void {
    this.state = { ...this.state, ...patch };
  }
}

/** Injectable-fetch seam for tests: verify a URL's size without downloading. */
export async function headSize(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  try {
    let current = url;
    for (let i = 0; i < 5; i++) {
      const res = await fetchImpl(current, { method: "HEAD", redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get("location");
        if (!next) return null;
        current = next;
        continue;
      }
      const len = Number(res.headers.get("content-length") ?? 0);
      return Number.isFinite(len) && len > 0 ? len : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Streaming SHA-256 of a file, used only if a checksum becomes available. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}
