/**
 * Phase 8.3 — Groq chat-model benchmark.
 *
 * Run (the entry point `scripts/ai-bench.mjs` re-execs this under `tsx`):
 *   GROQ_API_KEY=… node scripts/ai-bench.mjs --provider groq
 *   GROQ_API_KEY=… node scripts/ai-bench.mjs --provider groq --models llama-3.3-70b-versatile
 *   GROQ_API_KEY=… node scripts/ai-bench.mjs --provider groq --list-models
 *
 * ── Why this file is separate from `ai-bench.mjs` ───────────────────────────
 * This axis uses the REAL shipping prompt builder and the REAL shipping
 * validator — `buildInterviewUserPrompt` / `INTERVIEW_SYSTEM_PROMPT` from
 * `src/lib/interviewAgent.ts` and `validateAnswerOutput` from
 * `src/lib/outputValidation.ts`. Both are TypeScript, so this file is `.mts`
 * and runs under `tsx`. A benchmark that measured a hand-copied prompt and a
 * hand-copied validator would be measuring the copy, not the product.
 *
 * ── What it measures ────────────────────────────────────────────────────────
 * Per model: time to first token, total time, valid-answer rate, the
 * distribution of rejection reasons, and the raw answer text. The raw text is
 * printed on purpose — a composite score is a claim, and the user is the only
 * one who can overrule it.
 *
 * ── Keys come from the environment ONLY ─────────────────────────────────────
 * `GROQ_API_KEY` is read from `process.env` and nowhere else. There is no
 * `--key` flag, and `assertNoKeyInArgv` fails loudly if one is passed, because
 * a key in argv lands in the shell history, in `ps`, and in any CI log that
 * echoes the command.
 *
 * ── Never runs unattended ───────────────────────────────────────────────────
 * It spends real quota. No key → exit 2 with no fabricated result.
 */

import process from "node:process";

import { validateAnswerOutput } from "../src/lib/outputValidation";
import {
  INTERVIEW_SYSTEM_PROMPT,
  buildInterviewUserPrompt,
  type InterviewTurn,
} from "../src/lib/interviewAgent";

export const GROQ_BASE = "https://api.groq.com/openai/v1";
const MODELS_URL = `${GROQ_BASE}/models`;
const CHAT_URL = `${GROQ_BASE}/chat/completions`;

/** Default pause between requests, in ms. */
export const DEFAULT_DELAY_MS = 400;

/**
 * The fixed question set: 10 short interview questions.
 *
 * Fixed and in this order so two runs, or two models, are comparable. Short by
 * design — the benchmark is about latency and answer shape, and a long-form
 * prompt would measure the model's patience rather than the product's turn.
 */
export const QUESTIONS: ReadonlyArray<{ id: string; text: string }> = [
  { id: "process-thread", text: "What is the difference between a process and a thread?" },
  { id: "index-cost", text: "What is an index, and what does it cost you to have one?" },
  { id: "map-vs-set", text: "When would you use a HashMap over a HashSet in Java?" },
  { id: "rest-idempotent", text: "Which HTTP methods are idempotent, and why?" },
  { id: "auth-session", text: "How do you keep a session secure in a browser app?" },
  { id: "sql-index", text: "Why can a composite index be slower than a single-column one?" },
  { id: "retry-backoff", text: "How do you retry a failed request without making an outage worse?" },
  { id: "gc-pause", text: "What causes a garbage collection pause, and how do you reduce it?" },
  { id: "api-versioning", text: "How do you version a public API without breaking clients?" },
  { id: "debug-slow", text: "A page load got slower last week. How do you find out why?" },
];

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * A 429 from Groq.
 *
 * Its own class so the caller can STOP that model rather than retrying. A
 * retry loop against a rate limit is how a benchmark turns into a bill.
 */
export class RateLimitError extends Error {
  readonly status = 429;
  /** Seconds Groq asked us to wait, when it said. */
  readonly retryAfterSeconds: number | null;
  constructor(message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Any other non-2xx, or a transport failure. Reported, never retried. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`HTTP ${status}: ${message}`);
    this.name = "HttpError";
    this.status = status;
  }
}

// ── Argument parsing ────────────────────────────────────────────────────────

export interface GroqArgs {
  /** Explicit model list. Empty means "use the live list". */
  models: string[];
  /** Print the live model list and exit without spending quota. */
  listModels: boolean;
  rounds: number;
  maxTokens: number;
  delayMs: number;
  /**
   * Write every answer to this path as JSON, so a later harness can re-measure
   * REJECTION RULES against real model output instead of against question text.
   * Measuring a rule on question text measures the wrong population.
   */
  dumpAnswers: string | null;
}

/**
 * Parse argv.
 *
 * There is deliberately no key flag here. Every option is either a model name,
 * a count, or a duration — nothing that could be a secret.
 */
export function parseArgs(argv: string[]): GroqArgs {
  const out: GroqArgs = {
    models: [],
    listModels: false,
    rounds: 1,
    maxTokens: 1024,
    delayMs: DEFAULT_DELAY_MS,
    dumpAnswers: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--models") {
      // Comma-separated so the whole choice is one flag: `--models a,b,c`.
      const value = argv[++i] ?? "";
      out.models = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (argv[i] === "--list-models") {
      out.listModels = true;
    } else if (argv[i] === "--rounds") {
      out.rounds = Math.max(1, Number(argv[++i]) || 1);
    } else if (argv[i] === "--max-tokens") {
      out.maxTokens = Number(argv[++i]) || 1024;
    } else if (argv[i] === "--delay-ms") {
      out.delayMs = Math.max(0, Number(argv[++i]) || 0);
    } else if (argv[i] === "--dump-answers") {
      out.dumpAnswers = argv[++i] ?? null;
    }
  }
  return out;
}

/**
 * Fail if anything resembling a key was passed as an argument.
 *
 * A key in argv is the one mistake that cannot be undone by deleting a file:
 * it is already in the shell history. Refusing is the only responsible option.
 */
export function assertNoKeyInArgv(argv: string[]): void {
  const secretish = /(?:^|=)(sk-|gsk_|AIza|xai-|nvapi-|gsk_|Bearer\s)|api[_-]?key/i;
  for (const arg of argv) {
    if (secretish.test(arg)) {
      throw new Error(
        `refusing to run: "${arg}" looks like a key passed on the command line. ` +
          `Keys are read from the environment only (GROQ_API_KEY), never from an ` +
          `argument, because argv is visible in shell history and process listings.`,
      );
    }
  }
}

// ── Model selection ─────────────────────────────────────────────────────────

/**
 * Model-id fragments that mean "not a chat model".
 *
 * Groq's catalogue mixes text chat with Whisper (audio transcription), TTS,
 * guard models and vision models. Only the chat models can answer an interview
 * question, so everything else is excluded rather than attempted and failed.
 *
 * Exported so the exclusion list is testable on its own.
 */
export const NON_CHAT_PATTERNS: readonly RegExp[] = [
  /whisper/i,
  /tts/i,
  /guard/i,
  /embed/i,
  /vision/i,
  /image/i,
  /audio/i,
  /moderation/i,
  /ocr/i,
  /text-to-speech/i,
];

/** Whether a model id is a chat model this benchmark can drive. */
export function isChatModel(id: string): boolean {
  if (!id) return false;
  return !NON_CHAT_PATTERNS.some((re) => re.test(id));
}

/**
 * Reduce a `/models` payload to the chat models, sorted for a stable report.
 *
 * A malformed payload yields an EMPTY list rather than a guess, because
 * benchmarking a hard-coded model list would silently measure models the key
 * cannot actually reach.
 */
export function selectChatModels(payload: unknown): string[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((m) => (m as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].filter(isChatModel).sort();
}

/** Fetch the live model list. Requires the key; never logs it. */
export async function fetchChatModels(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const res = await fetchImpl(MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const detail = await safeDetail(res);
    throw new HttpError(res.status, detail);
  }
  return selectChatModels(await res.json());
}

async function safeDetail(res: { text: () => Promise<string> }): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200);
  } catch {
    return "(no body)";
  }
}

// ── Prompt construction (the REAL builder) ──────────────────────────────────

/**
 * Build the user message with the shipping prompt builder.
 *
 * The turn is a single committed utterance, which is what the app sends on a
 * first turn with no history: `finals` = [the question], `questionIndex` 0.
 */
export function buildPromptForQuestion(question: string): string {
  const turn: InterviewTurn = {
    finals: [{ source: "mic", text: question }],
    interim: null,
  };
  return buildInterviewUserPrompt(turn, { questionIndex: 0 });
}

// ── One streamed request ────────────────────────────────────────────────────

export interface GroqRunResult {
  text: string;
  totalMs: number;
  /** Time to the first content delta, or null if the stream carried none. */
  firstTokenMs: number | null;
}

/**
 * Stream one chat completion, timing the first content token.
 *
 * A 429 becomes {@link RateLimitError} so the caller can stop the model; every
 * other failure becomes {@link HttpError}. Neither is ever retried here.
 */
export async function runGroqOnce({
  apiKey,
  model,
  userPrompt,
  maxTokens,
  fetchImpl = fetch,
}: {
  apiKey: string;
  model: string;
  userPrompt: string;
  maxTokens: number;
  fetchImpl?: typeof fetch;
}): Promise<GroqRunResult> {
  const t0 = performance.now();
  const res = await fetchImpl(CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.3,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: INTERVIEW_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    if (res.status === 429) {
      const retryAfter = Number(res.headers?.get?.("retry-after") ?? "") || null;
      throw new RateLimitError("rate limited by Groq (429)", retryAfter);
    }
    throw new HttpError(res.status, await safeDetail(res));
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let firstTokenMs: number | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload.trim() === "[DONE]") continue;
      let json: { choices?: Array<{ delta?: { content?: unknown } }> };
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = json.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        if (firstTokenMs === null) firstTokenMs = performance.now() - t0;
        text += delta;
      }
    }
  }

  return {
    text: text.trim(),
    totalMs: Math.round(performance.now() - t0),
    firstTokenMs: firstTokenMs === null ? null : Math.round(firstTokenMs),
  };
}

// ── Per-model run ───────────────────────────────────────────────────────────

export interface ModelRow {
  questionId: string;
  round: number;
  firstTokenMs: number | null;
  totalMs: number;
  chars: number;
  valid: boolean;
  reason: string | null;
  detail: string | null;
  text: string;
}

export interface ModelOutcome {
  model: string;
  rows: ModelRow[];
  /** Set when the model was abandoned. Never retried. */
  stopped: string | null;
}

/**
 * Run every question against one model.
 *
 * Stops on the FIRST 429 and says so. Continuing would spend the remaining
 * quota the rate limit exists to protect, and would produce a partial average
 * that looks like a completed one.
 */
export async function runModel({
  apiKey,
  model,
  args,
  sleep = defaultSleep,
  fetchImpl = fetch,
}: {
  apiKey: string;
  model: string;
  args: GroqArgs;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<ModelOutcome> {
  const rows: ModelRow[] = [];
  let stopped: string | null = null;

  outer: for (let round = 0; round < args.rounds; round++) {
    for (const q of QUESTIONS) {
      if (rows.length > 0) await sleep(args.delayMs);
      try {
        const r = await runGroqOnce({
          apiKey,
          model,
          userPrompt: buildPromptForQuestion(q.text),
          maxTokens: args.maxTokens,
          fetchImpl,
        });
        // The REAL validator, with the REAL prompt template, so a rejection
        // here means the app would have rejected it too.
        const verdict = validateAnswerOutput(r.text, {
          question: q.text,
          promptTemplate: INTERVIEW_SYSTEM_PROMPT,
        });
        rows.push({
          questionId: q.id,
          round: round + 1,
          firstTokenMs: r.firstTokenMs,
          totalMs: r.totalMs,
          chars: r.text.length,
          valid: verdict.ok,
          reason: verdict.reason ?? null,
          detail: verdict.detail ?? null,
          text: r.text,
        });
      } catch (err) {
        if (err instanceof RateLimitError) {
          const wait = err.retryAfterSeconds
            ? ` Retry-After: ${err.retryAfterSeconds}s.`
            : "";
          stopped = `rate limited (429) after ${rows.length} of ${
            args.rounds * QUESTIONS.length
          } samples.${wait} Not retried — continuing would spend the quota the limit protects.`;
          break outer;
        }
        stopped = `failed: ${err instanceof Error ? err.message : String(err)}`;
        break outer;
      }
    }
  }

  return { model, rows, stopped };
}

const defaultSleep = (ms: number) =>
  ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();

// ── Statistics and reporting ────────────────────────────────────────────────

/** Median, which is the right statistic for a handful of noisy samples. */
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export interface ModelSummary {
  model: string;
  samples: number;
  /** Median ms to the first content token. */
  firstTokenMs: number | null;
  /** Median ms to the last byte. */
  totalMs: number | null;
  validRate: number | null;
  /** reason → count, most frequent first. */
  rejections: Array<[string, number]>;
  stopped: string | null;
}

export function summarizeModel(outcome: ModelOutcome): ModelSummary {
  const { rows, stopped } = outcome;
  const reasons = new Map<string, number>();
  for (const r of rows) {
    if (r.valid) continue;
    const key = r.reason ?? "unknown";
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  return {
    model: outcome.model,
    samples: rows.length,
    firstTokenMs: median(rows.map((r) => r.firstTokenMs ?? 0).filter((v) => v > 0)),
    totalMs: median(rows.map((r) => r.totalMs)),
    validRate: rows.length
      ? Math.round((rows.filter((r) => r.valid).length / rows.length) * 100) / 100
      : null,
    rejections: [...reasons.entries()].sort((a, b) => b[1] - a[1]),
    stopped,
  };
}

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(0)}%`);
const ms = (v: number | null) => (v === null ? "—" : `${v}ms`);

/** The per-model table. Fixed columns so two runs diff cleanly. */
export function formatSummaryTable(summaries: ModelSummary[]): string {
  const head = ["model", "n", "TTFT", "total", "valid", "rejections"];
  const rows = summaries.map((s) => [
    s.model,
    String(s.samples),
    ms(s.firstTokenMs),
    ms(s.totalMs),
    pct(s.validRate),
    s.rejections.length
      ? s.rejections.map(([r, n]) => `${r}×${n}`).join(" ")
      : "—",
  ]);
  const widths = [34, 4, 8, 8, 7, 30];
  const line = (cells: string[]) =>
    cells.map((c, i) => (c.length >= widths[i] ? c.slice(0, widths[i]) : c.padEnd(widths[i]))).join(" ");
  return [line(head), widths.map((w) => "-".repeat(w)).join(" "), ...rows.map(line)].join("\n");
}

/** Per-sample detail plus the raw answers, so a human can overrule the score. */
export function formatDetail(outcome: ModelOutcome): string {
  const lines: string[] = [];
  for (const r of outcome.rows) {
    const verdict = r.valid ? "valid" : `REJECTED ${r.reason}${r.detail ? ` (${r.detail})` : ""}`;
    lines.push(
      `  [${r.questionId} | r${r.round}] ttft=${ms(r.firstTokenMs)} total=${ms(
        r.totalMs,
      )} chars=${r.chars} ${verdict}`,
    );
    lines.push(`    ${r.text || "(empty)"}`);
  }
  return lines.join("\n");
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  assertNoKeyInArgv(argv);
  const args = parseArgs(argv);
  const apiKey = process.env.GROQ_API_KEY ?? "";
  if (!apiKey.trim()) {
    console.error(
      "GROQ_API_KEY is not set. This benchmark spends real quota, so it " +
        "refuses to report a fabricated result without one. Set it in the " +
        "environment; it is never read from a file or an argument.",
    );
    return 2;
  }

  console.log("=== Phase 8.3 AI benchmark: Groq ===");
  console.log(`questions  : ${QUESTIONS.length}`);
  console.log(`rounds     : ${args.rounds}`);
  console.log(`maxTokens  : ${args.maxTokens}`);
  console.log(`delayMs    : ${args.delayMs}`);
  console.log("key        : present in environment (value never logged)");
  console.log("");

  let models: string[];
  if (args.models.length > 0) {
    models = args.models;
    console.log(`Models: chosen explicitly (${models.length}): ${models.join(", ")}`);
  } else {
    models = await fetchChatModels(apiKey);
    if (models.length === 0) {
      console.error(
        "The live /models response contained no chat models, or the key cannot " +
          "list them. Refusing to fall back to a hard-coded list, because a " +
          "model the key cannot reach would fail every sample and look like a " +
          "model that answers badly.",
      );
      return 3;
    }
    console.log(`Models: from the live /models list (${models.length})`);
    for (const m of models) console.log(`  ${m}`);
  }
  console.log("");

  if (args.listModels) {
    console.log("--list-models: no requests sent.");
    return 0;
  }

  console.log("Prompt: the shipping buildInterviewUserPrompt + INTERVIEW_SYSTEM_PROMPT");
  console.log("Scoring: the shipping validateAnswerOutput");
  console.log("");

  const outcomes: ModelOutcome[] = [];
  for (const model of models) {
    console.log(`--- ${model} ---`);
    const outcome = await runModel({ apiKey, model, args });
    outcomes.push(outcome);
    if (outcome.stopped) console.log(`  STOPPED: ${outcome.stopped}`);
    for (const r of outcome.rows) {
      console.log(
        `  ${r.questionId.padEnd(16)} ttft=${ms(r.firstTokenMs).padStart(7)} ` +
          `total=${ms(r.totalMs).padStart(7)} chars=${String(r.chars).padStart(5)} ` +
          `${r.valid ? "valid" : `REJECTED ${r.reason}`}`,
      );
    }
  }

  // ── Answer dump ─────────────────────────────────────────────────────────
  // Written AFTER the run so a measurement pass can be re-run against the same
  // output without spending quota twice. Contains model output, which is not a
  // secret but IS potentially user-visible text, so the path is always explicit
  // and the file is never written by default.
  if (args.dumpAnswers) {
    const payload = {
      generatedAt: new Date().toISOString(),
      provider: "groq",
      questions: QUESTIONS.map((q) => ({ id: q.id, text: q.text })),
      answers: outcomes.flatMap((o) =>
        o.rows.map((r) => {
          const q = QUESTIONS.find((x) => x.id === r.questionId);
          return {
            model: o.model,
            questionId: r.questionId,
            question: q?.text ?? "",
            answer: r.text,
            valid: r.valid,
            reason: r.reason,
            firstTokenMs: r.firstTokenMs,
            totalMs: r.totalMs,
          };
        }),
      ),
    };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(args.dumpAnswers, JSON.stringify(payload, null, 2), "utf8");
    console.log(`\nAnswers written to ${args.dumpAnswers}`);
  }

  console.log("\n=== summary ===");
  console.log(formatSummaryTable(outcomes.map(summarizeModel)));
  console.log("\nRaw answers (so a human can disagree with the validator):");
  for (const o of outcomes) {
    console.log(`\n--- ${o.model} ---`);
    console.log(formatDetail(o));
  }
  return 0;
}