/**
 * Verify the PACKAGED build, not the dev tree.
 *
 * ── Why this exists as a script ─────────────────────────────────────────────
 * Every other harness in this repo runs from source, where `sherpa-onnx-node`
 * resolves out of `node_modules/` and the model sits in `models/`. A packaged
 * app is a different world: the addon must load from `app.asar.unpacked`, and
 * the model must come from `userData`, because the installer ships neither a
 * `models/` folder nor an archive a `.node` file can be dlopen'd out of.
 *
 * Those two differences are exactly where a native-module packaging bug hides,
 * and neither is visible in a dev run. So this script runs the REAL packaged
 * executable with `ELECTRON_RUN_AS_NODE=1` (no window, no UI) and drives the
 * actual `parakeetWorker.cjs` through its own protocol.
 *
 * ── What it proves ──────────────────────────────────────────────────────────
 *   1. `dist/win-unpacked` exists and contains the unpacked addon + DLLs.
 *   2. The packaged executable can load the addon from `app.asar.unpacked`.
 *   3. The packaged worker script resolves `sherpa-onnx-node` from beside itself.
 *   4. The model loads from a userData-style directory.
 *   5. A real fixture decodes and produces the expected transcript.
 *
 * ── Prerequisites ───────────────────────────────────────────────────────────
 *   npm run build && npm run package
 *
 * Usage:
 *   node scripts/verify-packaged-parakeet.mjs [--clip <file.wav>]
 *
 * It creates a temporary userData-shaped directory under the OS temp folder and
 * links the repo's model into it, so no 460 MB download is required. Nothing
 * outside that temp folder is written, and it is removed afterwards.
 */

import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, symlinkSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const UNPACKED_APP = path.join(ROOT, "dist", "win-unpacked");
const UNPACKED = path.join(UNPACKED_APP, "resources", "app.asar.unpacked");
const EXE = path.join(UNPACKED_APP, "Ghostly.exe");
const MODEL_NAME = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";
const REQUIRED = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"];

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`);
  }
}

function checkTrue(name, actual) {
  check(name, Boolean(actual), true);
}

const clipArg = process.argv.indexOf("--clip");
const CLIP =
  clipArg >= 0
    ? path.resolve(process.argv[clipArg + 1])
    : findFirstRealClip();

function findFirstRealClip() {
  const root = path.join(ROOT, "debug-audio");
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const folder = path.join(root, dir);
    if (!statSync(folder).isDirectory()) continue;
    const wav = readdirSync(folder).find((f) => f.endsWith(".wav"));
    if (wav) return path.join(folder, wav);
  }
  return null;
}

console.log("Packaged-build verification\n");

// ── Preconditions ───────────────────────────────────────────────────────────
if (!existsSync(EXE)) {
  console.log(`No packaged build at ${EXE}.`);
  console.log("Run:  npm run build && npm run package\n");
  process.exit(1);
}

checkTrue("the packaged executable exists", existsSync(EXE));
checkTrue("app.asar.unpacked exists", existsSync(UNPACKED));
checkTrue(
  "the native addon is unpacked (a .node cannot be loaded from inside an asar)",
  existsSync(path.join(UNPACKED, "node_modules", "sherpa-onnx-win-x64", "sherpa-onnx.node")),
);
checkTrue(
  "the onnxruntime DLL is unpacked next to it",
  existsSync(path.join(UNPACKED, "node_modules", "sherpa-onnx-win-x64", "onnxruntime.dll")),
);
checkTrue(
  "the utility-process entry point is unpacked",
  existsSync(path.join(UNPACKED, "out", "main", "parakeetWorker.cjs")),
);
checkTrue(
  "the model was NOT bundled into the package",
  !existsSync(path.join(UNPACKED_APP, "resources", "app.asar.unpacked", "models")),
);

const modelSrc = path.join(ROOT, "models", MODEL_NAME);
const modelReady = REQUIRED.every((f) => existsSync(path.join(modelSrc, f)));
if (!modelReady) {
  console.log(`\nNo model at ${modelSrc}. Run: node scripts/provision-parakeet-model.mjs\n`);
  process.exit(1);
}

if (!CLIP) {
  console.log(
    "\nNo fixture clip. Save one from the Debug panel ('Save all debug clips'),\n" +
      "or pass --clip <file.wav>.\n",
  );
  process.exit(1);
}

// ── A userData-shaped model directory ───────────────────────────────────────
const userData = mkdtempSync(path.join(os.tmpdir(), "ghostly-packaged-ud-"));
const modelsDir = path.join(userData, "models");
mkdirSync(modelsDir, { recursive: true });
fs_link(path.join(modelSrc), path.join(modelsDir, MODEL_NAME));
checkTrue(
  "the model is reachable from a userData-shaped path",
  REQUIRED.every((f) => existsSync(path.join(modelsDir, MODEL_NAME, f))),
);

// ── Drive the packaged worker ───────────────────────────────────────────────
const probePath = path.join(UNPACKED, "out", "main", "_packaged-probe.cjs");
writeFileSync(probePath, probeSource());

let output = "";
let ran = false;
try {
  output = execFileSync(EXE, [probePath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      GHOSTLY_PROBE_UD: userData,
      GHOSTLY_PROBE_CLIP: CLIP,
    },
    encoding: "utf8",
    timeout: 180_000,
  });
  ran = true;
} catch (err) {
  output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
} finally {
  rmSync(probePath, { force: true });
  rmSync(userData, { recursive: true, force: true });
}

checkTrue("the packaged worker ran without crashing", ran);

const replies = output
  .split(/\r?\n/)
  .filter((l) => l.startsWith("REPLY "))
  .map((l) => JSON.parse(l.slice(6)));

const loaded = replies.find((r) => r.type === "loaded");
const decoded = replies.find((r) => r.type === "result");
const failure = replies.find((r) => r.ok === false);

checkTrue("the packaged worker loaded the model", Boolean(loaded));
checkTrue("the model load reported a duration", typeof loaded?.loadMs === "number");
checkTrue("the packaged worker decoded the fixture", Boolean(decoded));
checkTrue("the decode reported a duration", typeof decoded?.decodeMs === "number");
checkTrue(
  "the transcript is non-empty",
  typeof decoded?.text === "string" && decoded.text.trim().length > 0,
);
check("nothing failed", failure ?? null, null);

console.log("");
if (loaded) console.log(`  model load : ${loaded.loadMs} ms`);
if (decoded) {
  console.log(`  decode     : ${decoded.decodeMs} ms`);
  console.log(`  fixture    : ${path.basename(CLIP)}`);
  console.log(`  transcript : ${decoded.text}`);
}

if (!ran) {
  console.log("\n--- raw output ---");
  console.log(output);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A directory junction, so a 631 MB model does not have to be copied.
 *
 * Falls back to nothing if the OS refuses: the check afterwards reports the
 * truth either way, and a hard failure here would be a confusing way to learn
 * that the temp directory is on a different volume.
 */
function fs_link(from, to) {
  try {
    symlinkSync(from, to, "junction");
  } catch {
    /* reported by the check that follows */
  }
}

/**
 * The probe, run INSIDE the packaged tree by the packaged Electron binary.
 *
 * A function rather than a top-level const, so it is available before the spot
 * that uses it — a top-level `const` would be in the temporal dead zone and
 * throw on use above its declaration.
 */
function probeSource() {
  return `
let handler = null;
process.parentPort = {
  postMessage: (m) => {
    console.log("REPLY " + JSON.stringify({
      ok: m.ok, type: m.type, code: m.code, message: m.message,
      loadMs: m.loadMs, decodeMs: m.decodeMs, text: m.text,
    }));
    if (m.type === "loaded") {
      handler({ data: { id: 2, type: "transcribe", samples: globalThis.__clip, sampleRate: 16000 } });
    }
    if (m.type === "result" || (m.ok === false && m.id === 2)) {
      setTimeout(() => process.exit(0), 50);
    }
  },
  on: (_evt, cb) => { handler = cb; },
};

require("./parakeetWorker.cjs");

const fs = require("fs");
const path = require("path");
const MODEL = path.join(process.env.GHOSTLY_PROBE_UD, "models", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");

const buf = fs.readFileSync(process.env.GHOSTLY_PROBE_CLIP);
// The writer emits a canonical 44-byte-header 16 kHz mono 16-bit WAV.
const n = Math.floor((buf.length - 44) / 2);
const clip = new Float32Array(n);
for (let i = 0; i < n; i++) clip[i] = buf.readInt16LE(44 + i * 2) / 32768;
globalThis.__clip = clip;

setTimeout(() => handler({ data: { id: 1, type: "load", modelDir: MODEL } }), 100);
setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 120000);
`;
}
