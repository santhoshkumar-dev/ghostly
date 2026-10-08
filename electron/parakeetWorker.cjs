/**
 * Parakeet utility-process child — holds the model, nothing else.
 *
 * ── Why a separate process ─────────────────────────────────────────────────
 * The sherpa-onnx addon is a native module. It cannot be loaded in the renderer
 * (a Web Worker, where native addons are unavailable), and loading several
 * hundred megabytes of model into the main process would put a 6-second stall
 * and a large heap spike on the process that owns the UI and the window.
 * A `utilityProcess` gives it its own heap, its own lifecycle, and a clean
 * restart path, and it keeps the renderer and main process free of it.
 *
 * Plain CommonJS on purpose: this file is forked directly by Electron and is
 * NOT part of the electron-vite build, so it must not need bundling.
 *
 * Protocol (see `src/lib/parakeetHost.ts` for the typed contract):
 *   in : { id, type: "load" | "unload" | "transcribe", ... }
 *   out: { id, ok, type, text?, loadMs?, decodeMs?, rssMb?, code?, message? }
 *
 * Every failure is reported as a reply, never as a thrown exception, so a
 * broken model can never take this process — or Ghostly — down.
 */

"use strict";

/**
 * ── Load breakdown ──────────────────────────────────────────────────────────
 *
 * The child is the only place the load cost is actually paid, so the four phases
 * are timed here and reported individually. A single total cannot distinguish
 * "the model is big" from "process start is slow", and those have completely
 * different fixes.
 *
 *   spawnMs     — process fork → first line of this file executing. Includes
 *                 Electron's utilityProcess bootstrap and module resolution.
 *   requireMs   — `require("sherpa-onnx-node")`: loading the native addon
 *                 (koffi binding + ONNX Runtime DLL) off disk.
 *   readMs      — stat + first touch of the four model files. Includes reading
 *                 the ~460 MB encoder into memory on Windows' default cache.
 *   constructMs — `new OfflineRecognizer(...)`: ONNX session creation and
 *                 weight initialisation.
 *
 * `spawnMs` is measured against `process.uptime()`-independent origin: the
 * parent stamps the fork time into the environment, because the child cannot
 * know when it was spawned and a `performance.now()` origin inside the child
 * would measure only the time since its own first line.
 */
const SPAWN_ORIGIN_MS = Number(process.env.PARAKEET_SPAWN_ORIGIN_MS || 0);

function spawnMs() {
  if (!SPAWN_ORIGIN_MS) return null;
  // `Date.now()` in both processes: same machine, same clock, no skew to
  // correct for and no IPC round trip in the measurement.
  return Date.now() - SPAWN_ORIGIN_MS;
}

/**
 * Sampled ONCE, at module evaluation — which is the earliest instruction this
 * process can run.
 *
 * Calling `spawnMs()` later would measure fork → *that moment*, not fork →
 * start-up. Because the reply is sent after the whole load has finished, a
 * lazily-taken sample reported `spawn = 7679 ms`, which is the entire load time
 * wearing the wrong label. It is a constant for the life of the process.
 */
const SPAWN_MS = spawnMs();

/** Timings for one load, in ms. `null` means the phase was not reached. */
function emptyBreakdown() {
  return { spawn: null, require: null, read: null, construct: null };
}

const REQUIRED_FILES = [
  "encoder.int8.onnx",
  "decoder.int8.onnx",
  "joiner.int8.onnx",
  "tokens.txt",
];

/** Model is loaded on first use only. Nothing happens at spawn time. */
let recognizer = null;
let sherpa = null;
let loadedModelDir = null;

/** Replies on the parent channel. Named per the utilityProcess contract. */
function reply(message) {
  if (process.parentPort) {
    process.parentPort.postMessage(message);
  }
}

function rssMb() {
  return Math.round((process.memoryUsage().rss / 1048576) * 10) / 10;
}

function fail(id, code, message) {
  reply({ id, ok: false, code, message });
}

function isModelComplete(dir) {
  const fs = require("node:fs");
  const path = require("node:path");
  try {
    return REQUIRED_FILES.every((f) => fs.existsSync(path.join(dir, f)));
  } catch {
    return false;
  }
}

/**
 * Warm the model files into the OS page cache, and report how long that took.
 *
 * Split out from construction on purpose. On Windows the first read of a large
 * file goes through a filter driver and can dominate the load; measuring it
 * separately is what tells you whether a slow load is I/O or computation.
 *
 * The bytes are deliberately discarded — only the cache warmth is wanted, and
 * holding 460 MB in JS on top of the model's own copy would double the peak.
 */
function warmModelFiles(dir) {
  const fs = require("node:fs");
  const path = require("node:path");
  const sizes = {};
  let totalBytes = 0;
  for (const file of REQUIRED_FILES) {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    sizes[file] = stat.size;
    totalBytes += stat.size;
    // Open and read in 4 MB slices, then close. Reading is what pulls the file
    // into the cache; the content is thrown away immediately.
    const fd = fs.openSync(full, "r");
    try {
      const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
      let position = 0;
      for (;;) {
        const bytes = fs.readSync(fd, buf, 0, buf.length, position);
        if (bytes <= 0) break;
        position += bytes;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return { sizes, totalBytes };
}

function ensureModel(modelDir, breakdown) {
  if (recognizer) return true;

  const numThreads = Number(process.env.PARAKEET_NUM_THREADS || 4);

  breakdown.read = -Date.now();
  if (!isModelComplete(modelDir)) {
    throw Object.assign(new Error(`model not found at ${modelDir}`), {
      code: "model_missing",
    });
  }
  const fileInfo = warmModelFiles(modelDir);
  breakdown.read += Date.now();

  const path = require("node:path");

  breakdown.require = -Date.now();
  sherpa = require("sherpa-onnx-node");
  breakdown.require += Date.now();

  breakdown.construct = -Date.now();
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { samplingRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(modelDir, "encoder.int8.onnx"),
        decoder: path.join(modelDir, "decoder.int8.onnx"),
        joiner: path.join(modelDir, "joiner.int8.onnx"),
      },
      tokens: path.join(modelDir, "tokens.txt"),
      numThreads,
      // CPU only, int8 only. Deliberately no GPU/CUDA path in this phase.
      provider: "cpu",
      debug: false,
    },
  });
  breakdown.construct += Date.now();

  loadedModelDir = modelDir;
  return fileInfo;
}

function handleLoad(msg) {
  const started = Date.now();
  const breakdown = emptyBreakdown();
  try {
    const fileInfo = ensureModel(msg.modelDir, breakdown);
    const loadMs = Date.now() - started;
    reply({
      id: msg.id,
      ok: true,
      type: "loaded",
      loadMs,
      rssMb: rssMb(),
      breakdown: {
        ...breakdown,
        spawn: SPAWN_MS,
        total: loadMs,
        // `endToEnd` includes the spawn phase the breakdown ticks cannot
        // measure, so it is reported separately rather than folded in: it is
        // the number the user actually waits for.
        endToEnd: loadMs + (SPAWN_MS ?? 0),
        modelBytes: fileInfo ? fileInfo.totalBytes : null,
      },
    });
  } catch (err) {
    recognizer = null;
    fail(msg.id, err && err.code ? err.code : "crashed", err.message);
  }
}

function handleTranscribe(msg) {
  try {
    if (!recognizer) {
      fail(msg.id, "model_missing", "model was not loaded");
      return;
    }
    if (!(msg.samples instanceof Float32Array)) {
      fail(msg.id, "invalid_audio", "samples must be a Float32Array");
      return;
    }

    const sampleRate = msg.sampleRate || 16000;
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: msg.samples, sampleRate });

    const started = Date.now();
    recognizer.decode(stream);
    const decodeMs = Date.now() - started;

    const result = recognizer.getResult(stream);
    reply({
      id: msg.id,
      ok: true,
      type: "result",
      text: typeof result?.text === "string" ? result.text.trim() : "",
      decodeMs,
      rssMb: rssMb(),
    });
  } catch (err) {
    fail(msg.id, "crashed", err && err.message ? err.message : String(err));
  }
}

if (process.parentPort) {
  process.parentPort.on("message", (event) => {
    const msg = event && event.data ? event.data : event;
    if (!msg || typeof msg.id !== "number") return;
    switch (msg.type) {
      case "load":
        handleLoad(msg);
        break;
      case "transcribe":
        handleTranscribe(msg);
        break;
      case "unload":
        recognizer = null;
        loadedModelDir = null;
        reply({ id: msg.id, ok: true, type: "unloaded", rssMb: rssMb() });
        break;
      default:
        fail(msg.id, "malformed", `unknown request type: ${msg.type}`);
    }
  });
}

process.on("uncaughtException", (err) => {
  // Never die silently: the host would otherwise wait for a reply that can
  // never arrive. Report and keep serving.
  console.error("[Parakeet child] uncaught:", err && err.message);
});