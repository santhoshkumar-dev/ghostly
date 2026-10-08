/**
 * Deterministic tests for the Phase 8.3 AI benchmark.
 *
 * Run: `npx tsx scripts/verify-ai-bench.mts`
 *
 * ── The one thing this exists to prove ──────────────────────────────────────
 * The benchmark's headline comparison is Gemini 2.5 Flash with thinking DISABLED
 * against its default. For Flash the SHIPPING policy is already
 * `thinkingBudget: 0`, so a benchmark that passed `0` for both arms would print
 * a confident, real-looking delta of zero and teach the opposite of the truth:
 * that thinking costs nothing.
 *
 * Omitting `thinkingConfig` entirely is the only way to ask for the API's own
 * default, so it has to be a reachable state — and the benchmark carries its own
 * copy of the config because it runs under plain `node`. A drift between that
 * copy and the module that actually serves a request would make the measurement
 * describe a request the app never makes, so the two are compared directly.
 */
import { readFile } from "node:fs/promises";

import { geminiGenerationConfig } from "../src/lib/ai/gemini";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    failures.push(
      `${name}
    expected: ${JSON.stringify(expected)}
    actual:   ${JSON.stringify(actual)}`,
    );
  }
}
function checkTrue(name: string, actual: boolean) {
  check(name, actual, true);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The Gemini generation config, and the two arms that must differ
// ═══════════════════════════════════════════════════════════════════════════

{
  // For Flash the SHIPPING policy is already `thinkingBudget: 0`. A benchmark
  // that compared "0" against "0" would report a confident delta of zero and
  // teach the opposite of the truth, so omitting the field entirely has to be a
  // supported state — this is what makes the comparison meaningful.
  const flash = geminiGenerationConfig("gemini-2.5-flash", 4096);
  check(
    "B6 the shipping Flash policy is thinking off",
    flash.thinkingConfig,
    { thinkingBudget: 0 },
  );

  check(
    "B7 an explicit 0 overrides any model default",
    geminiGenerationConfig("gemini-2.5-flash", 4096, { thinkingBudget: 0 }),
    { maxOutputTokens: 4096, temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } },
  );

  check(
    "B8 the provider-default arm OMITS the field entirely",
    geminiGenerationConfig("gemini-2.5-flash", 4096, {
      thinkingBudget: "provider-default",
    }).thinkingConfig,
    undefined,
  );

  check(
    "B9 Pro keeps its documented floor (0 is a 400 there)",
    geminiGenerationConfig("gemini-2.5-pro", 4096).thinkingConfig,
    { thinkingBudget: 128 },
  );
  check(
    "B0 a 1.5 model rejects the field outright, unchanged",
    geminiGenerationConfig("gemini-1.5-flash", 4096).thinkingConfig,
    undefined,
  );

  // The benchmark carries its own copy of the config because it runs under plain
  // `node`. A drift between the copy and the shipping module would make the
  // measurement describe a request the app never makes.
  const bench = await readFile("scripts/ai-bench.mjs", "utf8");
  const m = bench.match(
    /export function geminiGenerationConfig\([\s\S]*?\n}/,
  );
  checkTrue("B1 the benchmark has a mirrored config", !!m);
  if (m) {
    // Evaluate the benchmark's OWN source rather than a re-typed copy, so this
    // compares the file that will actually run against the module that will
    // actually serve a request.
    const mirrored = new Function(
      `${m[0].replace("export ", "")}; return geminiGenerationConfig;`,
    )() as (model: string, maxTokens: number, tb?: unknown) => any;

    for (const model of [
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-pro",
      "gemini-2.0-flash",
      "gemini-1.5-pro",
    ]) {
      for (const tb of [undefined, 0, 128, 512, "provider-default"]) {
        check(
          `B2 mirrored config agrees for ${model} tb=${String(tb)}`,
          mirrored(model, 4096, tb),
          geminiGenerationConfig(model, 4096, { thinkingBudget: tb as never }),
        );
      }
    }
  }

  checkTrue(
    "B3 the benchmark refuses to report without a key",
    /GEMINI_API_KEY is not set/.test(bench),
  );
  checkTrue(
    "B4 the benchmark compares the two arms that actually differ",
    /A thinking OFF \(budget=0\)/.test(bench) &&
      /B provider default/.test(bench),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}