/**
 * The dev-only debug WAV dump.
 *
 * ── Why the writer was lying about the audio ───────────────────────────────
 * The old writer did this for every sample:
 *
 *     let s = Math.max(-1, Math.min(1, samples[i]));
 *
 * That clamp is required to fit a 16-bit sample, and on its own it is fine.
 * The problem is that it was the ONLY thing that happened: samples above +1.0
 * or below -1.0 — i.e. actual clipping in the captured signal — were flattened
 * to the rails and then written out as if nothing had happened. So the WAV
 * rendered as a clean, flat-topped waveform, and someone listening to the
 * evidence recording could not tell a healthy take from a destroyed one.
 *
 * Since the whole point of the debug dump is to be the ground truth for "what
 * did the ASR actually receive", a writer that smooths over the exact defect
 * being investigated is worse than no writer at all.
 *
 * The 16-bit clamp is kept (it is what makes the file playable), but the
 * number of clipped samples and the true pre-clamp peak are now measured and
 * returned, so the caller can report them and a test can assert on them.
 *
 * ── Why it is dev-only and opt-in ──────────────────────────────────────────
 * This writes the interviewer's voice to a file. That is interview
 * material — potentially confidential, and in some jurisdictions recording
 * consent laws apply. It is therefore:
 *
 *   • compiled out of production builds entirely (`import.meta.env.DEV`), and
 *   • additionally OFF unless explicitly switched on at runtime.
 *
 * Nothing here uploads, transmits or logs audio. The blob becomes an object
 * URL for a local `<audio>` element and nothing else. Files written by the
 * "save to disk" path are gitignored (`debug-audio/`).
 */

/** Where a manually saved debug WAV goes. Gitignored — never committed. */
export const DEBUG_AUDIO_DIR = "debug-audio";

/** True only in a dev build. Production builds have this compiled to false. */
export function isDebugWavAvailable(): boolean {
  return import.meta.env.DEV;
}

/**
 * Runtime opt-in. Separate from availability: even in dev, dumping is off until
 * asked for, so a normal `npm run dev` session records nothing.
 */
let optedIn = false;

export function isDebugWavEnabled(): boolean {
  return isDebugWavAvailable() && optedIn;
}

/** Turn the dump on/off. Ignored outside a dev build. */
export function setDebugWavEnabled(enabled: boolean): void {
  optedIn = isDebugWavAvailable() && enabled;
}

export interface WavClipping {
  /** Samples whose magnitude exceeded 1.0 and were clamped. */
  clippedSamples: number;
  /** Samples at or beyond the rail after clamping (saturation). */
  saturatedSamples: number;
  /** True peak BEFORE clamping — may exceed 1.0, which is the whole point. */
  truePeak: number;
  /** Fraction of samples clipped, 0–1. */
  clippedFraction: number;
}

export interface WavResult {
  blob: Blob;
  clipping: WavClipping;
}

/**
 * Encode 16-bit PCM WAV, and REPORT the clipping rather than hiding it.
 *
 * The returned {@link WavClipping} is what makes the file trustworthy: a
 * `clippedSamples > 0` dump is evidence that the capture path is losing signal
 * and needs gain staging, which is a conclusion the old writer made impossible
 * to reach.
 */
export function float32ToWavWithClipping(
  samples: Float32Array,
  sampleRate: number,
): WavResult {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (view: DataView, offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  let clippedSamples = 0;
  let saturatedSamples = 0;
  let truePeak = 0;

  for (let i = 0; i < samples.length; i++, offset += 2) {
    const raw = samples[i];
    const magnitude = raw < 0 ? -raw : raw;
    if (magnitude > truePeak) truePeak = magnitude;
    if (magnitude > 1) clippedSamples++;
    // Clamp for the 16-bit range — but count it, so the caller can say so.
    const s = raw < -1 ? -1 : raw > 1 ? 1 : raw;
    if (magnitude >= 1) saturatedSamples++;
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return {
    blob: new Blob([view], { type: "audio/wav" }),
    clipping: {
      clippedSamples,
      saturatedSamples,
      truePeak,
      clippedFraction: samples.length > 0 ? clippedSamples / samples.length : 0,
    },
  };
}

/** One-line clipping report for the ASR log. */
export function describeClipping(clipping: WavClipping): string {
  if (clipping.clippedSamples === 0) {
    return `no clipping (truePeak=${clipping.truePeak.toFixed(3)})`;
  }
  return `CLIPPING: ${clipping.clippedSamples} samples over full scale (${(
    clipping.clippedFraction * 100
  ).toFixed(2)}% of the clip, truePeak=${clipping.truePeak.toFixed(
    3,
  )}) — the true waveform exceeds ±1.0 and this recording under-represents it`;
}
