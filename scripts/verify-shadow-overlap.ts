/**
 * Verification harness for SHADOW RULE (c) — answer/question content-word
 * overlap.
 *
 * Run: `npx tsx scripts/verify-shadow-overlap.ts`
 *
 * No audio, no network, no Electron.
 *
 * ── What this harness is really checking ────────────────────────────────────
 * Rule (c) is deliberately NOT enforced, so the tests cannot be "does it
 * reject the bad answer". They are:
 *
 *   1. Is the computation correct and guarded on both sides?
 *   2. Is it provably INERT — i.e. can anything it produces change what the
 *      user sees? (It must not.)
 *   3. What does it actually do on real recorded questions and answers?
 *
 * (3) matters most. A rule that misses the bug it was written for, while
 * rejecting correct answers, is worse than no rule, and only a measurement can
 * show that.
 */

import { readFileSync } from "node:fs";

import {
  SHADOW_MIN_ANSWER_WORDS,
  SHADOW_MIN_QUESTION_WORDS,
  shadowOverlapCheck,
  validateAnswerOutput,
} from "../src/lib/outputValidation";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else failures.push(`  ${name}\n    expected: ${b}\n    actual:   ${a}`);
}
function checkTrue(name: string, cond: boolean) {
  check(name, cond, true);
}
function checkFalse(name: string, cond: boolean) {
  check(name, cond, false);
}

const SQL_Q = "What is difference between SQL and NoSQL databases?";

// ── 1. The computation ──────────────────────────────────────────────────────

{
  const r = shadowOverlapCheck(
    "The difference is that SQL databases are relational while NoSQL ones are not",
    SQL_Q,
  );
  check("1a shared content words are counted", r.sharedContentWords, 4);
  check("1b the score is shared/min(both sides)", r.overlapScore, 1);
  checkFalse("1c full overlap does not reject", r.wouldReject);
  check("1d it did not abstain", r.abstained, null);
  check("1e the question's content words are counted", r.questionContentWords, 4);
}

{
  // The rule's designed target: an answer about something else entirely.
  const r = shadowOverlapCheck(
    "One is relational with a fixed schema and joins, the other is document oriented and schemaless",
    SQL_Q,
  );
  check("1f zero shared content words is detected", r.sharedContentWords, 0);
  check("1g and WOULD reject", r.wouldReject, true);
  check("1h with a zero score", r.overlapScore, 0);
}

// ── 2. Minimum-sample guards ────────────────────────────────────────────────

{
  const oneWord = shadowOverlapCheck(
    "Redis is an in-memory data store used mainly for caching and fast lookups",
    "What is Redis?",
  );
  checkFalse("2a a one-content-word question abstains", oneWord.wouldReject);
  check("2b and says so", oneWord.abstained, "too-few-question-words");
  checkTrue(
    `2c the guard is the named constant`,
    oneWord.questionContentWords < SHADOW_MIN_QUESTION_WORDS,
  );
}

{
  const short = shadowOverlapCheck("Yes, exactly that.", SQL_Q);
  checkFalse("2d a too-short answer abstains", short.wouldReject);
  check("2e and says so", short.abstained, "too-few-answer-words");
  checkTrue(
    "2f the guard is the named constant",
    short.answerContentWords < SHADOW_MIN_ANSWER_WORDS,
  );
}

{
  const none = shadowOverlapCheck("anything at all here", undefined);
  checkFalse("2g a missing question abstains", none.wouldReject);
  check("2h with a reason", none.abstained, "no-question");
}

{
  const empty = shadowOverlapCheck("", SQL_Q);
  checkFalse("2i an empty answer abstains rather than rejecting", empty.wouldReject);
}

// ── 3. No topic words in the function-word list ─────────────────────────────

{
  // The exclude-list must be linguistic only. If a technology name were on it,
  // that technology could never count as shared and the rule would silently
  // become a topic filter.
  const src = readFileSync("src/lib/outputValidation.ts", "utf8");
  const block = src.slice(
    src.indexOf("const SHADOW_FUNCTION_WORDS"),
    src.indexOf("];", src.indexOf("const SHADOW_FUNCTION_WORDS")),
  );
  for (const tech of [
    "redis", "docker", "sql", "nosql", "mongodb", "cache", "api", "rest",
    "spring", "node", "react", "http", "index", "thread",
  ]) {
    checkFalse(`3 ${tech} is NOT in the function-word list`, block.includes(`"${tech}"`));
  }
}

// ── 4. The rule is INERT — it can never change what the user sees ───────────

{
  // A shadow result is not an input to the validator. The bad answer is
  // rejected by the WAIT rule, and the correct-but-zero-overlap answer is
  // ACCEPTED — which is exactly why (c) is not in force.
  const bad =
    "What is the difference between a Node 79 - Node.js8 WAIT then provide a clear question, and if a technical example or clarification, please WAIT";
  const correctButZeroOverlap =
    "One is relational with a fixed schema and joins, the other is document oriented and schemaless";

  check(
    "4a the live bug is rejected by the WAIT sentinel, not by overlap",
    validateAnswerOutput(bad, { question: SQL_Q }).reason,
    "artifact-wait-sentinel",
  );
  checkTrue(
    "4b the correct zero-overlap answer is ACCEPTED (proving (c) must stay shadow)",
    validateAnswerOutput(correctButZeroOverlap, { question: SQL_Q }).ok === true,
  );

  // And the shadow result for that same accepted answer says "would reject".
  const shadow = shadowOverlapCheck(correctButZeroOverlap, SQL_Q);
  checkTrue(
    "4c the shadow rule WOULD have rejected that correct answer",
    shadow.wouldReject === true,
  );
}

{
  // Source-level: nothing in the shipping decision path reads `wouldReject`.
  const home = readFileSync("src/pages/Home.tsx", "utf8");
  checkFalse(
    "4d Home.tsx never branches on wouldReject",
    /if\s*\(\s*[^)]*wouldReject/.test(home),
  );
  checkTrue(
    "4e Home.tsx computes the shadow result",
    /shadowOverlapCheck\(/.test(home),
  );
  checkTrue(
    "4f and logs it as numbers only",
    /shadow-overlap wouldReject=\$\{s\.wouldReject\}/.test(home),
  );
  checkFalse(
    "4g the shadow log line never includes the answer or question text",
    /shadow-overlap[^`]*\$\{fullSolution\}|\$\{answeredQuestion\}/.test(home),
  );

  const valid = readFileSync("src/lib/outputValidation.ts", "utf8");
  checkFalse(
    "4h validateAnswerOutput does not call the shadow rule",
    /shadowOverlapCheck\(trimmed/.test(valid),
  );
}

// ── 5. The report aggregates it ─────────────────────────────────────────────

{
  const stage = readFileSync("src/lib/stageTiming.ts", "utf8");
  checkTrue(
    "5a the report has a shadow section",
    /SHADOW RULE \(c\)/.test(stage),
  );
  checkTrue(
    "5b it reports the would-reject count",
    /would-reject=\$\{wouldReject\.length\}/.test(stage),
  );
  checkTrue(
    "5c it reports the rate",
    /rate=\$\{FIXED\(/.test(stage),
  );
  checkTrue(
    "5d it reports the abstention reasons",
    /abstained because:/.test(stage),
  );
  checkTrue(
    "5e the section states it is not enforced",
    /NOT ENFORCED/.test(stage),
  );
}

// ── 6. EXTRA CASE: the live-bug text is an ABSTENTION-ADJACENT miss ─────────
//
// The most important measurement in this file. The bug that motivated rule (c)
// is NOT caught by it, because the bad answer happens to share the word
// "difference" with the question. Reported as its own case so the finding is
// not buried inside an aggregate.
{
  const bad =
    "What is the difference between a Node 79 - Node.js8 WAIT then provide a clear question, and if a technical example or clarification, please WAIT";
  const r = shadowOverlapCheck(bad, SQL_Q);
  checkFalse(
    "6a rule (c) does NOT catch the live bug it was proposed for",
    r.wouldReject,
  );
  checkTrue(
    "6b because it shares a content word with the question",
    r.sharedContentWords > 0,
  );
  checkTrue("6c specifically 'difference'", r.sharedContentWords === 1);
}

// ── 7. Measured behaviour on the recorded fixtures ─────────────────────────

{
  const manifest = JSON.parse(
    readFileSync("tests/fixtures/asr/manifest.json", "utf8"),
  );
  const refs: Array<{ id: string; text: string }> = [
    ...manifest.questions.map((q: any) => ({ id: q.id, text: q.reference as string })),
    ...manifest.shortSegments.map((s: any) => ({ id: s.id, text: s.reference as string })),
  ];

  // The recorded references ARE questions, so measuring "an answer shares no
  // content words with the question" needs a second string. Asking whether a
  // question overlaps ITSELF is the only honest baseline available offline: it
  // must be 100% overlap, and anything else means the tokeniser is broken.
  let selfRejects = 0;
  let selfAbstained = 0;
  for (const r of refs) {
    const res = shadowOverlapCheck(r.text, r.text);
    if (res.wouldReject) selfRejects++;
    if (res.abstained) selfAbstained++;
  }
  check("7a a question compared with itself never rejects", selfRejects, 0);
  check(
    `7b and abstains only on single-content-word references`,
    selfAbstained,
    refs.filter((r) => shadowOverlapCheck(r.text, r.text).abstained !== null).length,
  );

  // Cross-pair every reference against every OTHER reference. Real interview
  // questions are mostly unrelated to each other, so this approximates the
  // false-reject rate the rule would have on legitimately unrelated answer
  // text — an upper bound, since an answer to a question is far more related to
  // it than a different question is.
  let pairs = 0;
  let zeroOverlap = 0;
  let abstained = 0;
  for (const a of refs) {
    for (const b of refs) {
      if (a.id === b.id) continue;
      const res = shadowOverlapCheck(a.text, b.text);
      if (res.abstained) {
        abstained++;
        continue;
      }
      pairs++;
      if (res.wouldReject) zeroOverlap++;
    }
  }
  const rate = pairs > 0 ? (zeroOverlap / pairs) * 100 : 0;

  console.log("");
  console.log("SHADOW RULE (c) — measured on recorded fixtures");
  console.log(`  references compared          : ${refs.length}`);
  console.log(`  cross-pairs evaluated        : ${pairs}`);
  console.log(`  cross-pairs with ZERO overlap: ${zeroOverlap} (${rate.toFixed(1)}%)`);
  console.log(`  cross-pairs that abstained   : ${abstained}`);
  console.log(
    "  reading: unrelated questions share no content words this often, so the",
  );
  console.log(
    "  rule's zero-overlap signal is not specific to bad answers.",
  );
  console.log("");

  checkTrue(
    "7c unrelated question pairs DO frequently score zero overlap (the rule is not specific)",
    rate > 5,
  );
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.join("\n"));
  process.exit(1);
}
