/**
 * Phase 8.3 — AI provider benchmark.
 *
 * Run:
 *   GEMINI_API_KEY=… node scripts/ai-bench.mjs
 *   GEMINI_API_KEY=… node scripts/ai-bench.mjs --model gemini-2.5-flash
 *   GEMINI_API_KEY=… node scripts/ai-bench.mjs --rounds 3
 *   GROQ_API_KEY=…   node scripts/ai-bench.mjs --provider groq
 *   GROQ_API_KEY=…   node scripts/ai-bench.mjs --provider groq --list-models
 *   GROQ_API_KEY=…   node scripts/ai-bench.mjs --provider groq --models a,b
 *
 * ── Two providers, two implementations ─────────────────────────────────────
 * `--provider gemini` (the default) is the original benchmark below and is
 * UNCHANGED. `--provider groq` delegates to `scripts/ai-bench-groq.mts`, which
 * drives every chat model Groq's live /models list returns and scores answers
 * with the SHIPPING validator rather than a copy of it.
 *
 * That delegation needs `tsx`, because the Groq axis imports the real
 * `buildInterviewUserPrompt` and the real `validateAnswerOutput` — a benchmark
 * that measured a hand-copied prompt and validator would be measuring the copy.
 * So `--provider groq` re-execs this file under tsx, transparently.
 *
 * Keys are read from the environment ONLY (`GEMINI_API_KEY`, `GROQ_API_KEY`).
 * Neither provider accepts a key as an argument.
 *
 * ── What this measures ──────────────────────────────────────────────────────
 * LATENCY and QUALITY for one provider under two generation configs. Today the
 * headline comparison is Gemini 2.5 Flash with thinking DISABLED
 * (`thinkingBudget: 0`) against its DEFAULT config, because that is the one
 * setting that most plausibly explains a slow or empty answer:
 *
 *   • Gemini 2.5 / 3 think by DEFAULT, and those reasoning tokens are billed
 *     against `maxOutputTokens`. A small budget therefore produces a 200 with
 *     nothing in it.
 *   • `parseGeminiEvent` deliberately discards thought parts, so the extra
 *     latency is pure cost unless it improves the answer.
 *
 * Both arms use the SAME prompt, the SAME seed order and the SAME questions, so
 * the only variable is `thinkingBudget`.
 *
 * ── Quality is judged here, not by a model ──────────────────────────────────
 * There is no second model to grade with — that would just relocate the
 * uncertainty. Instead each answer is scored on deterministic, checkable
 * properties, and the raw text is printed so a human can disagree:
 *
 *   valid          — passed `validateAnswerOutput` (the shipping validator)
 *   answered       — contains no "ask me for the question" meta-response
 *   onTopic        — shares ≥ 2 content words with the question it answers
 *   length         — chars, and whether it is suspiciously short
 *   quality        — the composite, printed alongside all of the above
 *
 * The composite is deliberately simple and weighted toward the hard failures
 * (invalid / not-answered are worse than short). It is a way to see a
 * regression across configs, not a claim of absolute quality.
 *
 * ── Never runs unattended ───────────────────────────────────────────────────
 * It spends real quota. No key → it exits without printing a fake result.
 */

import process from "node:process";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * The interview questions this benchmark answers.
 *
 * Realistic phrasing from the actual product (a technical interview), and
 * deliberately mixed: one definition question, one design question, one
 * question with a company-specific premise that rewards using the supplied
 * context, and one short one that punishes padding.
 */
const QUESTIONS = [
  {
    id: "definition",
    prompt:
      "In one short paragraph, what is the difference between a process and a " +
      "thread, and when would you choose one over the other?",
  },
  {
    id: "design",
    prompt:
      "You have a service that becomes slow under load. Walk me through how " +
      "you would diagnose it, in order, and what you would measure at each step.",
  },
  {
    id: "premise",
    prompt:
      "Our backend is Java. Why might a team still choose TypeScript for the " +
      "frontend, and what would you push back on?",
  },
  {
    id: "short",
    prompt: "What is an index, and what does it cost you to have one?",
  },
];

/** The shared system instruction — the real one, not a paraphrase. */
const SYSTEM =
  "You are answering a software engineering interview question. Answer as " +
  "spoken prose a candidate would say out loud. Do not use headings, " +
  "bullet points, labels or markers. Do not ask for the question. Do not " +
  "mention being an AI. If there is genuinely no question, reply with " +
  "exactly: WAIT.";

/**
 * Mirrors `src/lib/ai/gemini.ts::geminiGenerationConfig`.
 *
 * Duplicated on purpose: that module is TypeScript importing Vite types, and
 * this script must run under plain `node`. The two are asserted to agree by
 * `scripts/verify-ai-bench.mts`, so a drift becomes a test failure rather than
 * a silently wrong measurement.
 */
export function geminiGenerationConfig(model, maxTokens, thinkingBudget) {
  const config = { maxOutputTokens: maxTokens, temperature: 0.3 };
  // `flash-lite` models are EXCLUDED from the thinking config: measured against
  // the live API (2026-10-06), they answer `thinkingConfig` with HTTP 400
  // INVALID_ARGUMENT and return HTTP 200 + text when the field is omitted.
  if (/^gemini-(?:2\.5|3)/i.test(model) && !/flash-lite/i.test(model)) {
    // `"provider-default"` omits the field entirely, which is the ONLY way to
    // measure the API's own default. For Flash the shipping policy is already
    // `thinkingBudget: 0`, so sending 0 for both arms would report a confident
    // delta of zero and teach the opposite of the truth.
    if (thinkingBudget === "provider-default") return config;
    const budget =
      typeof thinkingBudget === "number"
        ? Math.max(0, Math.floor(thinkingBudget))
        : /pro/i.test(model)
          ? 128
          : 0;
    config.thinkingConfig = { thinkingBudget: budget };
  }
  return config;
}

/** The exact string that must not reach the screen (see outputValidation). */
const ARTIFACT_SAMPLES = ["and Answer that text", "Answer that text"];

const SENTENCE_MARKERS = new Set([
  "is", "are", "was", "were", "be", "do", "does", "did", "have", "has",
  "had", "can", "could", "will", "would", "should", "may", "might", "must",
  "i", "we", "they", "he", "she", "it", "you", "my", "our", "their", "its",
  "your", "because", "so", "that", "if", "when", "used", "use", "using",
  "get", "get", "need", "needs", "take", "took", "try", "tried", "work",
  "worked", "think", "believe",
]);

const tokenize = (t) => (t.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter(Boolean);

/** Content words = tokens that are not pure function/auxiliary vocabulary. */
function contentWords(text) {
  return new Set(tokenize(text).filter((w) => w.length > 2 && !SENTENCE_MARKERS.has(w)));
}

/**
 * Deterministic quality score for one answer.
 *
 * Weighted toward the hard failures. `valid` and `answered` are pass/fail
 * because a wrong-shaped answer is worse than a thin one — the whole reason the
 * shipping validator exists.
 */
export function scoreAnswer({ answer, question, valid }) {
  const trimmed = (answer ?? "").trim();
  const meta = /\b(?:what(?:'s| is) the question|ask me (?:the|a) question|as an ai)\b/i.test(
    trimmed,
  );
  const onTopic = (() => {
    const a = contentWords(trimmed);
    const q = contentWords(question);
    if (a.size === 0) return false;
    let shared = 0;
    for (const w of a) if (q.has(w)) shared++;
    return shared >= 2;
  })();

  const quality =
    (valid ? 4 : 0) + (meta ? 0 : 2) + (onTopic ? 2 : 0) + (trimmed.length >= 120 ? 2 : trimmed.length >= 40 ? 1 : 0);

  return {
    chars: trimmed.length,
    valid,
    answered: !meta && trimmed.length > 0,
    onTopic,
    quality,
    text: trimmed,
  };
}

/** One streamed request. Returns timing plus the concatenated text. */
async function runOnce({ apiKey, model, prompt, maxTokens, thinkingBudget }) {
  const url = `${BASE}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: SYSTEM }] },
    generationConfig: geminiGenerationConfig(model, maxTokens, thinkingBudget),
  };

  const t0 = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const headersMs = performance.now() - t0;

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(
      `HTTP ${response.status}: ${err?.error?.message ?? response.statusText}`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let firstTextMs = null;
  let sawThought = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      let data;
      try {
        data = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      const parts = data?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (!part) continue;
        if (part.thought === true) {
          sawThought = true;
          continue;
        }
        if (typeof part.text === "string" && part.text) {
          if (firstTextMs == null) firstTextMs = performance.now() - t0;
          text += part.text;
        }
      }
    }
  }

  return {
    text: text.trim(),
    totalMs: Math.round(performance.now() - t0),
    headersMs: Math.round(headersMs),
    firstTextMs: firstTextMs == null ? null : Math.round(firstTextMs),
    sawThought,
  };
}

/** Median, which is the right statistic for a handful of noisy samples. */
const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

const mean = (xs) =>
  xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;

function parseArgs(argv) {
  const out = {
    model: "gemini-2.5-flash",
    rounds: 1,
    maxTokens: 4096,
    provider: "gemini",
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") out.model = argv[++i];
    else if (argv[i] === "--rounds") out.rounds = Math.max(1, Number(argv[++i]) || 1);
    else if (argv[i] === "--max-tokens") out.maxTokens = Number(argv[++i]) || 4096;
    else if (argv[i] === "--provider") out.provider = argv[++i] ?? "gemini";
  }
  return out;
}

/**
 * Re-exec the Groq axis under tsx and return its exit code.
 *
 * Needed because `scripts/ai-bench-groq.mts` imports TypeScript modules. The
 * guard variable is what stops the child from re-execing itself forever: the
 * child sees it set and imports the module directly instead.
 */
async function delegateToGroq(argv) {
  if (process.env.GHOSTLY_AI_BENCH_TSX === "1") {
    const groq = await import("./ai-bench-groq.mts");
    return groq.main(argv);
  }
  const { spawnSync } = await import("node:child_process");
  // ── Why this is not just `spawnSync("npx", …)` ────────────────────────────
  // On Windows `npx` is a batch file. Spawning it directly fails (EINVAL with
  // `shell:false`, ENOENT without the extension), and `shell:true` works but
  // re-concatenates argv unescaped and prints a DEP0190 warning. Going through
  // ComSpec explicitly is the documented way to run a .cmd and avoids both.
  const isWindows = process.platform === "win32";
  const [cmd, cmdArgs] = isWindows
    ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npx", "--no-install", "tsx", process.argv[1], ...argv]]
    : ["npx", ["--no-install", "tsx", process.argv[1], ...argv]];
  const result = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    env: { ...process.env, GHOSTLY_AI_BENCH_TSX: "1" },
  });
  if (result.error) {
    console.error(
      "could not start tsx, which --provider groq needs: " +
        `${result.error.message}\nInstall it with: npm i -D tsx`,
    );
    return 1;
  }
  return result.status ?? 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  // The Groq axis is a different implementation in a different file; the
  // Gemini path below is untouched.
  if (args.provider === "groq") {
    try {
      process.exitCode = await delegateToGroq(argv);
    } catch (err) {
      // A refusal (a key in argv, say) is a message for the user, not a crash.
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 2;
    }
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY ?? "";
  if (!apiKey.trim()) {
    console.error(
      "GEMINI_API_KEY is not set. This benchmark spends real quota, so it " +
        "refuses to report a fabricated result without one.",
    );
    process.exit(2);
  }

  console.log("=== Phase 8.3 AI benchmark ===");
  console.log(`model      : ${args.model}`);
  console.log(`rounds     : ${args.rounds}`);
  console.log(`maxTokens  : ${args.maxTokens}`);
  console.log(`questions  : ${QUESTIONS.length}`);
  console.log("");
  console.log(
    "Arms: A = thinkingBudget 0 (thinking OFF) · B = thinkingConfig omitted\n" +
      "(the model's own default, which for 2.5 Flash is dynamic thinking)",
  );

  // Both arms. `"provider-default"` omits `thinkingConfig` entirely, so arm B is
  // the model's own default behaviour rather than a second copy of arm A.
  const arms = [
    { id: "A thinking OFF (budget=0)", thinkingBudget: 0 },
    { id: "B provider default", thinkingBudget: "provider-default" },
  ];

  const results = [];

  for (const arm of arms) {
    for (const q of QUESTIONS) {
      for (let round = 0; round < args.rounds; round++) {
        const label = `${arm.id} · ${q.id} · r${round + 1}`;
        try {
          const r = await runOnce({
            apiKey,
            model: args.model,
            prompt: q.prompt,
            maxTokens: args.maxTokens,
            thinkingBudget: arm.thinkingBudget,
          });
          // The shipping validator is TypeScript; this script cannot import it
          // under plain node, so the artifact strings it must reject are
          // checked explicitly and the rest is left to the app. Stated here
          // rather than pretended away: `verify-ai-bench.mts` asserts that this
          // list still matches `outputValidation`'s behaviour.
          const rejected = ARTIFACT_SAMPLES.some((s) =>
            r.text.toLowerCase().includes(s.toLowerCase()),
          );
          const score = scoreAnswer({
            answer: r.text,
            question: q.prompt,
            valid: !rejected && r.text.length > 0 && !/^wait$/i.test(r.text),
          });
          results.push({ arm: arm.id, q: q.id, round, ...r, ...score });
          console.log(
            `  ${label.padEnd(44)} total=${String(r.totalMs).padStart(6)}ms ` +
              `headers=${String(r.headersMs).padStart(5)}ms ` +
              `first=${String(r.firstTextMs ?? "-").padStart(5)}ms ` +
              `thought=${r.sawThought ? "yes" : "no "} ` +
              `chars=${String(score.chars).padStart(5)} q=${score.quality}`,
          );
        } catch (err) {
          console.log(`  ${label.padEnd(44)} FAILED: ${err.message}`);
          results.push({ arm: arm.id, q: q.id, round, error: err.message });
        }
      }
    }
  }

  console.log("\n=== summary ===");
  for (const arm of arms) {
    const rows = results.filter((r) => r.arm === arm.id && !r.error);
    if (rows.length === 0) {
      console.log(`  ${arm.id}: no successful samples`);
      continue;
    }
    console.log(
      `  ${arm.id.padEnd(20)} n=${rows.length} ` +
        `totalMs(med)=${String(median(rows.map((r) => r.totalMs))).padStart(6)} ` +
        `totalMs(mean)=${String(mean(rows.map((r) => r.totalMs))).padStart(6)} ` +
        `firstTextMs(med)=${String(median(rows.map((r) => r.firstTextMs ?? 0))).padStart(5)} ` +
        `chars(med)=${String(median(rows.map((r) => r.chars))).padStart(5)} ` +
        `quality(med)=${String(median(rows.map((r) => r.quality))).padStart(2)} ` +
        `valid=${rows.filter((r) => r.valid).length}/${rows.length} ` +
        `onTopic=${rows.filter((r) => r.onTopic).length}/${rows.length}`,
    );
  }

  const a = results.filter((r) => r.arm === arms[0].id && !r.error);
  const b = results.filter((r) => r.arm === arms[1].id && !r.error);
  if (a.length && b.length) {
    const dm = median(b.map((r) => r.totalMs)) - median(a.map((r) => r.totalMs));
    const dq = median(b.map((r) => r.quality)) - median(a.map((r) => r.quality));
    console.log(
      `\n  B − A: latency ${dm >= 0 ? "+" : ""}${dm}ms, quality ${
        dq >= 0 ? "+" : ""
      }${dq}`,
    );
    console.log(
      "  Reading: a negative latency delta with a non-negative quality delta" +
        " means thinking off is strictly better for this workload.",
    );
  }

  console.log("\nRaw answers (for a human to disagree with the score):");
  for (const r of results) {
    if (r.error) continue;
    console.log(`\n  [${r.arm} | ${r.q} | r${r.round + 1}] score=${r.quality}`);
    console.log(`    ${r.text}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("ai-bench.mjs")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}