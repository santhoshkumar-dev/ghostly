/**
 * Phonetic + lexical similarity primitives for the ASR repair engine.
 *
 * Deliberately engine-independent: this module knows nothing about Moonshine,
 * Deepgram, the question gate or the AI pipeline. It is pure and unit-testable
 * so that scoring can be reasoned about (and tuned) in isolation.
 *
 * ── Why a *class-based* phonetic key and not Soundex/Metaphone ─────────────
 * Classic Soundex keys are 4 characters long, which destroys the length signal
 * that distinguishes genuine near-misses from unrelated words
 * ("cooper netties" vs "kubernetes"). Instead every letter is mapped to a
 * coarse articulatory class (plosives, fricatives, nasals, vowels) and the
 * resulting *string* is compared with edit distance. Near-misses that differ
 * only in place of articulation (b/p, d/t, g/k) collapse together, while
 * genuinely different words stay far apart.
 *
 *   wood   → WAAT      boot   → PAAT      sim ≈ 0.75  (same shape)
 *   water  → WATAR     boot   → PAAT      sim ≈ 0.5   (weaker)
 *   mongo db → MANKATAP  MongoDB → MANKATAP  sim = 1.0
 */

/** Lowercase and strip everything that is not a letter or digit. */
export function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Articulatory class per letter. Vowels collapse to `A`; each consonant class
 * groups sounds that are easy to confuse in speech (and therefore in ASR).
 */
const PHONETIC_CLASS: Record<string, string> = {
  a: "A",
  e: "A",
  i: "A",
  o: "A",
  u: "A",
  y: "A",
  b: "P",
  p: "P",
  c: "K",
  g: "K",
  k: "K",
  q: "K",
  d: "T",
  t: "T",
  f: "F",
  v: "F",
  l: "L",
  m: "N",
  n: "N",
  r: "R",
  s: "S",
  z: "S",
  j: "J",
  h: "H",
  w: "W",
};

/** Digraphs that are consistently misheard as a single sound. */
function applyDigraphs(text: string): string {
  return text
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/wh/g, "w")
    .replace(/qu/g, "k")
    .replace(/sh/g, "s")
    .replace(/th/g, "0")
    .replace(/x/g, "ks");
}

/**
 * Phonetic key for a word or phrase. Digits pass through unchanged so
 * "s4holidays" keeps its identifier-ness.
 */
export function phoneticKey(text: string): string {
  const base = applyDigraphs(normalizeForCompare(text));
  let out = "";
  for (const ch of base) {
    out += PHONETIC_CLASS[ch] ?? ch;
  }
  return out;
}

/** Standard Levenshtein distance, iterative and allocation-light. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length];
}

/** Normalized edit similarity in [0, 1]; 1 means identical. */
export function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const max = Math.max(a.length, b.length);
  return 1 - editDistance(a, b) / max;
}

/** Lexical (character) similarity of two phrases, ignoring punctuation. */
export function lexicalSimilarity(a: string, b: string): number {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  return similarity(na, nb);
}

/** Phonetic similarity of two phrases, ignoring punctuation. */
export function phoneticSimilarity(a: string, b: string): number {
  const ka = phoneticKey(a);
  const kb = phoneticKey(b);
  if (!ka || !kb) return 0;
  return similarity(ka, kb);
}
