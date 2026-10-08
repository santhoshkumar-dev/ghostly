/**
 * Deterministic tests for the optional Groq Whisper comparison engine.
 *
 * Run: `npx tsx scripts/verify-groq-asr.mts`
 *
 * No network access: the HTTP layer is driven through an injected `fetchImpl`,
 * so request construction, status mapping, parsing and telemetry are all
 * verified without a real Groq call.
 */
import {
  GROQ_ASR_ENDPOINT,
  DEFAULT_GROQ_ASR_MODEL,
  GROQ_ASR_LANGUAGE,
  GROQ_ASR_TEMPERATURE,
  GROQ_ASR_RESPONSE_FORMAT,
  MAX_GROQ_ASR_PROMPT_CHARS,
  MAX_GROQ_ASR_AUDIO_BYTES,
  buildGroqAsrFormData,
  buildGroqAsrPrompt,
  classifyGroqHttpStatus,
  parseGroqTranscriptionResponse,
  transcribeWithGroq,
  formatGroqTelemetryForLog,
} from "../src/lib/groqWhisper";
import { correctTranscript } from "../src/lib/transcriptCorrection";
import { buildCandidateContext } from "../src/lib/transcriptVocabulary";
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

function checkTrue(name: string, actual: unknown) {
  check(name, Boolean(actual), true);
}

const wavBlob = (bytes = 2000) =>
  new Blob([new Uint8Array(bytes)], { type: "audio/wav" });

function fakeResponse(
  status: number,
  body: unknown,
  opts: { throwJson?: boolean } = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (opts.throwJson) throw new Error("bad json");
      return body;
    },
  } as unknown as Response;
}

const noFetch = (async () => {
  throw new Error("fetch must not be called");
}) as unknown as typeof fetch;

// ═══════════════════════════════════════════════════════════════════════════
// 1. Request construction
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Request construction ─────────────────────────────────────");

{
  const form = buildGroqAsrFormData({ audio: wavBlob() });
  check("1 file part present", form.get("file") instanceof Blob, true);
  check(
    "1 file part is named segment.wav",
    (form.get("file") as File).name,
    "segment.wav",
  );
  check("1 model defaults to whisper-large-v3", form.get("model"), DEFAULT_GROQ_ASR_MODEL);
  check("1 model is exactly whisper-large-v3", form.get("model"), "whisper-large-v3");
  check("3 language is en", form.get("language"), "en");
  check("3 language constant matches", form.get("language"), GROQ_ASR_LANGUAGE);
  check("4 temperature is 0", form.get("temperature"), String(GROQ_ASR_TEMPERATURE));
  check("4 temperature is the string '0'", form.get("temperature"), "0");
  check("5 response_format is verbose_json", form.get("response_format"), GROQ_ASR_RESPONSE_FORMAT);
  check(
    "5 timestamp granularities request segment",
    form.getAll("timestamp_granularities[]"),
    ["segment"],
  );
}

{
  const form = buildGroqAsrFormData({
    audio: wavBlob(),
    model: "whisper-large-v3-turbo",
    language: "en",
    prompt: "Spring Boot, Kafka",
    timestampGranularities: ["word"],
  });
  check("2 the model is configurable", form.get("model"), "whisper-large-v3-turbo");
  check("7 prompt is attached", form.get("prompt"), "Spring Boot, Kafka");
  check(
    "7 word granularity is repeated, never comma-joined",
    form.getAll("timestamp_granularities[]"),
    ["word"],
  );
}

{
  check("endpoint is the documented Groq URL", GROQ_ASR_ENDPOINT,
    "https://api.groq.com/openai/v1/audio/transcriptions");
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Prompt construction (bounded, not a whitelist)
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Context prompt ───────────────────────────────────────────");

{
  check(
    "7 prompt joins terms",
    buildGroqAsrPrompt(["Spring Boot", "Docker", "Kafka"]),
    "Spring Boot, Docker, Kafka",
  );
  check(
    "7 prompt deduplicates case-insensitively",
    buildGroqAsrPrompt(["Docker", "docker", "DOCKER"]),
    "Docker",
  );
  check(
    "7 prompt strips newlines/commas so it cannot break the field",
    buildGroqAsrPrompt(["Spring\nBoot", "A,B"]),
    "Spring Boot, A B",
  );
  const long = buildGroqAsrPrompt(
    Array.from({ length: 200 }, (_, i) => `Term${i}`),
  );
  checkTrue(
    "7 prompt is bounded",
    long.length <= MAX_GROQ_ASR_PROMPT_CHARS,
  );
  check("7 empty input yields an empty prompt", buildGroqAsrPrompt([]), "");
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Missing key / error handling / malformed / empty
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Failure handling ─────────────────────────────────────────");

{
  const outcome = await transcribeWithGroq({
    apiKey: "",
    audio: wavBlob(),
    fetchImpl: noFetch,
  });
  check("8 missing key fails with no_key", outcome.ok === false && outcome.code, "no_key");
}

{
  const cases: Array<[number, string]> = [
    [400, "http_400"],
    [401, "http_401"],
    [403, "http_403"],
    [413, "http_413"],
    [429, "http_429"],
    [500, "http_5xx"],
    [503, "http_5xx"],
    [418, "http_other"],
  ];
  for (const [status, code] of cases) {
    const outcome = await transcribeWithGroq({
      apiKey: "k",
      audio: wavBlob(),
      fetchImpl: (async () => fakeResponse(status, {})) as unknown as typeof fetch,
    });
    check(`9/10 HTTP ${status} → ${code}`, outcome.ok === false && outcome.code, code);
    checkTrue(
      `9/10 HTTP ${status} records the status`,
      outcome.ok === false && outcome.telemetry.httpStatus === status,
    );
  }
  check("classify 422 is a 400-class error", classifyGroqHttpStatus(422), "http_400");
}

{
  const outcome = await transcribeWithGroq({
    apiKey: "k",
    audio: wavBlob(),
    fetchImpl: (async () =>
      fakeResponse(200, null, { throwJson: true })) as unknown as typeof fetch,
  });
  check("11 malformed JSON → malformed", outcome.ok === false && outcome.code, "malformed");
}

{
  const outcome = await transcribeWithGroq({
    apiKey: "k",
    audio: wavBlob(),
    fetchImpl: (async () =>
      fakeResponse(200, { text: "" })) as unknown as typeof fetch,
  });
  check("12 empty transcript → empty", outcome.ok === false && outcome.code, "empty");
}

{
  const outcome = await transcribeWithGroq({
    apiKey: "k",
    audio: wavBlob(),
    fetchImpl: (async () => {
      throw new Error("ENETUNREACH");
    }) as unknown as typeof fetch,
  });
  check("network failure → network", outcome.ok === false && outcome.code, "network");
}

{
  // The fetch honours the abort signal, so the timeout path is exercised.
  const hangingFetch = (async (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
    })) as unknown as typeof fetch;
  const outcome = await transcribeWithGroq({
    apiKey: "k",
    audio: wavBlob(),
    fetchImpl: hangingFetch,
    timeoutMs: 10,
  });
  check("timeout aborts the request", outcome.ok === false && outcome.code, "timeout");
}

{
  const outcome = await transcribeWithGroq({
    apiKey: "k",
    audio: wavBlob(MAX_GROQ_ASR_AUDIO_BYTES + 1),
  });
  checkTrue(
    "oversized audio refuses to upload",
    outcome.ok === false && outcome.code === "too_large",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Normalised ASR result + telemetry
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Normalised result ────────────────────────────────────────");

{
  const body = {
    task: "transcribe",
    language: "en",
    duration: 3.2,
    text: "What is Spring Boot?",
    segments: [
      { id: 0, start: 0, end: 1.1, text: "What is" },
      { id: 1, start: 1.1, end: 3.2, text: " Spring Boot?" },
    ],
  };
  const outcome = await transcribeWithGroq({
    apiKey: "k",
    audio: wavBlob(),
    fetchImpl: (async () => fakeResponse(200, body)) as unknown as typeof fetch,
  });
  checkTrue("13 success outcome", outcome.ok);
  if (outcome.ok) {
    check("13 provider-neutral provider", outcome.result.provider, "groq");
    check("13 model recorded", outcome.result.model, "whisper-large-v3");
    check("13 text normalised", outcome.result.text, "What is Spring Boot?");
    check("13 audioSeconds from duration", outcome.result.audioSeconds, 3.2);
    check("13 segments normalised", outcome.result.segments.length, 2);
    checkTrue("13 latency recorded", typeof outcome.result.latencyMs === "number");
    checkTrue("13 firstResultMs recorded", outcome.result.firstResultMs !== null);
    check("13 telemetry success", outcome.telemetry.success, true);
    check("13 telemetry chars", outcome.telemetry.chars, 20);
    check("13 telemetry segmentCount", outcome.telemetry.segmentCount, 2);
  }
  const parsed = parseGroqTranscriptionResponse({ text: "  hi  " });
  checkTrue("13 parser trims text", parsed.ok && parsed.text === "hi");
}

{
  const line = formatGroqTelemetryForLog({
    provider: "groq",
    model: "whisper-large-v3",
    audioSeconds: 3,
    requestStartMs: 0,
    firstResultMs: 120,
    totalMs: 200,
    httpStatus: 200,
    success: true,
    failureReason: null,
    chars: 19,
    segmentCount: 1,
  });
  checkTrue("13 telemetry log has no transcript field", line.includes("chars=19"));
  checkTrue("13 telemetry log is single-line", !line.includes("\n"));
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Correction integration — the SHARED engine, no Groq-specific rules
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Correction integration ───────────────────────────────────");

{
  const candidateContext = buildCandidateContext({
    resumeText: "Built services with Spring Boot and Kafka",
  });
  const corrected = correctTranscript({
    rawText: "what is spring boat",
    source: "system",
    candidateContext,
  });
  checkTrue(
    "16 the shared correction engine accepts Groq-shaped output",
    typeof corrected.correctedText === "string" && corrected.correctedText.length > 0,
  );
  checkTrue("16 raw text is preserved", corrected.rawText === "what is spring boat");
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Isolation — comparison output never reaches the AI
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── AI isolation ─────────────────────────────────────────────");

{
  const groqOnly = "Explain how you would shard a Postgres database";
  const turn = {
    finals: [{ source: "system" as const, text: groqOnly }],
    interim: null,
  };
  const gate = evaluateInterviewTurn(turn);
  check("14 a Groq-shaped transcript is a normal question to the gate", gate.action, "answer");

  const normalized = normalizeTurn(turn);
  check("15 the AI turn is built from finals only", normalized.finals.length, 1);
  checkTrue(
    "15 no comparison field is on the turn the AI reads",
    !("groqText" in (normalized as unknown as Record<string, unknown>)),
  );
  checkTrue(
    "15 no Groq telemetry is on the turn the AI reads",
    !("groqTelemetry" in (normalized as unknown as Record<string, unknown>)),
  );
}

{
  const store = await import("node:fs").then((fs) =>
    fs.readFileSync("src/store/useStore.ts", "utf8"),
  );
  checkTrue(
    "14 the Groq result lives in the isolated asrComparisons slice",
    /groqText\?: string;[\s\S]*?groqCorrectedText\?: string;/.test(store),
  );
  checkTrue(
    "15 getInterviewTurn never reads asrComparisons",
    !/asrComparisons[\s\S]{0,200}getInterviewTurn/.test(store),
  );
}

{
  // Same audio guarantee: both comparison callbacks receive the same buffer.
  const hook = await import("node:fs").then((fs) =>
    fs.readFileSync("src/hooks/useInterviewAudio.ts", "utf8"),
  );
  checkTrue(
    "18 both comparison engines receive the same downsampled buffer",
    /onCompareWithDeepgram\(downsampled, speechSeconds, phraseId\);\s*onCompareWithGroq\(downsampled, speechSeconds, phraseId\);/.test(
      hook,
    ),
  );
  checkTrue(
    "13 the Groq result is recorded through the comparison upsert",
    /upsertComparison\(phraseId, \{[\s\S]*?groqText: result\.text/.test(hook),
  );
  checkTrue(
    "14 the Groq path never writes an interview message",
    !/addInterviewMessage\([\s\S]{0,200}groq/i.test(hook),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Secret boundary
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Secret boundary ──────────────────────────────────────────");

{
  const envSource = await import("node:fs").then((fs) =>
    fs.readFileSync("src/env.d.ts", "utf8"),
  );
  const envCode = envSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  checkTrue(
    "17 the renderer bridge has no getter that returns the Groq key",
    !/getGroqAsrKey|readGroqAsrKey/.test(envCode),
  );
  checkTrue("17 the bridge exposes groqAsrHasKey", envCode.includes("groqAsrHasKey"));
  checkTrue("17 the bridge exposes groqTranscribe", envCode.includes("groqTranscribe"));

  const client = await import("node:fs").then((fs) =>
    fs.readFileSync("src/lib/groqWhisperClient.ts", "utf8"),
  );
  checkTrue(
    "17 the renderer client never reads the key or the settings store",
    !/groqAsrKey|settings|apiKeys|useStore/.test(
      client.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
    ),
  );

  const main = await import("node:fs").then((fs) =>
    fs.readFileSync("electron/groqAsr.ts", "utf8"),
  );
  checkTrue(
    "17 the has-key handler reduces the key to a boolean",
    /groq:has-key"[\s\S]{0,120}length > 0/.test(main),
  );
  checkTrue(
    "17 the set-key handler never returns the key",
    /return \{ ok: true as const, configured: key\.length > 0 \}/.test(main),
  );
  const preload = await import("node:fs").then((fs) =>
    fs.readFileSync("electron/preload.ts", "utf8"),
  );
  checkTrue(
    "17 preload exposes no key getter",
    !/getGroqAsrKey|readGroqAsrKey/.test(preload),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
