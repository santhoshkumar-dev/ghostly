/**
 * Diagnostic probe — PHASE 2 (OpenRouter "timeout" on HTTP 200 + text).
 *
 * Drives the REAL `orchestrateAnswer` with the REAL OpenRouterProvider (the
 * app's actual registry), the stored key (never printed) and the PRODUCTION
 * budgets (first-token 5s / total 12s), against a prompt long enough to stream
 * past the total budget — the exact shape the runtime reported:
 *
 *   OpenRouter → HTTP 200 → first chunks arrive → orchestrator reports timeout
 *
 * Timeline is logged per attempt: http, firstChunk, firstText, chunk arrivals,
 * completion, and the orchestrator's final classification.
 *
 * Run: npx tsx scripts/probe-openrouter.mts
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { orchestrateAnswer } from "../src/lib/ai/orchestrator";
import { getProvider } from "../src/lib/ai";

const STORE_PATH = `${process.env.APPDATA}/ghostly/ghostly-data.json`;
const ENC_KEY = "ghostly-secure-key-v1";

function readStore(): any {
  const buf = fs.readFileSync(STORE_PATH);
  let text: string;
  if (buf.slice(16, 17).toString() === ":") {
    const iv = buf.slice(0, 16);
    const pw = crypto.pbkdf2Sync(ENC_KEY, iv.toString(), 10000, 32, "sha512");
    const d = crypto.createDecipheriv("aes-256-cbc", pw, iv);
    text = Buffer.concat([d.update(buf.slice(17)), d.final()]).toString("utf8");
  } else {
    text = buf.toString("utf8");
  }
  return JSON.parse(text);
}

const store = readStore();
const apiKey: string = store.settings?.apiKeys?.openrouter ?? "";
const storedModel: string = store.settings?.models?.openrouter ?? "";
if (!apiKey.trim()) {
  console.log("NO OPENROUTER KEY — cannot probe.");
  process.exit(1);
}
console.log(`storedOpenrouterModel=${storedModel} keyLen=${apiKey.length} (never printed)`);

const models = process.argv[2] ? [process.argv[2]] : [storedModel, "openrouter/free"];

const LONG_PROMPT =
  "Write a very detailed, long interview answer (at least 1200 words) about Redis: " +
  "data structures, persistence, replication, cluster mode, common pitfalls, and when NOT to use it. " +
  "Use full paragraphs. Do not stop early.";

for (const model of models) {
  console.log(`\n===== ORCHESTRATE with model=${model} (production budgets) =====`);
  const t0 = Date.now();
  const ac = new AbortController();
  const res = await orchestrateAnswer({
    attempts: [{ provider: "openrouter", model, apiKey, maxTokens: 4096 }],
    prompt: LONG_PROMPT,
    system: "Answer like a spoken interview answer. Never mention being an AI.",
    signal: ac.signal,
    log: (line) => {
      const rel = String(Date.now() - t0).padStart(6);
      console.log(`[+${rel}ms] ${line}`);
    },
  });
  console.log(
    `RESULT winner=${res.winner} provider=${res.provider} chars=${res.text.length} ` +
      `elapsed=${Date.now() - t0}ms error=${res.error ?? "-"}`,
  );
  for (const f of res.failures) {
    console.log(`FAILURE ${f.provider}: reason=${f.reason} message=${f.message}`);
  }
  for (const t of res.attemptsStarted) {
    console.log(
      `TELEMETRY http=${t.httpMs} firstChunk=${t.firstChunkMs} firstText=${t.firstTextMs} ` +
        `complete=${t.completeMs} total=${t.totalMs} outcome=${t.outcome} reason=${t.failureReason ?? "-"} chars=${t.chars}`,
    );
  }
  if (res.text) {
    console.log(`TEXT head: ${res.text.replace(/\s+/g, " ").slice(0, 120)}`);
  }
}
