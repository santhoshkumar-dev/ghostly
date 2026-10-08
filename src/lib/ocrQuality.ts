/**
 * Deterministic OCR quality gate.
 *
 * ── Why this is not an LLM call ─────────────────────────────────────────────
 * The decision "is this OCR text worth answering?" has to be cheap, offline and
 * reproducible: it runs before every screenshot answer, and a model call here
 * would add the very latency and non-determinism the OCR-first path exists to
 * remove. So it is a closed set of counting rules over the recognised string.
 *
 * ── Why the thresholds are deliberately generous ────────────────────────────
 * Coding screenshots are full of `[]`, `{}`, `()`, `==`, `!=`, `<=`, `>=` and
 * ambiguous glyphs (`0/O`, `1/l/I`). A quality gate that rejected symbol-heavy
 * text would reject the most valuable captures in the product. So symbols are
 * never penalised on their own: text is only judged POOR when it is too short,
 * almost entirely a single repeated character, or has too little variety to be
 * language at all.
 *
 * The output is a classification plus the numbers that produced it, so a wrong
 * verdict can be understood from a log line without reproducing the screen.
 */

export type OcrQuality = "good" | "poor";

export interface OcrQualityMetrics {
  /** Characters after trimming. */
  chars: number;
  /** Non-empty lines. */
  lines: number;
  /** Whitespace-separated tokens. */
  words: number;
  /** Letters + digits divided by non-space characters, 0 when empty. */
  alnumRatio: number;
  /** Length of the longest run of a single repeated character. */
  longestRun: number;
  /** How many distinct non-space characters appear. */
  distinctChars: number;
}

export interface OcrQualityResult {
  quality: OcrQuality;
  /** Closed vocabulary, safe to log. Never the text itself. */
  reason:
    | "enough readable text"
    | "too little text"
    | "no readable lines"
    | "excessive repeated characters"
    | "not enough character variety"
    | "mostly symbols"
    | "ghostly's own interface in the capture";
  metrics: OcrQualityMetrics;
  /**
   * True when `reason` is the self-leak rule, i.e. the recognised text is
   * Ghostly's OWN UI or its own prompt template rather than the user's screen.
   *
   * Kept as a separate flag rather than a reason-string comparison at the call
   * site so the caller never has to know the wording, and so renaming a reason
   * cannot silently turn a privacy guard off.
   */
  selfLeak?: boolean;
}

/**
 * Verbatim fragments of Ghostly's OWN interface and its OWN prompt templates.
 *
 * ── Why this list exists ────────────────────────────────────────────────────
 * A capture is a photograph of the whole desktop, so if Ghostly is in the picture
 * its text is read too — and the model then answers Ghostly's instructions instead
 * of the interviewer's question. That failure is silent: the read is "good" by
 * every other measure here, because Ghostly's own copy IS a lot of readable
 * English laid out in lines.
 *
 * The primary fix is mechanical, not textual: every capture route now hides the
 * overlay and re-asserts capture exclusion for the duration (`electron/
 * captureSelfExclusion.ts`), so Ghostly's pixels are never in the image at all.
 * This rule is the backstop for when that cannot hold — a build where the
 * exclusion flag is unavailable, a renderer-side route added later that forgets
 * the wrapper — and it costs nothing when the fix is working.
 *
 * ── Why these particular strings are safe to match on ──────────────────────
 * Every entry is a long, verbatim, NEVER-RENDERED (or Ghostly-labelled) slice of
 * Ghostly itself: sentences from `buildUniversalPrompt` /
 * `INTERVIEW_SYSTEM_PROMPT`, and the app's own panel headings. No interview
 * question, code listing, editor tab or PDF a candidate would be looking at can
 * contain them, so a match is unambiguous evidence that the capture photographed
 * Ghostly rather than the target screen.
 */
export const GHOSTLY_SELF_LEAK_MARKERS: readonly string[] = [
  // buildUniversalPrompt — the screenshot/typed question template.
  "You are an expert interview assistant",
  "Decide the answer shape from the question itself",
  "Never ask the candidate to pick a category",
  "Read the actual question and answer it in the shape that question calls for",
  "Keep it speakable: direct, short, natural",
  // INTERVIEW_SYSTEM_PROMPT — the interview rules template.
  "live interview ANSWERING engine",
  "You answer exactly one thing: the text between",
  // Ghostly's own interface, including text the Settings panel really does render
  // (so it proves the capture included Ghostly's window, not merely that some
  // prompt-like copy leaked into a buffer).
  "Text read from screen",
  "Answer like a real candidate in an interview",
  "Text read locally from the candidate",
];

/**
 * Did the recognised text come from Ghostly's own window rather than the
 * candidate's screen?
 *
 * Case-insensitive and whitespace-tolerant, because OCR renders the same glyphs
 * with different spacing. Never returns true for text that merely *looks* like
 * prose: it needs one of the long verbatim fragments above.
 */
export function detectGhostlySelfLeak(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  // Collapse runs of whitespace so a line-broken prompt still matches, and lower
  // case so OCR case noise cannot hide a match.
  const flat = text.toLowerCase().replace(/\s+/g, " ");
  return GHOSTLY_SELF_LEAK_MARKERS.some((marker) =>
    flat.includes(marker.toLowerCase()),
  );
}

/**
 * Below this many trimmed characters there is not enough to answer.
 * Set low on purpose: a one-line coding question ("Reverse a string.") is 17.
 */
export const OCR_MIN_CHARS = 8;

/** At least this many non-empty lines. A single line is fine; zero is not. */
export const OCR_MIN_LINES = 1;

/**
 * A run of one repeated character longer than this is a scan/garbage artefact
 * (`________`, `1111111111`). Legitimate code rarely repeats one glyph > 12
 * times in a row. Kept high so a long separator line still passes if the rest
 * of the capture is readable.
 */
export const OCR_MAX_REPEAT_RUN = 12;

/**
 * Distinct non-space characters required. Language and code both re-use many
 * glyphs, but true gibberish tends to collapse to a handful.
 */
export const OCR_MIN_DISTINCT_CHARS = 5;

/** Minimum share of non-space characters that are letters or digits. */
export const OCR_MIN_ALNUM_RATIO = 0.3;

/**
 * Words needed for the "mostly symbols" rule to be waived. A line that is a
 * single code fragment (`a>=b`) has few words but real content, so the rule
 * only fires when there are also almost no recognisable words.
 */
export const OCR_MIN_WORDS_FOR_SYMBOLS = 1;

function longestRepeatRun(text: string): number {
  let longest = 0;
  let current = 0;
  let prev = "";
  for (const ch of text) {
    if (ch === "\n" || ch === "\r") {
      prev = "";
      current = 0;
      continue;
    }
    if (ch === prev) {
      current++;
    } else {
      prev = ch;
      current = 1;
    }
    if (current > longest) longest = current;
  }
  return longest;
}

/** Compute the raw metrics. Pure and total — never throws. */
export function measureOcrText(text: string): OcrQualityMetrics {
  const trimmed = typeof text === "string" ? text.trim() : "";
  const chars = trimmed.length;
  const lines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0).length;
  const words = trimmed.split(/\s+/).filter(Boolean).length;

  let alnum = 0;
  let nonSpace = 0;
  const distinct = new Set<string>();
  for (const ch of trimmed) {
    if (/\s/.test(ch)) continue;
    nonSpace++;
    distinct.add(ch);
    if (/[A-Za-z0-9]/.test(ch)) alnum++;
  }

  return {
    chars,
    lines,
    words,
    alnumRatio: nonSpace > 0 ? alnum / nonSpace : 0,
    longestRun: longestRepeatRun(trimmed),
    distinctChars: distinct.size,
  };
}

/**
 * Classify recognised text as GOOD or POOR.
 *
 * Deterministic and side-effect free: the same string always yields the same
 * verdict, which is what lets the harness pin this behaviour.
 *
 * The self-leak rule runs FIRST, before any counting rule. Ordering matters: it
 * does not matter whether Ghostly's own copy is long enough, varied enough or
 * line-rich enough to pass the language checks — if the read is of Ghostly, it is
 * wrong as a problem statement whatever it scores.
 */
export function assessOcrText(text: string): OcrQualityResult {
  const metrics = measureOcrText(text);

  if (detectGhostlySelfLeak(text)) {
    return {
      quality: "poor",
      reason: "ghostly's own interface in the capture",
      metrics,
      selfLeak: true,
    };
  }

  if (metrics.chars < OCR_MIN_CHARS) {
    return { quality: "poor", reason: "too little text", metrics };
  }
  if (metrics.lines < OCR_MIN_LINES) {
    return { quality: "poor", reason: "no readable lines", metrics };
  }
  if (metrics.longestRun > OCR_MAX_REPEAT_RUN) {
    return {
      quality: "poor",
      reason: "excessive repeated characters",
      metrics,
    };
  }
  if (metrics.distinctChars < OCR_MIN_DISTINCT_CHARS) {
    return {
      quality: "poor",
      reason: "not enough character variety",
      metrics,
    };
  }
  if (
    metrics.alnumRatio < OCR_MIN_ALNUM_RATIO &&
    metrics.words <= OCR_MIN_WORDS_FOR_SYMBOLS
  ) {
    return { quality: "poor", reason: "mostly symbols", metrics };
  }

  return { quality: "good", reason: "enough readable text", metrics };
}

/** Convenience predicate for callers that only need the boolean. */
export function isGoodOcr(text: string): boolean {
  return assessOcrText(text).quality === "good";
}
