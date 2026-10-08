/**
 * Verification harness for the cloud-comparison privacy property.
 *
 * Run: `npx tsx scripts/verify-cloud-comparison.ts`
 *
 * No audio, no network, no Electron. Source-level assertions over the real
 * hook and component, because the property being protected is structural: raw
 * microphone audio must not leave the machine unless the user turned a specific
 * comparison on, and when they have, the UI must say so.
 */

import { readFileSync } from "node:fs";

const failures: string[] = [];
let pass = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else failures.push(`  ${name}\n    expected: ${b}\n    actual:   ${a}`);
}

function checkTrue(name: string, cond: boolean) {
  check(name, cond, true);
}

const hook = readFileSync("src/hooks/useInterviewAudio.ts", "utf8");
const modalRaw = readFileSync("src/components/InterviewModal.tsx", "utf8");
const store = readFileSync("src/store/useStore.ts", "utf8");

/**
 * JSX wraps prose across lines for readability, so a sentence the test asserts
 * on is rarely on one line in the source. Collapsing whitespace means the
 * assertions describe the RENDERED string rather than the formatter's choices.
 */
const modal = modalRaw.replace(/\s+/g, " ");

// ── 1. Every comparison engine is OFF by default ───────────────────────────
checkTrue(
  "1a asrCompareMode defaults to false",
  /asrCompareMode:\s*false/.test(store),
);
checkTrue(
  "1b asrCompareGroq defaults to false",
  /asrCompareGroq:\s*false/.test(store),
);
checkTrue(
  "1c asrCompareParakeet defaults to false",
  /asrCompareParakeet:\s*false/.test(store),
);
checkTrue(
  "1d asrCompareMoonshine defaults to false",
  /asrCompareMoonshine:\s*false/.test(store),
);

// ── 2. Every comparison engine requires an EXPLICIT flag ────────────────────
// The flag check must come BEFORE any network call in each engine's body.
{
  const engines: Array<[string, string, string]> = [
    ["Deepgram", "compareWithDeepgram", "asrCompareMode"],
    ["Groq Whisper", "compareWithGroq", "asrCompareGroq"],
    ["Parakeet", "compareWithParakeet", "asrCompareParakeet"],
  ];
  for (const [label, fn, flag] of engines) {
    const start = hook.indexOf(`const ${fn} = useCallback(`);
    checkTrue(`2a ${label}: found its callback`, start >= 0);
    if (start < 0) continue;
    // The body runs to the next top-level `const <name> = useCallback(`.
    const rest = hook.slice(start);
    const next = rest.indexOf("\n  const ", 10);
    const body = next > 0 ? rest.slice(0, next) : rest.slice(0, 2500);

    const flagAt = body.indexOf(`!settings.${flag}`);
    const devAt = body.indexOf("import.meta.env.DEV");
    checkTrue(`2b ${label}: gated on settings.${flag}`, flagAt >= 0);
    checkTrue(`2c ${label}: also gated on import.meta.env.DEV`, devAt >= 0);
    checkTrue(
      `2d ${label}: the flag is checked BEFORE the DEV gate`,
      flagAt >= 0 && devAt >= 0 && flagAt < devAt,
    );
  }
}

// ── 3. A production build cannot upload audio at all ───────────────────────
// `import.meta.env.DEV` is statically false in a packaged build, so each of the
// two CLOUD engines is unreachable there regardless of the stored setting.
checkTrue(
  "3a Deepgram's cloud call is unreachable outside DEV",
  /if \(!settings\.asrCompareMode\) return;\s*\n\s*if \(!import\.meta\.env\.DEV\) return;/.test(
    hook,
  ),
);
checkTrue(
  "3b Groq's cloud call is unreachable outside DEV",
  /if \(!settings\.asrCompareGroq\) return;\s*\n\s*if \(!import\.meta\.env\.DEV\) return;/.test(
    hook,
  ),
);
checkTrue(
  "3c each cloud engine's network call sits INSIDE its gated callback, i.e. the "
    + "gate is not in a different function from the fetch",
  (() => {
    for (const [fn, call] of [
      ["compareWithDeepgram", "openDeepgramSegment("],
      ["compareWithGroq", "runGroqWhisperComparison("],
    ] as const) {
      const start = hook.indexOf(`const ${fn} = useCallback(`);
      if (start < 0) return false;
      const body = hook.slice(start, start + 3000);
      if (!body.includes(call)) return false;
      // The gate must appear BEFORE the call within the same body.
      if (body.indexOf("!import.meta.env.DEV") > body.indexOf(call)) return false;
    }
    return true;
  })(),
);
checkTrue(
  "3d the Deepgram key is never read unless the flag AND DEV both pass",
  /!settings\.asrCompareMode\) return;[\s\S]{0,200}!import\.meta\.env\.DEV\) return;[\s\S]{0,200}!settings\.deepgramKey\) return;/.test(
    hook,
  ),
);

// ── 4. The cloud-audio indicator exists and is user-visible ────────────────
checkTrue(
  "4a the panel computes which cloud engines are active",
  /cloudComparisonEngines/.test(modal),
);
checkTrue("4b Deepgram is named in the indicator", /names\.push\("Deepgram"\)/.test(modal));
checkTrue("4c Groq Whisper is named in the indicator", /names\.push\("Groq Whisper"\)/.test(modal));
checkTrue(
  "4d the indicator is gated on import.meta.env.DEV, like the engines it describes",
  (modal.match(/import\.meta\.env\.DEV && asrCompare/g) ?? []).length >= 2,
);
checkTrue(
  "4e the indicator renders only when at least one engine is active",
  /cloudComparisonEngines\.length > 0 &&/.test(modal),
);
checkTrue(
  "4f it states plainly that audio is being uploaded",
  /Recording audio is being uploaded to/.test(modal),
);
checkTrue(
  "4g it names where to turn it off",
  /in Settings to stop/.test(modal),
);
checkTrue(
  "4h it reassures that the primary engine is unaffected",
  /primary engine is unaffected/.test(modal),
);
checkTrue(
  "4i it is announced to assistive tech, not colour-only",
  /role="status"/.test(modal),
);

// ── 5. The indicator can never appear in a packaged build ───────────────────
{
  const indicator = modal.slice(modal.indexOf("cloudComparisonEngines.length > 0 &&"));
  checkTrue("5a the indicator block exists to inspect", indicator.length > 0);
  // The names can only be pushed under import.meta.env.DEV, so in production
  // the array is always empty and the block is unreachable. Assert the guard
  // rather than the rendering, which cannot be evaluated statically.
  const guardBlock = modal.slice(
    modal.indexOf("const cloudComparisonEngines"),
    modal.indexOf("const cloudComparisonEngines") + 700,
  );
  checkTrue(
    "5b every push in that block is DEV-gated",
    (guardBlock.match(/names\.push\(/g) ?? []).length ===
      (guardBlock.match(/import\.meta\.env\.DEV &&/g) ?? []).length,
  );
}

console.log(
  fail_count() === 0
    ? `\nALL CHECKS PASSED (${pass} assertions)`
    : `\n${fail_count()} CHECK(S) FAILED (${pass} passed)`,
);
function fail_count() {
  return failures.length;
}
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.join("\n"));
  process.exit(1);
}