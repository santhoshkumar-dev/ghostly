/**
 * Deterministic tests for the standalone ASR benchmark code.
 *
 * Everything here runs with no model, no API key, no audio file and no network.
 * That is the point: the benchmark's arithmetic and its refusal to fabricate
 * numbers must be verifiable on a machine that has neither fixtures nor a key.
 *
 * Run: `npx tsx scripts/verify-asr-bench.mts`
 */

import {
  parseWavHeader,
  checkWavFormat,
  parseManifest,
  normalizeForWer,
  werTokens,
  tokenEditDistance,
  computeWer,
  computeCompleteness,
  checkTechnicalTerms,
  percentile,
  computeRtf,
  padSilence,
  round,
  summarizeEngine,
  formatSummaryTable,
  SYNTHETIC_BANNER,
  NO_AUDIO_BANNER,
  WavFormatError,
} from "./asr-bench-lib.mjs";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  evaluateInterviewTurn,
  normalizeTurn,
  buildInterviewUserPrompt,
  type InterviewTurn,
} from "../src/lib/interviewAgent";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else {
    fail++;
    failures.push(`${name}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function ok(name: string, condition: boolean, detail = "") {
  if (condition) pass++;
  else {
    fail++;
    failures.push(`${name}${detail ? `\n    ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

// ── Build an in-memory 16 kHz mono 16-bit PCM WAV ───────────────────────────
function makeWav({
  sampleRate = 16000,
  channels = 1,
  bitsPerSample = 16,
  audioFormat = 1,
  frames = 16000,
}: {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  audioFormat?: number;
  frames?: number;
} = {}): Buffer {
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = frames * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(audioFormat, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  // Write samples at the declared width so the buffer size and the declared
  // `data` size always agree — a mismatch here would test the fixture, not the
  // parser.
  const totalSamples = frames * channels;
  for (let i = 0; i < totalSamples; i++) {
    const value = Math.round(Math.sin(i / 40) * 8000);
    if (bitsPerSample === 8) {
      buf.writeUInt8(Math.max(0, Math.min(255, Math.round(value / 256) + 128)), 44 + i);
    } else {
      buf.writeInt16LE(value, 44 + i * 2);
    }
  }
  return buf;
}

const ROOT = path.resolve(process.cwd());

// ═══════════════════════════════════════════════════════════════════════════
section("1. WAV loading and header parsing");
// ═══════════════════════════════════════════════════════════════════════════
{
  const header = parseWavHeader(makeWav({ frames: 32000 }));
  check("wav: sample rate parsed", header.sampleRate, 16000);
  check("wav: channels parsed", header.channels, 1);
  check("wav: bits parsed", header.bitsPerSample, 16);
  check("wav: audioFormat is PCM", header.audioFormat, 1);
  // 32000 frames @ 16 kHz = 2.0 s
  ok(
    "wav: duration computed",
    Math.abs(header.durationSeconds - 2) < 1e-9,
    `got ${header.durationSeconds}`,
  );

  // Chunk walking: a LIST chunk before `data` must not confuse the parser.
  // Built byte-exactly: "LIST" + uint32 size + payload, where the payload is
  // exactly `size` bytes, followed by the original data chunk.
  const base = makeWav({ frames: 16000 });
  const payload = Buffer.alloc(10, 0x41); // 10 filler bytes
  const listChunk = Buffer.alloc(8);
  listChunk.write("LIST", 0, "ascii");
  listChunk.writeUInt32LE(payload.length, 4);
  const listTagged = Buffer.concat([
    base.subarray(0, 36), // RIFF/WAVE/fmt
    listChunk,
    payload,
    base.subarray(36), // the original "data" chunk
  ]);
  const listHeader = parseWavHeader(listTagged);
  ok(
    "wav: LIST chunk before data is skipped",
    listHeader.sampleRate === 16000 && listHeader.dataSize === 32000,
    `sr=${listHeader.sampleRate} data=${listHeader.dataSize}`,
  );

  let threw = false;
  try {
    parseWavHeader(Buffer.from("not a wav file at all!!"));
  } catch (e) {
    threw = e instanceof WavFormatError;
  }
  ok("wav: malformed file throws WavFormatError", threw);

  threw = false;
  try {
    parseWavHeader(Buffer.alloc(2));
  } catch {
    threw = true;
  }
  ok("wav: truncated file throws", threw);
}

// ═══════════════════════════════════════════════════════════════════════════
section("2. Sample rate check");
// ═══════════════════════════════════════════════════════════════════════════
{
  check(
    "sample rate: 16000 accepted",
    checkWavFormat(parseWavHeader(makeWav({ sampleRate: 16000 }))).ok,
    true,
  );
  const wrong = checkWavFormat(parseWavHeader(makeWav({ sampleRate: 22050 })));
  check("sample rate: 22050 rejected", wrong.ok, false);
  ok(
    "sample rate: reason names the rate",
    wrong.problems.some((p) => p.includes("22050")),
    wrong.problems.join("; "),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
section("3. Mono check");
// ═══════════════════════════════════════════════════════════════════════════
{
  check(
    "mono: 1 channel accepted",
    checkWavFormat(parseWavHeader(makeWav({ channels: 1 }))).ok,
    true,
  );
  const stereo = checkWavFormat(parseWavHeader(makeWav({ channels: 2 })));
  check("mono: 2 channels rejected", stereo.ok, false);
  ok(
    "mono: reason says mono",
    stereo.problems.some((p) => p.includes("mono")),
    stereo.problems.join("; "),
  );
  const eightBit = checkWavFormat(parseWavHeader(makeWav({ bitsPerSample: 8 })));
  check("bit depth: 8-bit rejected", eightBit.ok, false);
  const floatFmt = checkWavFormat(parseWavHeader(makeWav({ audioFormat: 3 })));
  check("format: non-PCM (3) rejected", floatFmt.ok, false);
}

// ═══════════════════════════════════════════════════════════════════════════
section("4. Fixture manifest parsing");
// ═══════════════════════════════════════════════════════════════════════════
{
  const manifestPath = path.join(ROOT, "tests", "fixtures", "asr", "manifest.json");
  ok("manifest: file exists", existsSync(manifestPath), manifestPath);
  const manifest = parseManifest(readFileSync(manifestPath, "utf8"));

  // The manifest grows every time real interview clips are imported (see
  // `scripts/import-debug-audio.mjs`), so pinning the TOTAL was asserting that
  // nobody had ever recorded a real interview — which is the opposite of what
  // this corpus is for. Assert the synthetic subset is intact instead, and
  // separately that any real clips are honestly marked.
  const synthetic = manifest.questions.filter((q) => q.id.startsWith("q"));
  const real = manifest.questions.filter((q) => q.id.startsWith("real-"));
  check("manifest: all 15 synthetic questions are present", synthetic.length, 15);
  check("manifest: 3 short segments", manifest.shortSegments.length, 3);
  check(
    "manifest: every real clip has a spoken reference",
    real.every((q) => typeof q.reference === "string" && q.reference.trim() !== ""),
    true,
  );
  check(
    "manifest: every real clip points at a wav",
    real.every((q) => typeof q.file === "string" && q.file.endsWith(".wav")),
    true,
  );
  check(
    "manifest: every real clip carries the phraseId it was captured with",
    real.every((q) => typeof q.phraseId === "number"),
    true,
  );
  check(
    "manifest: synthetic ids are q01..q15",
    synthetic.map((q) => q.id),
    Array.from({ length: 15 }, (_, i) => `q${String(i + 1).padStart(2, "0")}`),
  );
  check(
    "manifest: q01 reference is exact",
    manifest.questions[0].reference,
    "Why do we use MongoDB?",
  );
  check(
    "manifest: q01 technical terms",
    manifest.questions[0].technicalTerms,
    ["MongoDB"],
  );
  check(
    "manifest: every entry has a reference",
    manifest.questions.every((q) => q.reference.length > 0),
    true,
  );
  check(
    "manifest: every entry names a .wav",
    manifest.questions.every((q) => q.file.endsWith(".wav")),
    true,
  );

  // Structural rejections.
  const throws = (obj: unknown) => {
    try {
      parseManifest(obj as never);
      return false;
    } catch {
      return true;
    }
  };
  check("manifest: duplicate ids rejected", throws({ questions: [{ id: "a", file: "a.wav", reference: "x" }, { id: "a", file: "b.wav", reference: "y" }] }), true);
  check("manifest: missing reference rejected", throws({ questions: [{ id: "a", file: "a.wav" }] }), true);
  check("manifest: missing file rejected", throws({ questions: [{ id: "a", reference: "x" }] }), true);
  check("manifest: empty manifest is valid", throws({ questions: [] }), false);
}

// ═══════════════════════════════════════════════════════════════════════════
section("5+6. Metric and WER calculation");
// ═══════════════════════════════════════════════════════════════════════════
{
  check("normalize: lowercases", normalizeForWer("MongoDB"), "mongodb");
  check("normalize: strips punctuation", normalizeForWer("Why now?"), "why now");
  check("normalize: collapses whitespace", normalizeForWer("Why   do  we?"), "why do we");
  check("normalize: empty is empty", normalizeForWer(""), "");
  check("tokens: splits on spaces", werTokens("Why do we?"), ["why", "do", "we"]);

  check("edit distance: identical", tokenEditDistance(["a", "b"], ["a", "b"]), 0);
  check("edit distance: one substitution", tokenEditDistance(["a", "b"], ["a", "c"]), 1);
  check("edit distance: one insertion", tokenEditDistance(["a", "b"], ["a", "b", "c"]), 1);
  check("edit distance: empty ref", tokenEditDistance([], ["a", "b"]), 2);
  check("edit distance: empty hyp", tokenEditDistance(["a", "b"], []), 2);

  const perfect = computeWer("why do we use mongodb", "Why do we use MongoDB?");
  check("wer: identical is 0", perfect.wer, 0);

  const oneErr = computeWer("why do we use mongodb", "why do we use mongo");
  ok(
    "wer: one error over five words",
    Math.abs(oneErr.wer - 0.2) < 1e-9,
    `got ${oneErr.wer}`,
  );

  const emptyRef = computeWer("", "anything");
  check("wer: empty reference with output is 1", emptyRef.wer, 1);
  const bothEmpty = computeWer("", "");
  check("wer: empty reference and output is 0", bothEmpty.wer, 0);
  check("wer: never Infinity", Number.isFinite(computeWer("a", "").wer), true);

  check("percentile: p50 of 1..100", percentile([...Array(100).keys()].map((i) => i + 1), 50), 50);
  check("percentile: empty input is null", percentile([], 50), null);
  check("round: 3 decimals", round(1.23456, 3), 1.235);
  check("round: null passes through", round(null), null);
  check("rtf: decode/audio", round(computeRtf(500, 2), 3), 0.25);
  check("rtf: zero audio is null", computeRtf(500, 0), null);
}

// ═══════════════════════════════════════════════════════════════════════════
section("7. Technical-term matching (case-insensitive, no near-miss credit)");
// ═══════════════════════════════════════════════════════════════════════════
{
  check(
    "terms: exact case matches",
    checkTechnicalTerms(["MongoDB"], "What is MongoDB?"),
    [{ term: "MongoDB", found: true }],
  );
  check(
    "terms: lowercase matches uppercase term",
    checkTechnicalTerms(["MongoDB"], "what is mongodb?"),
    [{ term: "MongoDB", found: true }],
  );
  check(
    "terms: 'mango' is NOT MongoDB",
    checkTechnicalTerms(["MongoDB"], "What is mango?"),
    [{ term: "MongoDB", found: false }],
  );
  check(
    "terms: 'Spring boat' is NOT Spring Boot",
    checkTechnicalTerms(["Spring Boot"], "What is Spring boat?"),
    [{ term: "Spring Boot", found: false }],
  );
  check(
    "terms: 'Spring Boot' matches",
    checkTechnicalTerms(["Spring Boot"], "What is Spring Boot?"),
    [{ term: "Spring Boot", found: true }],
  );
  check(
    "terms: multiple terms evaluated independently",
    checkTechnicalTerms(["RabbitMQ", "Kafka"], "The difference between Rabbit MQ and Kafka"),
    [
      { term: "RabbitMQ", found: false },
      { term: "Kafka", found: true },
    ],
  );
  check("terms: no terms is empty list", checkTechnicalTerms([], "anything"), []);
  check("terms: undefined terms is empty list", checkTechnicalTerms(undefined, "x"), []);
  check(
    "terms: empty transcript finds nothing",
    checkTechnicalTerms(["Docker"], ""),
    [{ term: "Docker", found: false }],
  );
}

// ═══════════════════════════════════════════════════════════════════════════
section("8. Completeness calculation");
// ═══════════════════════════════════════════════════════════════════════════
{
  const ref =
    "Suppose your application receives thousands of requests at the same time. How would you scale the backend?";
  const truncated =
    "Suppose your application receives thousands of requests at the same time.";
  const t = computeCompleteness(ref, truncated);
  check("completeness: missing ending is INCOMPLETE", t.complete, false);
  ok(
    "completeness: missing words are recorded",
    t.missingFinalClause.includes("backend"),
    JSON.stringify(t.missingFinalClause),
  );
  check(
    "completeness: full reference is COMPLETE",
    computeCompleteness(ref, ref).complete,
    true,
  );
  check(
    "completeness: full reference covers everything",
    round(computeCompleteness(ref, ref).coverage, 3),
    1,
  );
  check(
    "completeness: empty transcript is INCOMPLETE",
    computeCompleteness(ref, "").complete,
    false,
  );
  check(
    "completeness: empty reference is trivially complete",
    computeCompleteness("", "").complete,
    true,
  );
  check(
    "completeness: case/punctuation do not affect it",
    computeCompleteness("Why do we use MongoDB?", "why do we use mongodb").complete,
    true,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
section("9. Empty-result handling");
// ═══════════════════════════════════════════════════════════════════════════
{
  const rows = [
    { transcript: "What is Redis?", decodeMs: 100, rtf: 0.1, reference: "What is Redis?", wer: { wer: 0 }, completeness: { complete: true }, terms: [{ found: true }] },
    { transcript: "", decodeMs: 90, rtf: 0.1, reference: "What is Docker?", wer: { wer: 1 }, completeness: { complete: false }, terms: [{ found: false }] },
    { transcript: "   ", decodeMs: 95, rtf: 0.1, reference: "What is JWT?", wer: { wer: 1 }, completeness: { complete: false }, terms: [{ found: false }] },
  ];
  const s = summarizeEngine("Test", rows, { hasAccuracyData: true });
  check("empty: two of three are empty", s.emptyRate, round(2 / 3, 4));
  check("empty: clips counted", s.clips, 3);
  check(
    // Two of the three rows are empty, and each empty transcript scores WER 1
    // (everything expected was missing), so the mean is 2/3 — an empty result
    // must be penalised, never treated as neutral.
    "empty: an empty transcript contributes WER 1",
    round(s.wer, 4),
    round(2 / 3, 4),
  );
  check("empty: completeness reflects failures", round(s.completeness, 4), round(1 / 3, 4));
  check("empty: term accuracy counts misses", s.technicalTermAccuracy, round(1 / 3, 4));
}

// ═══════════════════════════════════════════════════════════════════════════
section("10. Missing Groq key handling");
// ═══════════════════════════════════════════════════════════════════════════
{
  const saved = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  check(
    "groq: absent key reads as empty",
    Boolean(process.env.GROQ_API_KEY),
    false,
  );
  // The harness must treat this as a reported outcome, not a crash.
  const summary = summarizeEngine("Parakeet", [
    { transcript: "x", decodeMs: 10, rtf: 0.1, reference: "x", wer: { wer: 0 }, completeness: { complete: true }, terms: [] },
  ], { hasAccuracyData: true });
  check("groq: Moonshine/Parakeet still summarise without a key", summary.clips, 1);
  check("groq: the summarised engine is Parakeet", summary.engine, "Parakeet");
  // Only the engines that actually ran appear in the table, so an absent key
  // can never produce a fabricated Groq row.
  ok(
    "groq: no Groq row is invented when the key is missing",
    summary.engine !== "Groq Whisper",
  );
  if (saved) process.env.GROQ_API_KEY = saved;

  // The key must never be embedded in the harness source.
  const harnessSrc = readFileSync(
    path.join(ROOT, "scripts", "asr-bench.mjs"),
    "utf8",
  );
  ok(
    "groq: key is read from process.env only",
    harnessSrc.includes("process.env.GROQ_API_KEY"),
  );
  ok(
    "groq: no literal gsk_ key in source",
    !/gsk_[A-Za-z0-9]{20,}/.test(harnessSrc),
  );
  ok(
    "groq: key is never written to disk",
    !/writeFileSync\([^)]*GROQ_API_KEY/.test(harnessSrc),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
section("11. Malformed Parakeet result handling");
// ═══════════════════════════════════════════════════════════════════════════
{
  // A malformed recognizer result must degrade to an empty transcript, not throw.
  const malformedRecognizer = {
    createStream: () => ({
      acceptWaveform: () => {},
    }),
    decode: () => {},
    getResult: () => ({ text: undefined }),
  };
  const stream = malformedRecognizer.createStream();
  stream.acceptWaveform({ samples: new Float32Array(16000), sampleRate: 16000 });
  const text = (malformedRecognizer.getResult(stream).text ?? "").trim();
  check("malformed: undefined text becomes empty string", text, "");

  // A recognizer that throws must be reported as a failure, not swallowed.
  let failure: string | null = null;
  try {
    const throwing = {
      createStream: () => ({ acceptWaveform: () => {} }),
      decode: () => {
        throw new Error("onnxruntime out of memory");
      },
      getResult: () => ({ text: "" }),
    };
    const s2 = throwing.createStream();
    s2.acceptWaveform({ samples: new Float32Array(16000), sampleRate: 16000 });
    throwing.decode(s2);
  } catch (e) {
    failure = (e as Error).message;
  }
  check("malformed: decode error is captured", failure, "onnxruntime out of memory");

  const failedRow = summarizeEngine(
    "Parakeet",
    [{ transcript: "", decodeMs: null, rtf: null, reference: "x", failure: "boom" }],
    { hasAccuracyData: true },
  );
  check("malformed: failure counted", failedRow.failures, 1);
  check("malformed: failure has no latency", failedRow.latencyP50, null);
  check("malformed: failure has no RTF", failedRow.rtf, null);
}

// ═══════════════════════════════════════════════════════════════════════════
section("12. Memory measurement output");
// ═══════════════════════════════════════════════════════════════════════════
{
  const s = summarizeEngine(
    "Parakeet",
    [
      { transcript: "a", decodeMs: 100, rtf: 0.1, reference: "a", wer: { wer: 0 }, completeness: { complete: true }, terms: [] },
      { transcript: "b", decodeMs: 200, rtf: 0.2, reference: "b", wer: { wer: 0 }, completeness: { complete: true }, terms: [] },
      { transcript: "c", decodeMs: 300, rtf: 0.3, reference: "c", wer: { wer: 0 }, completeness: { complete: true }, terms: [] },
    ],
    { hasAccuracyData: true },
  );
  check("memory/latency: p50 over three clips", s.latencyP50, 200);
  check("memory/latency: p95 over three clips", s.latencyP95, 300);
  check("memory/latency: mean RTF", s.rtf, 0.2);
  check("memory/latency: no failures", s.failures, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
section("13. Deterministic report formatting");
// ═══════════════════════════════════════════════════════════════════════════
{
  const rows = [
    { transcript: "What is Redis?", decodeMs: 123.456, rtf: 0.1234, reference: "What is Redis?", wer: { wer: 0 }, completeness: { complete: true }, terms: [{ found: true }] },
    { transcript: "", decodeMs: 200, rtf: 0.2, reference: "What is Docker?", wer: { wer: 1 }, completeness: { complete: false }, terms: [{ found: false }] },
  ];
  const a = formatSummaryTable([summarizeEngine("Parakeet", rows, { hasAccuracyData: true })]);
  const b = formatSummaryTable([summarizeEngine("Parakeet", rows, { hasAccuracyData: true })]);
  check("report: byte-identical across runs", a, b);
  ok("report: names the engine", a.includes("Parakeet"));
  ok("report: includes a header row", a.includes("WER"));
  ok("report: includes p95 column", a.includes("p95 ms"));

  // Without accuracy data, accuracy columns must be n/a — never a number.
  const noAcc = summarizeEngine("Parakeet", rows, { hasAccuracyData: false });
  check("report: WER is null without accuracy data", noAcc.wer, null);
  check("report: completeness is null without accuracy data", noAcc.completeness, null);
  const noAccTable = formatSummaryTable([noAcc]);
  ok("report: renders n/a for WER", noAccTable.includes("n/a"));
  ok("report: still renders latency", noAccTable.includes("200"));

  // Padding helper.
  const padded = padSilence(new Float32Array([0.1, 0.2]), 16000, 10);
  check("padding: adds 10ms before and after", padded.length, 2 + 320);
  check("padding: zero pad is a no-op", padSilence(new Float32Array([0.1]), 16000, 0).length, 1);

  // Banners.
  ok("banner: synthetic says not valid for accuracy", SYNTHETIC_BANNER.includes("not valid for accuracy"));
  ok("banner: no-audio says skipped cleanly", NO_AUDIO_BANNER.includes("skipped cleanly"));
}

// ═══════════════════════════════════════════════════════════════════════════
// REGRESSION: punctuated + capitalised Parakeet-style text must pass the
// existing gate, turn normaliser and interview prompt unchanged. Parakeet
// emits "What is MongoDB?" where Moonshine emits "what is mongodb" — this
// proves that difference is safe BEFORE any integration.
// ═══════════════════════════════════════════════════════════════════════════
section("REGRESSION: punctuated/capitalised Parakeet-style text");
// ═══════════════════════════════════════════════════════════════════════════
{
  const parakeetStyle = [
    "What is MongoDB?",
    "What is Spring Boot?",
    "Explain Docker.",
    "How does JWT authentication work?",
    "What is Kubernetes?",
    "What is the difference between RabbitMQ and Kafka?",
    "Tell me about the architecture of your project.",
    "Your payment service starts failing immediately after deployment. What would you check first?",
  ];

  for (const text of parakeetStyle) {
    const turn: InterviewTurn = {
      finals: [{ source: "system", text }],
      interim: null,
    };
    const verdict = evaluateInterviewTurn(turn);
    check(`gate accepts: "${text}"`, verdict.action, "answer");
    if (verdict.action === "answer") {
      check(`gate preserves text verbatim: "${text}"`, verdict.question, text);
    }
  }

  // normalizeTurn must not split, merge or strip a punctuated question.
  const multi: InterviewTurn = {
    finals: [
      { source: "system", text: "What is MongoDB?" },
      { source: "system", text: "Why did you choose it?" },
    ],
    interim: null,
  };
  const normalized = normalizeTurn(multi);
  check("normalizeTurn: punctuated questions stay separate", normalized.finals.length, 2);
  check(
    "normalizeTurn: text is unchanged (no lowercasing, no de-punctuating)",
    normalized.finals.map((u) => u.text),
    ["What is MongoDB?", "Why did you choose it?"],
  );

  // A punctuated two-part question must still be seen as ONE question, not two.
  const twoPart: InterviewTurn = {
    finals: [
      {
        source: "system",
        text: "Your payment service starts failing immediately after deployment. What would you check first?",
      },
    ],
    interim: null,
  };
  check(
    "gate treats a two-sentence question as one question",
    evaluateInterviewTurn(twoPart).action,
    "answer",
  );

  // The prompt must carry the punctuated form through unchanged.
  const prompt = buildInterviewUserPrompt(
    { finals: [{ source: "system", text: "What is MongoDB?" }], interim: null },
    { questionIndex: 0 },
  );
  ok("prompt: contains the punctuated question", prompt.includes("What is MongoDB?"));
  ok("prompt: question is inside the LATEST_QUESTION block", prompt.includes("<<<LATEST_QUESTION>>>"));
  ok("prompt: contains the closing delimiter", prompt.includes("<<<END_LATEST_QUESTION>>>"));

  // Punctuation must not defeat the unfinished-utterance heuristics.
  const unfinished = evaluateInterviewTurn({
    finals: [{ source: "system", text: "Can you explain" }],
    interim: null,
  });
  check("gate: punctuated-but-unfinished still waits", unfinished.action, "wait");
  const filler = evaluateInterviewTurn({
    finals: [{ source: "system", text: "Okay." }],
    interim: null,
  });
  check("gate: punctuated filler still waits", filler.action, "wait");
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log("\n" + failures.join("\n\n"));
console.log(
  fail === 0
    ? "\nALL ASR-BENCH TESTS PASSED"
    : "\nASR-BENCH TESTS FAILED",
);
process.exit(fail > 0 ? 1 : 0);