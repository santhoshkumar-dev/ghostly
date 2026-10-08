/**
 * Conversation thread — the SECOND context layer, for technical / project
 * drill-downs.
 *
 * ── Why this is not `activeProblem` ─────────────────────────────────────────
 * `activeProblem` answers "what work are we doing?" — it holds a coding or
 * design problem that follow-up questions refer back to. This layer answers a
 * different question: "what have we been DISCUSSING?", where each turn is a
 * question and what Ghostly suggested in reply.
 *
 * The chain this exists for:
 *
 *   "What is Redis?"
 *   "Why did you use Redis in your project?"
 *   "What is the flow with Redis in your project?"
 *   "What happens when the cache misses?"
 *
 * By turn three, "the flow" is meaningless without turn two, and turn two is
 * meaningless without turn one. `activeProblem` cannot carry it: none of these
 * is a coding problem, and hanging a Redis discussion off it would both misfile
 * the discussion and destroy the real problem's context.
 *
 * ── What this layer must NEVER do ──────────────────────────────────────────
 *   NO MANUFACTURED PROJECT FACTS. The thread stores the topic, the recent
 *   questions, and Ghostly's own suggested answer heads. It never concludes
 *   "the project uses caching because the interviewer asked about Redis" and
 *   stores that as fact. Project facts come from the candidate profile only.
 *   The prompt says so explicitly, because a stored invented fact is
 *   indistinguishable from a real one on the next turn.
 *
 *   NO "WHAT YOU SAID". `answerHead` is an excerpt of an answer GHOSTLY
 *   PRODUCED. Ghostly has no candidate-microphone channel, so it cannot know
 *   what the candidate actually said. Every label says "earlier suggested
 *   answer", and the prompt spells out that these are not statements about the
 *   candidate.
 *
 *   NO LLM CALL. Sentence extraction and truncation are deterministic, so this
 *   cannot add latency, cost quota, or fail in a way that blocks an answer.
 *
 *   IN MEMORY ONLY. A thread that survived a restart would be wrong about what
 *   is being discussed, which is worse than having none.
 */

// ── Caps and TTL (all named, all measured in `verify-conversation-thread.ts`) ──

/** How many recent turns are retained. Older ones are evicted from the front. */
export const THREAD_MAX_TURNS = 3;

/**
 * Hard cap on one `answerHead`, in characters.
 *
 * The spec asks for "the first 1–2 sentences, max ~200 chars". Both limits are
 * applied: sentence extraction decides where to stop, and this is the backstop
 * for an answer whose first sentence is enormous.
 */
export const THREAD_ANSWER_HEAD_MAX_CHARS = 200;

/** How many content words are kept as the thread's topic fingerprint. */
export const THREAD_MAX_TOPIC_TERMS = 8;

/**
 * How long a thread stays attachable after its last use, in ms.
 *
 * Shorter than `SESSION_CONTEXT_TTL_MS` (30 min) on purpose. A coding problem
 * legitimately spans a long working session; a drill-down discussion does not,
 * and reviving a stale Redis thread twenty minutes later is exactly the wrong
 * attachment the conservatism rule exists to prevent.
 */
export const THREAD_TTL_MS = 10 * 60 * 1000;

/** Smallest acceptable answer excerpt. Below this, nothing is stored. */
const MIN_ANSWER_HEAD_CHARS = 20;

// ── Types ───────────────────────────────────────────────────────────────────

export interface ThreadTurn {
  /** The corrected question, as the pipeline used it. */
  question: string;
  /**
   * The first 1–2 sentences of a VALIDATED Ghostly answer, or null when no
   * acceptable excerpt was available. Null is stored rather than an empty
   * string so the renderer can omit the line instead of printing a bare label.
   */
  answerHead: string | null;
}

export interface ConversationThread {
  /**
   * Content words from the recent questions, most recent first, deduplicated.
   *
   * Derived from the questions themselves — never from a topic whitelist. This
   * is what makes the layer work for a topic nobody anticipated.
   */
  topicTerms: string[];
  /**
   * Content words from the question the thread was STARTED on, kept
   * permanently and used to lead {@link topicTerms}.
   *
   * Why this is separate from `topicTerms`: that fingerprint is rebuilt from the
   * RETAINED turns, newest first, so after an ordinary four-question
   * drill-down the subject word is pushed out by the scaffolding of the
   * follow-ups ("what", "happens", "cache", "miss", "can", "explain"). A thread
   * about Redis then held no "redis" at all, and the next question that plainly
   * named Redis matched nothing. Turn eviction makes it worse, because the seed
   * question is the first turn to go. The subject is what the thread is ABOUT
   * and must not depend on which turns happen to still be retained.
   *
   * Optional so a thread literal written before this field existed still works;
   * when it is absent the fingerprint simply leads with the retained turns.
   */
  subjectTerms?: string[];
  /** Most recent LAST, so `turns[turns.length - 1]` is the current turn. */
  turns: ThreadTurn[];
  updatedAt: number;
}

export const EMPTY_THREAD: ConversationThread | null = null;

// ── Text helpers ────────────────────────────────────────────────────────────

/**
 * Leading conversational fillers, stripped before cue matching.
 *
 * "Okay so why did you use Redis?" must match the same cue as "Why did you use
 * Redis?". Only LEADING fillers are removed — a filler word in the middle is
 * part of the sentence.
 */
const LEADING_FILLERS =
  /^\s*(?:(?:okay|ok|so|and|right|then|well|alright|yeah|yes|now|but|hmm|um|uh)\b[\s,.]*)+/i;

export function stripLeadingFillers(text: string): string {
  let out = (text ?? "").trim();
  // Repeat: "okay so and then" is four fillers in a row.
  for (let i = 0; i < 8; i++) {
    const next = out.replace(LEADING_FILLERS, "");
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

/**
 * Function words excluded from topic terms.
 *
 * Linguistic only. A technology name in here would make that technology
 * invisible to the overlap test — silently turning this into a topic filter,
 * which is the one thing the design forbids. `verify-conversation-thread.ts`
 * asserts no technology name appears in this list.
 */
const THREAD_FUNCTION_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can",
  "was", "one", "our", "out", "get", "has", "him", "his", "how", "its",
  "now", "old", "see", "two", "way", "who", "did", "put", "say", "she",
  "too", "use", "used", "using", "uses", "that", "this", "with", "have",
  "from", "they", "would", "there", "their", "what", "about", "which",
  "when", "make", "like", "time", "just", "know", "take", "into", "your",
  "some", "them", "than", "then", "only", "come", "over", "such", "also",
  "back", "after", "other", "many", "most", "well", "even", "want",
  "because", "these", "give", "does", "done", "being", "having", "where",
  "while", "should", "could", "might", "must", "shall", "will", "been",
  "were", "each", "more", "less", "very", "much", "same", "both", "why",
  "wha", "project", "projects",
]);

/** Content words: tokens longer than 2 chars that are not function words. */
export function threadContentWords(text: string): string[] {
  const words = (text ?? "").toLowerCase().match(/[a-z0-9']+/g) ?? [];
  return words.filter((w) => w.length > 2 && !THREAD_FUNCTION_WORDS.has(w));
}

// ── Answer head extraction ──────────────────────────────────────────────────

/**
 * Deterministically take the first 1–2 sentences of a VALIDATED answer.
 *
 * ── Sentence splitting, and why it is this crude ───────────────────────────
 * A real sentence tokeniser is a dependency and a source of surprises. Splitting
 * on `.!?` followed by whitespace-or-end is enough for the stated job, and an
 * abbreviation mis-split costs one short excerpt, never a wrong answer.
 *
 * ── Which sentences ────────────────────────────────────────────────────────
 * The OPENING sentences, because they state what Ghostly proposed before it
 * elaborates. A summary from the middle would be a detail shot out of context.
 *
 * ── Markdown ───────────────────────────────────────────────────────────────
 * Answers frequently open with a heading or a code fence. Leading heading and
 * fence lines are dropped, because an excerpt that is only `## Approach` tells
 * the next turn nothing.
 *
 * @returns the excerpt, or `null` when the answer yields nothing usable. The
 *   caller stores null rather than an empty string.
 */
export function extractAnswerHead(answer: string): string | null {
  const raw = (answer ?? "").trim();
  if (raw.length === 0) return null;

  const withoutDecoration = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (line.length === 0) return false;
      // Markdown heading, horizontal rule, or code fence.
      if (/^#{1,6}\s/.test(line)) return false;
      if (/^[-=*_]{3,}$/.test(line)) return false;
      if (/^```/.test(line)) return false;
      return true;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (withoutDecoration.length === 0) return null;

  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < withoutDecoration.length; i++) {
    const ch = withoutDecoration[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    const next = withoutDecoration[i + 1];
    // Only a terminator at end-of-string or before whitespace ends a sentence.
    if (next !== undefined && next !== " ") continue;
    sentences.push(withoutDecoration.slice(start, i + 1).trim());
    start = i + 1;
    if (sentences.length >= 2) break;
  }
  if (sentences.length === 0) {
    sentences.push(withoutDecoration);
  }

  const joined = sentences.join(" ").trim();
  if (joined.length < MIN_ANSWER_HEAD_CHARS) {
    // Too short to be a useful excerpt — but only reject if the WHOLE answer is
    // this short. A short first sentence from a long answer is fine.
    if (withoutDecoration.length < MIN_ANSWER_HEAD_CHARS) return null;
  }

  return clipChars(joined, THREAD_ANSWER_HEAD_MAX_CHARS);
}

/** Trim on a word boundary, adding an ellipsis only when something was cut. */
function clipChars(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

// ── Cue detection ───────────────────────────────────────────────────────────

/**
 * Generic drill-down cues.
 *
 * Every alternative is grammar for referring back to something already
 * discussed. None names a technology, a data structure or a language, so
 * "Why would you use Redis?" and "Why would you use Kubernetes?" match for
 * identical reasons and neither match is topical.
 */
const THREAD_CUE_GROUPS: Array<{ reason: string; re: RegExp }> = [
  {
    reason: "asks about usage in the project",
    re: /\b(?:in|for)\s+(?:your|the|my)\s+(?:project|system|application|app|service|code|team|product|work)\b|\bhow\s+(?:is|are)\s+it\s+used\b|\bhow\s+did\s+you\s+use\b|\bhow\s+do\s+you\s+use\b|\bhow\s+is\s+it\s+used\b/i,
  },
  {
    reason: "asks why a technology was chosen",
    re: /\bwhy\s+(?:would|did|do|should)\s+you\s+use\b|\bwhy\s+use\b|\bwhy\s+(?:would|did)\s+you\s+(?:choose|pick)\b/i,
  },
  {
    reason: "asks whether a technology would be used",
    re: /\bwould\s+you\s+use\b|\bcan\s+you\s+use\b|\bcould\s+you\s+use\b|\bwhy\s+not\s+use\b/i,
  },
  {
    reason: "asks about the flow or sequence",
    // The second alternative is deliberately narrow: it requires the DEFINITE
    // object, so "explain the flow" continues the thread while "explain Docker"
    // still opens a new subject (and is caught by NEW_SUBJECT_CUES). A bare
    // "can you explain" cue would have broken that, because a cue is tested
    // BEFORE the new-subject check.
    re: /\bwhat(?:'s| is)\s+the\s+flow\b|\bwhat\s+happens\s+(?:when|if|next|after|on|during|for)\b|\bhow\s+does\s+it\s+work\b|\bwalk\s+me\s+through\s+the\s+flow\b|\b(?:explain|walk\s+me\s+through)\s+the\s+(?:flow|process|steps|pipeline|sequence|approach|design|architecture)\b/i,
  },
  {
    reason: "asks about trade-offs or drawbacks",
    re: /\btrade[-\s]?offs?\b|\bdrawbacks?\b|\bdownsides?\b|\blimitations?\b/i,
  },
  {
    reason: "refers back with a deictic pronoun",
    re: /\b(?:what|how|why)\s+about\s+(?:it|that|this|them)\b|\b(?:and|so|then)\s+(?:it|that|this|what|how|why)\b/i,
  },
  {
    // ── Drill-down on the artefact under discussion ──────────────────────────
    //
    // This group exists because of a measured gap, not a guess. The canonical
    // coding interview runs like this:
    //
    //   Q1 "Write a function to reverse a string."
    //   Q2 "Can you optimize the solution?"
    //   Q3 "What is the time complexity?"
    //   Q4 "What edge cases should I handle?"
    //
    // None of Q2–Q4 shares a content word with Q1 ("write function reverse
    // string"), so the overlap fallback scored 0 and the thread was dropped —
    // four consecutive questions about ONE problem answered as four unrelated
    // ones. Q3 failed a second way: "What is the time complexity?" matches
    // NEW_SUBJECT_CUES (it opens like "What is Docker?"), so it was read as a
    // topic switch.
    //
    // It is listed as a CUE, not a change to NEW_SUBJECT_CUES, because cues are
    // deliberately tested first (see the note on the flow/sequence group). That
    // ordering is what keeps the distinction intact: "What is the TIME
    // COMPLEXITY?" now matches this group and attaches, while "What is Docker?"
    // matches nothing here and still opens a new subject.
    //
    // Like every other group it is technology-neutral: it matches on the
    // grammar of drilling down, never on a named tool or language.
    reason: "drills into the artefact under discussion",
    re: /\boptimi[sz]e\b|\boptimi[sz]ed\b|\bmake\s+it\s+(?:faster|better|more\s+efficient)\b|\bbetter\s+(?:approach|way|solution|implementation)\b|\b(?:time|space)\s+complexity\b|\bcomplexity\b|\bedge\s+cases?\b|\bcorner\s+cases?\b|\bmore\s+(?:detail|details)\b|\bgo\s+deeper\b|\bwhat\s+am\s+i\s+missing\b/i,
  },
];

/** Attempts to introduce a NEW subject, which must not attach to the old one. */
const NEW_SUBJECT_CUES: RegExp[] = [
  // "What is Docker?" / "What are containers?" — a standalone definition.
  /^\s*what\s+(?:is|are|was|were)\s+(?:a|an|the)?\s*\w/i,
  // "Explain X" / "Describe X" / "Tell me about X"
  /^\s*(?:explain|describe|tell\s+me\s+about|define)\b/i,
];

/** True when the question plausibly opens a fresh subject. */
export function looksLikeNewSubject(question: string): boolean {
  const text = stripLeadingFillers(question ?? "");
  return NEW_SUBJECT_CUES.some((re) => re.test(text));
}

// ── Overlap ─────────────────────────────────────────────────────────────────

/**
 * Fraction of the question's content words that appear in the thread's
 * vocabulary (topic terms + earlier question words).
 *
 * Supportive evidence only. Zero overlap is NOT evidence of a bad answer, and
 * nothing here ever rejects anything.
 */
export function threadOverlapScore(
  question: string,
  thread: ConversationThread,
): number {
  const q = threadContentWords(question);
  if (q.length === 0) return 0;
  const vocab = new Set<string>([
    ...thread.topicTerms,
    ...thread.turns.flatMap((t) => threadContentWords(t.question)),
  ]);
  if (vocab.size === 0) return 0;
  let shared = 0;
  for (const w of q) if (vocab.has(w)) shared++;
  return Math.round((shared / q.length) * 1000) / 1000;
}

/** Minimum overlap that counts as supporting evidence. */
export const THREAD_MIN_OVERLAP = 0.2;

// ── The decision ────────────────────────────────────────────────────────────

export type ThreadReason =
  | "attached: follow-up cue + topic overlap"
  | "attached: follow-up cue"
  | "attached: topic overlap"
  | "no thread"
  | "thread expired (older than the TTL)"
  | "new subject: does not attach"
  | "no cue and no overlap: not attached";

export interface ThreadVerdict {
  attach: boolean;
  reason: ThreadReason;
  /** Which cue matched, when one did. */
  cue?: string;
  /** The measured overlap, always reported — it is the instrument. */
  overlap: number;
}

/**
 * Should this question be answered with the conversation thread?
 *
 * ── Conservatism is the design ─────────────────────────────────────────────
 * A WRONG attachment is worse than a missing one: the block is labelled
 * "background", so a missing thread costs a slightly vaguer answer, while a
 * wrong one invites the model to blend two unrelated discussions. Every
 * ambiguous case therefore resolves to `attach: false`.
 *
 * ── Order of checks, and why the CUE runs before the new-subject test ───────
 *   1. No thread → no.
 *   2. TTL expired → no, and the caller may start a fresh thread.
 *   3. A cue → yes. This MUST run before the new-subject test, because the two
 *      overlap on the most important case in the whole feature:
 *
 *        "What is the flow with Redis in your project?"
 *
 *      starts with "what is" — the exact shape of a standalone definition — and
 *      under ASR the topic word routinely arrives mangled ("reddis", "red is"),
 *      which drops the overlap below the threshold and removes the only thing
 *      that would have saved it. Ordering the new-subject test first therefore
 *      broke a drilled-down question precisely when the audio was worst, which
 *      is when the context is most needed. A cue is a positive signal and wins.
 *   4. No cue, but a standalone definition on an unrelated subject → no, and the
 *      caller REPLACES the thread. This is where "What is Docker?" lands: it
 *      matches no cue at all, so it is genuinely a fresh subject.
 *   5. No cue, enough overlap → yes. "how does the cache miss behave?" carries
 *      no cue but is plainly about the thread's subject.
 */
export function continueThread(
  question: string,
  thread: ConversationThread | null,
  now: number,
): ThreadVerdict {
  if (!thread || thread.turns.length === 0) {
    return { attach: false, reason: "no thread", overlap: 0 };
  }

  if (now - thread.updatedAt > THREAD_TTL_MS) {
    return {
      attach: false,
      reason: "thread expired (older than the TTL)",
      overlap: 0,
    };
  }

  const stripped = stripLeadingFillers(question);
  const overlap = threadOverlapScore(question, thread);

  // A CUE WINS. See the ordering note above: a drilled-down question under noisy
  // audio looks exactly like a standalone definition, and the cue is the signal
  // that still holds.
  for (const group of THREAD_CUE_GROUPS) {
    if (group.re.test(stripped)) {
      return {
        attach: true,
        reason:
          overlap >= THREAD_MIN_OVERLAP
            ? "attached: follow-up cue + topic overlap"
            : "attached: follow-up cue",
        cue: group.reason,
        overlap,
      };
    }
  }

  // No cue, and it opens like a standalone definition → a fresh subject REPLACES
  // the thread. "What is Docker?" lands here.
  if (looksLikeNewSubject(stripped)) {
    return { attach: false, reason: "new subject: does not attach", overlap };
  }

  if (overlap >= THREAD_MIN_OVERLAP) {
    return { attach: true, reason: "attached: topic overlap", overlap };
  }

  return {
    attach: false,
    reason: "no cue and no overlap: not attached",
    overlap,
  };
}

// ── Mutation ────────────────────────────────────────────────────────────────

/** Start a thread from a question. Used when a new subject is detected. */
export function startThread(
  question: string,
  now: number,
): ConversationThread {
  const terms = threadContentWords(question).slice(0, THREAD_MAX_TOPIC_TERMS);
  return {
    topicTerms: [...terms],
    subjectTerms: [...terms],
    turns: [{ question: question.trim(), answerHead: null }],
    updatedAt: now,
  };
}

/**
 * Append a turn, evicting the oldest past {@link THREAD_MAX_TURNS}.
 *
 * Topic terms are RE-DERIVED from the retained turns rather than accumulated:
 * a term from an evicted turn would keep a subject alive after every question
 * about it has scrolled out, which is the drift that makes a thread attach to
 * the wrong thing.
 *
 * The one term class that survives re-derivation is the thread's own SUBJECT
 * (see {@link ConversationThread.subjectTerms}). It leads the fingerprint so a
 * thread cannot lose the thing it is about to a run of generic follow-ups, and
 * later turns fill whatever budget is left.
 */
export function appendThreadTurn(
  thread: ConversationThread,
  question: string,
  answerHead: string | null,
  now: number,
): ConversationThread {
  const turns = [...thread.turns, { question: question.trim(), answerHead }];
  const kept = turns.slice(-THREAD_MAX_TURNS);
  const terms: string[] = [];
  const add = (word: string): boolean => {
    if (!terms.includes(word)) terms.push(word);
    return terms.length >= THREAD_MAX_TOPIC_TERMS;
  };
  // The subject first: it is what the thread is about, and it must not be
  // evicted by the newest turn's question scaffolding.
  for (const w of thread.subjectTerms ?? []) {
    if (add(w)) break;
  }
  // Then the retained turns, most recent first, so fresh vocabulary follows the
  // subject rather than competing with it.
  for (const t of [...kept].reverse()) {
    for (const w of threadContentWords(t.question)) {
      if (add(w)) break;
    }
    if (terms.length >= THREAD_MAX_TOPIC_TERMS) break;
  }
  return {
    topicTerms: terms,
    subjectTerms: thread.subjectTerms,
    turns: kept,
    updatedAt: now,
  };
}

// ── Prompt block ────────────────────────────────────────────────────────────

/**
 * Label used for a previous Ghostly answer.
 *
 * NOT "what you said". Ghostly has no candidate-microphone channel, so it
 * cannot know what the candidate actually said, and a label claiming otherwise
 * would make the model treat a suggestion as a fact about the candidate — then
 * build on it.
 */
export const THREAD_ANSWER_LABEL = "Earlier suggested answer";

/**
 * Build the thread prompt block. Returns `""` when there is nothing to send.
 *
 * The header states what the material IS and what it is NOT, in the block
 * itself, because the block is what the model reads — a disclaimer that lives
 * only in our source comments protects nobody.
 */
export function buildThreadBlock(thread: ConversationThread | null): string {
  if (!thread || thread.turns.length === 0) return "";

  const lines: string[] = [];
  lines.push("EARLIER INTERVIEW THREAD (background only)");
  lines.push(
    "These are questions already asked and answers Ghostly SUGGESTED at the " +
      "time. They are not necessarily what the candidate said. Use them only " +
      "to stay consistent with the ongoing discussion.",
  );

  for (const turn of thread.turns) {
    lines.push(`Q: ${turn.question}`);
    if (turn.answerHead) {
      lines.push(`${THREAD_ANSWER_LABEL}: ${turn.answerHead}`);
    }
  }

  return lines.join("\n");
}

/**
 * The instruction appended to the thread block.
 *
 * Deliberately names no technology and states no conclusion — it constrains
 * where project FACTS may come from, which is the only way to keep the model
 * from inventing project usage because the interviewer mentioned a product.
 */
export const THREAD_INSTRUCTION =
  "Answer ONLY the latest interviewer question. Use the background above only " +
  "when it is relevant to that question. Keep project facts consistent with " +
  "the candidate profile — never invent project usage, architecture, " +
  "technologies, metrics or implementation details.";

/** One-line description for the context chip. Never contains the topic text. */
export function describeThread(thread: ConversationThread | null): string {
  if (!thread || thread.turns.length === 0) return "no thread";
  const lead = thread.topicTerms[0];
  return `${lead ?? "topic"} · ${thread.turns.length} turn${
    thread.turns.length === 1 ? "" : "s"
  }`;
}
