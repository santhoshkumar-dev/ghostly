/**
 * Technical term normalization for interview speech-to-text output.
 *
 * Moonshine (like most ASR models) is trained on general speech, so it
 * mishears domain jargon:
 *
 *   "Virtual DOM"   → "virtual down"
 *   "Node.js"       → "node js"  / "node jay ess"
 *   "REST API"      → "rest api"
 *   "PostgreSQL"    → "post grass"
 *   "MongoDB"       → "mongo dee"
 *   "Spring Boot"   → "spring boat"
 *
 * This module repairs those transcripts with deterministic, word-boundary
 * matching — no LLM call, no network, no second model.
 *
 * ── Design rules (deliberate, to avoid corrupting meaning) ───────────────
 *  1. CORRECTIONS ONLY. Every left-hand side below is a phrase that is
 *     meaningless in an engineering interview ("virtual down", "post grass").
 *     If a phrase could plausibly be intended as-is, it is NOT in this list.
 *     That is why there is no `hook → hooks` or `render → renders` rule.
 *  2. NO SINGULAR/PLURAL OR INFLECTION CHANGES. We fix mishearing, not grammar.
 *  3. CASING is applied only to acronyms and proper nouns that never appear
 *     as ordinary lowercase English words (API, REST, JWT, JVM, SQL, …).
 *  4. LONGEST PATTERN WINS. Phrases are applied longest-first so
 *     "virtual dom" is never partially consumed by the bare `dom` rule.
 *  5. IDEMPOTENT. Running it twice returns the same string, so a transcript
 *     that is normalized twice (e.g. after a retry) cannot drift.
 *
 * Pipeline position — strictly before the question gate:
 *
 *   STT final → normalizeTechnicalTerms() → evaluateInterviewTurn() → AI
 *
 * Interim/partial transcripts are NEVER normalized: they are display-only
 * and must never influence detection or generation.
 */

/** A correction whose left-hand side is unambiguously a mishearing. */
interface Correction {
  /** Canonical, correctly-cased output form. */
  readonly canonical: string;
  /** Patterns that match the misheard phrasing. Case-insensitive. */
  readonly patterns: readonly RegExp[];
}

/**
 * Group 1 — mishearings. The left-hand side is nonsense, so replacing it can
 * never change what the interviewer meant. Grouped by domain so it stays easy
 * to extend; see `TECHNICAL_CORRECTIONS` for the flat, ordered list below.
 */
const REACT_CORRECTIONS: Correction[] = [
  // "virtual down" / "virtual doom" → the single most common React mishearing.
  { canonical: "Virtual DOM", patterns: [/\bvirtual[\s-]+(?:down|doom|dom)\b/gi] },
  { canonical: "useEffect", patterns: [/\buse[\s-]+eh[\s-]?f(?:e|ec|ek)[\s-]?(?:k|c)?t\b/gi] },
  { canonical: "useState", patterns: [/\buse[\s-]+estate\b/gi] },
  { canonical: "useCallback", patterns: [/\buse[\s-]+call[\s-]?back\b/gi] },
  { canonical: "useMemo", patterns: [/\buse[\s-]+memo\b/gi] },
  { canonical: "useReducer", patterns: [/\buse[\s-]+reducer\b/gi] },
  { canonical: "useContext", patterns: [/\buse[\s-]+con(?:text|text)\b/gi] },
  { canonical: "useRef", patterns: [/\buse[\s-]+ref\b/gi] },
  // Spaced/garbled hook spellings produced by the ASR.
  { canonical: "useEffect", patterns: [/\buse\s+effect\b/gi] },
  { canonical: "useState", patterns: [/\buse\s+state\b/gi] },
  { canonical: "useCallback", patterns: [/\buse\s+callback\b/gi] },
  { canonical: "useMemo", patterns: [/\buse\s+memo\b/gi] },
  { canonical: "useRef", patterns: [/\buse\s+ref\b/gi] },
];

const BACKEND_CORRECTIONS: Correction[] = [
  { canonical: "Node.js", patterns: [/\bnode[\s-]*(?:jay[\s-]*ess|js|j\.s)\b/gi] },
  { canonical: "Express.js", patterns: [/\bexpress[\s-]*(?:js|j\.s)\b/gi] },
  { canonical: "REST API", patterns: [/\brest[\s-]*(?:ay[\s-]*pea|ape|a\.p\.i)\b/gi] },
  { canonical: "JWT", patterns: [/\bjay[\s-]*double[\s-]*u[\s-]*tee\b/gi] },
  { canonical: "JWT", patterns: [/\bjson[\s-]*web[\s-]*token\b/gi] },
  { canonical: "FastAPI", patterns: [/\bfast[\s-]*a[\s-]*p[\s-]*i\b/gi] },
  { canonical: "GraphQL", patterns: [/\bgraph[\s-]*q[\s-]*l\b/gi] },
  { canonical: "NoSQL", patterns: [/\bno[\s-]*sql\b/gi] },
];

const DATABASE_CORRECTIONS: Correction[] = [
  { canonical: "PostgreSQL", patterns: [/\bpost[\s-]*(?:grass|grasp|grease|gray)\b/gi] },
  { canonical: "MongoDB", patterns: [/\bmongo[\s-]*(?:dee|deb|d b|db)\b/gi] },
  { canonical: "MongoDB", patterns: [/\bmongo[\s-]*db\b/gi] },
  { canonical: "PostgreSQL", patterns: [/\bpost[\s-]*gres(?:ql)?\b/gi] },
  { canonical: "Postgres", patterns: [/\bpost[\s-]*gres\b/gi] },
];

const JAVA_CORRECTIONS: Correction[] = [
  { canonical: "Spring Boot", patterns: [/\bspring[\s-]*boat\b/gi] },
  { canonical: "Spring Boot", patterns: [/\bspring[\s-]*boot\b/gi] },
  { canonical: "dependency injection", patterns: [/\bdependen(?:cy|see)[\s-]*injec(?:tion|shun)\b/gi] },
  { canonical: "JVM", patterns: [/\bj(?:ava)?[\s-]*v[\s-]*m\b/gi] },
  { canonical: "JDK", patterns: [/\bj(?:ava)?[\s-]*d[\s-]*k\b/gi] },
];

const DEVOPS_CORRECTIONS: Correction[] = [
  { canonical: "Kubernetes", patterns: [/\bkube[\s-]*(?:retes|rettis|neties|rnetes)\b/gi] },
  { canonical: "Kubernetes", patterns: [/\bkubernetes\b/gi] },
  { canonical: "Docker", patterns: [/\bdock(?:er|\/er)\b/gi] },
  { canonical: "CI/CD", patterns: [/\bci[\s/\\]*cd\b/gi] },
  { canonical: "CI/CD", patterns: [/\bsigh[\s-]*dee[\s/\\]*(?:see|sea)[\s-]*dee\b/gi] },
  { canonical: "GitHub Actions", patterns: [/\bgit[\s-]*hub[\s-]*(?:actoins|akshuns|actions)\b/gi] },
  { canonical: "message queue", patterns: [/\bmessage[\s-]*q(?:ue|you)eue\b/gi] },
];

/**
 * Group 2 — casing only, for terms that never occur as ordinary English words.
 *
 * `guarded: true` means "only rewrite if it isn't already correctly cased",
 * which makes the whole pass idempotent and avoids churning text that the
 * candidate (or a previous normalization) already spelled correctly.
 */
const CANONICAL_CASING: Array<{ term: string; guarded?: boolean }> = [
  // Web / protocol acronyms
  { term: "REST", guarded: true },
  { term: "API", guarded: true },
  { term: "HTTP", guarded: true },
  { term: "HTTPS", guarded: true },
  { term: "JSON", guarded: true },
  { term: "XML", guarded: true },
  { term: "HTML", guarded: true },
  { term: "CSS", guarded: true },
  { term: "SQL", guarded: true },
  { term: "JWT", guarded: true },
  { term: "URL", guarded: true },
  { term: "JVM", guarded: true },
  { term: "JDK", guarded: true },
  { term: "AWS", guarded: true },
  { term: "GCP", guarded: true },
  { term: "CI/CD", guarded: true },
  { term: "SOA", guarded: true },
  { term: "PDF", guarded: true },
  { term: "DOM", guarded: true },
  { term: "JSX", guarded: true },
  // Proper nouns / brands
  { term: "MongoDB", guarded: true },
  { term: "PostgreSQL", guarded: true },
  { term: "MySQL", guarded: true },
  { term: "Redis", guarded: true },
  { term: "Java", guarded: true },
  { term: "JavaScript", guarded: true },
  { term: "TypeScript", guarded: true },
  { term: "Python", guarded: true },
  { term: "Maven", guarded: true },
  { term: "Gradle", guarded: true },
  { term: "Docker", guarded: true },
  { term: "Kubernetes", guarded: true },
  { term: "Kafka", guarded: true },
  { term: "React", guarded: true },
  { term: "Angular", guarded: true },
  { term: "Svelte", guarded: true },
  { term: "Flask", guarded: true },
  { term: "Django", guarded: true },
];

/**
 * All mishearing corrections, flattened. Order matters only within a group;
 * we additionally sort by pattern specificity (see `specificity`) so that a
 * longer phrase always wins over a shorter one that it contains.
 */
const TECHNICAL_CORRECTIONS: Correction[] = [
  ...REACT_CORRECTIONS,
  ...BACKEND_CORRECTIONS,
  ...DATABASE_CORRECTIONS,
  ...JAVA_CORRECTIONS,
  ...DEVOPS_CORRECTIONS,
];

/**
 * How "greedy" a pattern is: longer literal prefixes score higher, so
 * `/\bvirtual[\s-]+(?:down|doom|dom)\b/` is applied before `/\bdom\b/`.
 * Using the matchable literal length keeps this independent of regex
 * sophistication.
 */
function specificity(pattern: RegExp): number {
  return (pattern.source.match(/[a-z0-9]/gi) ?? []).length;
}

/** Escapes a literal term so it can be matched on word boundaries. */
function literalPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  // Allow flexible whitespace between the words of a multi-word term
  // ("spring boot" / "spring-boot" / "spring  boot").
  const body = escaped.replace(/\s+/g, "[\\s-]+");
  return new RegExp(`\\b${body}\\b`, "i");
}

/**
 * Normalize technical terms in a FINAL transcript.
 *
 * Must be called after the ASR has committed a final utterance and before
 * `evaluateInterviewTurn()`.
 *
 * @param text Raw final transcript from the ASR worker.
 * @returns The transcript with technical terminology repaired.
 */
export function normalizeTechnicalTerms(text: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  // Very short fragments can't hold a technical term, and running the
  // passes over them only risks corrupting filler words.
  if (trimmed.length < 3) return text;

  let result = text;

  // ── Pass 1: repair mishearings, longest pattern first ──────────────────
  const ordered: Array<{ pattern: RegExp; canonical: string }> = [];
  for (const correction of TECHNICAL_CORRECTIONS) {
    for (const pattern of correction.patterns) {
      // Fresh (non-global) flags so `lastIndex` never carries between calls.
      const source = pattern.source;
      const flags = pattern.flags.replace(/[gy]/g, "");
      ordered.push({
        pattern: new RegExp(source, flags.includes("i") ? flags : `${flags}i`),
        canonical: correction.canonical,
      });
    }
  }
  ordered.sort((a, b) => specificity(b.pattern) - specificity(a.pattern));

  for (const { pattern, canonical } of ordered) {
    result = result.replace(pattern, canonical);
  }

  // ── Pass 2: casing for acronyms / proper nouns ─────────────────────────
  // A guarded term is skipped when the text already spells it canonically,
  // which is what keeps this pass idempotent.
  for (const { term, guarded } of CANONICAL_CASING) {
    const pattern = literalPattern(term);
    if (guarded) {
      result = result.replace(pattern, (match) =>
        match === term ? match : term,
      );
    } else {
      result = result.replace(pattern, term);
    }
  }

  return result;
}

/**
 * Development-only logging for the STT normalization stage.
 *
 * Prints the raw and normalized transcript side by side whenever a
 * correction actually changed something, so mishearings stay visible
 * without flooding the console with every utterance.
 */
export function logNormalization(raw: string, normalized: string): void {
  if (raw === normalized) return;
  console.log(`[STT RAW]        "${raw}"`);
  console.log(`[STT NORMALIZED] "${normalized}"`);
}