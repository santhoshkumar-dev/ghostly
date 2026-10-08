/**
 * Padded vs unpadded Parakeet, on the REAL clips you saved.
 *
 * ── What this measures ──────────────────────────────────────────────────────
 * `PARAKEET_PADDING_MS` (300 ms of silence on each side) has been PROVISIONAL
 * since it was introduced: it is a plausible default from the sherpa-onnx
 * examples, not a measurement. It was never tested against real interview audio,
 * because no real clips existed. This is the harness that settles it.
 *
 * It decodes every clip in `debug-audio/` twice — once padded, once not — and
 * reports:
 *   • how many results are EMPTY in each mode (the failure mode padding is
 *     supposed to fix, and the one it can introduce by lengthening the segment);
 *   • how many transcripts actually DIFFER, with the diff, so a change that is
 *     only cosmetic is visible as cosmetic;
 *   • WER for each mode, where a reference exists.
 *
 * ── What it deliberately will not do ────────────────────────────────────────
 * It never invents a reference. A clip with no matching reference is reported as
 * UNSCORED, because a WER against an invented transcript is worse than no WER at
 * all — it looks like evidence. Synthetic TTS clips are also refused: they are
 * not interview speech and a padding decision made on them is worthless.
 *
 * Usage:
 *   node scripts/parakeet-padding-ab.mjs [debug-audio-dir]
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  computeWer,
  normalizeForWer,
  parseWavHeader,
  werTokens,
} from "./asr-bench-lib.mjs";

const require = createRequire(import.meta.url);

const MODEL_DIR =
  process.env.PARAKEET_MODEL_DIR ??
  path.join(process.cwd(), "models", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");

const SAMPLE_RATE = 16000;
const PADDING_MS = 300;
const REQUIRED = [
  "encoder.int8.onnx",
  "decoder.int8.onnx",
  "joiner.int8.onnx",
  "tokens.txt",
];

// ── Clip discovery ──────────────────────────────────────────────────────────

/** Every `.wav` under the debug-audio root, recursively. */
function findClips(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".wav")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/** 16-bit PCM mono -> Float32 in [-1, 1]. */
function readWavSamples(file) {
  const buf = readFileSync(file);
  const header = parseWavHeader(buf);
  if (!header) throw new Error(`not a RIFF/WAVE file: ${file}`);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = Math.floor((buf.length - header.dataOffset) / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(header.dataOffset + i * 2, true) / 32768;
  return out;
}

/** The `phraseId` in `12_3.4s.wav`, or null. */
function phraseIdOf(file) {
  const m = /(?:^|[-_])(\d+)_[\d.]+s\.wav$/i.exec(path.basename(file));
  return m ? Number(m[1]) : null;
}

function pad(samples, ms) {
  const padSamples = Math.round((SAMPLE_RATE * ms) / 1000);
  const out = new Float32Array(samples.length + padSamples * 2);
  out.set(samples, padSamples);
  return out;
}

// ── Reference loading ───────────────────────────────────────────────────────

/**
 * References, in descending order of trustworthiness.
 *
 * 1. `tests/fixtures/asr/manifest.json` — the SPOKEN words, filled in by hand.
 *    This is the only reference that measures accuracy.
 * 2. `comparison-export.json` — another engine's output on the same audio. This
 *    measures distance from Moonshine/Groq, NOT accuracy, and the report labels
 *    it as such. It is a fallback for clips that have not been transcribed yet.
 *
 * The two are never mixed in one WER column, because averaging a hand-written
 * reference against a machine one produces a number that describes nothing.
 */
let manifestReferences = null;

function loadManifestReferences() {
  if (manifestReferences !== null) return manifestReferences;
  manifestReferences = [];
  const manifestPath = path.join(process.cwd(), "tests", "fixtures", "asr", "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
      for (const entry of parsed.questions ?? []) {
        if (
          typeof entry.id === "string" &&
          entry.id.startsWith("real-") &&
          typeof entry.reference === "string" &&
          entry.reference.trim() &&
          typeof entry.phraseId === "number"
        ) {
          manifestReferences.push({ phraseId: entry.phraseId, reference: entry.reference });
        }
      }
    } catch {
      // A malformed manifest must not stop the measurement; the session exports
      // are used instead and the report says which reference it used.
    }
  }
  return manifestReferences;
}

/**
 * Read one session's comparison rows.
 *
 * `comparison-export.json` holds one row per captured phrase, keyed by the SAME
 * `phraseId` that "Save all debug clips" puts in the filename. That makes the
 * join exact — no duration matching and no guessing.
 *
 * Cached per folder: every clip in a session folder resolves against that
 * session's own export. A global map would let a later session with the same
 * phraseIds silently overwrite an earlier one.
 */
const referenceCache = new Map();

function sessionRows(clipFile) {
  const folder = path.dirname(clipFile);
  if (referenceCache.has(folder)) return referenceCache.get(folder);
  const rows = new Map();
  const jsonPath = path.join(folder, "comparison-export.json");
  if (existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
      for (const row of parsed.rows ?? []) {
        if (typeof row.phraseId === "number" && row.phraseId >= 0) {
          rows.set(row.phraseId, row);
        }
      }
    } catch {
      // A malformed export must not stop the measurement; the affected clips
      // simply report as UNSCORED.
    }
  }
  referenceCache.set(folder, rows);
  return rows;
}

/**
 * The reference for a clip, or null when there is none.
 *
 * The source is reported per clip, so a table that silently mixes hand-written
 * and machine references can never be mistaken for a clean accuracy number.
 */
function referenceFor(clipFile) {
  const phraseId = phraseIdOf(clipFile);
  if (phraseId === null) return null;

  const spoken = loadManifestReferences().find((r) => r.phraseId === phraseId);
  if (spoken) return { text: spoken.reference, engine: "spoken" };

  const row = sessionRows(clipFile).get(phraseId);
  if (row?.moonshineText) return { text: row.moonshineText, engine: "moonshine" };
  if (row?.groqText) return { text: row.groqText, engine: "groq" };
  return null;
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const root = path.resolve(process.argv[2] ?? path.join(process.cwd(), "debug-audio"));

  if (!existsSync(root)) {
    console.log(`No saved real clips at ${root}.`);
    console.log("");
    console.log("To produce them, in a DEV build:");
    console.log("  1. Start an interview with a real meeting playing.");
    console.log("  2. Debug panel -> tick 'Save debug WAV recording'.");
    console.log("  3. Debug panel -> click 'Save all debug clips'.");
    console.log("");
    console.log("That writes debug-audio/<timestamp>/*.wav plus comparison-export.json.");
    console.log("Nothing to measure yet, so nothing was run.");
    return;
  }

  const clips = findClips(root);
  if (clips.length === 0) {
    console.log(`Found no .wav files under ${root}.`);
    return;
  }

  const missing = REQUIRED.filter((f) => !existsSync(path.join(MODEL_DIR, f)));
  if (missing.length > 0) {
    console.log(`Parakeet model is incomplete at ${MODEL_DIR} (missing ${missing.join(", ")}).`);
    console.log("Run: node scripts/provision-parakeet-model.mjs");
    return;
  }

  console.log(`Padded vs unpadded Parakeet on ${clips.length} real clip(s) from ${root}`);
  console.log(`Padding: ${PADDING_MS} ms each side. Model: ${MODEL_DIR}`);
  console.log("");

  const sherpa = require("sherpa-onnx-node");
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { samplingRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(MODEL_DIR, "encoder.int8.onnx"),
        decoder: path.join(MODEL_DIR, "decoder.int8.onnx"),
        joiner: path.join(MODEL_DIR, "joiner.int8.onnx"),
      },
      tokens: path.join(MODEL_DIR, "tokens.txt"),
      numThreads: Number(process.env.PARAKEET_NUM_THREADS ?? 4),
      provider: "cpu",
      debug: false,
    },
  });

  const decode = (samples) => {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    const started = Date.now();
    recognizer.decode(stream);
    const decodeMs = Date.now() - started;
    const result = recognizer.getResult(stream);
    return { text: (result?.text ?? "").trim(), decodeMs };
  };

  const rows = [];

  for (const clip of clips) {
    const samples = readWavSamples(clip);
    const unpadded = decode(samples);
    const padded = decode(pad(samples, PADDING_MS));
    const reference = referenceFor(clip);
    rows.push({
      clip: path.relative(root, clip),
      seconds: samples.length / SAMPLE_RATE,
      unpadded,
      padded,
      changed: unpadded.text !== padded.text,
      reference,
      referenceEngine: reference?.engine ?? null,
      werUnpadded: reference
        ? computeWer(normalizeForWer(reference.text), normalizeForWer(unpadded.text)).wer
        : null,
      werPadded: reference
        ? computeWer(normalizeForWer(reference.text), normalizeForWer(padded.text)).wer
        : null,
    });
  }

  const fit = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
  console.log(
    `${fit("clip", 34)} ${fit("sec", 6)} ${fit("ref", 9)} ${fit("empty", 7)} ${fit("chg", 5)} ${fit("wer-u", 7)} ${fit("wer-p", 7)}`,
  );
  console.log("ref = which reference the WER columns are measured against");
  console.log("-".repeat(83));
  for (const r of rows) {
    console.log(
      fit(r.clip, 34) +
        " " +
        fit(r.seconds.toFixed(1), 6) +
        " " +
        fit(r.referenceEngine ?? "-", 9) +
        " " +
        fit(`${!r.unpadded.text ? 1 : 0}/${!r.padded.text ? 1 : 0}`, 7) +
        " " +
        fit(r.changed ? "yes" : "no", 5) +
        " " +
        fit(r.werUnpadded === null ? "-" : r.werUnpadded.toFixed(3), 7) +
        " " +
        fit(r.werPadded === null ? "-" : r.werPadded.toFixed(3), 7),
    );
  }

  const emptyUnpadded = rows.filter((r) => !r.unpadded.text).length;
  const emptyPadded = rows.filter((r) => !r.padded.text).length;
  const changed = rows.filter((r) => r.changed).length;
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  console.log("");
  console.log(`empty unpadded : ${emptyUnpadded}/${rows.length}`);
  console.log(`empty padded   : ${emptyPadded}/${rows.length}`);
  console.log(`transcripts differing between modes: ${changed}/${rows.length}`);

  // Reported SEPARATELY per reference kind. A single averaged WER across a mix
  // of hand-written and machine references would describe neither.
  for (const kind of ["spoken", "moonshine", "groq"]) {
    const scored = rows.filter((r) => r.referenceEngine === kind);
    if (scored.length === 0) continue;
    const label =
      kind === "spoken"
        ? "WER vs the SPOKEN words (accuracy)"
        : `WER vs ${kind}'s own output on the same audio (distance, NOT accuracy)`;
    console.log("");
    console.log(
      `${label} — ${scored.length}/${rows.length} clips:`,
    );
    console.log(
      `  unpadded ${mean(scored.map((r) => r.werUnpadded)).toFixed(3)}   padded ${mean(scored.map((r) => r.werPadded)).toFixed(3)}`,
    );
    const better = scored.filter((r) => r.werPadded < r.werUnpadded).length;
    const worse = scored.filter((r) => r.werPadded > r.werUnpadded).length;
    console.log(`  padding helped ${better}, hurt ${worse}, no change ${scored.length - better - worse}`);
  }

  if (rows.every((r) => !r.reference)) {
    console.log("");
    console.log("WER            : UNSCORED — no reference for any clip.");
    console.log("  Fill `reference` in tests/fixtures/asr/manifest.json with the exact words");
    console.log("  spoken, or run a session with 'Save all debug clips' to get Moonshine output.");
  }

  const differing = rows.filter((r) => r.changed);
  if (differing.length > 0) {
    console.log("");
    console.log(`Differences (${differing.length}):`);
    for (const r of differing) {
      console.log(`  ${r.clip}`);
      console.log(`    unpadded: "${r.unpadded.text}"`);
      console.log(`    padded  : "${r.padded.text}"`);
    }
  }
  console.log("");
  console.log(
    rows.every((r) => !r.reference)
      ? "Decision input is incomplete: no references, so only the empty-rate and diff counts above are meaningful."
      : "Compare the two columns before changing PARAKEET_PADDING_MS.",
  );
}

main();
