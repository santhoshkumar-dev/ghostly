"use strict";

/**
 * Real-process smoke test for the Parakeet host and its utility-process child.
 *
 * Run (real utilityProcess — the production architecture):
 *   npx electron scripts/smoke-parakeet-host.cjs
 *
 * Run (Electron's Node runtime, addon loaded in-process):
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/smoke-parakeet-host.cjs
 *
 * ── Why this file is CommonJS, not .mjs / .mts ─────────────────────────────
 * Electron does NOT transpile the file you pass on the command line: it hands
 * that path straight to Node's own loader. So the extension has to match what
 * Node can parse unaided. Two failures motivated this file being .cjs:
 *
 *   • `.mts` → `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".mts"`
 *   • `.mjs` → `SyntaxError: Unexpected reserved word`, because the body had
 *     `await` inside a plain (non-async) `function main()`, and `.mjs` is ESM
 *     where `require` does not exist either.
 *
 * `.cjs` is unambiguous for both Node and Electron: CommonJS, `require` works,
 * `await` only inside the `async` function that owns it.
 *
 * ── What this proves, and what it does not ─────────────────────────────────
 * `verify-parakeet-host.mts` drives a FAKE child and proves the host's logic:
 * queueing, timeouts, the restart budget, stale replies, idle unload. It cannot
 * prove that a native addon loads inside a `utilityProcess`, which is a
 * completely different runtime from the one the fake imitates.
 *
 * This file closes that gap. It forks the REAL production worker
 * (`electron/parakeetWorker.cjs` — not a copy), requires the REAL
 * `sherpa-onnx-node` addon, loads the REAL 631 MB model, and decodes a REAL
 * recorded WAV. A transcript printed at the end came from the actual model.
 *
 * The clip is the official test WAV shipped with the model release. It is real
 * recorded speech, so unlike a synthetic tone it exercises the decoder the way
 * the app will. Its transcript is reported verbatim as evidence that the decode
 * path works; it is NOT an accuracy benchmark — accuracy needs the interview
 * corpus, and no claim about accuracy is made here.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const MODEL_DIR = path.join(
  PROJECT_ROOT,
  "models",
  "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
);
const WORKER = path.join(PROJECT_ROOT, "electron", "parakeetWorker.cjs");
const CLIP = path.join(MODEL_DIR, "test_wavs", "0.wav");

/** Mirrors src/lib/parakeetHost.ts. Kept here so the smoke test needs no build. */
const SAMPLE_RATE = 16000;
const PADDING_MS = 300;
const LOAD_TIMEOUT_MS = 180000;
const DECODE_TIMEOUT_MS = 30000;

/** Read a 16 kHz mono 16-bit PCM WAV into a Float32Array in [-1, 1]. */
function readWav16kMono(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 44) throw new Error(`${file} is too short to be a WAV`);
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error(`${file} has no RIFF header`);
  if (buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file} has no WAVE header`);

  // Walk the chunks: a fixed 44-byte header assumption reads the wrong offsets
  // on any file carrying a LIST/fact chunk, and would silently produce the
  // wrong sample rate.
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataStart = -1;
  let dataSize = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataStart = body;
      dataSize = Math.min(size, buf.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }

  if (sampleRate !== SAMPLE_RATE) {
    throw new Error(`${file} is ${sampleRate} Hz; expected ${SAMPLE_RATE}`);
  }
  if (channels !== 1) throw new Error(`${file} has ${channels} channels; expected mono`);
  if (bits !== 16) throw new Error(`${file} is ${bits}-bit; expected 16-bit PCM`);

  const count = Math.floor(dataSize / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = buf.readInt16LE(dataStart + i * 2) / 32768;
  }
  return { samples, sampleRate, channels, bits };
}

/** Wrap a float32 array in 300 ms of silence on each side, as the host does. */
function pad(samples, ms) {
  const padSamples = Math.round((SAMPLE_RATE * ms) / 1000);
  const out = new Float32Array(samples.length + padSamples * 2);
  out.set(samples, padSamples);
  return out;
}

/** Post one request to the child and await the matching reply, or time out. */
function request(child, message, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(
      () => finish({ ok: false, code: "timeout", message: `no reply within ${timeoutMs}ms` }),
      timeoutMs,
    );

    const onMessage = (reply) => {
      // Replies are matched by id: a late reply for an already-timed-out request
      // must not settle anything.
      if (!reply || reply.id !== message.id) return;
      child.removeListener("message", onMessage);
      finish(reply);
    };
    child.on("message", onMessage);

    try {
      child.postMessage(message);
    } catch (err) {
      child.removeListener("message", onMessage);
      finish({ ok: false, code: "crashed", message: err.message });
    }
  });
}

function rssMb() {
  return Math.round((process.memoryUsage().rss / 1048576) * 10) / 10;
}

/** Assert and hard-fail, so a broken smoke test can never report success. */
function checkTrue(condition, label) {
  if (!condition) {
    throw new Error(`smoke assertion failed: ${label}`);
  }
  console.log(`  assert ok: ${label}`);
}

/** Report one WAV's format and duration. */
function describeClip(clip) {
  const seconds = clip.samples.length / clip.sampleRate;
  console.log(
    `clip            : ${path.relative(PROJECT_ROOT, CLIP)} ` +
      `(${clip.sampleRate} Hz, ${clip.channels}ch, ${clip.bits}-bit, ${seconds.toFixed(2)}s)`,
  );
  return seconds;
}

/**
 * Mode A — the production architecture: a genuine `utilityProcess` child.
 * Requires running as Electron (NOT ELECTRON_RUN_AS_NODE, which strips the
 * Electron module down to a bare path string).
 */
async function runViaUtilityProcess() {
  const { utilityProcess, app } = require("electron");
  if (!utilityProcess || typeof utilityProcess.fork !== "function") {
    throw new Error("utilityProcess.fork is unavailable - not running under Electron");
  }

  // `utilityProcess.fork` does nothing until the app is ready. In the packaged
  // app this is already true by the time any handler runs; in this standalone
  // script there is no window and nothing else ever triggers readiness, so a
  // fork attempted before `whenReady()` simply never starts and the request
  // hangs until its timeout. Awaiting readiness first is the fix.
  if (app && typeof app.whenReady === "function" && !app.isReady()) {
    console.log("waiting for app ready...");
    await app.whenReady();
    console.log("app ready");
  }

  console.log("\n--- 1. fork utilityProcess (real child process) ---");
  const child = utilityProcess.fork(WORKER, [], {
    stdio: "pipe",
    serviceName: "parakeet-smoke",
    // Same stamp the app uses, so the `spawn` phase of the load breakdown is
    // measured the SAME way here and in `electron/parakeetAsr.ts`. Without it
    // the standalone number and the in-app number are not comparable, which is
    // the entire question this harness exists to answer.
    env: { ...process.env, PARAKEET_SPAWN_ORIGIN_MS: String(Date.now()) },
  });
  console.log(`worker          : ${path.relative(PROJECT_ROOT, WORKER)}`);
  console.log(`child pid       : ${child.pid}`);

  child.on("exit", (code) => console.log(`  [child exited] code=${code}`));
  child.stderr?.on("data", (d) => process.stderr.write(`  [child] ${d}`));

  console.log("\n--- 2. load (sherpa-onnx-node addon + real model) ---");
  const rssBefore = rssMb();
  const loadStart = Date.now();
  const loaded = await request(
    child,
    { id: 1, type: "load", modelDir: MODEL_DIR },
    LOAD_TIMEOUT_MS,
  );
  const loadWall = Date.now() - loadStart;

  console.log(`ok              : ${loaded.ok}`);
  console.log(`code            : ${loaded.code ?? "-"}`);
  console.log(`message         : ${loaded.message ?? "-"}`);
  console.log(`child loadMs    : ${loaded.loadMs ?? "-"} ms`);
  console.log(`host wall clock : ${loadWall} ms`);
  if (loaded.breakdown) {
    const b = loaded.breakdown;
    const show = (v) => (v == null ? "-" : `${v} ms`);
    console.log("load breakdown  :");
    console.log(`   spawn        : ${show(b.spawn)}   (fork -> first line of child)`);
    console.log(`   require      : ${show(b.require)}   (sherpa-onnx-node native addon)`);
    console.log(`   read         : ${show(b.read)}   (stat + page-cache warm)`);
    console.log(`   construct    : ${show(b.construct)}   (ONNX session creation)`);
    console.log(`   total        : ${show(b.total)}   (read + require + construct)`);
    console.log(`   endToEnd     : ${show(b.endToEnd)}   (spawn + total)`);
    console.log(
      `   modelBytes   : ${b.modelBytes == null ? "-" : `${(b.modelBytes / 1048576).toFixed(0)} MB`}`,
    );
  }
  console.log(`child rssMb     : ${loaded.rssMb ?? "-"} MB`);
  console.log(`host rss        : ${rssBefore} MB -> ${rssMb()} MB`);

  if (!loaded.ok) {
    child.kill();
    throw new Error(`model load failed: code=${loaded.code} message=${loaded.message}`);
  }

  console.log("\n--- 3. decode (real recorded speech) ---");
  const clip = readWav16kMono(CLIP);
  const seconds = describeClip(clip);
  const padded = pad(clip.samples, PADDING_MS);

  const decodeStart = Date.now();
  const decoded = await request(
    child,
    { id: 2, type: "transcribe", samples: padded, sampleRate: SAMPLE_RATE, paddingMs: PADDING_MS },
    DECODE_TIMEOUT_MS,
  );
  const decodeWall = Date.now() - decodeStart;

  console.log(`ok              : ${decoded.ok}`);
  console.log(`code            : ${decoded.code ?? "-"}`);
  console.log(`message         : ${decoded.message ?? "-"}`);
  console.log(`child decodeMs  : ${decoded.decodeMs ?? "-"} ms`);
  console.log(`host wall clock : ${decodeWall} ms`);
  console.log(`child rssMb     : ${decoded.rssMb ?? "-"} MB`);
  console.log(`text            : ${JSON.stringify(decoded.text ?? "")}`);

  if (decoded.ok) {
    const rtf = (decoded.decodeMs ?? 0) / 1000 / (padded.length / SAMPLE_RATE);
    console.log(`rtf             : ${rtf.toFixed(3)}`);
  }

  console.log("\n--- 4. diagnostics sampler (one real sample) ---");
  // The production sampler reads SYSTEM memory, which only the main process
  // can do — that is why it lives in `electron/parakeetDiagnostics.ts` rather
  // than in the renderer. Exercised here so the numbers are known to emit.
  //
  // This file runs in Node and cannot require() a TypeScript source, so the
  // REAL production module is bundled on the fly with esbuild (already present
  // as a Vite dependency). Bundling rather than reimplementing matters: a copy
  // of the sampler here would keep passing after the real one was deleted.
  let startParakeetDiagnostics = null;
  try {
    const esbuild = require("esbuild");
    const tmp = path.join(os.tmpdir(), "parakeet-diag-smoke.cjs");
    esbuild.buildSync({
      entryPoints: [path.join(PROJECT_ROOT, "electron", "parakeetDiagnostics.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: tmp,
      external: ["electron"],
      logLevel: "silent",
    });
    ({ startParakeetDiagnostics } = require(tmp));
  } catch (err) {
    console.log(`  (could not bundle the diagnostics module: ${err.message})`);
  }
  let sample = null;
  const diagHandle = startParakeetDiagnostics({
    getHost: () => ({
      getDiagnostics: () => ({
        status: "ready",
        loadMs: loaded.loadMs ?? null,
        rssMb: decoded.rssMb ?? null,
        decodeMs: decoded.decodeMs ?? null,
        // Same computation the host makes: decode seconds / AUDIO seconds,
        // including the 300 ms padding on each side. Divided by the sample
        // RATE (16000), not by 1000 — using milliseconds here produced an
        // RTF of 0.006 instead of the real ~0.09.
        rtf: decoded.decodeMs
          ? decoded.decodeMs / 1000 / (padded.length / 16000)
          : null,
        queued: 0,
        inFlight: 0,
        consecutiveFailures: 0,
      }),
    }),
    log: (line) => {
      if (line.includes("baseline") === false && sample === null) sample = line;
      console.log(line);
    },
    // Fire once instead of waiting the full 10 s; the cadence itself is
    // asserted in verify-parakeet-diagnostics.mts with an injected clock.
    setInterval: (fn) => {
      setTimeout(fn, 0);
      return 1;
    },
    clearInterval: () => {},
  });
  // The stub timer fires on the macrotask queue, so the sample has to be given
  // a turn before `stop()` is called — otherwise the assertion races the
  // callback and the run fails even though the sampler is fine.
  await new Promise((r) => setTimeout(r, 50));
  diagHandle.stop();
  if (startParakeetDiagnostics) {
    checkTrue(sample !== null && sample.includes("childRss="), "diagnostics sample emitted");
    checkTrue(
      sample !== null && !/blob:|text=/.test(sample),
      "diagnostics sample carries no transcript or audio",
    );
  } else {
    console.log("  SKIPPED: diagnostics sampler could not be bundled");
  }

  console.log("\n--- 5. teardown ---");
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  console.log("child killed");

  // Standalone script: quit explicitly, otherwise Electron keeps the event loop
  // alive on the app object after the work is done.
  if (app && typeof app.quit === "function") app.quit();

  return loaded.ok && decoded.ok;
}

/**
 * Mode B — ELECTRON_RUN_AS_NODE=1. Electron's own Node runtime (20.18.3), but
 * `utilityProcess` is unavailable because that mode reduces `require("electron")`
 * to a bare path string. So the addon is loaded IN-PROCESS here instead.
 *
 * This still proves something the unit harness cannot: that `sherpa-onnx-node`'s
 * native binary is ABI-compatible with the Node build Electron embeds, which is
 * the runtime the packaged app's main process would use.
 */
async function runInProcess() {
  console.log("\n--- 1. load sherpa-onnx-node in-process (Electron's Node runtime) ---");
  console.log(`ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE}`);

  const loadStart = Date.now();
  const sherpa = require("sherpa-onnx-node");
  console.log(`addon required  : ok (${Math.round((Date.now() - loadStart) * 10) / 10} ms)`);
  console.log(`exports         : ${Object.keys(sherpa).slice(0, 8).join(", ")}`);

  if (typeof sherpa.OfflineRecognizer !== "function") {
    throw new Error("sherpa-onnx-node does not export OfflineRecognizer");
  }

  const modelStart = Date.now();
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { samplingRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(MODEL_DIR, "encoder.int8.onnx"),
        decoder: path.join(MODEL_DIR, "decoder.int8.onnx"),
        joiner: path.join(MODEL_DIR, "joiner.int8.onnx"),
      },
      tokens: path.join(MODEL_DIR, "tokens.txt"),
      numThreads: 4,
      provider: "cpu",
      debug: false,
    },
  });
  const modelMs = Date.now() - modelStart;
  console.log(`recognizer      : ${recognizer ? "constructed" : "null"}`);
  console.log(`model load      : ${modelMs} ms`);
  console.log(`rss             : ${rssMb()} MB`);

  console.log("\n--- 2. decode (real recorded speech) ---");
  const clip = readWav16kMono(CLIP);
  describeClip(clip);
  const padded = pad(clip.samples, PADDING_MS);

  const decodeStart = Date.now();
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples: padded, sampleRate: SAMPLE_RATE });
  recognizer.decode(stream);
  const result = recognizer.getResult(stream);
  const decodeMs = Date.now() - decodeStart;

  const text = typeof result?.text === "string" ? result.text.trim() : "";
  console.log(`decode          : ${decodeMs} ms`);
  console.log(`text            : ${JSON.stringify(text)}`);
  console.log(`rss             : ${rssMb()} MB`);

  return text.length > 0;
}

async function main() {
  const asNode = process.env.ELECTRON_RUN_AS_NODE === "1";

  console.log("=== Parakeet smoke test (real Electron + real native addon) ===");
  console.log(`node            : ${process.version}`);
  console.log(`electron        : ${process.versions.electron ?? "(not Electron)"}`);
  console.log(`mode            : ${asNode ? "ELECTRON_RUN_AS_NODE=1 (in-process addon)" : "Electron main (utilityProcess child)"}`);
  console.log(`total ram       : ${Math.round(os.totalmem() / 1048576)} MB`);
  console.log(`free ram        : ${Math.round(os.freemem() / 1048576)} MB`);
  console.log(`model dir       : ${path.relative(PROJECT_ROOT, MODEL_DIR)}`);

  for (const required of [MODEL_DIR, WORKER, CLIP]) {
    if (!fs.existsSync(required)) {
      throw new Error(`required file missing: ${required}`);
    }
  }

  const ok = asNode ? await runInProcess() : await runViaUtilityProcess();

  console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) process.exitCode = 1;
}

// The async IIFE + catch is the fix for the "Unexpected reserved word" failure:
// every `await` in this file lives inside this one `async` function, so nothing
// depends on top-level await (unsupported in CommonJS) and no failure escapes
// as an unhandled rejection with a useless exit code.
(async () => {
  try {
    await main();
  } catch (err) {
    console.error(`\nSMOKE TEST FAILED: ${err && err.message ? err.message : err}`);
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  }
})();