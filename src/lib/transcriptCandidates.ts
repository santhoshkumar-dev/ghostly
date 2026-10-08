/**
 * Candidate generation for the ASR repair engine.
 *
 * Candidates come from four independent sources, and a candidate NEVER has to
 * appear in the candidate's profile:
 *
 *   A. ASR alternatives   — n-best / word alternatives, if the engine exposes them
 *   B. candidate context  — resume / projects / company / skills (a boost, not a gate)
 *   C. general vocabulary — open-world technical terms
 *   D. phonetic neighbours of any of the above
 *
 * This module is pure. It does not decide anything; it only produces the pool
 * the scorer ranks.
 *
 * Performance: general-vocabulary signatures (normalized + phonetic keys) are
 * precomputed once at module load, and a cheap length filter rejects terms
 * before any edit-distance work. This keeps per-utterance latency in the low
 * milliseconds — required for a live interview assistant.
 */

import {
  editDistance,
  normalizeForCompare,
  phoneticKey,
} from "./phonetic";
import {
  allTechTerms,
  isStylizedTerm,
  type CandidateContext,
} from "./transcriptVocabulary";

export type CandidateSource = "asr" | "context" | "vocabulary";

export interface Candidate {
  /** Canonical spelling that would replace the span. */
  term: string;
  source: CandidateSource;
  phoneticSim: number;
  lexicalSim: number;
}

export interface CandidateOptions {
  /**
   * Minimum phonetic / lexical similarity for a term to even be considered.
   * Both are tested with OR, so a strong lexical match (an exact-ish spelling)
   * or a strong phonetic match (a plausible mishearing) qualifies.
   */
  minPhonetic: number;
  minLexical: number;
  /** Stricter bars applied when the span is a single token. */
  minPhoneticSingle: number;
  minLexicalSingle: number;
  /**
   * A candidate must cover a minimum fraction of the span's length. This is
   * what stops a short term ("Spring") from "explaining" a longer span
   * ("spring wood") just because it shares a prefix.
   */
  minLengthRatio: number;
  /** Maximum candidate/span length ratio (candidate far longer than span). */
  maxLengthRatio: number;
  /** Extra n-best alternatives from the ASR engine, if any. */
  asrAlternatives?: readonly string[];
}

interface TermSignature {
  term: string;
  norm: string;
  phon: string;
  source: CandidateSource;
}

/** Normalized + phonetic signature for one candidate term. */
function signature(term: string, source: CandidateSource): TermSignature {
  const norm = normalizeForCompare(term);
  return { term, norm, phon: phoneticKey(term), source };
}

/** Precomputed signatures for the static, open-world vocabulary. */
const VOCABULARY_SIGNATURES: readonly TermSignature[] = allTechTerms().map((t) =>
  signature(t, "vocabulary"),
);

const SOURCE_RANK: Record<CandidateSource, number> = {
  asr: 3,
  context: 2,
  vocabulary: 1,
};

/**
 * Build the candidate pool for one suspicious span.
 *
 * `compareText` is what similarity is measured against — normally the span with
 * function words stripped, so "rabbit Q" matches "RabbitMQ" without a leading
 * "is" diluting the comparison.
 */
export function generateCandidates(
  compareText: string,
  context: CandidateContext,
  options: CandidateOptions,
): Candidate[] {
  const spanNorm = normalizeForCompare(compareText);
  if (!spanNorm) return [];
  const spanPhon = phoneticKey(compareText);
  const spanTokenCount = compareText.trim().split(/\s+/).filter(Boolean).length;
  const isSingle = spanTokenCount === 1;
  const minPhonetic = isSingle ? options.minPhoneticSingle : options.minPhonetic;
  const minLexical = isSingle ? options.minLexicalSingle : options.minLexical;
  const minThreshold = Math.min(minPhonetic, minLexical);

  const seen = new Map<string, Candidate>();

  const consider = (sig: TermSignature) => {
    // Truly identical spelling is not a correction.
    if (sig.term === compareText) return;

    // A term whose *normalized* form already matches is only a candidate when
    // its canonical spelling is stylized (an acronym or a brand spelling like
    // "MongoDB" / "Node.js"). Plain Title Case ("Dependency Injection") is not
    // worth overriding ordinary casing in a sentence.
    if (sig.norm === spanNorm && !isStylizedTerm(sig.term)) return;

    // Cheap length filter: similarity cannot exceed 1 - |Δlen| / maxLen, so a
    // term that is too far from the span's length cannot pass the threshold.
    const maxLen = Math.max(spanNorm.length, sig.norm.length);
    if (maxLen > 0 && 1 - Math.abs(spanNorm.length - sig.norm.length) / maxLen < minThreshold) {
      return;
    }

    const maxLenP = Math.max(spanPhon.length, sig.phon.length);
    if (maxLenP > 0 && 1 - Math.abs(spanPhon.length - sig.phon.length) / maxLenP < minThreshold) {
      return;
    }

    const lexicalSim = 1 - editDistance(spanNorm, sig.norm) / Math.max(spanNorm.length, sig.norm.length);
    const phoneticSim = 1 - editDistance(spanPhon, sig.phon) / Math.max(spanPhon.length, sig.phon.length);
    if (isSingle) {
      // A lone word is too easy to match phonetically (native ≈ Netlify), so a
      // single token requires corroborating lexical evidence.
      if (lexicalSim < options.minLexicalSingle) return;
    } else if (phoneticSim < minPhonetic && lexicalSim < minLexical) {
      return;
    }

    // Coverage: the candidate must be long enough to explain the span.
    const ratio = sig.norm.length / spanNorm.length;
    if (ratio < options.minLengthRatio || ratio > options.maxLengthRatio) return;

    // Key on the normalized form so spelling-variant aliases that mean the same
    // thing ("RabbitMQ" / "Rabbit MQ") collapse into one candidate instead of
    // looking like two competing options.
    const key = sig.norm;
    const existing = seen.get(key);
    if (existing) {
      if (SOURCE_RANK[sig.source] > SOURCE_RANK[existing.source]) existing.source = sig.source;
      existing.phoneticSim = Math.max(existing.phoneticSim, phoneticSim);
      existing.lexicalSim = Math.max(existing.lexicalSim, lexicalSim);
      return;
    }

    seen.set(key, {
      term: sig.term,
      source: sig.source,
      phoneticSim,
      lexicalSim,
    });
  };

  // Source A — the ASR's own hypotheses. Preferred when available. Restricted
  // to alternatives short enough to stand in for this span (a whole-sentence
  // n-best alternative is not a span replacement).
  for (const alt of options.asrAlternatives ?? []) {
    const clean = alt.replace(/[.!?]+\s*$/, "").trim();
    if (!clean) continue;
    if (clean.split(/\s+/).filter(Boolean).length > spanTokenCount) continue;
    consider(signature(clean, "asr"));
  }

  // Source B — candidate-specific context (boost, not a restriction).
  for (const term of context.terms) consider(signature(term, "context"));

  // Source C — the open-world technical vocabulary.
  for (const sig of VOCABULARY_SIGNATURES) consider(sig);

  // Source D — phonetic neighbours are simply the terms above, ranked by
  // phonetic + lexical similarity.
  return Array.from(seen.values()).sort(
    (a, b) => b.phoneticSim + b.lexicalSim - (a.phoneticSim + a.lexicalSim),
  );
}
