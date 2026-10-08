/**
 * Voice-activity-detection thresholds and the phrase-segmentation model.
 *
 * ── Why this is extracted from the worklet string ───────────────────────────
 * The VAD thresholds used to live as `this.SILENCE_THRESHOLD = 0.008` /
 * `this.MAX_SILENCE_SECONDS = 1.0` inside a template-literal AudioWorklet. That
 * made them impossible to unit-test (a worklet blob cannot be imported into a
 * Node test run) and impossible to change without editing a string, which is
 * exactly the situation that produced the fragmentation problem: `MAX_SILENCE`
 * was tuned by feel, at 1.0 s, and never measured.
 *
 * The thresholds are now plain data here, and {@link buildVadWorkletCode}
 * injects them into the worklet source. The numbers the worklet runs on are the
 * numbers the test asserts on, so they cannot drift apart.
 *
 * ── The segmentation decision this file exists to settle ────────────────────
 * A phrase ends when silence accumulates to `MAX_SILENCE_SECONDS`. The previous
 * value of 1.0 s ends a phrase on any one-second pause — but interviewers
 * pause to think, to breathe, and at clause boundaries, and all three routinely
 * exceed one second. The result was a single question arriving as three or four
 * independently-decoded fragments, each of which Finding #1 (the token-budget
 * defect) then starved.
 *
 * Raising the threshold trades that against the opposite failure: merging two
 * genuinely separate questions into one segment. {@link simulateSegmentation}
 * exists to measure the trade-off instead of guessing at it.
 */

/** RMS below this is treated as a non-speech frame. */
export const SILENCE_THRESHOLD = 0.008;

/**
 * Silence required to close a phrase, in seconds.
 *
 * Internally configurable — not a user setting. It is a segmentation parameter
 * with a measured trade-off, and exposing it in the UI would invite a value that
 * has not been measured.
 *
 * ── How 1.5 s was chosen (measured, not guessed) ──────────────────────────
 * `scripts/verify-asr.mts` runs a realistic three-clause question
 * (12.7 s of speech, clause pauses of 0.8 / 1.0 s, a 2.0 s thinking pause, and
 * a 1.6 s trailing pause) through `simulateSegmentation` at each candidate:
 *
 *     threshold  segments  undecodable  dropped
 *     1.0s          3            0     0.00s   <- the old value: shredded
 *     1.5s          2            0     0.00s   <- selected
 *     1.8s          2            1     2.81s   <- REJECTED, it drops audio
 *
 * 1.0 s split the question at every clause boundary into three independently
 * decoded fragments. That was survivable only because the token-budget defect
 * (Finding #1) meant fragments were already being destroyed — fixing that defect
 * without fixing fragmentation would have multiplied a good decode across three
 * shorter, worse-conditioned ones.
 *
 * 1.5 s halves that (3 fragments → 2) and drops nothing.
 *
 * 1.8 s was the obvious next candidate and the measurement REJECTED it. A
 * phrase is only ever emitted by `endPhrase()`, which fires on accumulated
 * silence — so a threshold above the length of the question's own trailing
 * pause means that pause never closes the phrase and the final clause is never
 * committed AT ALL. 1.8 s did not merge the fragment away; it silently deleted
 * 2.81 s of the question. That is strictly worse than a fragment, so 1.5 s is
 * selected as the highest threshold that loses nothing.
 *
 * The remaining cost of 1.5 s — a two-fragment question — is acceptable only
 * because the token budget is now correct: both fragments (6.35 s and 3.50 s)
 * decode with a real budget, and `normalizeTurn` merges the transcripts in the
 * renderer. Fragments are recoverable; dropped audio is not.
 *
 * The measurement reports `droppedSeconds` and `unclosed` explicitly, and the
 * test suite asserts they are zero, so 1.8 s cannot be reintroduced by anyone
 * who only looks at the fragment count.
 */
export const MAX_SILENCE_SECONDS = 1.5;

/** Discard blips shorter than this as non-speech. */
export const MIN_SPEECH_SECONDS = 0.35;

/** How often a rolling interim snapshot is emitted during speech. */
export const STREAM_INTERVAL_SECONDS = 0.7;

/** Stop emitting interim snapshots past this phrase length. */
export const MAX_PARTIAL_SECONDS = 20;

/** Force-flush a monologue past this length. */
export const MAX_PHRASE_SECONDS = 30;

/** Level-reporting cadence for the live UI meter (~20/s). */
export const LEVEL_INTERVAL_SECONDS = 0.05;

export interface VadConfig {
  silenceThreshold: number;
  maxSilenceSeconds: number;
  minSpeechSeconds: number;
  streamIntervalSeconds: number;
  maxPartialSeconds: number;
  maxPhraseSeconds: number;
  levelIntervalSeconds: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  silenceThreshold: SILENCE_THRESHOLD,
  maxSilenceSeconds: MAX_SILENCE_SECONDS,
  minSpeechSeconds: MIN_SPEECH_SECONDS,
  streamIntervalSeconds: STREAM_INTERVAL_SECONDS,
  maxPartialSeconds: MAX_PARTIAL_SECONDS,
  maxPhraseSeconds: MAX_PHRASE_SECONDS,
  levelIntervalSeconds: LEVEL_INTERVAL_SECONDS,
};

export interface VadFrame {
  /** Length of this frame in seconds (the real render quantum, 128 samples). */
  seconds: number;
  /** RMS amplitude of the frame. */
  rms: number;
}

export type VadEvent =
  /** A phrase was emitted for transcribing. */
  | { type: "speech"; seconds: number; phraseId: number }
  /** A rolling interim snapshot of the phrase in progress. */
  | { type: "partial"; seconds: number; phraseId: number }
  /** A phrase ended — ALWAYS emitted, even when the audio is discarded. */
  | { type: "phraseClosed"; phraseId: number }
  /** A level sample for the UI meter. */
  | { type: "level"; rms: number; speaking: boolean };

/**
 * A pure, framework-free model of exactly what the worklet's `process()` does.
 *
 * This mirrors the worklet line for line and is what the fragmentation
 * measurement runs against, so a change to the worklet's decision logic has to
 * be made in both places to stay honest — and the worklet's thresholds are
 * generated from {@link DEFAULT_VAD_CONFIG}, so the numbers cannot diverge.
 */
export function simulateVad(
  frames: VadFrame[],
  config: VadConfig = DEFAULT_VAD_CONFIG,
): VadEvent[] {
  const events: VadEvent[] = [];
  let audioBufferLength = 0; // in "frames", only used as a non-empty test
  let silenceSeconds = 0;
  let speechSeconds = 0;
  let streamSeconds = 0;
  let levelSeconds = 0;
  let phraseId = 0;

  const reset = () => {
    audioBufferLength = 0;
    silenceSeconds = 0;
    speechSeconds = 0;
    streamSeconds = 0;
  };

  const endPhrase = () => {
    const closedPhraseId = phraseId;
    phraseId++;
    if (speechSeconds >= config.minSpeechSeconds) {
      events.push({ type: "speech", seconds: speechSeconds, phraseId: closedPhraseId });
    }
    // ALWAYS announced, even when discarded — see the worklet for why.
    events.push({ type: "phraseClosed", phraseId: closedPhraseId });
    reset();
  };

  for (const frame of frames) {
    levelSeconds += frame.seconds;
    if (levelSeconds >= config.levelIntervalSeconds) {
      events.push({
        type: "level",
        rms: frame.rms,
        speaking: speechSeconds > 0,
      });
      levelSeconds = 0;
    }

    if (frame.rms > config.silenceThreshold) {
      silenceSeconds = 0;
      speechSeconds += frame.seconds;
      audioBufferLength++;
      streamSeconds += frame.seconds;
      if (
        streamSeconds >= config.streamIntervalSeconds &&
        speechSeconds <= config.maxPartialSeconds
      ) {
        streamSeconds = 0;
        events.push({ type: "partial", seconds: speechSeconds, phraseId });
      }
      if (speechSeconds >= config.maxPhraseSeconds) {
        endPhrase();
      }
    } else if (audioBufferLength > 0) {
      // Keep buffering through the pause: cutting here clips word tails.
      audioBufferLength++;
      silenceSeconds += frame.seconds;
      if (silenceSeconds >= config.maxSilenceSeconds) {
        endPhrase();
      }
    }
  }

  return events;
}

/** One measured segment, as produced by a fragmentation measurement. */
export interface FragmentationSegment {
  phraseId: number;
  /** Total speech seconds (the worklet reports this, not buffer length). */
  speechSeconds: number;
  /** Buffer length in seconds, including the trailing pause. */
  bufferSeconds: number;
  /** Interim snapshots that fired before the phrase closed. */
  partials: number;
  /**
   * True when the timeline ended while this phrase was still open.
   *
   * A phrase is only ever emitted by `endPhrase()`, which fires on silence or
   * the `MAX_PHRASE_SECONDS` cap. A timeline (or a stopped capture session)
   * that ends mid-phrase therefore DROPS that audio entirely. Counting it as a
   * segment would overstate fragmentation, but hiding it would make a
   * measurement silently wrong — so it is reported explicitly.
   */
  unclosed: boolean;
}

export interface FragmentationReport {
  maxSilenceSeconds: number;
  /** How many decodable phrases the timeline produced. */
  phrases: number;
  /** Phrases that will be sent to the ASR (i.e. passed MIN_SPEECH_SECONDS). */
  segments: FragmentationSegment[];
  /** Segments shorter than the 1.0 s decodable minimum — these cannot decode. */
  undecodable: number;
  /** Segments that never closed (audio that would be dropped, not merged). */
  unclosed: number;
  /**
   * Speech seconds that would be LOST — i.e. the timeline did not end with
   * enough silence to close the last phrase. A non-zero value means the
   * threshold is so high that a question finishing with an ordinary pause is
   * never committed at all.
   */
  droppedSeconds: number;
  /** Mean speech seconds per segment. */
  meanSpeechSeconds: number;
  /** Shortest segment, in speech seconds. */
  minSpeechSeconds: number;
  /** Interim snapshots per segment — a proxy for "how choppy does this feel". */
  meanPartials: number;
}

/**
 * Run a timeline through the VAD and report how it fragmented.
 *
 * The measurement the threshold decision is based on: given a realistic
 * interview-shaped timeline, how many ASR segments does each `MAX_SILENCE`
 * value produce, and how short is the worst one.
 */
export function simulateSegmentation(
  frames: VadFrame[],
  config: VadConfig = DEFAULT_VAD_CONFIG,
): FragmentationReport {
  const events = simulateVad(frames, config);
  const segments: FragmentationSegment[] = [];
  let current: FragmentationSegment | null = null;
  let bufferSeconds = 0;
  let partials = 0;

  for (const event of events) {
    if (event.type === "level") continue;
    if (event.type === "partial") {
      if (current) partials++;
      continue;
    }
    if (event.type === "speech") {
      current = {
        phraseId: event.phraseId,
        speechSeconds: event.seconds,
        bufferSeconds: 0,
        partials,
        unclosed: false,
      };
      partials = 0;
      continue;
    }
    // phraseClosed
    bufferSeconds = 0;
    if (current) {
      current.bufferSeconds = current.speechSeconds;
      segments.push(current);
      current = null;
    }
  }

  // A phrase that emitted `speech` but never reached `phraseClosed` (the
  // timeline ended between the two) — still recorded, still flagged.
  if (current) {
    current.bufferSeconds = current.speechSeconds;
    current.unclosed = true;
    segments.push(current);
    current = null;
  }

  // ── The phrase that never closed ──────────────────────────────────────────
//
// `endPhrase()` is the ONLY thing that emits a `speech` event, and it fires on
// either accumulated silence or the `MAX_PHRASE_SECONDS` cap. A phrase that is
// still accumulating when the timeline ends therefore emits NOTHING: no
// `speech`, no `phraseClosed`, only `partial`s.
//
// That is not fragmentation — it is total loss, and it is invisible if the
// measurement only counts emitted phrases. It is also a direct consequence of
// raising `MAX_SILENCE_SECONDS`: a higher threshold means more audio has to
// arrive before anything is committed at all. So the measurement has to see it,
// or it will happily recommend a threshold that silently eats the end of every
// question.
  const lastClosedPhraseId = events
    .filter((e) => e.type === "phraseClosed")
    .reduce((max, e) => Math.max(max, e.type === "phraseClosed" ? e.phraseId : -1), -1);
  const openPhraseId = [...events]
    .reverse()
    .find((e) => e.type === "partial");
  if (openPhraseId && openPhraseId.type === "partial") {
    const openId = openPhraseId.phraseId;
    if (openId > lastClosedPhraseId) {
      // Recover the accumulated speech time from the last interim snapshot.
      let openSeconds = 0;
      let openPartials = 0;
      for (const e of events) {
        if (e.type === "partial" && e.phraseId === openId) {
          openSeconds = Math.max(openSeconds, e.seconds);
          openPartials++;
        }
      }
      segments.push({
        phraseId: openId,
        speechSeconds: openSeconds,
        bufferSeconds: openSeconds,
        partials: openPartials,
        unclosed: true,
      });
    }
  }

  const speechTotal = segments.reduce((n, s) => n + s.speechSeconds, 0);
  const partialTotal = segments.reduce((n, s) => n + s.partials, 0);
  return {
    maxSilenceSeconds: config.maxSilenceSeconds,
    phrases: segments.length,
    segments,
    undecodable: segments.filter((s) => s.speechSeconds < 1.0).length,
    unclosed: segments.filter((s) => s.unclosed).length,
    droppedSeconds: segments
      .filter((s) => s.unclosed)
      .reduce((n, s) => n + s.speechSeconds, 0),
    meanSpeechSeconds:
      segments.length > 0 ? speechTotal / segments.length : 0,
    minSpeechSeconds:
      segments.length > 0
        ? Math.min(...segments.map((s) => s.speechSeconds))
        : 0,
    meanPartials: segments.length > 0 ? partialTotal / segments.length : 0,
  };
}

/**
 * The AudioWorklet source, with every threshold injected from `config`.
 *
 * Kept byte-for-byte equivalent in logic to {@link simulateVad} so the
 * measurement describes the code that actually runs.
 */
export function buildVadWorkletCode(config: VadConfig = DEFAULT_VAD_CONFIG): string {
  return `
class VADProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.audioBuffer = [];
    this.silenceSeconds = 0;
    this.speechSeconds = 0;
    this.streamSeconds = 0;
    this.phraseId = 0;
    // Thresholds are in SECONDS, derived from the real render quantum
    // (128 samples) + sampleRate. The previous frame-count version assumed a
    // ~0.25s buffer and ended a phrase after ~27ms of silence.
    this.SILENCE_THRESHOLD = ${config.silenceThreshold};
    this.MAX_SILENCE_SECONDS = ${config.maxSilenceSeconds};
    this.MIN_SPEECH_SECONDS = ${config.minSpeechSeconds};
    this.STREAM_INTERVAL_SECONDS = ${config.streamIntervalSeconds};
    this.MAX_PARTIAL_SECONDS = ${config.maxPartialSeconds};
    this.MAX_PHRASE_SECONDS = ${config.maxPhraseSeconds};
    this.levelSeconds = 0;
    this.peak = 0;
    this.reportedChannels = 0;
    // Whether the MOST RECENT frame was below the silence threshold.
    //
    // 'speaking' on the level message is 'speechSeconds > 0', which stays true
    // for the whole trailing pause, so it cannot distinguish "interviewer is
    // mid-word" from "interviewer finished and the phrase is waiting for its
    // endpoint". This flag can, and that distinction is the whole basis of the
    // force-endpoint decision.
    this.lastFrameSilent = true;
    // Level reporting cadence for the live UI meter. ~20/s is smooth enough to
    // look continuous and cheap enough not to flood the main thread.
    this.LEVEL_INTERVAL_SECONDS = ${config.levelIntervalSeconds};

    // ── Force-endpoint ────────────────────────────────────────────────
    // INERT unless the renderer asks. Nothing about segmentation, buffering or
    // thresholds changes: this only lets the EXISTING endPhrase() run early,
    // once, on request.
    this.port.onmessage = (e) => {
      if (!e.data || e.data.type !== 'force-endpoint') return;
      const speechSeconds = this.speechSeconds;
      const phraseOpen = this.audioBuffer.length > 0 && speechSeconds > 0;
      // Authoritative re-check: the renderer decides first, but only the
      // worklet knows the state of the last frame it actually processed.
      const speakingNow = !this.lastFrameSilent;
      if (!phraseOpen || speakingNow || speechSeconds < this.MIN_SPEECH_SECONDS) {
        this.port.postMessage({
          type: 'forceEndpointResult',
          fired: false,
          bufferedSeconds: speechSeconds,
          speakingNow: speakingNow,
        });
        return;
      }
      // Same code path as a silence endpoint or the phrase cap. One call, one
      // 'speech' message, one 'phraseClosed' message — identical to normal.
      this.endPhrase();
      this.port.postMessage({
        type: 'forceEndpointResult',
        fired: true,
        bufferedSeconds: speechSeconds,
        speakingNow: false,
      });
    };
  }

  merge() {
    const total = this.audioBuffer.reduce((acc, val) => acc + val.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const buffer of this.audioBuffer) {
      merged.set(buffer, offset);
      offset += buffer.length;
    }
    return merged;
  }

  reset() {
    this.audioBuffer = [];
    this.silenceSeconds = 0;
    this.speechSeconds = 0;
    this.streamSeconds = 0;
  }

  endPhrase() {
    const closedPhraseId = this.phraseId;
    this.phraseId++;
    if (this.speechSeconds >= this.MIN_SPEECH_SECONDS) {
      const merged = this.merge();
      this.port.postMessage(
        { type: 'speech', buffer: merged, seconds: this.speechSeconds, phraseId: closedPhraseId },
        [merged.buffer],
      );
    } else {
      this.port.postMessage({
        type: 'log',
        message: 'Speech too short (' + this.speechSeconds.toFixed(2) + 's), discarding',
      });
    }
    // ALWAYS announce the close, even when the phrase is discarded.
    //
    // Previously a discarded phrase advanced the id but sent no message, so the
    // renderer never cleared the interim line for it. The stale interim text
    // then satisfied the gate's "interviewer is still speaking" check forever,
    // and every later question was stuck behind a permanent WAIT.
    this.port.postMessage({ type: 'phraseClosed', phraseId: closedPhraseId });
    this.reset();
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    // ── Downmix to mono across ALL channels ────────────────────────────
    // This previously read only input[0], silently discarding the right
    // channel of a stereo loopback stream. Some Bluetooth profiles and call
    // apps place most of the voice energy in the right channel; when that
    // happened the left-only RMS fell below SILENCE_THRESHOLD and the phrase
    // was never detected at all, which surfaced as "(no speech recognised)".
    const channelCount = input.length;
    let channelData = input[0];
    if (channelCount > 1) {
      const mixed = new Float32Array(channelData.length);
      for (let c = 0; c < channelCount; c++) {
        const data = input[c];
        if (!data) continue;
        for (let i = 0; i < mixed.length; i++) mixed[i] += data[i];
      }
      for (let i = 0; i < mixed.length; i++) mixed[i] /= channelCount;
      channelData = mixed;
    }
    if (this.reportedChannels !== channelCount) {
      this.reportedChannels = channelCount;
      this.port.postMessage({
        type: 'log',
        message: 'Loopback audio is ' + channelCount + '-channel, downmixed to mono',
      });
    }

    const frameSeconds = channelData.length / sampleRate;
    let sum = 0;
    let framePeak = 0;
    for (let i = 0; i < channelData.length; i++) {
      const v = channelData[i];
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > framePeak) framePeak = a;
    }
    const rms = Math.sqrt(sum / channelData.length);

    // Every frame updates this, so the force-endpoint handler always reads the
    // state of the frame that was actually processed rather than a stale one.
    this.lastFrameSilent = rms <= this.SILENCE_THRESHOLD;

    // Report a level reading ~20x/second for the live meter, plus whether the
    // VAD is currently inside a speech run. This is the SAME signal that is
    // segmented and sent to the ASR — not the microphone — so the meter tells
    // the truth about what the interviewer path actually receives.
    if (framePeak > this.peak) this.peak = framePeak;
    this.levelSeconds += frameSeconds;
    if (this.levelSeconds >= this.LEVEL_INTERVAL_SECONDS) {
      this.port.postMessage({
        type: 'level',
        rms: rms,
        peak: this.peak,
        speaking: this.speechSeconds > 0,
        // Additive fields. Existing consumers ignore them.
        phraseOpen: this.audioBuffer.length > 0 && this.speechSeconds > 0,
        speechSeconds: this.speechSeconds,
        silentNow: this.lastFrameSilent,
      });
      this.levelSeconds = 0;
      this.peak = 0;
    }

    if (rms > this.SILENCE_THRESHOLD) {
      this.silenceSeconds = 0;
      this.speechSeconds += frameSeconds;
      this.audioBuffer.push(new Float32Array(channelData));

      // Streaming: hand out the utterance so far so words can appear live.
      this.streamSeconds += frameSeconds;
      if (
        this.streamSeconds >= this.STREAM_INTERVAL_SECONDS &&
        this.speechSeconds <= this.MAX_PARTIAL_SECONDS
      ) {
        this.streamSeconds = 0;
        const merged = this.merge();
        this.port.postMessage(
          { type: 'partial', buffer: merged, seconds: this.speechSeconds, phraseId: this.phraseId },
          [merged.buffer],
        );
      }

      // Safety valve — never let one utterance grow unbounded.
      if (this.speechSeconds >= this.MAX_PHRASE_SECONDS) {
        this.endPhrase();
      }
    } else if (this.audioBuffer.length > 0) {
      // Keep buffering during the pause too — cutting it off clips word tails.
      this.audioBuffer.push(new Float32Array(channelData));
      this.silenceSeconds += frameSeconds;

      if (this.silenceSeconds >= this.MAX_SILENCE_SECONDS) {
        this.endPhrase();
      }
    }
    return true;
  }
}
registerProcessor('vad-processor', VADProcessor);
`;
}
