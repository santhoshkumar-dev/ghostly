/**
 * Generic, open-world ASR repair.
 *
 * Position in the pipeline (deliberately BEFORE the question gate):
 *
 *   ASR → raw transcript → CONTEXT-AWARE ASR REPAIR → corrected transcript
 *        → question gate → manual hotkey → existing AI pipeline
 *
 * ── Core principle ─────────────────────────────────────────────────────────
 * The engine asks: "Is there strong evidence this span is an ASR error, and is
 * there a better word/phrase that explains the same audio and context?" It does
 * NOT ask "which glossary term is closest?". Known terms (resume / projects /
 * technologies) only *boost* a candidate; their absence can never block a
 * correction. If the evidence is weak, the raw transcript is preserved.
 *
 * ── Guarantees ─────────────────────────────────────────────────────────────
 *  • Never mutates the input string; the raw transcript is always returned too.
 *  • Idempotent: correctTranscript(correctTranscript(x)) === correctTranscript(x).
 *  • Never throws — any failure returns the original transcript unchanged.
 *  • Local and deterministic: no network, no LLM, no ASR-engine coupling.
 */

import {
  normalizeForCompare,
} from "./phonetic";
import {
  generateCandidates,
  type Candidate,
} from "./transcriptCandidates";
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  hasStrongEvidence,
  scoreCandidate,
  type ScoreBreakdown,
  type ScoreThresholds,
  type ScoreWeights,
} from "./transcriptScoring";
import {
  EMPTY_CANDIDATE_CONTEXT,
  isCommonEnglishWord,
  isCommonPhrase,
  isStopword,
  knownTechTerm,
  type CandidateContext,
} from "./transcriptVocabulary";
import { correctQuestionWithCandidate } from "./candidateCorrection";

/** Generic ASR metadata. Engine-independent by design. */
export interface AsrMetadata {
  engine?: string;
  /** Utterance-level confidence in [0, 1], when the engine exposes one. */
  confidence?: number;
  /** Whole-utterance n-best alternatives. */
  alternatives?: string[];
  /** Per-word alternatives, when the engine exposes them. */
  wordAlternatives?: Array<{ word: string; alternatives: string[] }>;
}

export interface CorrectionInput {
  /** The transcript exactly as the ASR produced it. Never modified. */
  rawText: string;
  source?: "mic" | "system";
  asrMetadata?: AsrMetadata;
  /** Resume / project / company vocabulary. Optional; empty is fine. */
  candidateContext?: CandidateContext;
  /** Convenience alias for `asrMetadata.alternatives`. */
  optionalAsrAlternatives?: string[];
  /**
   * Candidate correction signal. When supplied, `correctTranscript` will ALSO
   * apply the candidate repeated-word correction on top of the voice-path repair.
   * The candidate is used as a *correction signal* for a suspicious span in the
   * transcript (same architecture the manual text / candidate correction paths
   * use), and must never be appended to the transcript.
   *
   * The candidate is only applied when there is strong evidence it matches a
   * term-like span in the transcript; weak or unrelated candidates are ignored.
   */
  candidateSignal?: {
    text: string;
    timestamp?: number;
  };
  /** Overrides for tuning / tests. */
  weights?: ScoreWeights;
  thresholds?: ScoreThresholds;
}

export interface CorrectionDetail {
  from: string;
  to: string;
  confidence: number;
  reason: string;
}

export interface CorrectionTelemetry {
  correctionLatencyMs: number;
  candidateCount: number;
  changed: boolean;
  confidence: number;
}

export interface CorrectionResult {
  /** The untouched input transcript. */
  rawText: string;
  /** Formatting-normalized + repaired transcript. */
  correctedText: string;
  /** Whether *any* repair was applied (ASR repair or candidate correction). */
  changed: boolean;
  /** Confidence of the best single correction. */
  confidence: number;
  /** Corrections applied by the voice path (ASR repair + candidate correction). */
  corrections: CorrectionDetail[];
  /** Human-readable reason for the correction decision. */
  reason: string;
  /** Pure telemetry (latency, candidate counts) — never the transcript. */
  telemetry: CorrectionTelemetry;
}

/** How many tokens a single correction span may cover. */
const MAX_SPAN_TOKENS = 4;

interface Token {
  raw: string;
  start: number;
  end: number;
}

const CORE_TOKEN = /[A-Za-z0-9][A-Za-z0-9'’\-]*/g;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let match: RegExpExecArray | null;
  CORE_TOKEN.lastIndex = 0;
  while ((match = CORE_TOKEN.exec(text)) !== null) {
    tokens.push({ raw: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/**
 * Stage 1 — harmless formatting normalization only.
 *
 * Whitespace, spacing around punctuation, and duplicated punctuation. This is
 * deliberately separate from semantic repair: a span is never re-worded here.
 */
export function normalizeFormatting(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([.!?])\1{2,}/g, "$1")
    .replace(/^\s+|\s+$/g, "");
}

interface AppliedCorrection {
  detail: CorrectionDetail;
  breakdown: ScoreBreakdown;
  start: number;
  end: number;
}

function buildReason(breakdown: ScoreBreakdown): string {
  const signals: string[] = [];
  if (breakdown.phonetic >= 0.6) signals.push("phonetic");
  if (breakdown.lexical >= 0.6) signals.push("lexical");
  if (breakdown.sentenceContext >= 0.5) signals.push("sentence-context");
  if (breakdown.questionStructure >= 0.6) signals.push("question-structure");
  if (breakdown.candidateContext >= 1) signals.push("candidate-context");
  if (breakdown.asrAlternative >= 1) signals.push("asr-alternative");
  return signals.length > 0 ? signals.join(" + ") : "weak evidence";
}

/**
 * Try to repair a single span. Returns null when there is not enough evidence —
 * which is the common case and the safe default.
 */
function tryCorrectSpan(
  span: string,
  sentence: string,
  context: CandidateContext,
  asrAlternatives: readonly string[],
  weights: ScoreWeights,
  thresholds: ScoreThresholds,
): { candidate: Candidate; breakdown: ScoreBreakdown } | null {
  // ── Keep-raw rules ────────────────────────────────────────────────────────
  // A span that is already plausible English, or already a real term, is left
  // exactly as-is. These are structural, never topic-based.
  if (normalizeForCompare(span).length < 3) return null;
  if (isCommonPhrase(span)) return null;
  // Already spelled exactly as the canonical term — nothing to repair. A span
  // that only differs in casing/spacing still falls through and is corrected.
  if (knownTechTerm(span) === span) return null;

  const words = span.split(" ");
  // A correction span is a contiguous run of content words. Function words act
  // as hard boundaries, so "spring wood and mongo" never becomes one span (and
  // "and" is never swallowed by a replacement).
  if (words.some((w) => isStopword(w))) return null;
  if (words.length === 1 && isCommonEnglishWord(words[0])) return null;

  // Compare against the span with function words removed, so trailing/leading
  // fillers do not dilute the similarity measurement.
  const contentWords = words.filter((w) => !isStopword(w));
  if (contentWords.length === 0) return null;
  // A run made ENTIRELY of already-valid words — ordinary English, or a real
  // technical term — is never a mishearing. This is what keeps "starts
  // returning", "capital", and crucially "Explain docker" (="explain" +
  // the real term "Docker") untouched: there is nothing left to repair, so a
  // context term must not be allowed to swallow the whole span.
  //
  // The one exception is a span that has a canonical STYLIZED form of its own
  // ("rest api" → "REST API") — that is a genuine normalization, not a
  // mishearing, so it is allowed through to be reformatted.
  if (
    knownTechTerm(span) === null &&
    contentWords.every(
      (w) => isCommonEnglishWord(w) || knownTechTerm(w) !== null,
    )
  ) {
    return null;
  }
  const compareText = contentWords.join(" ");

  const candidates = generateCandidates(compareText, context, {
    minPhonetic: thresholds.minPhonetic,
    minLexical: thresholds.minLexical,
    minPhoneticSingle: thresholds.minPhoneticSingle,
    minLexicalSingle: thresholds.minLexicalSingle,
    minLengthRatio: thresholds.minLengthRatio,
    maxLengthRatio: thresholds.maxLengthRatio,
    asrAlternatives,
  });
  if (candidates.length === 0) return null;

  const scored = candidates
    .map((candidate) => ({
      candidate,
      breakdown: scoreCandidate(compareText, candidate, sentence, context.terms, weights),
    }))
    .sort((a, b) => b.breakdown.total - a.breakdown.total);

  const top = scored[0];

  // ── Evidence floor ───────────────────────────────────────────────────────
  // The combined score below mixes genuine similarity with soft priors
  // (candidate context, sentence framing, question structure). Those priors
  // are only allowed to BOOST a candidate that already explains the audio —
  // they must never be able to carry an unrelated candidate over the bar on
  // their own. Require strong phonetic AND lexical evidence for the SELECTED
  // candidate before any of the additive score is trusted.
  if (!hasStrongEvidence(top.candidate, thresholds)) return null;

  if (top.breakdown.total < thresholds.minConfidence) return null;
  // Ambiguity: if a genuinely different candidate is nearly as good, keep the
  // original. Spelling variants of the SAME term (PostgreSQL vs Postgres,
  // RabbitMQ vs Rabbit MQ) are one option, not two, and do not count here.
  const topNorm = normalizeForCompare(top.candidate.term);
  const runnerUp = scored.find((s) => {
    if (s === top) return false;
    const n = normalizeForCompare(s.candidate.term);
    return !(n === topNorm || n.startsWith(topNorm) || topNorm.startsWith(n));
  });
  if (runnerUp && top.breakdown.total - runnerUp.breakdown.total < thresholds.minMargin) {
    return null;
  }

  return { candidate: top.candidate, breakdown: top.breakdown };
}

/**
 * Repair a raw ASR transcript.
 *
 * Pure, synchronous and cheap: no network, no model, no side effects. Safe to
 * call on every final utterance.
 */
export function correctTranscript(input: CorrectionInput): CorrectionResult {
  const rawText = input.rawText ?? "";
  const startedAt =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();

  const empty = (reason: string): CorrectionResult => ({
    rawText,
    correctedText: rawText,
    changed: false,
    confidence: 0,
    corrections: [],
    reason,
    telemetry: {
      correctionLatencyMs: Math.max(
        0,
        Math.round(
          (typeof performance !== "undefined" && performance.now
            ? performance.now()
            : Date.now()) - startedAt,
        ),
      ),
      candidateCount: 0,
      changed: false,
      confidence: 0,
    },
  });

  try {
    if (!rawText.trim() || !/[a-z]/i.test(rawText)) {
      return empty("no alphabetic content");
    }

    const normalized = normalizeFormatting(rawText);
    const tokens = tokenize(normalized);
    if (tokens.length === 0) return empty("no tokens");

    const context = input.candidateContext ?? EMPTY_CANDIDATE_CONTEXT;
    const weights = input.weights ?? DEFAULT_WEIGHTS;
    const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;

    // Merge every ASR alternative source into one pool.
    const asrAlternatives: string[] = [
      ...(input.optionalAsrAlternatives ?? []),
      ...(input.asrMetadata?.alternatives ?? []),
      ...(input.asrMetadata?.wordAlternatives ?? []).flatMap((w) => w.alternatives),
    ];

    const sentence = normalized;
    const applied: AppliedCorrection[] = [];
    let candidateCount = 0;

    let i = 0;
    while (i < tokens.length) {
      let matched: {
        length: number;
        candidate: Candidate;
        breakdown: ScoreBreakdown;
      } | null = null;

      const maxLength = Math.min(MAX_SPAN_TOKENS, tokens.length - i);
      for (let length = maxLength; length >= 1; length--) {
        const span = tokens
          .slice(i, i + length)
          .map((t) => t.raw)
          .join(" ");
        const result = tryCorrectSpan(
          span,
          sentence,
          context,
          asrAlternatives,
          weights,
          thresholds,
        );
        if (result) {
          matched = { length, ...result };
          break; // longest span wins
        }
      }

      if (matched) {
        candidateCount += 1;
        const first = tokens[i];
        const last = tokens[i + matched.length - 1];
        applied.push({
          detail: {
            from: tokens
              .slice(i, i + matched.length)
              .map((t) => t.raw)
              .join(" "),
            to: matched.candidate.term,
            confidence: matched.breakdown.total,
            reason: buildReason(matched.breakdown),
          },
          breakdown: matched.breakdown,
          start: first.start,
          end: last.end,
        });
        i += matched.length;
      } else {
        i += 1;
      }
    }

    // ── Voice-path span repairs ────────────────────────────────────────────
    // Apply rightmost-first so earlier offsets stay valid.
    let voiceRepaired = normalized;
    const ordered = [...applied].sort((a, b) => b.start - a.start);
    for (const correction of ordered) {
      voiceRepaired =
        voiceRepaired.slice(0, correction.start) +
        correction.detail.to +
        voiceRepaired.slice(correction.end);
    }

    // ── Candidate repeated-word correction (transcript-level) ─────────────
    // Runs on top of the voice-repaired text, and uses the SAME module the
    // manual-text and candidate-input paths share, so there is one source of
    // truth. It is a *replacement*, never an append: the candidate signal can
    // only fix a suspicious span, it can never add text or a second question.
    //
    // It uses the candidate path's own thresholds (first-hand human evidence),
    // NOT the voice-path `thresholds`, so the voice floor is never relaxed here.
    let candidateCorrectedQuestion = voiceRepaired;
    let candidateCorrectionApplied = false;
    const candidateCorrectionDetails: CorrectionDetail[] = [];
    const candidateText = input.candidateSignal?.text?.trim() ?? "";
    if (candidateText) {
      const result = correctQuestionWithCandidate(voiceRepaired, {
        text: candidateText,
        timestamp: input.candidateSignal?.timestamp,
      });
      if (result.corrected) {
        candidateCorrectedQuestion = result.finalCorrectedQuestion;
        candidateCorrectionApplied = true;
        candidateCorrectionDetails.push(...result.corrections);
      }
    }

    const correctedText = candidateCorrectedQuestion;

    // A candidate correction on its own is a real correction, so it must not be
    // swallowed by the "no voice repairs" fast path below.
    if (applied.length === 0 && !candidateCorrectionApplied) {
      const latency = Math.max(
        0,
        Math.round(
          (typeof performance !== "undefined" && performance.now
            ? performance.now()
            : Date.now()) - startedAt,
        ),
      );
      return {
        rawText,
        correctedText: normalized,
        changed: normalized !== rawText,
        confidence: 0,
        corrections: [],
        reason: "no high-confidence correction",
        telemetry: {
          correctionLatencyMs: latency,
          candidateCount,
          changed: normalized !== rawText,
          confidence: 0,
        },
      };
    }

    const confidence = applied.length
      ? Math.min(
          ...applied.map((c) => c.detail.confidence),
          candidateCorrectionApplied ? 1 : 0,
        )
      : 1;
    const changed = correctedText !== rawText;
    const latency = Math.max(
      0,
      Math.round(
        (typeof performance !== "undefined" && performance.now
          ? performance.now()
          : Date.now()) - startedAt,
      ),
    );

    const reason =
      applied.length === 1
        ? candidateCorrectionApplied
          ? "voice repair + candidate correction"
          : "high-confidence contextual repair"
        : candidateCorrectionApplied
          ? "voice repairs + candidate correction"
          : "high-confidence contextual repairs";

    return {
      rawText,
      correctedText,
      changed,
      confidence: Number(confidence.toFixed(3)),
      corrections: [
        ...applied.map((c) => c.detail),
        ...candidateCorrectionDetails,
      ].sort((a, b) => a.from.localeCompare(b.from)),
      reason,
      telemetry: {
        correctionLatencyMs: latency,
        candidateCount,
        changed,
        confidence: Number(confidence.toFixed(3)),
      },
    };
  } catch {
    // Never let a repair failure break transcription.
    return empty("correction failed");
  }
}

/**
 * Development-only telemetry line. Never prints the transcript itself.
 *
 *   [ASR-CORRECTION] changed=true confidence=0.96 candidates=4 latencyMs=5
 */
export function logCorrection(result: CorrectionResult): void {
  const t = result.telemetry;
  console.log(
    `[ASR-CORRECTION] changed=${t.changed} confidence=${t.confidence} candidates=${t.candidateCount} latencyMs=${t.correctionLatencyMs}`,
  );
}
