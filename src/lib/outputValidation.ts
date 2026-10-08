/**
 * Deterministic output validation for streamed answers.
 *
 * The interview pipeline has a careful deterministic **input** gate
 * (`evaluateInterviewTurn`) but historically had NO output gate: anything
 * non-empty that was not the literal string `WAIT` was accepted, streamed,
 * written to `sessionMessages` and `history`, and then fed back into the next
 * prompt as `previousAnswers` — so one degenerate response propagated.
 *
 * A real observed failure:
 *
 *   question: Why they use Java as our best backend language?
 *   answer:   Previously mentioned interview questions or requests
 *
 * That string exists nowhere in the repository: it is the model imitating the
 * Markdown headings of our own prompt template. This module is the structural
 * backstop for exactly that class of failure.
 *
 * ── Design rules ────────────────────────────────────────────────────────────
 * 1. MULTIPLE SIGNALS, never a word blacklist. Nothing here knows anything
 *    about interview topics, so it cannot reject a legitimate question about
 *    "trade", "closures", or anything else.
 * 2. NO MINIMUM-WORD RULE. "Yes." / "No." / "It's immutable." must all pass.
 *    A length threshold is explicitly forbidden by design.
 * 3. STRUCTURE ONLY. The signals are: empty, a known prompt label, our own
 *    delimiter echoed back, output that is entirely Markdown headings, or an
 *    answer that is just the question restated with nothing added.
 * 4. CONSERVATIVE BY DEFAULT. A false rejection is much worse than a false
 *    acceptance here: it silences a real answer during an interview. Every
 *    threshold below is deliberately permissive.
 */

/** Machine-readable reason an answer was rejected. */
export type AnswerRejectionReason =
  | "empty"
  | "prompt-label"
  | "delimiter-echo"
  | "heading-only"
  | "question-echo"
  // ── Strong structural artifact signals (see detectAnswerArtifact) ──────────
  | "artifact-delimiter"
  | "artifact-prompt-label"
  | "artifact-template"
  | "artifact-placeholder"
  | "artifact-instruction"
  | "artifact-numeric"
  | "artifact-meta"
  | "artifact-directive"
  | "artifact-wait-sentinel"
  | "artifact-conversation-instruction"
  | "no-prose";

/**
 * Result of the structural artifact detector.
 *
 * Separate from {@link AnswerValidation} on purpose: the detector answers "is
 * this OURS instead of an answer?", while the answer validator additionally
 * applies shape heuristics (headings, labels, question-echo). Both are needed,
 * and keeping them apart makes each independently testable.
 */
export interface AnswerArtifact {
  artifact: boolean;
  reason?: AnswerRejectionReason;
  /** Short, non-secret description for the diagnostic log. */
  detail?: string;
}

export interface AnswerValidation {
  ok: boolean;
  /** Present only when `ok` is false. */
  reason?: AnswerRejectionReason;
  /** Short human-readable detail for the diagnostic log / retry banner. */
  detail?: string;
}

/**
 * Private application delimiters.
 *
 * `<<<…>>>` is our own prompt marker syntax and has no reason to appear in a
 * spoken interview answer. Presence anywhere — not just at the start — is a HARD
 * failure: the model is reproducing the harness rather than answering.
 */
const DELIMITER_RE = /<<<|>>>/;

/**
 * Internal label tokens.
 *
 * Underscore-joined ALL-CAPS tokens cannot occur in ordinary English prose, so
 * their presence is unambiguous evidence of prompt/pipeline leakage. This
 * includes the delimiters we use (`LATEST_QUESTION`, `BACKGROUND`, …) and the
 * stray artefacts observed in the wild (`ITEM_QUESTION`, `LATEST_TASK`,
 * `END_LATEST_TASK`, `INITIAL_QUESTION`, `INTERVIEW_QUESTION`, `WHAT IS
 * PROBLEMS`). Kept as OUR-strings-only, so it can never reject interview
 * vocabulary.
 */
const INTERNAL_LABEL_RE =
  /\b(ITEM_QUESTION|LATEST_TASK|END_LATEST_TASK|INITIAL_QUESTION|INTERVIEW_QUESTION|LATEST_QUESTION|END_LATEST_QUESTION|PREVIOUS_ANSWERS|END_PREVIOUS_ANSWERS|BACKGROUND|END_BACKGROUND|WHAT IS PROBLEMS|ACTIVE_PROBLEM|END_ACTIVE_PROBLEM)\b/;

/**
 * Distinctive strings that only exist in OUR instruction template.
 *
 * The model echoing any of these is reproducing the rulebook it was given, not
 * answering the candidate's question. All are long and specific enough that a
 * legitimate spoken answer will not contain them.
 */
const TEMPLATE_LEAK_PHRASES: string[] = [
  "live interview answering engine",
  "question detection you must perform internally",
  "output only the answer itself",
  "answer shaping",
  "never mention being an ai",
  "reply with exactly",
  "the only question that exists",
  "candidate context\nuse this to tailor",
  // Echo of the Groq-only answer directive (see `ai/groq.ts`). If a model
  // prints the directive back, it is reproducing its instructions, not
  // answering — reject it like any other template leak.
  "answer that question directly and immediately",
];

/**
 * META-RESPONSE patterns — the model talking ABOUT the task instead of
 * answering it.
 *
 * A real interview answer never asks for the question, requests clarification,
 * refuses to be useful, or refers to itself as an AI. These phrases are
 * therefore unambiguous meta-talk (exactly the same category as
 * {@link TEMPLATE_LEAK_PHRASES}: OUR/assistant strings, never interview
 * vocabulary), so substring matching cannot reject a legitimate answer. The
 * one short phrase kept here ("what is the question") only ever appears in a
 * response that is asking for the question — it is not a way to phrase an
 * answer about questions.
 *
 * Real observed failure this catches:
 *   "Okay. Please note: I will not provide unnecessary information unless
 *    directed."  (Groq `allam-2-7b`)
 */
const META_RESPONSE_RE = new RegExp(
  [
    // The exact observed refusal.
    "i (?:will|would|do) not provide unnecessary information",
    "unnecessary information unless directed",
    // Soliciting the question instead of answering it.
    "(?:please )?(?:ask me|ask us|give me|provide|send me) (?:the|a|your) question",
    "(?:please )?(?:ask|repeat|restate) (?:the|your|a) question",
    "what(?:'s| is) the question",
    "waiting for (?:the|your|a) question",
    "i (?:don'?t|do not) have (?:a|the) question",
    // Asking the user to clarify rather than answering.
    "please clarify(?: this| the)?(?: answer)?",
    "(?:the )?question is (?:unclear|incomplete|missing|not clear)",
    "no question (?:was )?provided",
    // Assistant self-reference.
    "(?:i(?:'m| am)|as) an? ai(?: language model)?",
    // Assistant-style refusals (never spoken by a candidate answering).
    "i (?:cannot|can'?t|can not) (?:assist|help)",
    // Leading refusal opener.
    "^okay[.,!]*\\s*please note",
    // Our own label, lower-cased.
    "^background details",
  ].join("|"),
  "i",
);

/**
 * The `WAIT` sentinel, as a STANDALONE token ANYWHERE in an answer.
 *
 * ── Why this is separate from `isWaitResponse` ─────────────────────────────
 * `isWaitResponse` only fires when `WAIT` is the whole output, or the first
 * line, or the whole line before a colon. A real observed failure was:
 *
 *   "What is the difference between a Node 79 - Node.js8 WAIT then provide a
 *    clear question, and if a technical example or clarification, please WAIT"
 *
 * — `WAIT` appears twice, both mid-sentence, and that answer reached the UI.
 * Once a model has emitted the sentinel it is refusing, so its presence
 * anywhere is decisive regardless of what surrounds it.
 *
 * ── Why CASE-SENSITIVE ─────────────────────────────────────────────────────
 * `WAIT` is the literal token the system prompt names (`reply with exactly:
 * WAIT`), so it is always upper-case. A case-INSENSITIVE `\bwait\b` was
 * measured against the 25 recorded fixture references and against
 * hand-written correct answers, and it fires on real prose:
 *
 *   "I would wait for the index build to finish before measuring…"
 *   "You wait on the future, and if replication lags you wait…"
 *
 * Case-sensitive measured **0/25 false rejects**; case-insensitive would have
 * rejected correct answers. Case sensitivity is therefore a correctness
 * requirement here, not a stylistic choice.
 */
const WAIT_SENTINEL_RE = /(?:^|[^A-Za-z])WAIT(?:[^A-Za-z]|$)/;

/**
 * An instruction ABOUT the conversation, addressed at the responder.
 *
 * ── Why `META_RESPONSE_RE` did not catch it ────────────────────────────────
 * That regex requires a bare determiner before "question", so it matches "the
 * question" and "a question" but not "a CLEAR question". The observed output
 * said "provide a clear question", which fell straight through the gap. This
 * pattern closes it by allowing the qualifier slot.
 *
 * Deliberately closed-class: the verbs are the request-for-input verbs and the
 * only noun is the conversation artefact itself. No interview topic appears,
 * so no legitimate technical answer can match — measured 0/25 false rejects on
 * the recorded references.
 */
const CONVERSATION_INSTRUCTION_RE = new RegExp(
  [
    // "provide a clear question", "give me a more specific question", …
    // The qualifier slot is what `META_RESPONSE_RE` was missing.
    "(?:please\\s+)?(?:ask|give|provide|send|share|state|tell)\\s+(?:me\\s+)?(?:us\\s+)?(?:an?\\s+|the\\s+|your\\s+)(?:(?:more|clear(?:er)?|specific(?:ally)?|explicit|complete|full|exact|proper|whole)\\s+)*questions?",
    // "please wait", "kindly wait for the question" — lower-case refusals.
    "(?:please|kindly)\\s+wait\\b",
    // "if you need a technical example or clarification, …" — the observed tail.
    "\\b(?:technical\\s+)?(?:example|clarification)\\s*,?\\s*(?:or\\s+)?(?:clarification)?\\s*,?\\s*please\\s+wait",
  ].join("|"),
  "i",
);

/**
 * Lines that read as template instructions rather than prose.
 *
 * Matched only in a high-density context (see {@link isInstructionTemplate}),
 * never individually — a real answer may legitimately begin a sentence with
 * "If the service…" or "Never do that…".
 */
const INSTRUCTION_LINE_RE =
  /^\s*(?:\d+[.)]\s*)?(?:never|do not|don't|always|you must|must not|answer only|output only|reply with|if the\b|use only)\b/i;

/** Placeholder tokens such as [insert here], {{company}}, <FIELD>, YOUR_NAME. */
const PLACEHOLDER_RE =
  /\[(?:insert|your|my|name|company|question|answer|example)[^\]]{0,40}\]|\{\{[^}]{1,40}\}\}|<[A-Z][A-Z_]{2,}>|\bYOUR_[A-Z_]{2,}\b/g;

/** A single token that is only digits / punctuation, with no letters. */
const NUMERIC_TOKEN_RE = /^[\d.,:%$+\-()/]+$/;

/**
 * CLOSED CLASS of speech-act verbs: the verb of an imperative addressed AT a
 * responder ("Answer that text", "Repeat the prompt").
 *
 * ── Why a closed class and not a topic blacklist ────────────────────────────
 * Everything the check below consults is vocabulary *about the conversation
 * itself*. There is no interview topic in here, so no legitimate question or
 * answer can be caught by it — that is the property a topic blacklist cannot
 * have, and the reason this is a structural rule rather than a word filter.
 */
const SPEECH_ACT_VERBS = new Set([
  "answer",
  "repeat",
  "summarize",
  "summarise",
  "rephrase",
  "paraphrase",
  "translate",
  "transcribe",
  "retype",
  "rewrite",
  "reword",
  "echo",
  "print",
  "copy",
  "quote",
  "respond",
  "reply",
  "describe",
  "explain",
  "solve",
  "list",
  "write",
  "generate",
  "output",
  "return",
]);

/**
 * NOUNS that can only refer to the CONVERSATION ARTEFACT — the text the user
 * just sent. Nothing on earth is a "prompt", a "passage" or "the above text" in
 * a spoken interview answer; they are references to the message.
 */
const CONVERSATION_REFERENCE_NOUNS = new Set([
  "text",
  "wording",
  "wordings",
  "prompt",
  "passage",
  "message",
  "statement",
  "sentence",
  "transcript",
  "instruction",
  "instructions",
  "directive",
  "directions",
  "question",
  "questions",
  "answer",
  "answers",
]);

/**
 * True when the whole response is a bare directive at the model rather than an
 * answer to the interviewer.
 *
 * ── The observed failure ────────────────────────────────────────────────────
 *   turn 1791060167441-w9zhux, `groq/allam-2-7b`
 *   answer: "and Answer that text"
 *
 * It survived every existing signal, and the reasons are worth recording:
 *   • `META_RESPONSE_RE` looks for *asking* for the question ("what is the
 *     question"). This never asks — it ORDERS.
 *   • `TEMPLATE_LEAK_PHRASES` holds the Groq directive's full wording ("answer
 *     that question directly and immediately"). The model echoed a mangled
 *     fragment of it, not the full string, so the exact-substring test misses.
 *   • `readsAsLabel` is defeated by the word "that", which is in
 *     `SENTENCE_MARKERS` — the fragment reads as a sentence, so the label test
 *     correctly declines to fire.
 *
 * ── The STRUCTURAL test instead ─────────────────────────────────────────────
 * Classify every token, then require that NOTHING in the response is a content
 * word about the interview. Concretely: after dropping function words and the
 * known sentence-marker vocabulary, every remaining word must be either
 *
 *     (a) a speech-act verb in {@link SPEECH_ACT_VERBS}, or
 *     (b) a conversation-reference noun in {@link CONVERSATION_REFERENCE_NOUNS},
 *     (c) a demonstrative determiner (`that`, `this`, `the`, `above`, …).
 *
 * If that holds, the response carries no topical content at all — it is a
 * command about the conversation, not an answer about anything.
 *
 * Why it cannot reject a real answer: a real answer necessarily contains at
 * least one content word that is neither. "I would answer that question by
 * explaining the parser" keeps `explaining`, which is not a speech-act verb, so
 * it passes. Only a response made ENTIRELY of conversation-meta vocabulary is
 * rejected.
 */
function isBareDirective(text: string): boolean {
  const words = tokenize(text);
  if (words.length === 0 || words.length > 12) return false;

  const demonstratives = new Set([
    "that",
    "this",
    "these",
    "those",
    "the",
    "a",
    "an",
    "above",
    "below",
    "following",
    "previous",
    "preceding",
    "last",
    "it",
    "again",
    "verbatim",
    "word",
    "words",
  ]);

  /**
   * Function words that carry no content of their own.
   *
   * Needed because the observed output was a CONTINUATION fragment, not a
   * clean imperative: allam-2-7b emitted `"and Answer that text"` — a leading
   * `and` spliced onto the directive. Without these the fragment would fail on
   * `and` and sail through, which is precisely the reported bug.
   *
   * Same safety argument as everywhere else in this module: none of these can
   * be the only content in a real answer, so admitting them cannot widen the
   * rejection set to anything topical.
   */
  const functionWords = new Set([
    "and",
    "or",
    "but",
    "then",
    "so",
    "now",
    "just",
    "only",
    "also",
    "please",
    "your",
    "my",
    "our",
    "us",
    "me",
    "you",
    "as",
    "of",
    "for",
    "to",
    "in",
    "on",
    "with",
    "exactly",
    "verbatim",
    "literally",
    "out",
    "back",
  ]);

  let sawSpeechAct = false;
  let sawReference = false;

  for (const w of words) {
    if (SPEECH_ACT_VERBS.has(w)) {
      sawSpeechAct = true;
      continue;
    }
    if (CONVERSATION_REFERENCE_NOUNS.has(w)) {
      sawReference = true;
      continue;
    }
    if (demonstratives.has(w) || functionWords.has(w)) continue;
    // Any other word means the response is about something real.
    return false;
  }

  // A directive needs a command, and a command with nothing to act on is not a
  // failure mode we have ever observed. Both must be present.
  return sawSpeechAct && sawReference;
}

/**
 * Labels that appear in our own prompt template. A model that echoes one back
 * has produced a prompt artefact, not an answer.
 *
 * This is a list of OUR strings, not a list of interview vocabulary — adding
 * to it can never reject a legitimate answer.
 */
const PROMPT_LABEL_PATTERNS: RegExp[] = [
  // Markdown-heading form of the user prompt's sections.
  /^\s*#{1,6}\s*(latest|earlier|your)\b/i,
  // Bare-label form (heading markers stripped by a markdown renderer).
  /^\s*(latest interviewer utterance|earlier conversation|your earlier answers|candidate context|answer style)\b/i,
  // The closing instruction of the user prompt.
  /^\s*(now do the following|if the latest interviewer utterance)/i,
  // Bold/em variants of the same labels.
  /^\s*[*_]{1,2}\s*(latest interviewer utterance|earlier conversation|your earlier answers)\b/i,
];

/** The neutral delimiters used by `buildInterviewUserPrompt`. */
const DELIMITER_ECHO_PATTERNS: RegExp[] = [
  /^\s*<{2,}\s*(latest_question|background|previous_answers|end_latest_question|end_background|end_previous_answers|active_problem|end_active_problem)\b/i,
];

/**
 * Labels of the session-context block, as BARE lines.
 *
 * The underscore-joined forms are already covered by
 * {@link INTERNAL_LABEL_RE}; these are the same labels as they appear in real
 * prose — "Active problem: …" — because a model asked to restate the context
 * will usually drop the underscores and emit the readable form.
 *
 * Same rule as everywhere else in this module: these are OUR strings. None of
 * them can appear in a legitimate spoken answer, and none of them names an
 * interview topic.
 */
const SESSION_CONTEXT_LABEL_PATTERNS: RegExp[] = [
  /^\s*active\s+problem\s*:/i,
  /^\s*ghostly'?s\s+earlier\s+suggested\s+approach\s*:/i,
  /^\s*user\s+notes\s*:/i,
  /^\s*end[_ ]active[_ ]problem\b/i,
  // ── The conversation-thread layer's labels ────────────────────────────
  // ADDITIVE ONLY. All four can only come from our own prompt block, so their
  // presence in an ANSWER means the model reproduced our scaffolding instead of
  // answering. That is the same class of leak the labels above catch, and a
  // new block that is not covered here is a new hole.
  /^\s*earlier\s+interview\s+thread\b/i,
  /^\s*earlier\s+suggested\s+answer\s*:/i,
  /^\s*background\s+context\s*:/i,
  /^\s*active\s+problem\s+context\s*:/i,
];

/**
 * Words that can only appear in a *spoken sentence*, never in a label.
 *
 * Used only as a supporting signal, and only in combination with several other
 * conditions — never on its own, and never as a topic blacklist. English
 * function/auxiliary vocabulary, which is what makes a fragment parseable as
 * an utterance rather than as a heading.
 */
const SENTENCE_MARKERS = new Set([
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "done",
  "have", "has", "had",
  "can", "could", "will", "would", "shall", "should", "may", "might", "must",
  "i", "we", "they", "he", "she", "it", "you",
  "my", "our", "their", "its", "your",
  // Subordinators only. Pure conjunctions ("and", "or", "but", "then") are
  // DELIBERATELY absent: they are exactly what headings are built from, so
  // including them let "Previously mentioned interview questions or requests"
  // read as a sentence.
  "because", "so", "that", "if", "when",
  "used", "use", "uses", "using", "made", "make", "makes",
  "get", "gets", "got", "need", "needs", "want", "wants",
  "took", "take", "tried", "try", "worked", "work", "works",
  "believe", "think", "feel", "wanted", "chose", "choose",
  "helped", "built", "handled", "learned", "prefer",
]);

/** Split into lowercase word tokens, dropping punctuation. */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter(Boolean);
}

/**
 * Strip Markdown decoration so we can judge the *content* of a line.
 * Returns "" when a line carried no prose at all (e.g. `---`, `***`).
 */
function stripMarkdown(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/^\s*>\s*/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Does the line look like a Markdown heading (setext or ATX)? */
function isMarkdownHeading(line: string): boolean {
  if (/^\s*#{1,6}\s+\S/.test(line)) return true;
  // Setext: a short line followed by === or ---
  return /^\s*(=+|-{3,})\s*$/.test(line);
}

/**
 * True when the response carries no prose — it is entirely headings, rules or
 * list markers.
 *
 * Deliberately requires *every* non-empty line to be Markdown. A bare sentence
 * with no `#` and no underline is prose, even without terminal punctuation,
 * because "It's mainly used for dependency injection" is a valid spoken answer.
 */
function isHeadingOnly(text: string): boolean {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return true;

  return lines.every(
    (line) => isMarkdownHeading(line) || stripMarkdown(line).length === 0,
  );
}

/**
 * True when the text reads as a *label* rather than a sentence.
 *
 * All four conditions must hold, which is what keeps this from touching real
 * answers:
 *   1. at least 3 words — "Yes", "No", "Correct", "Absolutely" are exempt;
 *   2. no sentence-terminating punctuation — a spoken answer ends in a stop;
 *   3. no sentence-marker word anywhere;
 *   4. short enough to be a heading (≤ 12 words).
 *
 * "Previously mentioned interview questions or requests" fails all four
 * (6 words, no terminator, no sentence marker) and is rejected.
 * "Yes I have" passes (3+ words but contains "i"/"have").
 * "It's mainly used for dependency injection" passes (contains "it"/"is"/"used").
 */
function readsAsLabel(text: string): boolean {
  const trimmed = text.trim();
  const words = tokenize(trimmed);
  if (words.length < 3) return false;
  if (words.length > 12) return false;
  if (/[.!?…]["')\]]?$/.test(trimmed)) return false;
  if (words.some((w) => SENTENCE_MARKERS.has(w))) return false;
  return true;
}

/**
 * True when the answer is the question restated with nothing added.
 *
 * Requires near-total containment of the answer's content words in the
 * question AND fewer than 4 content words, so "Yes." (0 overlap) and a real
 * short answer are untouched.
 */
function isQuestionEcho(answer: string, question?: string): boolean {
  if (!question?.trim()) return false;
  const answerWords = new Set(
    tokenize(answer).filter((w) => w.length > 2),
  );
  const questionWords = new Set(tokenize(question));
  if (answerWords.size === 0 || answerWords.size >= 4) return false;
  let shared = 0;
  for (const w of answerWords) if (questionWords.has(w)) shared++;
  return shared / answerWords.size >= 0.8;
}

// ── Structural artifact detector ────────────────────────────────────────────

/** k-word shingles over an alphabetic word stream. */
function shingles(words: string[], k: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + k <= words.length; i++) {
    out.add(words.slice(i, i + k).join(" "));
  }
  return out;
}

/**
 * Structural similarity to our instruction template (spec §4).
 *
 * Compares 5-word shingles of the answer against those of the template and
 * rejects when a large fraction of the answer is literally our own rules. The
 * caller passes the STATIC rules template only (`INTERVIEW_SYSTEM_PROMPT`),
 * never the assembled system message that also contains the candidate resume —
 * otherwise a legitimate answer that quotes the candidate's own experience
 * would look like a template echo.
 *
 * Requires a real sample size (≥ 8 answer shingles) and a high threshold (35%),
 * so ordinary English shared with the template cannot trip it.
 */
function isTemplateEcho(answer: string, promptTemplate?: string): boolean {
  if (!promptTemplate?.trim()) return false;
  const answerWords = answer.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  if (answerWords.length < 24) return false;
  const templateWords = promptTemplate.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  const templateShingles = shingles(templateWords, 5);
  if (templateShingles.size === 0) return false;
  const answerShingles = shingles(answerWords, 5);
  if (answerShingles.size < 8) return false;
  let overlap = 0;
  for (const s of answerShingles) if (templateShingles.has(s)) overlap++;
  return overlap / answerShingles.size >= 0.35;
}

/**
 * True when the output is a numbered rule list / imperative template rather
 * than prose. Requires BOTH many instruction-shaped lines AND them dominating
 * the response, so a normal answer that merely opens one sentence with "If the
 * service…" is untouched.
 */
function isInstructionTemplate(text: string): boolean {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 3) return false;
  const instructions = lines.filter((l) => INSTRUCTION_LINE_RE.test(l)).length;
  return instructions >= 3 && instructions / lines.length >= 0.5;
}

/**
 * True for a numeric / token dump.
 *
 * Deliberately requires MULTIPLE signals: either a numeric-heavy stream with
 * almost no words (two independent conditions), or one unbroken run of 8+
 * isolated integers, which is degenerate on its own. A legitimate technical
 * answer such as "Use HTTP 500 errors and 3 replicas" has plenty of words and
 * is never touched.
 */
function isNumericArtifact(text: string): boolean {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length >= 12) {
    const numeric = tokens.filter((t) => NUMERIC_TOKEN_RE.test(t)).length;
    const alpha = tokens.filter((t) => /[a-zA-Z]{2,}/.test(t)).length;
    if (numeric / tokens.length >= 0.4 && alpha / tokens.length <= 0.3) {
      return true;
    }
  }
  let run = 0;
  let maxRun = 0;
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      run++;
      maxRun = Math.max(maxRun, run);
    } else {
      run = 0;
    }
  }
  return maxRun >= 8;
}

/** True when there is no meaningful natural-language content at all. */
function isNoProse(text: string): boolean {
  const nonSpace = text.replace(/\s+/g, "");
  if (nonSpace.length < 4) return false;
  const letters = (text.match(/[a-zA-Z]/g) ?? []).length;
  if (letters === 0) return true;
  return letters / nonSpace.length < 0.2;
}

/**
 * Detect STRUCTURAL prompt leakage / malformed output.
 *
 * This is the hard backstop the UI relies on: a provider whose text trips any
 * signal here must never win and must never render. It uses multiple independent
 * structural signals and never a topic blacklist, so it cannot reject a normal
 * answer that merely contains words like "question" or "task".
 */
export function detectAnswerArtifact(
  text: string,
  opts: { promptTemplate?: string } = {},
): AnswerArtifact {
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) {
    return { artifact: true, reason: "empty", detail: "empty response" };
  }

  // 1. Application-private delimiters — a HARD failure anywhere in the text.
  if (DELIMITER_RE.test(trimmed)) {
    return {
      artifact: true,
      reason: "artifact-delimiter",
      detail: "answer contained a private <<< … >>> marker",
    };
  }

  // 2. Internal underscore-joined labels (LATEST_TASK, ITEM_QUESTION, …).
  const label = trimmed.match(INTERNAL_LABEL_RE);
  if (label) {
    return {
      artifact: true,
      reason: "artifact-prompt-label",
      detail: `answer contained an internal label: ${label[1]}`,
    };
  }

  // 3. Distinctive phrase lifted from our instruction template.
  const lower = trimmed.toLowerCase();
  for (const phrase of TEMPLATE_LEAK_PHRASES) {
    if (lower.includes(phrase)) {
      return {
        artifact: true,
        reason: "artifact-template",
        detail: "answer reproduced an instruction-template phrase",
      };
    }
  }

  // 3b-bis. The WAIT sentinel as a standalone token ANYWHERE. Runs before the
  // meta-response check so a mixed output ("…WAIT then provide a clear
  // question…") is reported as the refusal it is, rather than as a generic
  // meta-response. See {@link WAIT_SENTINEL_RE} for the case-sensitivity
  // measurement that justifies it.
  if (WAIT_SENTINEL_RE.test(trimmed)) {
    return {
      artifact: true,
      reason: "artifact-wait-sentinel",
      detail: "answer contained the WAIT refusal sentinel",
    };
  }

  // 3b-ter. An instruction about the conversation rather than an answer to it.
  // Closes the qualifier gap in `META_RESPONSE_RE` ("a clear question").
  if (CONVERSATION_INSTRUCTION_RE.test(trimmed)) {
    return {
      artifact: true,
      reason: "artifact-conversation-instruction",
      detail: "answer instructed about the conversation instead of answering",
    };
  }

  // 3b. Meta-response: asking for the question, requesting clarification, or
  // refusing to answer. A real answer never does any of these.
  if (META_RESPONSE_RE.test(trimmed)) {
    return {
      artifact: true,
      reason: "artifact-meta",
      detail: "answer was a meta-response (asked for the question or refused)",
    };
  }

  // 3c. A bare directive at the model instead of an answer to the interviewer.
  //     Runs BEFORE the placeholder and instruction-template checks because it
  //     is the more specific statement about the same class of failure.
  if (isBareDirective(trimmed)) {
    return {
      artifact: true,
      reason: "artifact-directive",
      detail: "answer was a directive addressed to the model, not a response",
    };
  }

  // 4. Unfilled placeholder blocks.
  const placeholders = trimmed.match(PLACEHOLDER_RE) ?? [];
  if (placeholders.length >= 2) {
    return {
      artifact: true,
      reason: "artifact-placeholder",
      detail: `answer contained ${placeholders.length} unfilled placeholders`,
    };
  }

  // 5. Instruction-shaped output rather than prose.
  if (isInstructionTemplate(trimmed)) {
    return {
      artifact: true,
      reason: "artifact-instruction",
      detail: "answer was an instruction-style template, not prose",
    };
  }

  // 6. Numeric / token dump.
  if (isNumericArtifact(trimmed)) {
    return {
      artifact: true,
      reason: "artifact-numeric",
      detail: "answer was a numeric/token dump",
    };
  }

  // 7. Structural echo of the instruction template.
  if (isTemplateEcho(trimmed, opts.promptTemplate)) {
    return {
      artifact: true,
      reason: "artifact-template",
      detail: "answer was structurally similar to the instruction template",
    };
  }

  // 8. No meaningful natural-language content.
  if (isNoProse(trimmed)) {
    return {
      artifact: true,
      reason: "no-prose",
      detail: "answer had no meaningful natural-language content",
    };
  }

  return { artifact: false };
}

/**
 * ── SHADOW RULE (c): answer/question content-word overlap ───────────────────
 *
 * Computed on every answer and reported in the Debug latency report, but it
 * NEVER REJECTS. It is instrumentation for a decision not yet made, because the
 * rule is known to be able to reject a CORRECT answer: a good response often
 * paraphrases rather than reuses the question's words, so
 *
 *   question: "What is difference between SQL and NoSQL databases?"
 *   answer:   "One is relational with a fixed schema and joins, the other is
 *              document-oriented and schemaless"
 *
 * shares ZERO content words and is correct. Shipping it as a rejection would
 * trade a rare bad answer for a common good one.
 *
 * Two minimum-sample guards exist so a degenerate case cannot look like a
 * finding: a one-content-word question ("What is Redis?" → just `redis`) and a
 * one-word answer are both excluded from `wouldReject` rather than counted as
 * zero-overlap evidence.
 *
 * Nothing here is a topic list. The word sets are derived from the two strings
 * being compared, which is what keeps the rule topic-agnostic.
 */
export const SHADOW_MIN_QUESTION_WORDS = 2;
export const SHADOW_MIN_ANSWER_WORDS = 3;

export interface ShadowOverlap {
  questionContentWords: number;
  answerContentWords: number;
  sharedContentWords: number;
  /** shared / min(questionWords, answerWords), 0..1. Numeric only. */
  overlapScore: number;
  /** True when the rule WOULD have rejected. Reported, never acted on. */
  wouldReject: boolean;
  /** Why the rule abstained, when it did. Closed vocabulary, no text. */
  abstained: "no-question" | "too-few-question-words" | "too-few-answer-words" | null;
}

/** Content words of a string: tokens longer than 2 chars, minus function words. */
function contentWordSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of tokenize(text)) {
    if (w.length > 2 && !SHADOW_FUNCTION_WORDS.has(w)) out.add(w);
  }
  return out;
}

/**
 * Function words excluded from the overlap comparison.
 *
 * Small and linguistic, not topical: every entry is a word that carries no
 * subject matter. Deliberately does NOT contain technology names, so "redis"
 * or "sql" count as content on both sides.
 */
const SHADOW_FUNCTION_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can",
  "her", "was", "one", "our", "out", "day", "get", "has", "him", "his",
  "how", "its", "new", "now", "old", "see", "two", "way", "who", "boy",
  "did", "man", "men", "put", "say", "she", "too", "use", "that", "this",
  "with", "have", "from", "they", "would", "there", "their", "what", "about",
  "which", "when", "make", "like", "time", "just", "know", "take", "into",
  "your", "some", "them", "than", "then", "only", "come", "over", "such",
  "also", "back", "after", "other", "many", "most", "well", "even", "want",
  "because", "these", "give", "does", "done", "being", "having", "where",
  "while", "should", "could", "might", "must", "shall", "will", "been",
  "were", "each", "more", "less", "very", "much", "same", "both", "between",
]);

/**
 * Evaluate rule (c) without applying it.
 *
 * Returns numbers and closed-vocabulary reasons only — no question text, no
 * answer text, so the result is safe to log and to display.
 */
export function shadowOverlapCheck(
  answer: string,
  question?: string,
): ShadowOverlap {
  const empty: ShadowOverlap = {
    questionContentWords: 0,
    answerContentWords: 0,
    sharedContentWords: 0,
    overlapScore: 0,
    wouldReject: false,
    abstained: "no-question",
  };
  if (!question?.trim()) return empty;

  const q = contentWordSet(question);
  const a = contentWordSet(answer ?? "");
  if (q.size < SHADOW_MIN_QUESTION_WORDS) {
    return {
      ...empty,
      questionContentWords: q.size,
      answerContentWords: a.size,
      abstained: "too-few-question-words",
    };
  }
  if (a.size < SHADOW_MIN_ANSWER_WORDS) {
    return {
      ...empty,
      questionContentWords: q.size,
      answerContentWords: a.size,
      abstained: "too-few-answer-words",
    };
  }

  let shared = 0;
  for (const w of a) if (q.has(w)) shared++;
  const denom = Math.min(q.size, a.size);

  return {
    questionContentWords: q.size,
    answerContentWords: a.size,
    sharedContentWords: shared,
    overlapScore: denom > 0 ? Math.round((shared / denom) * 1000) / 1000 : 0,
    // The rule as specified: sharing NO content words with the question.
    // Guarded above, so it only ever fires on a real comparison.
    wouldReject: shared === 0,
    abstained: null,
  };
}

/**
 * Validate a completed (or partial) answer.
 *
 * @param text   The answer text as received from the provider.
 * @param opts.question The question this run was answering, when known. Used
 *   only for the question-echo signal.
 * @param opts.promptTemplate Our STATIC instruction template, when available,
 *   used only for the structural prompt-echo check (never logged).
 */
export function validateAnswerOutput(
  text: string,
  opts: { question?: string; promptTemplate?: string } = {},
): AnswerValidation {
  const trimmed = (text ?? "").trim();

  if (trimmed.length === 0) {
    return { ok: false, reason: "empty", detail: "empty response" };
  }

  // Structural prompt-leak / malformed-output backstop. Runs BEFORE every other
  // check so a leaked response can never slip through on a technicality.
  const artifact = detectAnswerArtifact(trimmed, {
    promptTemplate: opts.promptTemplate,
  });
  if (artifact.artifact) {
    return {
      ok: false,
      reason: artifact.reason ?? "artifact-template",
      detail: artifact.detail ?? "answer rejected as a prompt artefact",
    };
  }

  // The session-context labels. ADDITIVE ONLY: nothing here removes or relaxes an
  // existing check, so every answer this feature already rejected is still
  // rejected, and every answer it accepted is still accepted unless it now
  // echoes a block label.
  for (const pattern of SESSION_CONTEXT_LABEL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        ok: false,
        reason: "prompt-label",
        detail: `output reproduced a session-context label: ${trimmed.slice(0, 60)}`,
      };
    }
  }

  for (const pattern of PROMPT_LABEL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        ok: false,
        reason: "prompt-label",
        detail: `output starts with a prompt label: ${trimmed.slice(0, 60)}`,
      };
    }
  }

  for (const pattern of DELIMITER_ECHO_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        ok: false,
        reason: "delimiter-echo",
        detail: `output echoed a prompt delimiter: ${trimmed.slice(0, 60)}`,
      };
    }
  }

  if (isHeadingOnly(trimmed)) {
    return {
      ok: false,
      reason: "heading-only",
      detail: `output was headings only: ${trimmed.slice(0, 60)}`,
    };
  }

  if (readsAsLabel(trimmed)) {
    return {
      ok: false,
      reason: "heading-only",
      detail: `output read as a label, not a sentence: ${trimmed.slice(0, 60)}`,
    };
  }

  if (isQuestionEcho(trimmed, opts.question)) {
    return {
      ok: false,
      reason: "question-echo",
      detail: "output only restated the question",
    };
  }

  return { ok: true };
}