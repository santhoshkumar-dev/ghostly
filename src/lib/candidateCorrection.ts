/**
 * Candidate repeated-word correction (transcript-level).
 *
 * Position in the pipeline:
 *
 *   ...  →  interviewer final question  +  candidate correction signal  →  corrected question
 *
 * Notes on the capture architecture (verified from the existing code):
 *
 *   - `useInterviewAudio.ts` captures ONLY system/loopback audio (`getDisplayMedia`
 *     with `audio: true` → primary, `chromeMediaSource: "desktop"` fallback). The
 *     video track is never stopped and there is no second microphone.
 *   - There is no candidate *audio* stream in the current pipeline, so no candidate
 *     capture exists to reuse. The correction therefore runs at the transcript
 *     level, on the already-present *finalised interviewer question text* plus a
 *     candidate signal that the host UI/host runtime can supply later.
 *   - The mechanism is kept "ready for a candidate correction signal" as the spec
 *     requires, but it never fabricates a second ASR stream and never touches
 *     audio capture, Moonshine, Deepgram, Groq Whisper, VAD or the AI chain.
 *
 * Contract (matches the spec):
 *
 *   - The candidate is a *correction signal*, not a new question and not appended
 *     speech. The caller must already have decided whether to answer; this module
 *     does not push text into the AI.
 *   - Only a valid interviewer question may be corrected. If there is no question
 *     yet, the candidate is ignored.
 *   - Evidence must be strong (see the threshold note below).
 *   - Same-phrase / whole-sentence / unrelated candidates are rejected.
 *   - Only the *minimal* relevant term is replaced; a full sentence is never the
 *     replacement.
 *   - Follow-up questions are never merged into the previous one (the caller
 *     controls turn boundaries by submitting a fresh `InterviewTurn`).
 *   - `rawInterviewerText` / `candidateCorrection` are preserved so the raw
 *     transcript survives.
 */

import {
  normalizeForCompare,
  editDistance,
  phoneticSimilarity,
  lexicalSimilarity,
} from "./phonetic";
import {
  isCommonEnglishWord,
  isStopword,
  knownTechTerm,
} from "./transcriptVocabulary";
import {
  DEFAULT_THRESHOLDS,
  hasStrongEvidence,
  type ScoreThresholds,
} from "./transcriptScoring";

/** How many question tokens a single correction span may cover ("spring boat"). */
const MAX_CORRECT_SPAN_TOKENS = 2;

/**
 * How many tokens the CANDIDATE may contain ("MongoDB", "Spring Boot").
 *
 * A longer utterance is the candidate *speaking*, not correcting, so it is never
 * used as a replacement. This is what rejects "MongoDB is a NoSQL database…"
 * structurally, rather than relying on similarity alone.
 */
const MAX_CANDIDATE_TOKENS = 3;

/**
 * Thresholds for the candidate-correction path.
 *
 * Deliberately NOT the voice-path defaults, and deliberately NOT weaker in
 * spirit: this path has a genuinely different evidence source. The voice path
 * must not let a resume/glossary prior carry a candidate over the bar, so its
 * floor is calibrated high (phonetic ≥ 0.72). Here the "candidate" is an
 * explicit, deliberate repetition by a human who heard the question — direct
 * first-hand evidence that the span is wrong, which no glossary prior can match.
 *
 * The floor is still a real floor: phonetic ≥ 0.68 AND lexical ≥ 0.5 must BOTH
 * clear, and the unrelated-pair corpus is rejected with a wide margin (e.g.
 * "Docker" vs "MongoDB" scores 0.43 phonetic / 0.14 lexical).
 *
 * The voice-path `DEFAULT_THRESHOLDS` are untouched by this module.
 */
export const CANDIDATE_CORRECTION_THRESHOLDS: ScoreThresholds = {
  ...DEFAULT_THRESHOLDS,
  minEvidencePhonetic: 0.68,
  minEvidenceLexical: 0.5,
};

/**
 * Pure acknowledgement / conversational filler.
 *
 * The spec is explicit that "Yes, exactly." must NOT be treated as a correction,
 * and "exactly" is phonetically close to plenty of technical words. Rejecting
 * these structurally is safer than hoping the similarity floor catches them.
 */
const ACK_ONLY =
  /^(?:ok(?:ay)?|yes|yeah|yep|ya|no|nope|right|sure|hmm+|uh+h?|um+|alright|great|good|nice|perfect|cool|thanks|thank you|got it|makes sense|i see|i understand|go on|continue|carry on|next|indeed|exactly|correct|true|false|absolutely|definitely|of course|sounds? good)[.!?,;\s'’-]*$/i;

export interface CandidateCorrectionSignal {
  /** The candidate's repeated / corrected term, as spoken. */
  text: string;
  /** Optional timestamp for ordering within a short window (not a strict guard). */
  timestamp?: number;
}

export interface CorrectionDetail {
  from: string;
  to: string;
  confidence: number;
  reason: string;
}

export interface CandidateCorrectionResult {
  /** The untouched interviewer question. */
  rawInterviewerText: string;
  /** The candidate's correction signal, preserved verbatim. */
  candidateCorrection: string;
  /** The final question after a *strongly-evidenced* correction. */
  finalCorrectedQuestion: string;
  /** Whether a correction was actually applied. */
  corrected: boolean;
  /** What changed, in the smallest relevant terms. */
  corrections: CorrectionDetail[];
}

interface Token {
  raw: string;
  start: number;
  end: number;
}

/** Core word characters only — punctuation is excluded so it is never swallowed. */
const CORE_TOKEN = /[A-Za-z0-9][A-Za-z0-9'’-]*/g;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let match: RegExpExecArray | null;
  CORE_TOKEN.lastIndex = 0;
  while ((match = CORE_TOKEN.exec(text)) !== null) {
    tokens.push({
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

/**
 * True when the candidate is a plausible short, term-like utterance.
 *
 * Rejects acknowledgements, empty text, sentences, and anything containing a
 * function word ("MongoDB and …"). Not a whitelist: any term the candidate
 * utters is eligible, it just has to look like a correction, not a reply.
 */
function looksTermLike(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed) return false;
  if (ACK_ONLY.test(trimmed)) return false;

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return false;
  if (tokens.length > MAX_CANDIDATE_TOKENS) return false;
  // A correction is a noun phrase, never a sentence containing a function word.
  return !tokens.some((t) => isStopword(t.raw));
}

/** Compare a suspicious span against the candidate with the existing metrics. */
function candidateMatches(
  span: string,
  candidate: string,
  thresholds: ScoreThresholds,
): { phoneticSim: number; lexicalSim: number } | null {
  const spanNorm = normalizeForCompare(span);
  const candNorm = normalizeForCompare(candidate);
  if (!spanNorm || !candNorm) return null;
  // Exact spelling match is not a correction — this is what keeps
  // "What is Spring Boot?" + "Spring Boot" from duplicating the phrase.
  if (spanNorm === candNorm) return null;

  // Edit-distance guard against pure-length noise.
  const maxLen = Math.max(spanNorm.length, candNorm.length);
  if (maxLen === 0) return null;
  if (editDistance(spanNorm, candNorm) / maxLen > 0.7) return null;

  const phoneticSim = phoneticSimilarity(span, candidate);
  const lexicalSim = lexicalSimilarity(span, candidate);
  if (!hasStrongEvidence({ phoneticSim, lexicalSim }, thresholds)) {
    return null;
  }
  return { phoneticSim, lexicalSim };
}

/**
 * Apply a single-region correction: replace the smallest strong-evidence span in
 * the interviewer question with the candidate term.
 *
 * Returns character offsets alongside the detail so the caller can splice the
 * replacement in WITHOUT touching surrounding punctuation ("What is mango?" →
 * "What is MongoDB?" and not "What is MongoDB").
 */
function tryCorrectQuestion(
  question: string,
  candidate: string,
  thresholds: ScoreThresholds,
): { start: number; end: number; detail: CorrectionDetail } | null {
  const tokens = tokenize(question);
  if (tokens.length === 0) return null;

  // Longest span first, so a 2-token mishearing ("spring boat") is captured
  // wholesale rather than piecemeal.
  for (
    let spanTokens = Math.min(MAX_CORRECT_SPAN_TOKENS, tokens.length);
    spanTokens >= 1;
    spanTokens -= 1
  ) {
    for (let start = 0; start + spanTokens <= tokens.length; start += 1) {
      const slice = tokens.slice(start, start + spanTokens);
      const region = slice.map((t) => t.raw).join(" ");

      if (normalizeForCompare(region).length < 3) continue;
      // A span must never contain a function word: the misheard content word is
      // the anchor, so "is mongo db" is never one span ("mongo db" is).
      if (slice.some((t) => isStopword(t.raw))) continue;

      // Keep-raw rule, mirroring `transcriptCorrection.tryCorrectSpan`: a span
      // made ENTIRELY of already-valid words is not a mishearing. Note this is
      // deliberately NOT "the first token must be unusual" — "Spring boat"
      // starts with the perfectly ordinary word "Spring", and only "boat" is
      // suspicious, so the span is still eligible.
      if (
        knownTechTerm(region) === null &&
        slice.every((t) => isCommonEnglishWord(t.raw) || knownTechTerm(t.raw) !== null)
      ) {
        continue;
      }

      const match = candidateMatches(region, candidate, thresholds);
      if (!match) continue;

      return {
        start: slice[0].start,
        end: slice[slice.length - 1].end,
        detail: {
          from: region,
          to: candidate.trim(),
          confidence: Math.min(match.phoneticSim, match.lexicalSim),
          reason: "candidate correction",
        },
      };
    }
  }
  return null;
}

/** The single "nothing was corrected" result, built once. */
function unchanged(
  raw: string,
  candidate: string,
): CandidateCorrectionResult {
  return {
    rawInterviewerText: raw,
    candidateCorrection: candidate,
    finalCorrectedQuestion: raw,
    corrected: false,
    corrections: [],
  };
}

/**
 * Correct an interviewer question using a candidate correction signal.
 *
 * Pure, deterministic and no side effects. Returns the corrected question when
 * the candidate is a strong, term-like correction of a span in the question;
 * otherwise returns the question unchanged with `corrected: false`.
 */
export function correctQuestionWithCandidate(
  interviewerQuestion: string,
  candidateSignal: CandidateCorrectionSignal,
  thresholds: ScoreThresholds = CANDIDATE_CORRECTION_THRESHOLDS,
): CandidateCorrectionResult {
  const raw = interviewerQuestion.trim();
  const candidate = candidateSignal.text.trim();

  // No active interviewer question → no correction, and nothing to send to the AI.
  if (!raw) return unchanged(raw, candidate);
  if (!looksTermLike(candidate)) return unchanged(raw, candidate);

  const correction = tryCorrectQuestion(raw, candidate, thresholds);
  if (!correction) return unchanged(raw, candidate);

  // Splice by offset so trailing punctuation ("?") is preserved verbatim.
  const final =
    raw.slice(0, correction.start) +
    correction.detail.to +
    raw.slice(correction.end);

  // Safety: never let self-correction create garbage.
  if (final === raw) return unchanged(raw, candidate);

  return {
    rawInterviewerText: raw,
    candidateCorrection: candidate,
    finalCorrectedQuestion: final,
    corrected: true,
    corrections: [correction.detail],
  };
}