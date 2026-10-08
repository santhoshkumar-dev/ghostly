/**
 * Transcript quality signals for FINAL ASR output.
 *
 * Moonshine occasionally emits something that is clearly not speech — the kind
 * of thing that then gets promoted to an "authoritative interview question"
 * purely because it happened to contain a question word. Observed examples from
 * real runtime logs:
 *
 *   "(no speech recognised)"
 *   "Mustam a land or mustam a land"
 *   "Instruction of Bardana."
 *   "What is virtual dawn?"          ← a mishearing, handled by normalization
 *
 * ── Design rules (deliberate, mirroring `outputValidation.ts`) ──────────────
 * 1. STRUCTURE ONLY. Every rule below reasons about the *shape* of a string
 *    (an engine sentinel, no letters at all, an exact doubled phrase, a
 *    repeated token). None of them inspect words for meaning.
 * 2. NO TOPIC OR VOCABULARY BLACKLIST. We deliberately do NOT block "trade" or
 *    any other ordinary word. "What is your trade on?" contains a question
 *    word and may well be a legitimate (if oddly worded) question — guessing
 *    otherwise is exactly the over-correction we are avoiding.
 * 3. NOT EVERY GARBLED TRANSCRIPT IS DETECTABLE. "Instruction of Bardana." has
 *    no structural defect; it is a lexical mishearing. Those are fixed
 *    upstream (see `useInterviewAudio.ts` RMS gate and the VAD channel mix),
 *    not guessed at here.
 * 4. FALSE NEGATIVES ARE FINE. A garbled question that slips through produces a
 *    weak answer. A false positive silences a real question mid-interview, which
 *    is far worse.
 *
 * Only FINAL transcripts are ever passed in. Interim/partial text is
 * display-only and never reaches the gate.
 */

export type TranscriptIssue =
  | "non-speech-sentinel"
  | "no-alphabetic-content"
  | "doubled-phrase"
  | "repeated-token-loop";

export interface TranscriptQuality {
  /** True when the transcript is safe to treat as real speech. */
  ok: boolean;
  issue?: TranscriptIssue;
  /** Short reason suitable for the gate's `reason` string. */
  detail?: string;
}

/**
 * Literal strings ASR engines emit to mean "nothing was recognised". These are
 * engine sentinels, not interview content.
 */
const NON_SPEECH_SENTINELS: RegExp[] = [
  /^\(\s*no speech (?:recognised|recognized|detected)\s*\)$/i,
  /^\[\s*(?:blank_audio|no_speech|inaudible|silence)\s*\]$/i,
  /^\(\s*(?:silence|inaudible|inaudible|muffled)\s*\)$/i,
  /^\[(?:silence|inaudible|inaudible)\]$/i,
  /^(?:no speech|nothing|silence|inaudible)(?:\s+(?:recognised|recognized|detected|heard))?\.?$/i,
  /^\.+$/,
];

/**
 * Connectors that can sit between two identical halves of a doubled phrase.
 * Narrow on purpose: "I worked at Google and I worked at Microsoft" must NOT
 * match, because its halves differ (checked separately).
 */
const DOUBLING_SEPARATORS = /\s+(?:or|and|then|and then|again)\s+/i;

const WORD = /[a-z0-9']+/g;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).filter(Boolean);
}

/**
 * Exact structural doubling: the whole utterance is one phrase said twice,
 * optionally joined by a conjunction. Both halves must be *identical*, so a
 * genuine repetition of two different phrases is unaffected.
 */
function isDoubledPhrase(text: string): boolean {
  const parts = text.trim().split(DOUBLING_SEPARATORS);
  if (parts.length !== 2) return false;
  const [a, b] = parts.map((p) => p.trim().replace(/\s+/g, " ").toLowerCase());
  // Require a non-trivial phrase on both sides.
  if (tokenize(a).length < 2 || tokenize(b).length < 2) return false;
  return a === b;
}

/** The same token five or more times in a row — a decoder repetition loop. */
function hasRepeatedTokenLoop(text: string): boolean {
  const words = tokenize(text);
  let run = 1;
  for (let i = 1; i < words.length; i++) {
    run = words[i] === words[i - 1] ? run + 1 : 1;
    if (run >= 5) return true;
  }
  return false;
}

/**
 * Decide whether a FINAL transcript is structurally usable as speech.
 *
 * Returns `{ ok: true }` for anything it cannot prove is an artefact, which is
 * the intended bias.
 */
export function assessTranscriptQuality(text: string): TranscriptQuality {
  const trimmed = (text ?? "").trim();

  if (trimmed.length === 0) {
    return { ok: false, issue: "non-speech-sentinel", detail: "empty transcript" };
  }

  for (const pattern of NON_SPEECH_SENTINELS) {
    if (pattern.test(trimmed)) {
      return {
        ok: false,
        issue: "non-speech-sentinel",
        detail: `ASR reported no usable speech: "${trimmed.slice(0, 40)}"`,
      };
    }
  }

  if (!/[a-z]/i.test(trimmed)) {
    return {
      ok: false,
      issue: "no-alphabetic-content",
      detail: "transcript contains no letters",
    };
  }

  if (isDoubledPhrase(trimmed)) {
    return {
      ok: false,
      issue: "doubled-phrase",
      detail: "transcript is one phrase repeated verbatim",
    };
  }

  if (hasRepeatedTokenLoop(trimmed)) {
    return {
      ok: false,
      issue: "repeated-token-loop",
      detail: "transcript repeats the same token in a loop",
    };
  }

  return { ok: true };
}