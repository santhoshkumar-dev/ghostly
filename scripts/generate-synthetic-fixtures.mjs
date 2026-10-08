#!/usr/bin/env node
/**
 * Generate SYNTHETIC ASR fixtures using Windows' built-in speech synthesiser.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * Latency, real-time factor and memory, before any real recording exists.
 * Windows `System.Speech.Synthesis.SpeechSynthesizer` produces clean,
 * perfectly-enunciated TTS audio — which is exactly why it is NOT a valid
 * accuracy corpus: it has no ASR noise, no room acoustics, no overlapping
 * speech, and a different prosody from a human interviewer.
 *
 * Every benchmark line produced from these clips is labelled
 * `synthetic: latency/RAM only, not valid for accuracy`.
 *
 * Output goes to `tests/fixtures/asr/synthetic/` which is gitignored (`*.wav`),
 * so nothing here is ever committed.
 *
 * Windows only. Requires PowerShell and the .NET System.Speech assembly.
 *
 * Usage:
 *   node scripts/generate-synthetic-fixtures.mjs
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "tests", "fixtures", "asr", "synthetic");

/** Matches manifest.json so the synthetic set is directly comparable. */
const QUESTIONS = [
  { id: "q01", text: "Why do we use MongoDB?" },
  { id: "q02", text: "What is Spring Boot?" },
  { id: "q03", text: "Explain Docker." },
  { id: "q04", text: "What is dependency injection in Spring Boot?" },
  { id: "q05", text: "How does JWT authentication work?" },
  { id: "q06", text: "What is the difference between RabbitMQ and Kafka?" },
  {
    id: "q07",
    text: "What is the difference between horizontal scaling and vertical scaling?",
  },
  { id: "q08", text: "What is the role of Redis in a backend application?" },
  { id: "q09", text: "How would you investigate a 500 error in production?" },
  {
    id: "q10",
    text: "Your payment service starts failing immediately after deployment. What would you check first?",
  },
  {
    id: "q11",
    text: "Suppose your application receives thousands of requests at the same time. How would you scale the backend?",
  },
  { id: "q12", text: "What is Kubernetes?" },
  { id: "q13", text: "What is Terraform used for?" },
  { id: "q14", text: "Tell me about the architecture of your project." },
  { id: "q15", text: "Why did you choose MongoDB?" },
];

const SHORT_SEGMENTS = [
  { id: "s01", text: "Why not?" },
  { id: "s02", text: "What is Redis?" },
  { id: "s03", text: "Explain the indexing strategy." },
];

/**
 * Speak one phrase to a WAV file.
 *
 * `SpeechAudioFormatInfo(16000, Sixteen, Mono)` makes System.Speech emit
 * exactly the format the benchmark requires, so no resampling or channel
 * mixing is needed afterwards — which keeps the generated audio honest.
 */
function synthesise(text, outPath) {
  const escaped = text.replace(/'/g, "''");
  const out = outPath.replace(/'/g, "''");
  // Written as a real multi-line script rather than a `;`-joined one-liner:
  // PowerShell will not parse a multi-line `New-Object ...(...)` call joined
  // with semicolons, and the error surfaces far from the actual mistake.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Speech",
    "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$synth.Rate = 0",
    "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(",
    "  16000,",
    "  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,",
    "  [System.Speech.AudioFormat.AudioChannel]::Mono",
    ")",
    // The format MUST be passed to SetOutputToWaveFile. Constructing
    // $fmt and then calling the single-argument overload silently produces
    // 22050 Hz instead — the format is simply ignored, with no error.
    "$synth.SetOutputToWaveFile('" + out + "', $fmt)",
    "$synth.Speak('" + escaped + "')",
    "$synth.Dispose()",
  ].join("\n");

  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 60_000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`${err.message}\n${stderr}`));
        else resolve();
      },
    );
  });
}

async function main() {
  if (process.platform !== "win32") {
    console.error(
      "This generator uses the Windows System.Speech TTS engine and only runs on Windows.",
    );
    process.exit(1);
  }

  // Always regenerate from scratch so a stale file can never be mistaken for
  // a fresh one.
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  console.log("Generating SYNTHETIC fixtures (TTS).");
  console.log("synthetic: latency/RAM only, not valid for accuracy");
  console.log(`Output: ${path.relative(ROOT, OUT_DIR)}`);
  console.log("");

  let ok = 0;
  const failures = [];

  for (const entry of [...QUESTIONS, ...SHORT_SEGMENTS]) {
    const outPath = path.join(OUT_DIR, `${entry.id}.wav`);
    try {
      await synthesise(entry.text, outPath);
      console.log(`  ${entry.id}.wav  "${entry.text}"`);
      ok++;
    } catch (err) {
      console.error(`  ${entry.id}.wav  FAILED: ${err.message}`);
      failures.push(entry.id);
    }
  }

  const written = await readdir(OUT_DIR).catch(() => []);
  console.log("");
  console.log(`${ok}/${QUESTIONS.length + SHORT_SEGMENTS.length} clips written (${written.length} files on disk).`);

  if (failures.length) {
    console.error(`Failed: ${failures.join(", ")}`);
    console.error(
      "Windows TTS may be unavailable. Real recordings remain the only valid accuracy corpus.",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});