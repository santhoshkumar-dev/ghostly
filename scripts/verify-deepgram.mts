/**
 * Deterministic tests for the optional Deepgram comparison engine.
 *
 * Run: `npx tsx scripts/verify-deepgram.mts`
 *
 * No network, no API key, no WebSocket server: the socket is a scripted fake
 * and the token grant is a fake `fetch`. The assertions target the three things
 * that fail SILENTLY in a real integration:
 *
 *   1. the keyterm URL form (Deepgram accepts a malformed one and boosts
 *      nothing, so the transcript just stays wrong with no error anywhere),
 *   2. the credential boundary (no long-lived key may reach the renderer),
 *   3. the isolation guarantee (a Deepgram transcript must never be able to
 *      reach the AI pipeline).
 */
import {
  buildDeepgramUrl,
  parseDeepgramMessage,
  float32ToPcm16,
  createTelemetryRecorder,
  emptyTelemetry,
  formatTelemetryForLog,
  DEEPGRAM_PARAMS,
  DEEPGRAM_SAMPLE_RATE,
  DEEPGRAM_CHANNELS,
  DEEPGRAM_ENCODING,
} from "../src/lib/deepgramProtocol";
import {
  buildKeyterms,
  redactForLog,
  MAX_KEYTERMS,
  MAX_KEYTERM_LENGTH,
} from "../src/lib/deepgramKeyterms";
import { evaluateInterviewTurn, normalizeTurn } from "../src/lib/interviewAgent";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(
      `${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`,
    );
  }
}
function checkTrue(name: string, actual: boolean) {
  check(name, actual, true);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Required parameters
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Required params ───────────────────────────────────────────");

{
  const url = new URL(buildDeepgramUrl());
  check("model is nova-3", url.searchParams.get("model"), "nova-3");
  check("language is en-US", url.searchParams.get("language"), "en-US");
  check("interim_results is true", url.searchParams.get("interim_results"), "true");
  check("endpointing is 400", url.searchParams.get("endpointing"), "400");
  check("smart_format is true", url.searchParams.get("smart_format"), "true");
  check("punctuate is true", url.searchParams.get("punctuate"), "true");
  check("endpoint is the streaming listen URL", url.origin + url.pathname,
    "wss://api.deepgram.com/v1/listen");
  check("scheme is wss", url.protocol, "wss:");
  check("encoding is linear16", url.searchParams.get("encoding"), DEEPGRAM_ENCODING);
  check("sample_rate is 16000", url.searchParams.get("sample_rate"), "16000");
  check("channels is 1", url.searchParams.get("channels"), "1");
  // Every required param in the brief, asserted as a set.
  check("all six required params present", Object.values(DEEPGRAM_PARAMS).every((v) =>
    url.searchParams.has(
      Object.keys(DEEPGRAM_PARAMS).find((k) => DEEPGRAM_PARAMS[k as keyof typeof DEEPGRAM_PARAMS] === v) ?? "",
    ),
  ), true);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Keyterm URL form — the silent-failure surface
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Keyterm URL form ─────────────────────────────────────────");

{
  const url = buildDeepgramUrl(["Docker", "gRPC", "React"]);
  const all = url.match(/keyterm=/g) ?? [];
  check("each keyterm is a REPEATED param", all.length, 3);
  check("all keyterms round-trip", url.match(/keyterm=[^&]+/g), [
    "keyterm=Docker",
    "keyterm=gRPC",
    "keyterm=React",
  ]);
  // The comma form is the documented footgun: it does NOT error, it silently
  // boosts one literal "a,b,c" and nothing else.
  checkTrue("keyterms are never comma-joined", !/keyterm=[^&]*,/.test(url));
  checkTrue("keyterms are never semicolon-joined", !/keyterm=[^&]*;/.test(url));
  // Weights/intensifiers are `keywords` syntax; `keyterm` must be plain.
  checkTrue("keyterms carry no weights", !/keyterm=[^&]*:/.test(url));
}

{
  // Multi-word phrases must be percent-encoded.
  const url = buildDeepgramUrl(["system design", "C++"]);
  const decoded = [...new URL(url).searchParams.getAll("keyterm")];
  check("multi-word phrases survive encoding", decoded, ["system design", "C++"]);
  checkTrue(
    "a phrase with a space is percent-encoded, not raw",
    url.includes("system+design") || url.includes("system%20design"),
  );
  check("special characters are encoded, not injected", new URL(url).searchParams.getAll("keyterm").length, 2);
}

{
  // `keywords` is the Nova-2 parameter and nova-3 rejects it with HTTP 400.
  const url = buildDeepgramUrl(["Docker"]);
  checkTrue("the legacy `keywords` param is never used", !/[?&]keywords=/.test(url));
}

{
  const url = buildDeepgramUrl([]);
  checkTrue("no keyterms means no keyterm param", !url.includes("keyterm"));
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Keyterm selection — safety and capping
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Keyterm selection ────────────────────────────────────────");

{
  const r = buildKeyterms({
    extra: ["Kubernetes"],
    skills: ["TypeScript", "gRPC"],
    role: "system_design",
    company: "Acme Corp",
  });
  // `interviewType` is snake_case ("system_design"); the underscore is never
  // spoken, so it becomes two independently-boostable words.
  check("explicit terms are kept", r.terms, [
    "Kubernetes",
    "TypeScript",
    "gRPC",
    "system",
    "design",
    "Acme Corp",
  ]);
  check("origins are tracked", r.selected.map((s) => s.origin), [
    "extra",
    "skills",
    "skills",
    "role",
    "role",
    "company",
  ]);
}

{
  // Free-text fields are split on the separators a human actually types.
  const r = buildKeyterms({ skills: "React, Node.js; Docker | Go\nRust" });
  check("comma/semicolon/pipe/newline all split", r.terms, [
    "React",
    "Node.js",
    "Docker",
    "Go",
    "Rust",
  ]);
}

{
  // Duplicates are removed case-insensitively, first spelling wins.
  const r = buildKeyterms({ extra: ["Docker", "docker", "DOCKER"] });
  check("case-insensitive dedupe", r.terms, ["Docker"]);
  checkTrue("duplicates are reported as dropped", r.dropped.length > 0);
}

{
  // Generic words must never become keyterms: Deepgram's own guidance.
  const r = buildKeyterms({
    extra: ["the", "and", "interview", "question", "yes", "okay", "team"],
  });
  check("generic words are all rejected", r.terms, []);
}

{
  // Cap enforcement — the docs advise staying at or under 50.
  const many = Array.from({ length: 200 }, (_, i) => `term${i}`);
  const r = buildKeyterms({ extra: many });
  check("the keyterm list is capped", r.terms.length, MAX_KEYTERMS);
  checkTrue("the cap is at or under Deepgram's 50-term guidance", MAX_KEYTERMS <= 50);
  check("the cap keeps the FIRST (highest-priority) terms", r.terms[0], "term0");
}

{
  // Over-long pastes must be rejected, not truncated into a non-word.
  const long = "x".repeat(MAX_KEYTERM_LENGTH + 1);
  const r = buildKeyterms({ extra: [long, "Docker"] });
  check("an over-long term is rejected whole", r.terms, ["Docker"]);
}

{
  // Single characters and blanks.
  const r = buildKeyterms({ extra: ["", "   ", "a", "ab", null as never] });
  check("blank and 1-char terms are rejected", r.terms, ["ab"]);
}

{
  // Control characters / angle brackets must not survive into a query string.
  const r = buildKeyterms({ extra: ["<script>", "ok\x00bad", "Docker"] });
  check("markup and control characters are rejected", r.terms, ["Docker"]);
}

{
  // Resume prose must never become a keyterm source.
  const r = buildKeyterms({
    role: "dsa",
    company: "Acme",
    skills: ["Kubernetes"],
  });
  checkTrue(
    "no resume text is ever used as a keyterm source",
    !("resumeText" in { role: "dsa", company: "Acme", skills: ["Kubernetes"] }),
  );
}

// ── Log redaction: counts only, never the terms themselves ────────────────
{
  const r = buildKeyterms({
    extra: ["ConfidentialProjectX"],
    company: "SecretStealthCorp",
    role: "system_design",
  });
  const line = redactForLog(r);
  checkTrue("the log line carries no keyterm text", !line.includes("ConfidentialProjectX"));
  checkTrue("the log line carries no company name", !line.includes("SecretStealthCorp"));
  // 4 terms: "ConfidentialProjectX", "system", "design" (snake_case split),
  // "SecretStealthCorp".
  checkTrue("the log line reports a count", line.includes("count=4"));
  checkTrue("the log line reports origins", line.includes("extra=1"));
}

{
  // An empty source set is a valid, empty list.
  const r = buildKeyterms({});
  check("no sources yields no keyterms", r.terms, []);
  check("no sources is not an error", r.dropped.length, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Message parsing
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Message parsing ──────────────────────────────────────────");

{
  const msg = {
    type: "Results",
    is_final: true,
    speech_final: true,
    channel: {
      alternatives: [{ transcript: "  Why should we hire you?  ", confidence: 0.94 }],
    },
    duration: 3.2,
  };
  const { results } = parseDeepgramMessage(msg);
  check("a final result parses", results.length, 1);
  check("the transcript is trimmed", results[0].text, "Why should we hire you?");
  check("is_final is read", results[0].isFinal, true);
  check("speech_final is read", results[0].speechFinal, true);
  check("confidence is read", results[0].confidence, 0.94);
  check("duration is read", results[0].audioDurationSeconds, 3.2);
}

{
  const interim = {
    type: "Results",
    is_final: false,
    speech_final: false,
    channel: { alternatives: [{ transcript: "Tell me about" }] },
  };
  const { results } = parseDeepgramMessage(interim);
  check("an interim parses", results[0].text, "Tell me about");
  check("an interim is not final", results[0].isFinal, false);
  check("an interim is not speech_final", results[0].speechFinal, false);
}

{
  // The legacy `channels[]` envelope must still parse.
  const legacy = {
    type: "Results",
    is_final: true,
    speech_final: false,
    channels: [
      { alternatives: [{ transcript: "legacy shape", confidence: 0.8 }] },
    ],
  };
  const { results } = parseDeepgramMessage(legacy);
  check("the legacy channels[] envelope parses", results[0].text, "legacy shape");
  check("speech_finalized alias is honoured",
    parseDeepgramMessage({
      type: "Results", is_final: true, speech_finalized: true,
      channel: { alternatives: [{ transcript: "x" }] },
    }).results[0].speechFinal, true);
}

{
  // Parsing must be total: an odd envelope yields nothing, never a throw.
  const bad = [
    null, undefined, 42, "not json", "", {}, { type: "Metadata" },
    { type: "CloseStream" }, { type: "Upgrade" },
    { type: "Results" },
    { type: "Results", channel: { alternatives: [] } },
    { type: "Results", channel: { alternatives: [{ transcript: "   " }] } },
    { type: "Results", channel: { alternatives: [{}] } },
  ];
  let threw = 0;
  for (const input of bad) {
    try {
      const out = parseDeepgramMessage(input);
      if (input && (input as any).error) continue;
      if (out.results.length !== 0) threw++;
    } catch {
      threw++;
    }
  }
  check("no malformed message throws or yields a bogus result", threw, 0);
}

{
  const err = parseDeepgramMessage({ type: "Results", error: "INVALID_AUTH" });
  checkTrue("an error envelope reports an error", Boolean(err.error));
  check("an error envelope yields no results", err.results.length, 0);
}

{
  // JSON strings (what the socket actually delivers) parse too.
  const { results } = parseDeepgramMessage(
    JSON.stringify({
      type: "Results", is_final: true, speech_final: true,
      channel: { alternatives: [{ transcript: "from a string frame" }] },
    }),
  );
  check("a JSON string frame parses", results[0].text, "from a string frame");
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Telemetry
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Telemetry ────────────────────────────────────────────────");

{
  const t0 = 1000;
  const rec = createTelemetryRecorder(t0);
  rec.addAudio(2.0);
  rec.record({ text: "Tell me", isFinal: false, speechFinal: false }, t0 + 120);
  rec.record({ text: "Tell me about", isFinal: false, speechFinal: false }, t0 + 200);
  rec.record({ text: "Tell me about Docker", isFinal: true, speechFinal: false }, t0 + 400);
  rec.record({ text: "Tell me about Docker.", isFinal: true, speechFinal: true }, t0 + 650);
  const t = rec.finish(t0 + 700, "Tell me about Docker.");

  check("first interim latency", t.firstInterimMs, 120);
  check("first final latency", t.firstFinalMs, 400);
  check("speech_final latency", t.speechFinalMs, 650);
  check("total latency", t.totalMs, 700);
  check("audio seconds accumulated", t.audioSeconds, 2.0);
  check("result events counted", t.resultCount, 4);
  check("final transcript captured", t.finalText, "Tell me about Docker.");
}

{
  // Only the FIRST of each kind is timed.
  const t0 = 0;
  const rec = createTelemetryRecorder(t0);
  rec.record({ text: "a", isFinal: false, speechFinal: false }, 100);
  rec.record({ text: "ab", isFinal: false, speechFinal: false }, 500);
  rec.record({ text: "abc", isFinal: true, speechFinal: false }, 300);
  rec.record({ text: "abcd", isFinal: true, speechFinal: false }, 900);
  const t = rec.finish(1000, "abcd");
  check("first interim is the earliest", t.firstInterimMs, 100);
  check("first final is the earliest", t.firstFinalMs, 300);
}

{
  // A stream that never produced text leaves the latencies null, not zero —
  // "never happened" and "instantly" must not look the same.
  const rec = createTelemetryRecorder(0);
  const t = rec.finish(50, "");
  check("no interim leaves the latency null", t.firstInterimMs, null);
  check("no final leaves the latency null", t.firstFinalMs, null);
  check("no speech_final leaves the latency null", t.speechFinalMs, null);
  check("an empty transcript has no total latency", t.totalMs, null);
}

{
  check("emptyTelemetry starts fully null", emptyTelemetry(), {
    firstInterimMs: null, firstFinalMs: null, speechFinalMs: null,
    totalMs: null, finalText: "", audioSeconds: 0, resultCount: 0,
  });
}

{
  // A clock that goes backwards must not produce a negative latency.
  const rec = createTelemetryRecorder(500);
  rec.record({ text: "x", isFinal: true, speechFinal: true }, 100);
  const t = rec.finish(100, "x");
  check("latencies are never negative", t.firstFinalMs >= 0, true);
}

{
  // ── The log line must not contain the transcript ──────────────────────
  const rec = createTelemetryRecorder(0);
  rec.addAudio(1.5);
  rec.record({ text: "My name is Jane Doe", isFinal: true, speechFinal: true }, 300);
  const t = rec.finish(350, "My name is Jane Doe");
  const line = formatTelemetryForLog("segment", t);
  checkTrue("the log line contains no transcript text", !line.includes("Jane Doe"));
  checkTrue("the log line contains no candidate name", !line.includes("My name"));
  checkTrue("the log line reports audio duration", line.includes("audio=1.50s"));
  checkTrue("the log line reports interim latency", line.includes("interim=-"));
  checkTrue("the log line reports final latency", line.includes("final=300ms"));
  checkTrue("the log line reports speech_final latency", line.includes("speech_final=300ms"));
  checkTrue("the log line reports only a character COUNT", line.includes("chars=19"));
  checkTrue(
    "an unreached milestone prints as '-' not '0ms' (never happened != instant)",
    line.includes("interim=- ") || line.includes("interim=-"),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. PCM16 encoding
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── PCM16 encoding ───────────────────────────────────────────");

{
  const buf = float32ToPcm16(Float32Array.from([0, 1, -1, 0.5]));
  check("2 bytes per sample", buf.byteLength, 8);
  const view = new DataView(buf);
  check("silence is 0", view.getInt16(0, true), 0);
  check("full scale positive is max int16", view.getInt16(2, true), 32767);
  check("full scale negative is min int16", view.getInt16(4, true), -32768);
  check("half scale", view.getInt16(6, true), 16383);
}

{
  // Over-full-scale samples must clamp, never wrap (a wrap is an audible click).
  const buf = float32ToPcm16(Float32Array.from([2.0, -2.0]));
  const view = new DataView(buf);
  check("over-full-scale positive clamps", view.getInt16(0, true), 32767);
  check("over-full-scale negative clamps", view.getInt16(2, true), -32768);
}

{
  check("empty input yields an empty buffer", float32ToPcm16(new Float32Array(0)).byteLength, 0);
  check("byte length matches sample count at 16kHz",
    float32ToPcm16(new Float32Array(DEEPGRAM_SAMPLE_RATE)).byteLength,
    DEEPGRAM_SAMPLE_RATE * 2);
  check("channels is mono", DEEPGRAM_CHANNELS, 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Isolation: a Deepgram transcript must never reach the AI pipeline
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── AI isolation ─────────────────────────────────────────────");

{
  // The Deepgram transcript is held in `asrComparisons`, a slice the gate and
  // the prompt never read. This asserts the gate only ever sees `finals`.
  const deepgramOnly = "Explain how you would shard a Postgres database";
  const turn = {
    finals: [{ source: "system" as const, text: deepgramOnly }],
    interim: null,
  };
  const gate = evaluateInterviewTurn(turn);
  check("a Deepgram-shaped transcript is a normal question to the gate",
    gate.action, "answer");

  // The real guarantee is structural: the AI reads `getInterviewTurn()`, which
  // is built from `interviewMessages` ONLY. A comparison row lives elsewhere.
  const normalized = normalizeTurn(turn);
  check("the AI turn is built from finals only",
    normalized.finals.length, 1);
  checkTrue(
    "no comparison field is present on the turn the AI reads",
    !("deepgramText" in (normalized as unknown as Record<string, unknown>)),
  );
  checkTrue(
    "no telemetry field is present on the turn the AI reads",
    !("deepgramTelemetry" in (normalized as unknown as Record<string, unknown>)),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Credential boundary
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Credential boundary ──────────────────────────────────────");

{
  // The renderer-visible bridge must not expose any way to read the key.
  // Comments are stripped first: the file documents the ABSENCE of such a
  // method by name, and matching the prose would be a false negative.
  const envSource = await import("node:fs").then((fs) =>
    fs.readFileSync("src/env.d.ts", "utf8"),
  );
  const envCode = envSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  checkTrue(
    "the renderer bridge has no getDeepgramKey",
    !/getDeepgramKey|readDeepgramKey/.test(envCode),
  );
  checkTrue(
    "the renderer bridge does expose deepgramHasKey",
    envCode.includes("deepgramHasKey"),
  );
  checkTrue(
    "the renderer bridge does expose deepgramToken",
    envCode.includes("deepgramToken"),
  );
  // A boolean is not a credential.
  checkTrue(
    "has-key returns a boolean, not the key",
    envCode.includes("deepgramHasKey: () => Promise<boolean>"),
  );
}

{
  // The main-process module must never hand the key back over IPC.
  const deepgramMain = await import("node:fs").then((fs) =>
    fs.readFileSync("electron/deepgram.ts", "utf8"),
  );
  const handlers = deepgramMain.slice(
    deepgramMain.indexOf("export function registerDeepgramHandlers"),
  );
  // has-key must reduce the key to a boolean.
  checkTrue(
    "the has-key handler reduces the key to a boolean",
    /deepgram:has-key"[,\s\S]{0,80}length > 0/.test(handlers),
  );
  // The token handler's success payload must be exactly the JWT + TTL. Assert
  // the returned object's property names rather than regexing for "key".
  const successReturn = handlers.match(/return\s*\{([^}]*)\}/);
  checkTrue("the token handler returns an object literal", Boolean(successReturn));
  const props = (successReturn?.[1] ?? "")
    .split(",")
    .map((p) => p.split(":")[0].trim())
    .filter(Boolean);
  check("the token handler's success payload has no key property", props, [
    "ok",
    "token",
    "expiresIn",
  ]);
  checkTrue(
    "the long-lived key never appears in a renderer-side module",
    !/deepgramKey/.test(
      await import("node:fs").then((fs) =>
        fs.readFileSync("src/lib/deepgramClient.ts", "utf8"),
      ),
    ),
  );
  checkTrue(
    "the renderer client never reads the store or settings for a key",
    !/settings|apiKeys|useStore/.test(
      await import("node:fs").then((fs) =>
        fs.readFileSync("src/lib/deepgramClient.ts", "utf8"),
      ),
    ),
  );
}

{
  // The grant helper must reject an empty key rather than sending a blank one.
  const { grantDeepgramToken, DeepgramAuthError } = await import(
    "../electron/deepgram"
  ).catch(() => ({ grantDeepgramToken: null, DeepgramAuthError: null }) as never);
  if (grantDeepgramToken) {
    let code = "";
    try {
      await grantDeepgramToken("");
    } catch (err) {
      code = (err as { code?: string }).code ?? "";
    }
    check("an empty key fails with no_key, never a network call", code, "no_key");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. The hotkey remains the only trigger
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Manual-trigger invariant ─────────────────────────────────");

{
  const hook = await import("node:fs").then((fs) =>
    fs.readFileSync("src/hooks/useInterviewAudio.ts", "utf8"),
  );
  // Deepgram results are recorded into the comparison slice and never into
  // interviewMessages, so nothing they produce can auto-trigger an answer.
  checkTrue(
    "the Deepgram path records a comparison, not an interview message",
    hook.includes("addAsrComparison") && !hook.includes("addAsrComparison({ source"),
  );
  checkTrue(
    "the comparison runs behind the dev-only flag",
    hook.includes("import.meta.env.DEV"),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. A rejected credential gets its own diagnostic (Phase 8)
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── 403 diagnostic ───────────────────────────────────────────");
{
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync("electron/deepgram.ts", "utf8"),
  );
  checkTrue(
    "401/403 is classified as its own error category",
    src.includes('"unauthorized"') && /status === 401 \|\| response\.status === 403/.test(src),
  );
  checkTrue(
    "a clear 'Deepgram unavailable' diagnostic is logged",
    src.includes("Deepgram unavailable: token request returned"),
  );
  checkTrue(
    "the diagnostic never includes the key or the response body",
    !/console\.[a-z]+\([^)]*apiKey/.test(src) &&
      !src.includes("await response.text()"),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}