/**
 * Diagnostic probe round 2 — PHASE 1.
 *
 * Uses the app's EXACT request shape (same URL, same generationConfig logic as
 * `geminiGenerationConfig`, same systemInstruction) and dumps the raw first SSE
 * frame when no text comes back, so an empty-200 cannot masquerade as success.
 *
 * Key is NEVER printed.
 *
 * Run: npx tsx scripts/probe-gemini2.mts
 */
import fs from "node:fs";
import crypto from "node:crypto";

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
const apiKey: string = store.settings?.apiKeys?.gemini ?? "";
if (!apiKey.trim()) {
  console.log("NO GEMINI KEY — cannot probe.");
  process.exit(1);
}

/** Mirrors `geminiGenerationConfig` in src/lib/ai/gemini.ts exactly. */
function generationConfig(model: string, maxTokens: number) {
  const config: any = { maxOutputTokens: maxTokens, temperature: 0.3 };
  if (/^gemini-(?:2\.5|3)/i.test(model)) {
    const budget = /pro/i.test(model) ? 128 : 0;
    config.thinkingConfig = { thinkingBudget: budget };
  }
  return config;
}

async function tryModel(model: string): Promise<void> {
  const t0 = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: "In 3 short sentences: What is Redis and why would you use it?",
          },
        ],
      },
    ],
    generationConfig: generationConfig(model, 4096),
    systemInstruction: {
      parts: [
        {
          text: "Answer like a spoken interview answer. Never mention being an AI.",
        },
      ],
    },
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const httpMs = Date.now() - t0;
    if (!res.ok) {
      const errText = await res.text();
      console.log(
        `${model} → HTTP ${res.status} at ${httpMs}ms :: ${errText.slice(0, 180).replace(/\s+/g, " ")}`,
      );
      return;
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let firstTextMs: number | null = null;
    let frames = 0;
    let firstFrame = "";
    let finish = "";
    let block = "";
    const consume = (line: string) => {
      if (!line.startsWith("data: ") || line === "data: [DONE]") return;
      frames++;
      if (frames === 1) firstFrame = line.slice(6, 400);
      try {
        const parsed = JSON.parse(line.slice(6));
        if (parsed?.promptFeedback?.blockReason) block = parsed.promptFeedback.blockReason;
        const cand = parsed?.candidates?.[0];
        if (cand?.finishReason) finish = cand.finishReason;
        const parts = cand?.content?.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (p && p.thought !== true && typeof p.text === "string" && p.text) {
              if (firstTextMs === null) firstTextMs = Date.now() - t0;
              text += p.text;
            }
          }
        }
      } catch {
        /* ignore */
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) consume(line);
    }
    if (buffer.trim()) consume(buffer);
    const total = Date.now() - t0;
    if (text) {
      console.log(
        `${model} → 200 OK · firstText=${firstTextMs ?? "none"}ms total=${total}ms frames=${frames} finish=${finish || "-"} text="${text.replace(/\s+/g, " ").slice(0, 90)}"`,
      );
    } else {
      console.log(
        `${model} → 200 but NO TEXT · total=${total}ms frames=${frames} finish=${finish || "-"} block=${block || "-"} firstFrame=${firstFrame}`,
      );
    }
  } catch (err) {
    console.log(`${model} → THREW: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const candidates = [
  "gemini-3.6-flash", // currently configured
  "gemini-3.5-flash-lite", // Google's own 404 replacement suggestion
  "gemini-flash-latest",
  "gemini-3.5-flash",
  "gemini-2.5-flash", // known-good baseline from round 1
];
for (const m of candidates) {
  await tryModel(m);
}
