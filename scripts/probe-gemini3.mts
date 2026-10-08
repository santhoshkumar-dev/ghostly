/**
 * Diagnostic probe round 3 — PHASE 1.
 *
 * (a) isolates WHY `gemini-3.5-flash-lite` returns 400 under the app's config
 *     (thinkingBudget present vs omitted),
 * (b) tests the newer flash models through the app's exact config, twice each,
 *     so the shipped default is chosen from measured evidence.
 *
 * Key is NEVER printed.
 *
 * Run: npx tsx scripts/probe-gemini3.mts
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

function appGenerationConfig(model: string, maxTokens: number) {
  const config: any = { maxOutputTokens: maxTokens, temperature: 0.3 };
  if (/^gemini-(?:2\.5|3)/i.test(model)) {
    const budget = /pro/i.test(model) ? 128 : 0;
    config.thinkingConfig = { thinkingBudget: budget };
  }
  return config;
}

async function tryModel(
  model: string,
  mode: "app" | "no-thinking",
  round: number,
): Promise<void> {
  const t0 = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const generationConfig =
    mode === "app"
      ? appGenerationConfig(model, 4096)
      : { maxOutputTokens: 512, temperature: 0.3 };
  const body: any = {
    contents: [
      {
        role: "user",
        parts: [{ text: "In 3 short sentences: What is Redis?" }],
      },
    ],
    generationConfig,
    systemInstruction: {
      parts: [
        { text: "Answer like a spoken interview answer. Never mention being an AI." },
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
        `${model} [${mode}] r${round} → HTTP ${res.status} at ${httpMs}ms :: ${errText.slice(0, 200).replace(/\s+/g, " ")}`,
      );
      return;
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let firstTextMs: number | null = null;
    let frames = 0;
    let finish = "";
    const consume = (line: string) => {
      if (!line.startsWith("data: ") || line === "data: [DONE]") return;
      frames++;
      try {
        const parsed = JSON.parse(line.slice(6));
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
    console.log(
      `${model} [${mode}] r${round} → ${text ? "200 OK" : "200 NO-TEXT"} · firstText=${firstTextMs ?? "none"}ms total=${Date.now() - t0}ms frames=${frames} finish=${finish || "-"} text="${text.replace(/\s+/g, " ").slice(0, 60)}"`,
    );
  } catch (err) {
    console.log(`${model} [${mode}] r${round} → THREW: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// (a) why is 3.5-flash-lite a 400 under the app config?
await tryModel("gemini-3.5-flash-lite", "app", 1);
await tryModel("gemini-3.5-flash-lite", "no-thinking", 1);
await tryModel("gemini-3.5-flash-lite", "no-thinking", 2);

// (b) newer flash models through the app config, twice.
for (const m of ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-3.5-flash"]) {
  await tryModel(m, "app", 1);
  await tryModel(m, "app", 2);
}

// known-good baseline again for a stability reference
await tryModel("gemini-2.5-flash", "app", 2);
