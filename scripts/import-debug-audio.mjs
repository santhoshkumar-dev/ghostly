#!/usr/bin/env node
/**
 * Copy recorded debug WAV clips into the ASR evaluation corpus.
 *
 * Run: `node scripts/import-debug-audio.mjs --from <dir> [--prefix real] [--dry-run]`
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The Parakeet-vs-Moonshine evaluation has, so far, only ever seen SYNTHETIC TTS
 * audio. Synthetic audio is useful for a smoke test and useless for accuracy:
 * a TTS voice has no room noise, no microphone noise, no crosstalk from a
 * laptop speaker, and no reason to hesitate mid-sentence. Every accuracy
 * conclusion drawn from it would be fabricated.
 *
 * So the corpus has to come from real Ghostly captures. Ghostly already has a
 * dev-only WAV dump (Interview modal → Debug → "Record debug WAV"), but it
 * hands back in-memory blob URLs, which die with the session. This script takes
 * WAVs you have saved to disk and files them correctly, so the only thing
 * standing between you and a real measurement is typing the sentence you
 * actually said.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 * It never guesses the reference text. A WER computed against an invented
 * reference is worse than no WER at all, because it looks like a measurement.
 * Every imported clip gets an EMPTY `text` field, and the evaluation harness
 * refuses to score a clip with an empty reference rather than inventing one.
 *
 * Audio stays gitignored: these recordings are interview material.
 *
 * ── Audio hygiene ───────────────────────────────────────────────────────────
 * The WAVs the debug dump produces are already 16 kHz mono 16-bit PCM, which is
 * exactly what the harness expects. Anything else is converted with ffmpeg if
 * it is available, and REJECTED with a clear message if it is not — a silently
 * wrong sample rate is exactly the kind of thing that produces a confident,
 * meaningless WER.
 */
import { mkdir, stat, readFile } from "node:fs/promises";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const FIXTURE_DIR = path.resolve("tests/fixtures/asr");
const MANIFEST_PATH = path.join(FIXTURE_DIR, "manifest.json");
const TARGET_SAMPLE_RATE = 16000;

/** Parse `--flag value` / `--flag=value` / bare `--flag` into an object. */
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      args[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[body] = next;
      i++;
    } else {
      args[body] = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

/** Locate ffmpeg once; its absence is not fatal, it just blocks conversion. */
function hasFfmpeg() {
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return probe.status === 0;
}

async function wavInfo(file) {
  const buffer = await readFile(file);
  if (buffer.length < 44) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WAVE") return null;

  // Walk the chunks rather than assuming a 44-byte header: some writers insert
  // a LIST/fact chunk, and reading the wrong offsets yields a plausible-looking
  // but wrong sample rate.
  let offset = 12;
  let sampleRate = null;
  let channels = null;
  let bitsPerSample = null;
  let dataLength = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt ") {
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataLength = Math.min(size, buffer.length - body);
      break;
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }

  if (sampleRate === null || !dataLength) return null;
  return { sampleRate, channels, bitsPerSample, dataLength };
}

/** Convert to the harness's required 16 kHz mono 16-bit PCM. */
function convertWithFfmpeg(from, to) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      from,
      "-ac",
      "1",
      "-ar",
      String(TARGET_SAMPLE_RATE),
      "-c:a",
      "pcm_s16le",
      to,
    ],
    { stdio: "ignore" },
  );
  return result.status === 0;
}

/** Stable, readable id from the source filename. */
function slugify(name) {
  return path
    .basename(name, path.extname(name))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(
      `Manifest not found at ${MANIFEST_PATH}. It should be committed from Phase 1.`,
    );
  }
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

async function main() {
  const source = args.from;
  if (!source || source === true) {
    console.log(`
Import real recorded clips into the ASR evaluation corpus.

  node scripts/import-debug-audio.mjs --from <dir> [options]

Options:
  --from <dir>    Folder holding the .wav files you want to import.
  --prefix <str>  Id prefix for the generated manifest entries
                  (default: real). Use one prefix per recording session.
  --dry-run       Report what would happen; copy nothing, write nothing.
  --help          This message.

How to get the files:
  1. Run a dev build:  npm run dev
  2. Open the Live Interview panel and press "Debug".
  3. Tick "Record debug WAV (local only …)".
  4. Run the interview (or just speak a few questions), then stop.
  5. Each captured segment appears under "Raw Audio" as a <audio> player.
     Save each one to disk (right-click → "Save audio as…", or the download
     button) into a folder of your choosing, e.g. debug-audio/session-1/.
  6. Run this script against that folder.

What this script does:
  • checks each file is a real 16 kHz mono WAV (converting with ffmpeg if
    it is not, and refusing rather than guessing if ffmpeg is unavailable)
  • copies it into tests/fixtures/asr/ as <prefix>-NN-<slug>.wav
  • appends a manifest stub with an EMPTY text field for you to fill in

The audio itself is gitignored (see .gitignore "*.wav"). Only the manifest is
committed. Fill in the exact spoken words — an invented reference produces a
confident, meaningless WER, which is worse than no measurement.
`);
    process.exit(0);
  }

  const sourceDir = path.resolve(String(source));
  if (!existsSync(sourceDir)) {
    console.error(`Source folder not found: ${sourceDir}`);
    process.exit(1);
  }

  const dryRun = args["dry-run"] === true;
  const prefix = typeof args.prefix === "string" ? args.prefix : "real";
  const ffmpeg = hasFfmpeg();

  console.log(`Source : ${sourceDir}`);
  console.log(`Target : ${FIXTURE_DIR}`);
  console.log(`Prefix : ${prefix}`);
  console.log(`ffmpeg : ${ffmpeg ? "available (conversion supported)" : "NOT FOUND (only 16 kHz mono will import)"}`);
  if (dryRun) console.log("Mode   : DRY RUN — nothing will be copied or written");

  // The manifest is read synchronously (as the other scripts in this folder do)
  // because every subsequent step mutates it and it is small.
  const manifest = loadManifest();
  manifest.questions = Array.isArray(manifest.questions) ? manifest.questions : [];
  const existingIds = new Set(manifest.questions.map((q) => q.id));

  const entries = readdirSync(sourceDir).filter((f) => f.toLowerCase().endsWith(".wav"));
  if (entries.length === 0) {
    console.log("\nNo .wav files found. Nothing to do.");
    process.exit(0);
  }

  let imported = 0;
  let skipped = 0;
  const stubs = [];

  /**
   * Next id for this prefix.
   *
   * Numbered from the imports ACCEPTED so far, not from the files examined —
   * counting a rejected file would leave gaps (01, 03, 04…) in the corpus, which
   * makes the manifest harder to reason about later. Collisions with ids
   * already in the manifest are resolved by advancing until the id is free.
   */
  const nextId = (slug) => {
    for (;;) {
      const n = String(stubs.length + 1).padStart(2, "0");
      const id = `${prefix}-${n}-${slug}`;
      if (!existingIds.has(id)) return id;
    }
  };

  for (const name of entries.sort()) {
    const from = path.join(sourceDir, name);
    const info = await stat(from);
    if (info.size < 64) {
      console.log(`  skip  ${name} — too small to be a WAV (${info.size} bytes)`);
      skipped++;
      continue;
    }

    const wav = await wavInfo(from);
    if (!wav) {
      console.log(`  skip  ${name} — not a readable RIFF/WAVE file`);
      skipped++;
      continue;
    }

    if (wav.sampleRate !== TARGET_SAMPLE_RATE || wav.channels !== 1) {
      const reasons = [];
      if (wav.sampleRate !== TARGET_SAMPLE_RATE) reasons.push(`${wav.sampleRate} Hz`);
      if (wav.channels !== 1) reasons.push(`${wav.channels} ch`);
      if (!ffmpeg) {
        console.log(
          `  skip  ${name} — ${reasons.join(", ")} needs conversion but ffmpeg is not on PATH`,
        );
        skipped++;
        continue;
      }
      const id = nextId(slugify(name));
      const to = path.join(FIXTURE_DIR, `${id}.wav`);
      console.log(`  conv  ${name} → ${id}.wav (${reasons.join(", ")} → 16 kHz mono)`);
      if (dryRun) {
        imported++;
        continue;
      }
      mkdirSyncSafe(FIXTURE_DIR);
      if (!convertWithFfmpeg(from, to)) {
        console.log(`  FAIL  ${name} — ffmpeg could not convert it`);
        skipped++;
        continue;
      }
      registerStub(stubs, existingIds, id, phraseIdFromFileName(name));
      imported++;
      continue;
    }

    const id = nextId(slugify(name));
    if (existingIds.has(id)) {
      console.log(`  skip  ${name} — manifest already has "${id}"`);
      skipped++;
      continue;
    }

    console.log(
      `  copy  ${name} → ${id}.wav (16 kHz mono, ${(wav.dataLength / 2 / TARGET_SAMPLE_RATE).toFixed(1)}s)`,
    );
    if (!dryRun) {
      mkdirSyncSafe(FIXTURE_DIR);
      copyFileSyncSafe(from, path.join(FIXTURE_DIR, `${id}.wav`));
    }
    registerStub(stubs, existingIds, id, phraseIdFromFileName(name));
    imported++;
  }

  if (imported === 0) {
    console.log("\nNothing imported.");
    process.exit(skipped > 0 ? 1 : 0);
  }

  if (!dryRun && stubs.length > 0) {
    manifest.questions.push(...stubs);
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  console.log(`
Imported ${imported} clip(s)${skipped ? `, skipped ${skipped}` : ""}${dryRun ? " (dry run — nothing written)" : ""}.

NEXT STEP — fill in the reference text.

${stubs.length > 0 ? "Open tests/fixtures/asr/manifest.json and set each new entry's `text` to" : "Set each new entry's `text` to"}
the EXACT words that were spoken, including any mistakes you actually made.
Leave it empty and the harness will report the clip as unscored rather than
inventing a reference.

Then:
  node scripts/asr-bench.mjs --check     # format + coverage check
  node scripts/asr-bench.mjs             # run the comparison`);
}

/**
 * An empty-reference stub.
 *
 * Never pre-filled: a guessed reference produces a confident, meaningless WER,
 * which is worse than no measurement at all. The field is named `reference`
 * because that is what the manifest schema requires — using a different name
 * here produced a manifest that failed to parse with a misleading error.
 */
function registerStub(stubs, existingIds, id, phraseId) {
  if (existingIds.has(id)) return;
  stubs.push({
    id,
    file: `${id}.wav`,
    // FILL THIS IN with the exact spoken words.
    reference: "",
    // Carried over from the filename when the clip came from "Save all debug
    // clips", which names files `<phraseId>_<audioSeconds>s.wav`. That makes the
    // join to the exported comparison JSON EXACT, so no duration guessing is
    // needed. Left null only for clips named some other way — and a null
    // phraseId means the clip can only be matched by duration later, which is
    // ambiguous whenever two segments round to the same length.
    phraseId: phraseId ?? null,
    ...(phraseId === null || phraseId === undefined
      ? { notes: "real capture; reference text and phraseId still need filling in" }
      : { notes: `real capture; phraseId ${phraseId} from filename` }),
    technicalTerms: [],
  });
}

/**
 * Pull the phraseId out of a filename written by "Save all debug clips".
 *
 * Returns null for anything else, so a clip saved by hand is imported WITHOUT a
 * phraseId rather than being given a wrong one — a confidently wrong join key is
 * worse than no join key.
 */
function phraseIdFromFileName(fileName) {
  const match = /^(\d+)_[\d.]+s\.wav$/i.exec(path.basename(fileName));
  return match ? Number(match[1]) : null;
}

function mkdirSyncSafe(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function copyFileSyncSafe(from, to) {
  try {
    copyFileSync(from, to);
  } catch (error) {
    console.error(`  FAIL  ${path.basename(from)} — ${error.message}`);
    throw error;
  }
}

main().catch((error) => {
  console.error(`\nimport-debug-audio failed: ${error.message}`);
  process.exit(1);
});