/**
 * Diagnostic probe — PHASE 1 (Gemini 404).
 *
 * Reads the encrypted electron-store locally, then:
 *   1. lists the models the stored key can actually use (same endpoint the app
 *      uses: GET v1beta/models),
 *   2. attempts a tiny streamed request with the CURRENT configured model,
 *   3. attempts the same with `gemini-2.5-flash-lite` (the reported 404),
 *   4. attempts the curated default from the registry.
 *
 * The key is NEVER printed. Output is statuses, timings and model ids only.
 *
 * Run: npx tsx scripts/probe-gemini.mts
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
const configured: string = store.settings?.models?.gemini ?? "";
if (!apiKey.trim()) {
  console.log("NO GEMINI KEY IN STORE — cannot probe.");
  process.exit(1);
}
console.log(`configuredModel=${configured}`);
console.log(`keyPresent=true (value never printed, length=${apiKey.length})`);

// ── 1. What does this key actually support? ────────────────────────────────
const listRes = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${apiKey}`,
  { method: "GET" },
);
console.log(`models.list http=${listRes.status} ${listRes.statusText}`);
let supported: string[] = [];
if (listRes.ok) {
  const data = await listRes.json();
  supported = (data?.models ?? [])
    .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m: any) => String(m.name).replace(/^models\//, ""))
    .filter((id: string) => id.startsWith("gemini"))
    .sort();
  console.log(`supported generateContent gemini models (${supported.length}):`);
  for (const id of supported) console.log(`  ${id}`);
} else {
  const body = await listRes.text();
  console.log(`list error body: ${body.slice(0, 300)}`);
}

// ── 2/3/4. Stream a tiny real request with candidate models ───────────────
const candidates = [...new Set([configured, "gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.5-flash"])];

async function tryModel(model: string): Promise<void> {
  const t0 = Date.now();
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Reply with exactly: OK" }] }],
          generationConfig: { maxOutputTokens: 64, temperature: 0.3 },
          systemInstruction: { parts: [{ text: "You are a test." }] },
        }),
      },
    );
    const httpMs = Date.now() - t0;
    if (!res.ok) {
      const body = await res.text();
      console.log(
        `STREAM ${model} → HTTP ${res.status} ${res.statusText} at ${httpMs}ms :: ${body.slice(0, 220).replace(/\s+/g, " ")}`,
      );
      return;
    }
    // Read the SSE stream to completion, collecting text.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let firstTextMs: number | null = null;
    let frames = 0;
    const consume = (line: string) => {
      if (!line.startsWith("data: ") || line === "data: [DONE]") return;
      frames++;
      try {
        const parsed = JSON.parse(line.slice(6));
        const parts = parsed?.candidates?.[0]?.content?.parts;
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
      `STREAM ${model} → HTTP 200 · firstText=${firstTextMs ?? "none"}ms total=${Date.now() - t0}ms frames=${frames} text="${text.replace(/\s+/g, " ").slice(0, 60)}"`,
    );
  } catch (err) {
    console.log(`STREAM ${model} → THREW: ${err instanceof Error ? err.message : String(err)}`);
  }
}

for (const m of candidates) {
  if (!m) continue;
  await tryModel(m);
}
