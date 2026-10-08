/**
 * Scoring for the ASR repair engine.
 *
 * Every component is a separate, documented weight so the model can be tuned
 * and tested rather than guessed at. The final score answers exactly one
 * question:
 *
 *   "Is there strong evidence that this span is an ASR error, and does this
 *    candidate explain the same audio and context better?"
 *
 * — not "which glossary term is closest?".
 */

import type { Candidate } from "./transcriptCandidates";

export interface ScoreWeights {
  /** How likely the candidate *sounds like* the span. */
  phonetic: number;
  /** How close the candidate is character-wise. */
  lexical: number;
  /** Being a real, known term at all (any candidate is; ASR alts rank higher). */
  knownTermPrior: number;
  /** Whether the candidate fits the sentence's technical framing. */
  sentenceContext: number;
  /** Whether the candidate fits the interrogative structure. */
  questionStructure: number;
  /** Candidate appears in the candidate profile (a boost, never a gate). */
  candidateContext: number;
  /** Candidate was an explicit ASR hypothesis. */
  asrAlternative: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  phonetic: 0.4,
  lexical: 0.2,
  knownTermPrior: 0.1,
  sentenceContext: 0.15,
  questionStructure: 0.1,
  candidateContext: 0.15,
  asrAlternative: 0.1,
};

export interface ScoreThresholds {
  /** Minimum combined score for a correction to be applied at all. */
  minConfidence: number;
  /** Minimum lead of the best candidate over the runner-up. */
  minMargin: number;
  /** Minimum phonetic similarity for a term to be a candidate. */
  minPhonetic: number;
  /** Minimum lexical similarity for a term to be a candidate. */
  minLexical: number;
  /**
   * Stricter bars for a SINGLE-token span. A lone word is easy to match
   * phonetically, so it needs corroborating lexical evidence.
   */
  minPhoneticSingle: number;
  minLexicalSingle: number;
  /** Minimum candidate/span length ratio (a short term cannot explain a long span). */
  minLengthRatio: number;
  /** Maximum candidate/span length ratio. */
  maxLengthRatio: number;
  /**
   * EVIDENCE FLOOR — the strong-similarity bar a replacement must clear on its
   * own, independent of any additive prior (candidate context, sentence
   * framing, question structure, known-term prior).
   *
   * The combined `total` mixes real evidence (phonetic/lexical similarity) with
   * soft priors, so a candidate with weak similarity could previously reach
   * `minConfidence` purely on "this word appears in the candidate profile" plus
   * generic question framing — the root cause of "Explain docker" →
   * "EXPERIENCE" and "starts failing…" → "starts Authentication…".
   *
   * A replacement now requires THAT candidate to be both a strong sound match
   * and a reasonable spelling match. Context/priors may only boost a candidate
   * that already explains the audio; they can never manufacture a match.
   */
  minEvidencePhonetic: number;
  minEvidenceLexical: number;
}

export const DEFAULT_THRESHOLDS: ScoreThresholds = {
  minConfidence: 0.55,
  minMargin: 0.12,
  minPhonetic: 0.5,
  minLexical: 0.55,
  minPhoneticSingle: 0.8,
  minLexicalSingle: 0.7,
  minLengthRatio: 0.75,
  maxLengthRatio: 1.4,
  // Calibrated against the labeled corpus: genuine repairs ("spring wood" →
  // Spring Boot, "cooper netties" → Kubernetes) all score ≥ 0.75 phonetic and
  // ≥ 0.53 lexical, while every observed false positive scores ≤ 0.62 phonetic
  // and ≤ 0.46 lexical. The gap between the two bands is wide, so this bar is
  // conservative in the direction the spec requires: prefer raw over a wrong fix.
  minEvidencePhonetic: 0.72,
  minEvidenceLexical: 0.5,
};

/**
 * Does this candidate explain the span with STRONG evidence of its own?
 *
 * Both a sound match and a spelling match are required. A candidate that merely
 * shares context with the candidate's profile does not qualify.
 */
export function hasStrongEvidence(
  candidate: { phoneticSim: number; lexicalSim: number },
  thresholds: ScoreThresholds = DEFAULT_THRESHOLDS,
): boolean {
  return (
    candidate.phoneticSim >= thresholds.minEvidencePhonetic &&
    candidate.lexicalSim >= thresholds.minEvidenceLexical
  );
}

/** Language that frames a technical / framework question. */
const TECH_FRAMING_CUES =
  /\b(?:what is|what are|what'?s|explain|describe|how does|how do|how would|why did|why do|why would|why is|difference between|tell me about|walk me through|when would|where would|have you used|experience with|used for|what about|how about|define|implement|design|when to use|pros and cons|trade ?offs?)\b/gi;

/**
 * Language that frames an ordinary / general-knowledge question. Deliberately
 * used only as a *penalty*, so an unknown topic is never blocked — it merely
 * has to clear a higher bar to be rewritten as a technology.
 */
const LITERAL_FRAMING_CUES =
  /\b(?:collect|collected|drink|drinking|capital|weather|nation|country|city|invented|who invented|history|river|ocean|sea|forest|garden|kitchen|sleep|eating|food|animal|plant|mountain|island|population)\b/i;

const QUESTION_START =
  /^(?:who|whom|whose|what|which|when|where|why|how)\b/i;
const REQUEST_START =
  /^(?:explain|describe|tell me|tell us|walk me|walk us|define|compare|difference)\b/i;

/** Clamp to [0, 1]. */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * How well the candidate fits the technical framing of the surrounding
 * sentence. Based on the WHOLE sentence, never just the suspicious word.
 */
export function sentenceContextFit(sentence: string): number {
  const techMatches = sentence.match(TECH_FRAMING_CUES)?.length ?? 0;
  let fit = 0.25 + Math.min(techMatches, 3) * 0.2;
  if (LITERAL_FRAMING_CUES.test(sentence)) fit -= 0.5;
  return clamp01(fit);
}

/** How well the candidate fits the interrogative shape of the sentence. */
export function questionStructureFit(sentence: string): number {
  const trimmed = sentence.trim();
  let fit = QUESTION_START.test(trimmed) || REQUEST_START.test(trimmed) ? 0.8 : 0.35;
  if (/\?\s*$/.test(trimmed)) fit += 0.15;
  return clamp01(fit);
}

export interface ScoreBreakdown {
  total: number;
  phonetic: number;
  lexical: number;
  knownTermPrior: number;
  sentenceContext: number;
  questionStructure: number;
  candidateContext: number;
  asrAlternative: number;
}

/**
 * Score one candidate against one span in one sentence.
 *
 * `contextTerms` are compared case-insensitively; a candidate that is present
 * in context receives the boost, but absence costs nothing beyond the missing
 * component — it never disqualifies.
 */
export function scoreCandidate(
  span: string,
  candidate: Candidate,
  sentence: string,
  contextTerms: readonly string[],
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): ScoreBreakdown {
  const contextSet = new Set(contextTerms.map((t) => t.toLowerCase()));
  const candidateContext = contextSet.has(candidate.term.toLowerCase()) ? 1 : 0;
  const knownTermPrior =
    candidate.source === "asr" ? 1 : candidate.source === "context" ? 0.8 : 1;
  const asrAlternative = candidate.source === "asr" ? 1 : 0;

  const sentenceContext = sentenceContextFit(sentence);
  const questionStructure = questionStructureFit(sentence);

  const total = clamp01(
    weights.phonetic * candidate.phoneticSim +
      weights.lexical * candidate.lexicalSim +
      weights.knownTermPrior * knownTermPrior +
      weights.sentenceContext * sentenceContext +
      weights.questionStructure * questionStructure +
      weights.candidateContext * candidateContext +
      weights.asrAlternative * asrAlternative,
  );

  return {
    total,
    phonetic: candidate.phoneticSim,
    lexical: candidate.lexicalSim,
    knownTermPrior,
    sentenceContext,
    questionStructure,
    candidateContext,
    asrAlternative,
  };
}
