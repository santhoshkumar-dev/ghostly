#!/usr/bin/env node
/**
 * Standalone Parakeet TDT 0.6B v2 (int8) spike.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * Proves the model loads and decodes on THIS machine, entirely outside the
 * Ghostly application. It touches no capture, no VAD, no correction, no
 * renderer, and no AI provider. It reads WAV files from disk and nothing else.
 *
 * CPU only, int8 only, no CUDA — per the Phase 1 evaluation plan.
 *
 * ── Measured, never estimated ───────────────────────────────────────────────
 * Every number printed is measured in this process at run time. RSS is read
 * from the OS, load and decode time from a monotonic clock. Nothing is
 * inferred, and a missing model or a failing native addon exits non-zero with
 * the exact error rather than degrading quietly.
 *
 * Usage:
 *   node scripts/spikes/parakeet-spike.mjs <file.wav> [more.wav ...]
 *   node scripts/spikes/parakeet-spike.mjs --dir <folder>
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { existsSync } from "node:fs";

import {
  parseWavHeader,
  checkWavFormat,
  computeRtf,
  round,
} from "../asr-bench-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const MODEL_DIR =
  process.env.PARAKEET_MODEL_DIR ??
  path.join(ROOT, "models", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");

/**
 * Thread count.
 *
 * The plan says ~4. This machine reports 12 logical processors, so 4 is a
 * deliberate cap that leaves headroom for the audio thread and the UI; it is
 * overridable so the measurement can be repeated at other values.
 */
const NUM_THREADS = Number(process.env.PARAKEET_NUM_THREADS ?? 4);

const REQUIRED_FILES = [
  "encoder.int8.onnx",
  "decoder.int8.onnx",
  "joiner.int8.onnx",
  "tokens.txt",
];

/** Resident set size of THIS process, in MB, read from the OS. */
function rssMb() {
  return process.memoryUsage().rss / (1024 * 1024);
}

/** Human-readable byte count. */
function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function die(message, extra) {
  console.error(`\nFAIL: ${message}`);
  if (extra) console.error(extra);
  process.exit(1);
}

function parseArgs(argv) {
  const files = [];
  let dir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") {
      dir = argv[++i];
    } else {
      files.push(argv[i]);
    }
  }
  return { files, dir };
}

async function main() {
  const { files, dir } = parseArgs(process.argv.slice(2));

  console.log("=== Parakeet TDT 0.6B v2 (int8) standalone spike ===");
  console.log(`host node        : ${process.version}`);
  console.log(`threads          : ${NUM_THREADS} (CPU only, no CUDA)`);
  console.log(`logical cpus     : ${os.cpus().length}`);
  console.log(`total ram        : ${mb(os.totalmem())}`);
  console.log(`model dir        : ${path.relative(ROOT, MODEL_DIR)}`);
  console.log("");

  // ── Model presence ────────────────────────────────────────────────────────
  if (!existsSync(MODEL_DIR)) {
    die(
      `model directory not found: ${MODEL_DIR}`,
      "Download the official release asset:\n" +
        "  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/" +
        "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
    );
  }
  const missing = REQUIRED_FILES.filter((f) => !existsSync(path.join(MODEL_DIR, f)));
  if (missing.length) {
    die(`model directory is incomplete, missing: ${missing.join(", ")}`);
  }

  // ── Collect input ─────────────────────────────────────────────────────────
  const targets = [...files];
  if (dir) {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    for (const e of entries.filter((f) => f.toLowerCase().endsWith(".wav")).sort()) {
      targets.push(path.join(dir, e));
    }
  }
  if (targets.length === 0) {
    die(
      "no input audio",
      "Pass one or more .wav files, or --dir <folder>.\n" +
        "Real clips: tests/fixtures/asr/ (see its README).\n" +
        "Synthetic clips: node scripts/generate-synthetic-fixtures.mjs",
    );
  }

  // ── Native addon ──────────────────────────────────────────────────────────
  let sherpa;
  const loadStart = performance.now();
  try {
    sherpa = (await import("sherpa-onnx-node")).default;
  } catch (err) {
    die(
      "sherpa-onnx-node native addon failed to load",
      `${err && err.message ? err.message : err}\n\n` +
        "This usually means the platform package (e.g. sherpa-onnx-win-x64)\n" +
        "is missing or its native DLLs were blocked by an install-script policy.",
    );
  }
  const addonLoadMs = performance.now() - loadStart;
  const rssBefore = rssMb();

  console.log(`addon load       : ${addonLoadMs.toFixed(0)} ms`);
  console.log(`sherpa version   : ${sherpa.version}`);
  console.log(`onnxruntime      : ${sherpa.onnxruntimeVersion}`);
  console.log(`rss before model : ${rssBefore.toFixed(1)} MB`);
  console.log("");

  // ── Model load ────────────────────────────────────────────────────────────
  const config = {
    featConfig: {
      samplingRate: 16000,
      featureDim: 80,
    },
    modelConfig: {
      transducer: {
        encoder: path.join(MODEL_DIR, "encoder.int8.onnx"),
        decoder: path.join(MODEL_DIR, "decoder.int8.onnx"),
        joiner: path.join(MODEL_DIR, "joiner.int8.onnx"),
      },
      tokens: path.join(MODEL_DIR, "tokens.txt"),
      numThreads: NUM_THREADS,
      provider: "cpu",
      debug: false,
    },
  };

  let recognizer;
  const loadStartModel = performance.now();
  try {
    recognizer = new sherpa.OfflineRecognizer(config);
  } catch (err) {
    die(
      "failed to construct the Parakeet recognizer (model load)",
      `${err && err.message ? err.message : err}\n\n` +
        "A 652 MB int8 encoder on ~7.6 GB of RAM with little free memory is the\n" +
        "most likely cause. Close applications and retry.",
    );
  }
  const modelLoadMs = performance.now() - loadStartModel;
  const rssAfterLoad = rssMb();

  console.log(`MODEL LOAD TIME  : ${modelLoadMs.toFixed(0)} ms  <-- headline number`);
  console.log(`rss after model  : ${rssAfterLoad.toFixed(1)} MB`);
  console.log(
    `rss delta (load) : ${(rssAfterLoad - rssBefore).toFixed(1)} MB`,
  );
  console.log("");
  console.log("--- per-clip decode ---");
  console.log(
    `${"file".padEnd(14)}${"dur".padStart(7)}${"decode".padStart(10)}${"RTF".padStart(8)}  transcript`,
  );

  let peakRss = rssAfterLoad;
  const results = [];

  for (const file of targets) {
    let wave;
    try {
      const buf = await readFile(file);
      const header = parseWavHeader(buf);
      const fmt = checkWavFormat(header);
      if (!fmt.ok) {
        console.log(
          `${path.basename(file).padEnd(14)}${header.durationSeconds.toFixed(2)}s`.padEnd(31) +
            `SKIPPED (${fmt.problems.join("; ")})`,
        );
        continue;
      }
      wave = sherpa.readWave(file, false);
    } catch (err) {
      console.log(
        `${path.basename(file).padEnd(14)}SKIPPED (${err && err.message ? err.message : err})`,
      );
      continue;
    }

    const durationSeconds = wave.samples.length / wave.sampleRate;

    let text = "";
    let decodeMs = 0;
    let failure = null;
    try {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate });
      const t0 = performance.now();
      recognizer.decode(stream);
      decodeMs = performance.now() - t0;
      text = recognizer.getResult(stream).text ?? "";
    } catch (err) {
      failure = err && err.message ? err.message : String(err);
    }

    const currentRss = rssMb();
    if (currentRss > peakRss) peakRss = currentRss;
    const rtf = round(computeRtf(decodeMs, durationSeconds), 4);

    const shown = (text || "").trim();
    console.log(
      `${path.basename(file).padEnd(14)}` +
        `${durationSeconds.toFixed(2)}s`.padStart(7) +
        `${(decodeMs / 1000).toFixed(2)}s`.padStart(10) +
        `${rtf === null ? "—" : rtf}`.padStart(8) +
        `  ${shown || (failure ? `FAILED: ${failure}` : "(empty)")}`,
    );

    results.push({
      file: path.basename(file),
      durationSeconds,
      decodeMs,
      rtf,
      text: shown,
      failure,
    });
  }

  console.log("");
  const ok = results.filter((r) => !r.failure);
  const totalDecode = ok.reduce((a, r) => a + r.decodeMs, 0);
  const totalAudio = ok.reduce((a, r) => a + r.durationSeconds, 0);
  console.log(`clips decoded    : ${ok.length}/${targets.length}`);
  console.log(`empty transcripts: ${ok.filter((r) => !r.text.trim()).length}`);
  if (ok.length) {
    console.log(`total decode     : ${(totalDecode / 1000).toFixed(2)} s`);
    console.log(`total audio      : ${totalAudio.toFixed(2)} s`);
    console.log(
      `aggregate RTF    : ${round(computeRtf(totalDecode, totalAudio), 4)}`,
    );
  }
  console.log(`peak rss         : ${peakRss.toFixed(1)} MB`);
  console.log(`final rss        : ${rssMb().toFixed(1)} MB`);
  console.log("");
  console.log(
    "NOTE: if these clips came from generate-synthetic-fixtures.mjs they are TTS,",
  );
  console.log(
    "      not a human: valid for latency/RAM only, NOT for accuracy.",
  );

  const hardFailures = results.filter((r) => r.failure);
  if (hardFailures.length) {
    console.error("");
    console.error(`${hardFailures.length} clip(s) failed to decode.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});