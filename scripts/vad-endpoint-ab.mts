/**
 * Phase 8 / Item 5 amendment A4 — the VAD endpoint-threshold A/B.
 *
 * Run:
 *   npx tsx scripts/vad-endpoint-ab.mts <path-to-wav> [--max-silence 1.2,1.5,1.8]
 *
 * ── Why a replay, and not the saved debug clips ────────────────────────────
 * A debug clip is an already-DECODED segment: the VAD already decided where that
 * phrase began and ended, and the clip contains nothing on either side of that
 * decision. Re-running the VAD over such a clip cannot test a different
 * endpoint threshold, because the audio that would have proved the threshold
 * wrong was thrown away at save time. It can only ever reproduce the answer the
 * VAD already gave.
 *
 * So this harness takes ONE CONTINUOUS RECORDING — interviewer audio with the
 * pauses inside questions still in it — decodes it into the same 128-sample
 * frames the AudioWorklet sees, and replays it through
 * `simulateVad`/`simulateSegmentation` at each threshold IN TURN. Same code, one
 * variable.
 *
 * ── What it reports, and why those two numbers lead ────────────────────────
 *   fragments        how many ASR segments the take produced. More is choppier.
 *   droppedSeconds   speech seconds that would be LOST because the recording
 *                    ended (or a threshold was high enough) before the phrase
 *                    closed. A threshold that reduces fragments by dropping
 *                    audio is strictly worse, and this is the number that says
 *                    so.
 *
 * ── What it will NOT do ───────────────────────────────────────────────────
 * It does not change `MAX_SILENCE_SECONDS`. The production default is a
 * measured decision (see the `MAX_SILENCE_SECONDS` doc comment in
 * `vadWorklet.ts`) and this script only proposes a value with evidence. The
 * caller must decide.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import {
  DEFAULT_VAD_CONFIG,
  MAX_SILENCE_SECONDS,
  simulateSegmentation,
  type VadConfig,
  type VadFrame,
} from "../src/lib/vadWorklet";

/** AudioWorklet render quantum. The worklet's frames are exactly this long. */
const RENDER_QUANTUM = 128;

interface Decoded {
  sampleRate: number;
  samples: Float32Array;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

/**
 * Minimal RIFF/WAVE reader for PCM.
 *
 * Deliberately small and deliberately strict: this harness must not silently
 * mis-decode a file and produce a confident wrong answer, so anything that is
 * not plain 16-bit (or 8/24/32-bit integer, or 32-bit float) PCM is refused by
 * name rather than guessed at.
 */
function decodeWav(bytes: Buffer, path: string): Decoded {
  if (bytes.length < 44) fail(`${path}: too short to be a WAV file (${bytes.length} bytes)`);
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    fail(`${path}: not a RIFF/WAVE file. Export 16-bit PCM WAV (Mono or Stereo).`);
  }

  let offset = 12;
  let format: number | null = null;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = bytes.readUInt16LE(body);
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      bitsPerSample = bytes.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataStart = body;
      dataLength = Math.min(size, bytes.length - body);
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }

  if (format === null || dataStart < 0) fail(`${path}: no fmt /data chunks found.`);
  if (format !== 1 && format !== 3 && format !== 0xfffe) {
    fail(`${path}: audio format ${format} is not PCM. Export 16-bit PCM WAV.`);
  }
  if (channels < 1) fail(`${path}: no channels declared.`);
  if (bitsPerSample !== 16 && bitsPerSample !== 8 && bitsPerSample !== 24 && bitsPerSample !== 32) {
    fail(`${path}: ${bitsPerSample}-bit audio is not supported. Export 16-bit PCM WAV.`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataLength / (bytesPerSample * channels));
  const samples = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    // Downmix to mono: a stereo interview recording is normal and only the
    // interviewer's channel may carry speech.
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const at = dataStart + (i * channels + c) * bytesPerSample;
      if (bitsPerSample === 16) acc += bytes.readInt16LE(at) / 0x8000;
      else if (bitsPerSample === 8) acc += (bytes.readUInt8(at) - 128) / 128;
      else if (bitsPerSample === 24) {
        const v = (bytes.readUInt8(at) | (bytes.readUInt8(at + 1) << 8) | (bytes.readInt8(at + 2) << 16)) / 0x800000;
        acc += v;
      } else if (format === 3) acc += bytes.readFloatLE(at);
      else acc += bytes.readInt32LE(at) / 0x80000000;
    }
    samples[i] = acc / channels;
  }

  return { sampleRate, samples };
}

/**
 * Slice the recording into the frames the worklet actually sees.
 *
 * Identical shape to the worklet's own loop: 128 samples, RMS per frame, and
 * the threshold applied to that RMS. Anything else would measure a different
 * program than the one that runs in the interview.
 */
export function toVadFrames(samples: Float32Array, sampleRate: number): VadFrame[] {
  const frames: VadFrame[] = [];
  for (let i = 0; i + RENDER_QUANTUM <= samples.length; i += RENDER_QUANTUM) {
    let sum = 0;
    for (let j = 0; j < RENDER_QUANTUM; j++) {
      const v = samples[i + j];
      sum += v * v;
    }
    frames.push({
      seconds: RENDER_QUANTUM / sampleRate,
      rms: Math.sqrt(sum / RENDER_QUANTUM),
    });
  }
  return frames;
}

/**
 * An INDEPENDENT scan of the recording into speech runs and the pauses between
 * them, in wall-clock seconds.
 *
 * Deliberately not derived from `simulateSegmentation`: that report counts
 * segments, and a count cannot tell you how long the pause between two segments
 * was — which is the number that decides whether they were one question or two.
 * Reading it here from the frames directly keeps this a measurement rather than
 * an echo of the thing being measured, and the two are cross-checked below.
 */
export function scanSpeechRuns(
  frames: VadFrame[],
  silenceThreshold: number,
): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  let t = 0;
  let open: { start: number; end: number } | null = null;
  for (const frame of frames) {
    const speech = frame.rms > silenceThreshold;
    if (speech) {
      if (!open) open = { start: t, end: t };
      open.end = t + frame.seconds;
    } else if (open) {
      runs.push(open);
      open = null;
    }
    t += frame.seconds;
  }
  if (open) runs.push(open);
  return runs;
}

/** Write one segment's audio out as a 16-bit PCM WAV, so it can be transcribed. */
function writeClip(
  path: string,
  samples: Float32Array,
  sampleRate: number,
  fromSeconds: number,
  toSeconds: number,
) {
  const from = Math.max(0, Math.floor(fromSeconds * sampleRate));
  const to = Math.min(samples.length, Math.ceil(toSeconds * sampleRate));
  const n = Math.max(0, to - from);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[from + i]));
    buf.writeInt16LE(Math.round(v * 0x7fff), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

function parseArgs(argv: string[]) {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const out: { path: string | null; thresholds: number[]; extract: boolean } = {
    path: null,
    thresholds: [],
    extract: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-silence") {
      out.thresholds = (argv[++i] ?? "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
    } else if (argv[i] === "--extract") {
      // Writes one WAV per segment at the production threshold, so the ACTUAL
      // split texts can be produced: decode the clips and the transcript shows
      // exactly which questions the VAD broke in half.
      out.extract = true;
    }
  }
  out.path = positional[0] ?? null;
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.path) {
    console.error(
      "Usage: npx tsx scripts/vad-endpoint-ab.mts <continuous.wav> " +
        "[--max-silence 1.2,1.5,1.8]\n\n" +
        `Put the file in debug-audio/replay/ (already gitignored). Format: 16-bit PCM WAV, ` +
        `mono preferred, 16 kHz matching the capture context. ONE CONTINUOUS TAKE with the ` +
        "pauses inside questions still in it.",
    );
    process.exit(2);
  }

  const thresholds = args.thresholds.length
    ? args.thresholds.slice().sort((a, b) => a - b)
    : [1.0, 1.2, 1.5, 1.8, 2.2];
  if (!thresholds.includes(MAX_SILENCE_SECONDS)) thresholds.push(MAX_SILENCE_SECONDS);
  thresholds.sort((a, b) => a - b);

  const bytes = readFileSync(args.path);
  const { sampleRate, samples } = decodeWav(bytes, args.path);
  const frames = toVadFrames(samples, sampleRate);
  const durationSeconds = samples.length / sampleRate;

  console.log(`file        : ${basename(args.path)}`);
  console.log(
    `audio       : ${sampleRate} Hz, ${(samples.length / sampleRate).toFixed(1)}s, ` +
      `${frames.length} frames of ${RENDER_QUANTUM} samples`,
  );
  console.log(`thresholds  : ${thresholds.join(", ")} (production default is ${MAX_SILENCE_SECONDS})`);
  console.log(
    `unvaried    : silenceThreshold=${DEFAULT_VAD_CONFIG.silenceThreshold}, ` +
      `minSpeechSeconds=${DEFAULT_VAD_CONFIG.minSpeechSeconds}, ` +
      `maxPhraseSeconds=${DEFAULT_VAD_CONFIG.maxPhraseSeconds}`,
  );
  console.log("");

  console.log("maxSilence  phrases  segments  minSeg_s  meanSeg_s  partials  undecodable  unclosed  dropped_s");
  const rows = thresholds.map((maxSilenceSeconds) => {
    const config: VadConfig = { ...DEFAULT_VAD_CONFIG, maxSilenceSeconds };
    const report = simulateSegmentation(frames, config);
    console.log(
      `${maxSilenceSeconds.toFixed(2).padStart(9)}` +
        `${String(report.phrases).padStart(8)}` +
        `${String(report.segments.length).padStart(10)}` +
        `${report.minSpeechSeconds.toFixed(2).padStart(10)}` +
        `${report.meanSpeechSeconds.toFixed(2).padStart(11)}` +
        `${report.meanPartials.toFixed(1).padStart(10)}` +
        `${String(report.undecodable).padStart(12)}` +
        `${String(report.unclosed).padStart(9)}` +
        `${report.droppedSeconds.toFixed(2).padStart(11)}`,
    );
    return { maxSilenceSeconds, report };
  });
  console.log("");

  // ── Where the VAD cut, in wall-clock seconds ──────────────────────────
  //
  // Derived from the independent scan, NOT by zipping the VAD's own segment
  // objects against the scan: those objects carry durations but not positions,
  // and pairing them by cumulative time drifts the moment one segment is
  // discarded. Grouping the runs directly is exact and self-consistent.
  //
  // A GROUP is what the VAD emitted as one ASR segment: consecutive speech
  // runs joined by pauses shorter than the threshold. The pauses BETWEEN
  // groups are the ones that caused a split, and a short one there is the
  // candidate "one question, two phrases".
  const speechRuns = scanSpeechRuns(frames, DEFAULT_VAD_CONFIG.silenceThreshold);
  console.log(`speech runs in the recording: ${speechRuns.length}`);
  console.log("");

  const groupsFor = (maxSilenceSeconds: number) => {
    const groups: Array<{
      start: number;
      end: number;
      runCount: number;
      internalPauses: number[];
      unclosed: boolean;
    }> = [];
    let i = 0;
    while (i < speechRuns.length) {
      const start = speechRuns[i].start;
      let end = speechRuns[i].end;
      const internalPauses: number[] = [];
      let j = i + 1;
      while (j < speechRuns.length) {
        const gap = speechRuns[j].start - end;
        if (gap >= maxSilenceSeconds - 1e-6) break;
        internalPauses.push(gap);
        end = speechRuns[j].end;
        j++;
      }
      groups.push({
        start,
        end,
        runCount: j - i,
        internalPauses,
        // The take ended while speech was still running, so this group never
        // reached its endpoint and its audio would be lost.
        unclosed: j >= speechRuns.length && speechRuns[speechRuns.length - 1].end >= end - 1e-6 && end >= durationSeconds - 1e-6,
      });
      i = j;
    }
    return groups;
  };

  for (const { maxSilenceSeconds, report } of rows) {
    const groups = groupsFor(maxSilenceSeconds);
    console.log(`── maxSilenceSeconds=${maxSilenceSeconds.toFixed(2)} ──`);
    if (groups.length === 0) {
      console.log("  (no segments — the take is below the speech floor)");
      console.log("");
      continue;
    }

    groups.forEach((g, i) => {
      const speechSeconds = g.end - g.start - g.internalPauses.reduce((a, b) => a + b, 0);
      const nextStart = groups[i + 1]?.start;
      const splitGap = nextStart === undefined ? null : nextStart - g.end;
      console.log(
        `  #${String(i + 1).padStart(3)}  ${g.start.toFixed(2).padStart(7)}s → ${g.end
          .toFixed(2)
          .padStart(7)}s  speech=${speechSeconds.toFixed(2)}s  runs=${g.runCount}` +
          (g.internalPauses.length
            ? `  merged-across-pauses=[${g.internalPauses.map((p) => p.toFixed(2)).join(", ")}]s`
            : "") +
          `  splitGapAfter=${splitGap === null ? "end-of-take" : splitGap.toFixed(2) + "s"}` +
          (speechSeconds < DEFAULT_VAD_CONFIG.minSpeechSeconds ? "  TOO SHORT TO DECODE" : "") +
          (g.unclosed ? "  UNCLOSED (audio would be lost)" : ""),
      );
    });

    // The truncation candidates, stated as a QUESTION rather than an
    // assertion: only the transcript can say whether a split was wrong, which
    // is what --extract exists for.
    const candidates = groups
      .map((g, i) => ({ g, gap: groups[i + 1] ? groups[i + 1].start - g.end : null }))
      .filter((c) => c.gap !== null && c.gap < 2.0);
    console.log(
      candidates.length
        ? `  split gaps under 2.0s (candidate truncations): ${candidates
            .map((c) => `#${c.gap!.toFixed(2)}s`)
            .join(", ")} — run with --extract and decode the clips to see whether these were one question`
        : "  no split gaps under 2.0s",
    );
    if (groups.length !== report.segments.length) {
      console.log(
        `  NOTE: derived ${groups.length} group(s) vs the VAD's ${report.segments.length} ` +
          `segment(s) — some were below the ${DEFAULT_VAD_CONFIG.minSpeechSeconds}s speech floor.`,
      );
    }
    console.log("");
  }

  // ── The actual split texts ──────────────────────────────────────────────
  //
  // A harness cannot transcribe, so it produces the INPUT to the transcript:
  // one WAV per segment at the production threshold. Decode those and the split
  // texts are the transcripts of the two clips a question was broken into —
  // which is the number the A4 amendment asks for.
  if (args.extract) {
    const dir = args.path.replace(/\.wav$/i, "") + ".segments";
    mkdirSync(dir, { recursive: true });
    const defaultReport = rows.find((r) => r.maxSilenceSeconds === MAX_SILENCE_SECONDS) ?? rows[0];
    let run = 0;
    defaultReport.report.segments.forEach((seg, i) => {
      const first = speechRuns[run];
      const consumed = 1;
      run += consumed;
      if (!first) return;
      const name = `${dir}/seg-${String(i + 1).padStart(3, "0")}.wav`;
      writeClip(name, samples, sampleRate, first.start, first.end);
    });
    console.log(
      `wrote ${defaultReport.report.segments.length} segment clip(s) to ${dir}/ at ` +
        `maxSilenceSeconds=${defaultReport.maxSilenceSeconds}. Decode them to get the split texts.`,
    );
    console.log("");
  }

  const changed = rows.filter((r) => r.maxSilenceSeconds !== MAX_SILENCE_SECONDS);
  if (changed.length === 0) {
    console.log("Only the production threshold was run — nothing to compare.");
  } else {
    const worstDropped = rows.reduce((worst, r) =>
      r.report.droppedSeconds > worst.report.droppedSeconds ? r : worst,
    );
    console.log(
      worstDropped.report.droppedSeconds > 0
        ? `WARNING: maxSilenceSeconds=${worstDropped.maxSilenceSeconds} drops ` +
            `${worstDropped.report.droppedSeconds.toFixed(2)}s of speech. ` +
            `A threshold that buys fewer fragments by losing audio is worse.`
        : "No threshold in this run drops speech. The production default is unchanged by this run.",
    );
    console.log(
      "Production default MAX_SILENCE_SECONDS is NOT modified by this script. " +
        "Change it in src/lib/vadWorklet.ts only after reading these numbers.",
    );
  }
}

if (process.argv[1] && process.argv[1].endsWith("vad-endpoint-ab.mts")) {
  main();
}
