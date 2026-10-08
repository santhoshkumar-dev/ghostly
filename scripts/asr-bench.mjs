#!/usr/bin/env node
/**
 * Moonshine vs Parakeet vs Groq Whisper — ASR benchmark.
 *
 * ── Hard rules this harness enforces ────────────────────────────────────────
 *
 * 1. SAME AUDIO TO EVERY ENGINE. One WAV file per question is read once and the
 *    same samples are handed to each engine. No engine ever sees another
 *    engine's output, and no VAD re-cuts or manual edit happens in between.
 *
 * 2. RAW ASR ONLY. Ghostly's transcript correction, candidate correction and
 *    technical-term normalization are NOT applied. Those would flatter the
 *    engines and hide real ASR mistakes. Accuracy measures the ASR.
 *
 * 3. NO FABRICATION. With no real clips the harness says so and exits cleanly.
 *    With synthetic clips it still reports accuracy-shaped columns but stamps
 *    every such run with a banner saying they are not valid for accuracy.
 *
 * 4. GROQ KEY FROM THE ENVIRONMENT ONLY. `GROQ_API_KEY` is read from
 *    process.env, never written to disk, never logged, never passed to the
 *    renderer. Absent key => Groq is reported as "not run - missing key".
 *
 * Usage:
 *   node scripts/asr-bench.mjs            # real fixtures, or a clean skip
 *   node scripts/asr-bench.mjs --synthetic # TTS fixtures: latency/RAM only
 *   node scripts/asr-bench.mjs --padding   # short-segment padding comparison
 *   node scripts/asr-bench.mjs --check     # format-check clips only
 *   node scripts/asr-bench.mjs --engine parakeet
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import {
  parseWavHeader,
  checkWavFormat,
  parseManifest,
  computeWer,
  computeCompleteness,
  checkTechnicalTerms,
  computeRtf,
  summarizeEngine,
  formatSummaryTable,
  round,
  SYNTHETIC_BANNER,
  NO_AUDIO_BANNER,
} from "./asr-bench-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIXTURE_DIR = path.join(ROOT, "tests", "fixtures", "asr");
const SYNTHETIC_DIR = path.join(FIXTURE_DIR, "synthetic");

const PARAKEET_MODEL_DIR =
  process.env.PARAKEET_MODEL_DIR ??
  path.join(ROOT, "models", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");

/** Padding applied by the short-segment test, per the evaluation plan. */
const PADDING_MS = Number(process.env.BENCH_PADDING_MS ?? 300);

const GROQ_ENDPOINT =
  "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3";

function parseArgs(argv) {
  return {
    synthetic: argv.includes("--synthetic"),
    padding: argv.includes("--padding"),
    check: argv.includes("--check"),
    engine: (() => {
      const i = argv.indexOf("--engine");
      return i >= 0 ? argv[i + 1] : "all";
    })(),
  };
}

function rssMb() {
  return process.memoryUsage().rss / (1024 * 1024);
}

/** Minimal 16-bit PCM WAV writer for the padding test. */
function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buf;
}

/** Load Parakeet, or return a structured failure instead of throwing. */
async function loadParakeet() {
  let sherpa;
  try {
    sherpa = (await import("sherpa-onnx-node")).default;
  } catch (err) {
    return {
      ok: false,
      error: `sherpa-onnx-node failed to load: ${err?.message ?? err}`,
    };
  }
  const need = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"];
  if (!existsSync(PARAKEET_MODEL_DIR)) {
    return { ok: false, error: `model directory missing: ${PARAKEET_MODEL_DIR}` };
  }
  const missing = need.filter((f) => !existsSync(path.join(PARAKEET_MODEL_DIR, f)));
  if (missing.length) {
    return { ok: false, error: `model incomplete, missing: ${missing.join(", ")}` };
  }
  try {
    const t0 = performance.now();
    const recognizer = new sherpa.OfflineRecognizer({
      featConfig: { samplingRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: path.join(PARAKEET_MODEL_DIR, "encoder.int8.onnx"),
          decoder: path.join(PARAKEET_MODEL_DIR, "decoder.int8.onnx"),
          joiner: path.join(PARAKEET_MODEL_DIR, "joiner.int8.onnx"),
        },
        tokens: path.join(PARAKEET_MODEL_DIR, "tokens.txt"),
        numThreads: Number(process.env.PARAKEET_NUM_THREADS ?? 4),
        provider: "cpu",
        debug: false,
      },
    });
    return { ok: true, sherpa, recognizer, loadMs: performance.now() - t0 };
  } catch (err) {
    return { ok: false, error: `recognizer construction failed: ${err?.message ?? err}` };
  }
}

function transcribeParakeet(recognizer, sherpa, file) {
  const wave = sherpa.readWave(file, false);
  const durationSeconds = wave.samples.length / wave.sampleRate;
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate });
  const t0 = performance.now();
  recognizer.decode(stream);
  const decodeMs = performance.now() - t0;
  return {
    transcript: (recognizer.getResult(stream).text ?? "").trim(),
    decodeMs,
    durationSeconds,
    rtf: computeRtf(decodeMs, durationSeconds),
  };
}

/**
 * Groq Whisper. Reads the key from process.env only — it is never persisted,
 * never logged and never returned. A missing key is a reported outcome, not an
 * error to work around.
 */
async function transcribeGroq(file, key) {
  const bytes = await readFile(file);
  const form = new FormData();
  form.append("file", new Blob([bytes]), path.basename(file));
  form.append("model", GROQ_MODEL);
  form.append("language", "en");
  form.append("temperature", "0");
  form.append("response_format", "json");

  const t0 = performance.now();
  const res = await fetch(GROQ_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const decodeMs = performance.now() - t0;
  if (!res.ok) {
    return { failure: `http_${res.status}`, decodeMs };
  }
  const json = await res.json();
  return { transcript: (json.text ?? "").trim(), decodeMs };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const manifestPath = path.join(FIXTURE_DIR, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`FAIL: manifest not found at ${manifestPath}`);
    process.exit(1);
  }
  const manifest = parseManifest(await readFile(manifestPath, "utf8"));

  const audioDir = opts.synthetic ? SYNTHETIC_DIR : FIXTURE_DIR;
  const isSynthetic = opts.synthetic;
  const banner = isSynthetic ? SYNTHETIC_BANNER : NO_AUDIO_BANNER;

  console.log("=== ASR benchmark: Moonshine / Parakeet / Groq Whisper ===");
  console.log(`host node : ${process.version}   electron target: 33.4.11`);
  console.log(`logical cpus: ${os.cpus().length}   total ram: ${(os.totalmem() / 1048576).toFixed(0)} MB`);
  console.log(`audio dir : ${path.relative(ROOT, audioDir)}`);
  console.log("");

  // ── Discover available clips ──────────────────────────────────────────────
  const entries = isSynthetic
    ? (existsSync(audioDir) ? await readdir(audioDir) : [])
    : manifest.questions.map((q) => q.file);

  const clips = [];
  for (const entry of manifest.questions) {
    const file = path.join(audioDir, entry.file);
    if (!existsSync(file)) continue;
    let header;
    try {
      header = parseWavHeader(await readFile(file));
    } catch (err) {
      console.log(`  ${entry.id}: unreadable (${err.message}) - skipped`);
      continue;
    }
    const fmt = checkWavFormat(header);
    clips.push({
      id: entry.id,
      file,
      reference: entry.reference,
      technicalTerms: entry.technicalTerms ?? [],
      durationSeconds: header.durationSeconds,
      formatProblems: fmt.problems,
      synthetic: isSynthetic,
    });
  }

  if (opts.check) {
    console.log("Clip format check");
    console.log("");
    for (const c of clips) {
      const h = parseWavHeader(await readFile(c.file));
      const f = checkWavFormat(h);
      console.log(
        `  ${f.ok ? "OK " : "BAD"} ${c.id.padEnd(6)} ${h.sampleRate}Hz ${h.channels}ch ${h.bitsPerSample}bit ${h.durationSeconds.toFixed(2)}s${f.ok ? "" : "  " + f.problems.join("; ")}`,
      );
    }
    console.log("");
    console.log(`${clips.length}/${manifest.questions.length} clips present.`);
    return;
  }

  if (clips.length === 0) {
    // ── The honest no-data path ─────────────────────────────────────────────
    console.log(NO_AUDIO_BANNER);
    console.log("");
    console.log(`No .wav files in ${path.relative(ROOT, audioDir)}.`);
    console.log("These are recordings of a real voice and are never committed (.gitignore excludes *.wav).");
    console.log("");
    console.log("To run this benchmark:");
    console.log("  1. Record the 15 questions listed in tests/fixtures/asr/README.md");
    console.log("     as 16 kHz mono 16-bit WAV, named q01.wav ... q15.wav,");
    console.log("     placed in tests/fixtures/asr/");
    console.log("  2. Run: node scripts/asr-bench.mjs");
    console.log("");
    console.log("No WER, completeness or accuracy figure is reported, because none can be");
    console.log("measured without audio. Skipping cleanly rather than inventing numbers.");
    console.log("");
    console.log("For latency/RAM only (NOT accuracy): node scripts/asr-bench.mjs --synthetic");
    process.exit(0);
  }

  const badFormat = clips.filter((c) => c.formatProblems.length);
  if (badFormat.length) {
    console.log("WARNING: clips not matching the required 16 kHz mono 16-bit format:");
    for (const c of badFormat) {
      console.log(`  ${c.id}: ${c.formatProblems.join("; ")}`);
    }
    console.log("");
  }

  console.log(
    `${clips.length}/${manifest.questions.length} clips present${
      isSynthetic ? " (SYNTHETIC TTS - latency/RAM only, not valid for accuracy)" : ""
    }`,
  );
  console.log("");

  const rssBaseline = rssMb();
  console.log(`process rss before engine load: ${rssBaseline.toFixed(1)} MB`);
  console.log("");

  // ── Engines ───────────────────────────────────────────────────────────────
  const parakeet = opts.engine === "groq" ? null : await loadParakeet();
  if (parakeet && !parakeet.ok) {
    console.log(`Parakeet: NOT RUN - ${parakeet.error}`);
  } else if (parakeet) {
    console.log(
      `Parakeet: loaded in ${parakeet.loadMs.toFixed(0)} ms (sherpa ${parakeet.sherpa.version}, ort ${parakeet.sherpa.onnxruntimeVersion}, CPU int8)`,
    );
    console.log(`process rss after model load : ${rssMb().toFixed(1)} MB`);
  }

  const groqKey = process.env.GROQ_API_KEY;
  const groqAvailable = Boolean(groqKey && opts.engine !== "parakeet");
  if (!groqKey) {
    console.log("Groq Whisper: not run - missing key (set GROQ_API_KEY in the environment)");
  } else if (!groqAvailable) {
    console.log("Groq Whisper: skipped by --engine");
  } else {
    console.log("Groq Whisper: key present in environment (value never logged)");
  }
  console.log("");

  // ── Run ───────────────────────────────────────────────────────────────────
  const rows = { Parakeet: [], "Groq Whisper": [] };
  let peakRss = rssBaseline;

  for (const clip of clips) {
    for (const engine of ["Parakeet", "Groq Whisper"]) {
      if (engine === "Parakeet" && !parakeet?.ok) continue;
      if (engine === "Groq Whisper" && !groqAvailable) continue;

      let row;
      try {
        if (engine === "Parakeet") {
          const r = transcribeParakeet(parakeet.recognizer, parakeet.sherpa, clip.file);
          row = {
            clipId: clip.id,
            engine,
            transcript: r.transcript,
            decodeMs: r.decodeMs,
            durationSeconds: r.durationSeconds,
            rtf: r.rtf,
            reference: clip.reference,
            wer: computeWer(clip.reference, r.transcript),
            completeness: computeCompleteness(clip.reference, r.transcript),
            terms: checkTechnicalTerms(clip.technicalTerms, r.transcript),
            failure: null,
          };
        } else {
          const r = await transcribeGroq(clip.file, groqKey);
          row = {
            clipId: clip.id,
            engine,
            transcript: r.transcript ?? "",
            decodeMs: r.decodeMs,
            durationSeconds: clip.durationSeconds,
            rtf: computeRtf(r.decodeMs ?? 0, clip.durationSeconds),
            reference: clip.reference,
            wer: r.transcript ? computeWer(clip.reference, r.transcript) : null,
            completeness: r.transcript
              ? computeCompleteness(clip.reference, r.transcript)
              : null,
            terms: r.transcript
              ? checkTechnicalTerms(clip.technicalTerms, r.transcript)
              : [],
            failure: r.failure ?? null,
          };
        }
      } catch (err) {
        row = {
          clipId: clip.id,
          engine,
          transcript: "",
          decodeMs: null,
          durationSeconds: clip.durationSeconds,
          rtf: null,
          reference: clip.reference,
          wer: null,
          completeness: null,
          terms: [],
          failure: err?.message ?? String(err),
        };
      }
      rows[engine].push(row);
      const now = rssMb();
      if (now > peakRss) peakRss = now;
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log("--- per-clip (same WAV to every engine) ---");
  console.log(
    `${"id".padEnd(6)}${"audio".padStart(9)}${"engine".padEnd(16)}${"decode".padStart(10)}${"rtf".padStart(8)}  transcript`,
  );
  for (const engine of Object.keys(rows)) {
    for (const r of rows[engine]) {
      console.log(
        r.clipId.padEnd(6) +
          `${r.durationSeconds.toFixed(2)}s`.padStart(9) +
          engine.padEnd(16) +
          `${r.decodeMs === null ? "—" : (r.decodeMs / 1000).toFixed(2) + "s"}`.padStart(10) +
          `${r.rtf === null ? "—" : round(r.rtf, 4)}`.padStart(8) +
          `  ${r.transcript || (r.failure ? `FAILED: ${r.failure}` : "(empty)")}`,
      );
    }
  }
  console.log("");

  console.log("--- summary ---");
  const summaries = Object.entries(rows)
    .filter(([, list]) => list.length > 0)
    .map(([engine, list]) =>
      summarizeEngine(engine, list, { hasAccuracyData: true }),
    );
  console.log(formatSummaryTable(summaries));
  console.log("");
  console.log(`peak process rss : ${peakRss.toFixed(1)} MB (baseline ${rssBaseline.toFixed(1)} MB)`);
  console.log("");

  if (isSynthetic) {
    console.log("=".repeat(72));
    console.log(SYNTHETIC_BANNER);
    console.log(
      "The WER / completeness / technical-term columns above were computed on",
    );
    console.log(
      "Windows TTS audio. They describe how each engine handles clean synthetic",
    );
    console.log(
      "speech and must NOT be read as interview accuracy. Real fixtures are",
    );
    console.log("required before any accuracy claim is meaningful.");
    console.log("=".repeat(72));
  }

  // ── Padding test ──────────────────────────────────────────────────────────
  if (opts.padding) {
    console.log("");
    console.log(`--- short-segment padding test (${PADDING_MS} ms each side) ---`);
    const shortDir = isSynthetic ? SYNTHETIC_DIR : FIXTURE_DIR;
    const shorts = [];
    for (const entry of manifest.shortSegments) {
      const file = path.join(shortDir, entry.file);
      if (existsSync(file)) shorts.push({ ...entry, file });
    }
    if (shorts.length === 0) {
      console.log("No short-segment clips present - skipped cleanly.");
    } else if (!parakeet?.ok) {
      console.log("Parakeet unavailable - skipped cleanly.");
    } else {
      console.log(
        `${"id".padEnd(6)}${"dur".padStart(9)}${"mode".padEnd(14)}${"decode".padStart(10)}  transcript`,
      );
      for (const s of shorts) {
        for (const padded of [false, true]) {
          let file = s.file;
          let label = "raw";
          if (padded) {
            const wave = parakeet.sherpa.readWave(s.file, false);
            const { padSilence } = await import("./asr-bench-lib.mjs");
            const paddedSamples = padSilence(wave.samples, wave.sampleRate, PADDING_MS);
            const tmp = path.join(os.tmpdir(), `${s.id}-pad.wav`);
            const { writeFile } = await import("node:fs/promises");
            await writeFile(tmp, encodeWav(paddedSamples, wave.sampleRate));
            file = tmp;
            label = `+${PADDING_MS}ms`;
          }
          try {
            const r = transcribeParakeet(parakeet.recognizer, parakeet.sherpa, file);
            console.log(
              s.id.padEnd(6) +
                `${r.durationSeconds.toFixed(2)}s`.padStart(9) +
                label.padEnd(14) +
                `${(r.decodeMs / 1000).toFixed(2)}s`.padStart(10) +
                `  ${r.transcript || "(EMPTY)"}`,
            );
          } catch (err) {
            console.log(
              s.id.padEnd(5) + label.padEnd(20) + `  FAILED: ${err.message}`,
            );
          }
        }
      }
      console.log("");
      console.log("Actual numbers are printed above; no padding policy is assumed.");
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});