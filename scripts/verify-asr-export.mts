/**
 * Deterministic tests for the ASR comparison export and clip matching.
 *
 * Run: `npx tsx scripts/verify-asr-export.mts`
 *
 * ── Why matching must fail loudly ───────────────────────────────────────────
 * The whole accuracy comparison rests on pairing each saved WAV with the
 * transcript the live session produced for that exact audio. If a clip is
 * matched to the wrong row, every downstream number is confidently wrong — and
 * nothing in the output would look wrong. So the tests below are mostly about
 * the failure paths: an ambiguous duration match must be REPORTED, not guessed,
 * because guessing is precisely how a benchmark ends up measuring noise.
 */
import {
  buildAsrComparisonExport,
  serializeAsrComparisonExport,
  parsePhraseId,
  matchClipsToRows,
  CLIP_MATCH_TOLERANCE_SECONDS,
  type ExportedComparison,
} from "../src/lib/asrComparisonExport";
import type { AsrComparison } from "../src/store/useStore";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    failures.push(
      `${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`,
    );
  }
}

function checkTrue(name: string, actual: unknown) {
  check(name, Boolean(actual), true);
}

const row = (over: Partial<AsrComparison> = {}): AsrComparison => ({
  id: "7-1700000000000",
  audioSeconds: 4.2,
  moonshineText: "what is spring boot",
  deepgramText: "",
  deepgramTelemetry: null,
  moonshineMs: 610,
  timestamp: 1700000000000,
  ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Export shape ────────────────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const file = buildAsrComparisonExport([row()], new Date("2026-01-01T00:00:00Z"));
  check("1 the file is tagged with its kind", file.kind, "ghostly-asr-comparison-export");
  check("2 it carries a version", file.version, 1);
  check("3 the count matches the rows", file.count, 1);
  checkTrue("4 engines always include moonshine", file.engines.includes("moonshine"));
  checkTrue("5 exportedAt is set", typeof file.exportedAt === "string");

  const r = file.rows[0];
  check("6 phraseId is parsed from the id", r.phraseId, 7);
  check("7 audioSeconds is carried", r.audioSeconds, 4.2);
  check("8 moonshine text is carried", r.moonshineText, "what is spring boot");
  check("9 moonshine latency is carried", r.moonshineMs, 610);
  check("10 absent parakeet fields become empty, not undefined",
    [r.parakeetText, r.parakeetMs, r.parakeetStatus], ["", null, ""]);
}

{
  // Optional engine presence must be RECORDED, so a blank column is never
  // mistaken for a silent engine rather than one that never ran.
  const file = buildAsrComparisonExport([
    row({ parakeetText: "what is spring boot", parakeetStatus: "ok", parakeetMs: 700 }),
    row({ id: "8-1700000001000", groqText: "What is Spring Boot?" }),
  ]);
  check("11 parakeet is listed when it ran", file.engines.includes("parakeet"), true);
  check("12 groq is listed when it ran", file.engines.includes("groq"), true);
}

{
  // Newest first, so "top of the export" is "top of the on-screen list".
  const file = buildAsrComparisonExport([
    row({ id: "1-1", timestamp: 1000 }),
    row({ id: "2-2", timestamp: 5000 }),
    row({ id: "3-3", timestamp: 3000 }),
  ]);
  check("13 rows are ordered newest first",
    file.rows.map((r) => r.phraseId), [2, 3, 1]);
}

{
  check("14 a well-formed id yields its phraseId", parsePhraseId("42-1700000000000"), 42);
  check("15 a malformed id yields null", parsePhraseId("not-an-id"), null);
  check("16 an id with no timestamp separator yields null", parsePhraseId("42"), null);
}

{
  // A row whose id cannot be parsed must stay VISIBLE, flagged, rather than
  // being dropped — a silently missing row makes the export look tidier than
  // the session actually was.
  const file = buildAsrComparisonExport([row({ id: "garbage" })]);
  check("17 an unparseable id is flagged, not dropped", file.rows.length, 1);
  check("18 it is marked with a sentinel phraseId", file.rows[0].phraseId, -1);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── No audio, ever ──────────────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const json = serializeAsrComparisonExport([
    row({ audioUrl: "blob:http://localhost/9f8e-secret-audio" }),
  ]);
  checkTrue("19 the export contains no audioUrl", !json.includes("audioUrl"));
  checkTrue("20 the export contains no blob URL", !json.includes("blob:"));
  checkTrue("21 the export contains no base64 payload", !json.includes("base64"));
  // The one legitimate occurrence is a schema word, not data.
  checkTrue("22 no raw Float32Array leaked", !json.includes("Float32Array"));
  JSON.parse(json); // must be valid JSON
  checkTrue("23 the export parses as JSON", true);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Clip matching ──────────────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const rows = buildAsrComparisonExport([
    row({ id: "7-1", audioSeconds: 4.2 }),
    row({ id: "9-2", audioSeconds: 7.8 }),
  ]).rows;

  const explicit = matchClipsToRows([{ file: "real-01-phrase-7.wav", audioSeconds: 1.0 }], rows);
  check("24 an explicit phraseId in the filename matches", explicit[0].status, "phraseId");
  check("25 it matched the right row", explicit[0].row?.phraseId, 7);

  const byDuration = matchClipsToRows([{ file: "clip.wav", audioSeconds: 7.79 }], rows);
  check("26 a lone duration match is accepted", byDuration[0].status, "audioSeconds");
  check("27 it matched the right row", byDuration[0].row?.phraseId, 9);

  const none = matchClipsToRows([{ file: "clip.wav", audioSeconds: 30.0 }], rows);
  check("28 a clip with no near row is unmatched", none[0].status, "unmatched");
  check("29 an unmatched clip has no row", none[0].row, null);
}

{
  // ── The important one ──────────────────────────────────────────────────
  // Two rows within tolerance of one clip. Picking either would be a guess,
  // and a guessed pairing yields a real-looking WER that measures nothing.
  const rows = buildAsrComparisonExport([
    row({ id: "7-1", audioSeconds: 4.20 }),
    row({ id: "8-2", audioSeconds: 4.28 }),
  ]).rows;

  const result = matchClipsToRows([{ file: "clip.wav", audioSeconds: 4.24 }], rows);
  check("30 an ambiguous duration match is reported, not guessed",
    result[0].status, "ambiguous");
  check("31 no row is chosen for an ambiguous clip", result[0].row, null);
  check("32 both candidates are offered", result[0].candidates?.length, 2);
  checkTrue("33 the detail says a human must decide",
    /human decision/.test(result[0].detail));
}

{
  // Exactly at the tolerance boundary: inclusive, so a clip is not dropped
  // because of floating-point drift.
  const rows = buildAsrComparisonExport([row({ id: "7-1", audioSeconds: 4.2 })]).rows;
  const edge = matchClipsToRows(
    [{ file: "clip.wav", audioSeconds: 4.2 + CLIP_MATCH_TOLERANCE_SECONDS }],
    rows,
  );
  check("34 the tolerance boundary is inclusive", edge[0].status, "audioSeconds");
}

{
  const unknown = matchClipsToRows([{ file: "clip.wav", audioSeconds: null }], []);
  check("35 a clip of unknown length cannot be matched", unknown[0].status, "unmatched");
  checkTrue("36 it explains why",
    /duration unknown/.test(unknown[0].detail));
}

{
  // Matching must not consume rows: two clips of the same length both need to
  // be resolvable, and the ambiguity case must surface rather than silently
  // pairing the first candidate twice.
  const rows = buildAsrComparisonExport([
    row({ id: "7-1", audioSeconds: 4.2 }),
    row({ id: "8-2", audioSeconds: 4.2 }),
  ]).rows;
  const two = matchClipsToRows(
    [
      { file: "a.wav", audioSeconds: 4.2 },
      { file: "b.wav", audioSeconds: 4.2 },
    ],
    rows,
  );
  check("37 identical-length clips both report ambiguity",
    [two[0].status, two[1].status], ["ambiguous", "ambiguous"]);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Isolation ──────────────────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync("src/lib/asrComparisonExport.ts", "utf8"),
  );
  checkTrue("38 the exporter never touches the transcript store",
    !/addInterviewMessage|interviewMessages/.test(source));
  checkTrue("39 the exporter never imports a Node API",
    !/from "node:/.test(source));

  const ipc = await import("node:fs").then((fs) =>
    fs.readFileSync("electron/asrExport.ts", "utf8"),
  );
  checkTrue("40 the export path is chosen by main, not the renderer",
    !/payload\.path|resolveDir\(payload/.test(ipc));
  checkTrue("41 the writer validates the JSON before writing",
    /JSON\.parse\(payload\.json\)/.test(ipc));

  const preload = await import("node:fs").then((fs) =>
    fs.readFileSync("electron/preload.ts", "utf8"),
  );
  checkTrue("42 preload exposes no arbitrary-path write",
    !/writeFile|writeTextFile/i.test(preload));

  const env = await import("node:fs").then((fs) =>
    fs.readFileSync("src/env.d.ts", "utf8"),
  );
  checkTrue("43 the renderer bridge cannot choose the destination",
    !/writeAsrComparisonExport[\s\S]{0,200}path:/.test(
      env.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
    ));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}