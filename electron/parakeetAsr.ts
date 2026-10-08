import { ipcMain, utilityProcess } from "electron";
import path from "node:path";
import fs from "node:fs";
import {
  ParakeetHost,
  PARAKEET_SAMPLE_RATE,
  PARAKEET_MAX_SECONDS,
  type ParakeetHostDeps,
  type ParakeetHostResult,
  type ParakeetChildLike,
  type ParakeetHostReply,
  type ParakeetHostRequest,
  type ParakeetHostMode,
  type ParakeetModelStatus,
  type ParakeetLoadBreakdown,
} from "../src/lib/parakeetHost";
import {
  startParakeetDiagnostics,
  type ParakeetDiagnosticsHandle,
} from "./parakeetDiagnostics";
import {
  ParakeetModelManager,
  ensureModelInPlace,
  type ParakeetModelStatus as ParakeetModelFileStatus,
} from "./parakeetModel";

/**
 * Parakeet comparison host — MAIN PROCESS ONLY.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * Parakeet is a DEVELOPMENT COMPARISON ENGINE. It is off by default, it is
 * never the production default, it is never a fallback for Moonshine, and its
 * transcript is written ONLY to the isolated `asrComparisons` slice. It must
 * never reach the question gate, the prompt, or the answer path.
 *
 * This module owns the `utilityProcess` that holds the model. All the decision
 * logic — queueing, timeouts, restarts, validation, idle unload — lives in
 * `src/lib/parakeetHost.ts` and is unit-tested against a fake child. This file
 * is only the Electron adapter.
 *
 * Follows the same shape as `electron/groqAsr.ts`: the renderer gets a boolean
 * and a normalised result, never a handle into the engine.
 */

/**
 * Dev location of the model, relative to the repo root.
 *
 * A packaged app never resolves this: {@link resolveModelDir} prefers the
 * userData copy that the in-app downloader writes, and only falls back here
 * when running from source.
 */
export const PARAKEET_MODEL_DIR_NAME = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";

/** Dev fallback: `models/<name>` next to the repo root. */
export const DEFAULT_PARAKEET_MODEL_DIR = path.join(
  process.cwd(),
  "models",
  PARAKEET_MODEL_DIR_NAME,
);

export interface ParakeetIpcOutcome {
  ok: boolean;
  text?: string;
  decodeMs?: number;
  loadMs?: number;
  /** Per-phase load timings from the child. See `ParakeetLoadBreakdown`. */
  breakdown?: ParakeetLoadBreakdown;
  rssMb?: number;
  rtf?: number;
  code?: string;
  message?: string;
  status?: ParakeetModelStatus;
  /** Whether this call was Parakeet-as-primary or Parakeet-as-comparison. */
  mode?: ParakeetHostMode;
}

export interface ParakeetTranscribePayload {
  samples?: unknown;
  sampleRate?: unknown;
}

/**
 * Adapt an Electron `utilityProcess` to the small interface the host expects.
 *
 * Electron's child uses `post`/`on("message")`/`on("exit")`; the host is
 * written against that shape so its tests can substitute a fake in one line.
 */
function adaptUtilityProcess(child: Electron.UtilityProcess): ParakeetChildLike {
  return {
    post(message: ParakeetHostRequest) {
      child.postMessage(message);
    },
    kill() {
      child.kill();
    },
    onMessage(cb: (reply: ParakeetHostReply) => void) {
      child.on("message", (message: ParakeetHostReply) => cb(message));
    },
    onExit(cb: (code: number | null) => void) {
      child.on("exit", (code: number) => cb(code));
    },
  };
}

/** Create the host with real Electron wiring. Exported so tests can inspect it. */export function createParakeetHost(options: {
  modelDir: string;
  isEnabled: () => boolean;
  isPrimary?: () => boolean;
  paddingMs?: () => number | undefined;
  log?: (line: string) => void;
}): ParakeetHost {
  const modelDir = options.modelDir;
  const workerPath = resolveWorkerPath();

  const deps: ParakeetHostDeps = {
    modelDir,
    isEnabled: options.isEnabled,
    mode: () => (options.isPrimary?.() ? "primary" : "comparison"),
    paddingMs: options.paddingMs,
    log: options.log ?? ((line) => console.log(line)),
    spawnChild: () =>
      adaptUtilityProcess(
        utilityProcess.fork(workerPath, [], {
          stdio: "pipe",
          // The child cannot know when it was forked, so the fork instant is
          // stamped into its environment. This is what makes the `spawn` phase
          // of the load breakdown measurable at all — without it the child can
          // only time itself from its own first line, which is always ~0.
          env: { ...process.env, PARAKEET_SPAWN_ORIGIN_MS: String(Date.now()) },
        }),
      ),
  };
  return new ParakeetHost(deps);
}

/**
 * Locate `parakeetWorker.cjs` in dev and in a packaged app.
 *
 * electron-vite copies the worker next to `index.js` in `out/main`, so
 * `__dirname` is right in development. It is WRONG inside an asar archive in one
 * specific way that matters here: `utilityProcess.fork` executes the script with
 * a real Node runtime, which cannot load a JavaScript file from inside the
 * archive. The unpacked copy lives beside it under `app.asar.unpacked`, so the
 * packaged path is rewritten to that.
 *
 * Both candidates are checked rather than assumed, because guessing wrong here
 * fails as an unhelpful ENOENT inside the fork, long after the useful error
 * message has scrolled away.
 */
export function resolveWorkerPath(
  dir: string = __dirname,
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
): string {
  const local = path.join(dir, "parakeetWorker.cjs");

  // Inside a packaged app, `__dirname` is
  //   <resources>/app.asar/out/main
  // and the unpacked copy of the SAME tree is
  //   <resources>/app.asar.unpacked/out/main
  // so the only thing that changes is the archive directory itself. Rewriting
  // that one segment is exact, whereas walking a fixed number of `..` steps is
  // a guess about the layout that silently produces a path OUTSIDE resources
  // the moment the depth changes.
  const marker = `${path.sep}app.asar${path.sep}`;
  if (dir.includes(marker)) {
    const unpackedDir = dir.replace(
      marker,
      `${path.sep}app.asar.unpacked${path.sep}`,
    );
    const candidate = path.join(unpackedDir, "parakeetWorker.cjs");
    if (exists(candidate)) return candidate;
  }

  return local;
}

/**
 * Where the model actually lives.
 *
 * Preference order is deliberate: an explicit override first (developer), then
 * the userData copy the in-app downloader manages, then the dev `models/`
 * folder. A packaged app has no `models/` directory and must never be pointed
 * at one, so the packaged caller is expected to pass its userData path.
 */
export function resolveModelDir(options: {
  override?: string;
  userDataDir?: string;
  devDir?: string;
}): string {
  if (options.override) return options.override;
  if (options.userDataDir) {
    return path.join(options.userDataDir, "models", PARAKEET_MODEL_DIR_NAME);
  }
  return options.devDir ?? DEFAULT_PARAKEET_MODEL_DIR;
}

let host: ParakeetHost | null = null;

/**
 * The live memory/latency sampler, started on load and stopped on unload.
 *
 * Scoped to the model's lifetime on purpose: a sampler that ran for the whole
 * app session would keep reporting after the model was gone, which is exactly
 * when those numbers stop being interpretable.
 */
let diagnostics: ParakeetDiagnosticsHandle | null = null;

/**
 * The model manager, created lazily against whatever directory this install uses.
 *
 * `baseDir` is the PARENT of the versioned model folder (normally
 * `userData/models`), derived from the resolved model dir so there is exactly
 * one place that decides where models live.
 */
let modelManager: ParakeetModelManager | null = null;

/**
 * Register the dev-only Parakeet IPC surface.
 *
 * Every handler is wrapped so a failure becomes a value. Nothing in here may
 * throw into the main app: a comparison engine that breaks the editor is worse
 * than no comparison at all.
 */
export function registerParakeetHandlers(options: {
  isEnabled: () => boolean;
  isPrimary?: () => boolean;
  modelDir: string;
  paddingMs?: () => number | undefined;
}): { getHost: () => ParakeetHost } {
  // A completed download from an earlier build can sit one directory too deep
  // (see `ensureModelInPlace`). Move it into place BEFORE anything looks for
  // it, otherwise the loader reports `model_missing` against a 652 MB encoder
  // that is really on disk and the only remedy looks like re-downloading it.
  // Runs at most once per registration, and never loads the model.
  let modelPlaced = false;
  const ensureModelPlaced = () => {
    if (modelPlaced) return;
    modelPlaced = true;
    ensureModelInPlace(path.dirname(options.modelDir));
  };

  const getHost = (): ParakeetHost => {
    ensureModelPlaced();
    if (!host) {
      host = createParakeetHost({
        modelDir: options.modelDir,
        isEnabled: options.isEnabled,
        isPrimary: options.isPrimary,
        paddingMs: options.paddingMs,
      });
    }
    return host;
  };
  const mode = (): ParakeetHostMode =>
    options.isPrimary?.() ? "primary" : "comparison";

  const getModelManager = (): ParakeetModelManager => {
    if (!modelManager) {
      modelManager = new ParakeetModelManager({
        // `dir` is passed explicitly so the downloader and the loader are given
        // the SAME resolved string, rather than each deriving one. Deriving them
        // independently is how they came to disagree.
        dir: options.modelDir,
        baseDir: path.dirname(options.modelDir),
      });
    }
    return modelManager;
  };

  // Cheap, safe status probe for the settings UI. Never loads anything.
  ipcMain.handle(
    "parakeet:status",
    (): { status: ParakeetModelStatus; mode?: ParakeetHostMode } => {
      if (!options.isEnabled()) return { status: "disabled" };
      try {
        return { status: getHost().getStatus(), mode: mode() };
      } catch {
        return { status: "error" };
      }
    },
  );

  // Explicit model load, called on Start Interview rather than at launch.
  ipcMain.handle("parakeet:load", async (): Promise<ParakeetIpcOutcome> => {
    try {
      if (!options.isEnabled()) {
        return { ok: false, code: "disabled", message: "Parakeet is not enabled" };
      }
      const result = await getHost().load();
      if (result.ok && !diagnostics) {
        // Sampled every 10 s for the lifetime of the model: system memory
        // (available, plus the delta since the model loaded), the child's own
        // RSS, and the latest decode ms / RTF. Numbers only — never a
        // transcript, never audio.
        diagnostics = startParakeetDiagnostics({ getHost, mode: mode() });
      }
      return { ...result, status: getHost().getStatus(), mode: mode() };
    } catch (err) {
      return {
        ok: false,
        code: "crashed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Release the model, called on Stop Interview.
  ipcMain.handle("parakeet:unload", (): ParakeetIpcOutcome => {
    try {
      // Stop sampling BEFORE releasing the model, so the final line still
      // reflects a loaded model rather than a just-freed one.
      diagnostics?.stop();
      diagnostics = null;
      host?.unload();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        code: "crashed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Transcription. The same handler serves both roles: as a comparison column it
  // feeds the dev diagnostics table, and as the primary engine it feeds the
  // normal transcript pipeline. What the result is USED for is decided in the
  // renderer; this side only decodes.
  ipcMain.handle(
    "parakeet:transcribe",
    async (_event, payload: ParakeetTranscribePayload): Promise<ParakeetIpcOutcome> => {
      try {
        if (!options.isEnabled()) {
          return { ok: false, code: "disabled", message: "Parakeet is not enabled" };
        }
        // The host validates the samples (Float32Array, 16 kHz, length cap);
        // this pre-check exists so an obviously wrong payload never even reaches
        // the queue.
        if (!(payload?.samples instanceof Float32Array)) {
          return {
            ok: false,
            code: "invalid_audio",
            message: "samples must be a Float32Array",
          };
        }
        if (payload.sampleRate !== PARAKEET_SAMPLE_RATE) {
          return {
            ok: false,
            code: "invalid_audio",
            message: `sampleRate must be ${PARAKEET_SAMPLE_RATE}`,
          };
        }
        const seconds = payload.samples.length / PARAKEET_SAMPLE_RATE;
        if (seconds > PARAKEET_MAX_SECONDS) {
          return {
            ok: false,
            code: "too_long",
            message: `${seconds.toFixed(1)}s exceeds the ${PARAKEET_MAX_SECONDS}s cap`,
          };
        }
        const result: ParakeetHostResult = await getHost().transcribe(
          payload.samples,
          payload.sampleRate,
        );
        return result;
      } catch (err) {
        return {
          ok: false,
          code: "crashed",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // ── Model management (Settings) ─────────────────────────────────────────
  //
  // The download runs in the MAIN process for two reasons: the renderer has no
  // filesystem access and no way to stream 460 MB to disk, and the bytes must
  // not pass through the renderer's memory at all.
  //
  // `parakeet:modelStatus` is safe to poll — it stats four files and returns a
  // small object. `parakeet:modelDownload` is idempotent while a download is
  // running: a second click joins the in-flight one instead of starting a
  // competing 460 MB transfer.
  ipcMain.handle("parakeet:modelStatus", () => {
    try {
      return getModelManager().refresh();
    } catch (err) {
      return {
        status: "error" as ParakeetModelFileStatus,
        progress: null,
        bytesDownloaded: 0,
        bytesTotal: 0,
        message: err instanceof Error ? err.message : String(err),
        dir: options.modelDir,
      };
    }
  });

  ipcMain.handle("parakeet:modelDownload", async () => {
    try {
      return await getModelManager().download();
    } catch (err) {
      // `download()` already converts failures into state, so reaching here
      // means something outside it broke. Still return a value, never throw.
      return {
        status: "error" as ParakeetModelFileStatus,
        progress: null,
        bytesDownloaded: 0,
        bytesTotal: 0,
        message: err instanceof Error ? err.message : String(err),
        dir: options.modelDir,
      };
    }
  });

  ipcMain.handle("parakeet:modelCancel", () => {
    try {
      getModelManager().cancel();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle("parakeet:modelRemove", () => {
    try {
      // Releasing the model first is not optional: deleting the files under a
      // loaded recognizer would leave a live process holding handles to
      // unlinked files, and the next decode would fail in a way that looks
      // unrelated to the removal.
      diagnostics?.stop();
      diagnostics = null;
      host?.unload();
      return getModelManager().remove();
    } catch (err) {
      return {
        status: "error" as ParakeetModelFileStatus,
        progress: null,
        bytesDownloaded: 0,
        bytesTotal: 0,
        message: err instanceof Error ? err.message : String(err),
        dir: options.modelDir,
      };
    }
  });

  // Dev diagnostics for the log / settings panel. Counts and timings only —
  // never audio, never model contents.
  ipcMain.handle("parakeet:diagnostics", () => {
    try {
      if (!options.isEnabled()) {
        return { status: "disabled" as ParakeetModelStatus };
      }
      // The mode is recomputed per call, not captured at load: the user can flip
      // the primary engine in Settings while the model is loaded, and a stale
      // label on a memory figure is exactly the false claim this avoids.
      return { ...getHost().getDiagnostics(), mode: mode() };
    } catch {
      return { status: "error" as ParakeetModelStatus };
    }
  });

  return { getHost };
}

/** Test seam: drop the host without leaving a utility process running. */
export function __resetParakeetHostForTests(): void {
  try {
    diagnostics?.stop();
  } catch {
    /* already gone */
  }
  diagnostics = null;
  try {
    host?.dispose();
  } catch {
    /* already gone */
  }
  host = null;
}