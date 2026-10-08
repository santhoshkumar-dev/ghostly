/**
 * Re-measure the answer-rejection rules against REAL MODEL ANSWERS.
 *
 * Run:
 *   npx tsx scripts/measure-rules-on-answers.ts <answers.json>
 *
 * Produced by:
 *   node scripts/ai-bench.mjs --provider groq --dump-answers answers.json
 *
 * ── Why a separate harness from `verify-shadow-overlap.ts` ──────────────────
 * That one measures the rules against QUESTION TEXT, because that is all the
 * repo contains offline. A rejection rule operates on ANSWERS, which is a
 * different distribution: answers are longer, share more vocabulary with their
 * question, and are the only population on which "did this rule catch a bad
 * answer" and "did this rule kill a good one" are meaningful questions.
 *
 * Measuring a rule on the wrong population is how a rule gets shipped that
 * looks fine and fails in production.
 *
 * ── What it reports ─────────────────────────────────────────────────────────
 * Per rule: how many answers it rejects, and of those, how many the SHIPPING
 * validator ALREADY rejected (`extra`) versus how many it would reject that the
 * shipping validator ACCEPTED (`newly rejected`). The second number is the one
 * that costs the user an answer.
 *
 * No network, no quota, no models. Reads a file.
 */

import { readFileSync } from "node:fs";

import {
  validateAnswerOutput,
  shadowOverlapCheck,
} from "../src/lib/outputValidation";
import { INTERVIEW_SYSTEM_PROMPT } from "../src/lib/interviewAgent";

interface Row {
  model: string;
  questionId: string;
  question: string;
  answer: string;
  valid: boolean;
  reason: string | null;
}

const failures: string[] = [];
let pass = 0;
function checkTrue(name: string, cond: boolean) {
  if (cond) pass++;
  else failures.push(`  ${name}`);
}

const path = process.argv[2];
if (!path) {
  console.error(
    "usage: npx tsx scripts/measure-rules-on-answers.ts <answers.json>\n\n" +
      "Create the file with:\n" +
      "  node scripts/ai-bench.mjs --provider groq --dump-answers answers.json",
  );
  process.exit(2);
}

let rows: Row[];
try {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { answers?: Row[] };
  rows = parsed.answers ?? [];
} catch (err) {
  console.error(
    `could not read ${path}: ${err instanceof Error ? err.message : String(err)}\n` +
      `If this is pasted benchmark output rather than a --dump-answers file, ` +
      `save it to JSON first.`,
  );
  process.exit(2);
}

if (rows.length === 0) {
  console.error(
    `${path} contains no answers. Refusing to report a rule's false-reject ` +
      `rate on an empty sample — every rule would score a perfect 0%.`,
  );
  process.exit(2);
}

/**
 * The three rules under measurement.
 *
 * Each returns null when it does not fire. (a) and (b) are IN FORCE; (c) is a
 * shadow rule that is never enforced, and is included precisely so its numbers
 * can be compared with the two that are.
 */
const RULES: Array<{
  id: string;
  label: string;
  enforced: boolean;
  fires: (answer: string, question: string) => string | null;
}> = [
  {
    id: "a",
    label: "WAIT sentinel anywhere (case-sensitive)",
    enforced: true,
    fires: (answer) =>
      /(?:^|[^A-Za-z])WAIT(?:[^A-Za-z]|$)/.test(answer) ? "wait-sentinel" : null,
  },
  {
    id: "b",
    label: "instruction about the conversation",
    enforced: true,
    fires: (answer) => {
      const re = new RegExp(
        [
          "(?:please\\s+)?(?:ask|give|provide|send|share|state|tell)\\s+(?:me\\s+)?(?:us\\s+)?(?:an?\\s+|the\\s+|your\\s+)(?:(?:more|clear(?:er)?|specific(?:ally)?|explicit|complete|full|exact|proper|whole)\\s+)*questions?",
          "(?:please|kindly)\\s+wait\\b",
          "\\b(?:technical\\s+)?(?:example|clarification)\\s*,?\\s*(?:or\\s+)?(?:clarification)?\\s*,?\\s*please\\s+wait",
        ].join("|"),
        "i",
      );
      return re.test(answer) ? "conversation-instruction" : null;
    },
  },
  {
    id: "c",
    label: "SHADOW: no content-word overlap with the question",
    enforced: false,
    fires: (answer, question) =>
      shadowOverlapCheck(answer, question).wouldReject ? "zero-overlap" : null,
  },
];

const total = rows.length;
const shippingRejections = rows.filter(
  (r) => !validateAnswerOutput(r.answer, { question: r.question, promptTemplate: INTERVIEW_SYSTEM_PROMPT }).ok,
).length;

console.log("=== rules measured on REAL answers ===");
console.log(`source            : ${path}`);
console.log(`answers           : ${total}`);
console.log(`models            : ${[...new Set(rows.map((r) => r.model))].length}`);
console.log(
  `already rejected  : ${shippingRejections}/${total} by the shipping validator`,
);
console.log("");

const header =
  "rule".padEnd(6) +
  "in force".padEnd(10) +
  "fires".padEnd(7) +
  "extra".padEnd(7) +
  "NEWLY REJECT".padEnd(13) +
  "detail";
console.log(header);
console.log("-".repeat(header.length));

for (const rule of RULES) {
  let fires = 0;
  let extra = 0;
  let newlyRejected = 0;
  const reasons = new Map<string, number>();

  for (const row of rows) {
    const reason = rule.fires(row.answer, row.question);
    if (!reason) continue;
    fires++;
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);

    const shipping = validateAnswerOutput(row.answer, {
      question: row.question,
      promptTemplate: INTERVIEW_SYSTEM_PROMPT,
    });
    if (shipping.ok) {
      newlyRejected++;
    } else {
      extra++;
    }
  }

  console.log(
    rule.id.padEnd(6) +
      (rule.enforced ? "yes" : "SHADOW").padEnd(10) +
      String(fires).padEnd(7) +
      String(extra).padEnd(7) +
      String(newlyRejected).padEnd(13) +
      [...reasons.entries()].map(([r, n]) => `${r}x${n}`).join(" "),
  );
}

console.log("");
console.log("READING");
console.log(
  "  extra         = the rule fired on an answer the shipping validator had",
);
console.log("                  already rejected. Costs nothing; confirms overlap.");
console.log(
  "  NEWLY REJECT  = the rule fired on an answer that currently REACHES THE",
);
console.log(
  "                  USER. For an enforced rule this must be a genuine bad",
);
console.log(
  "                  answer, or the rule is rejecting good ones.",
);
console.log(
  "  A SHADOW rule's NEWLY REJECT count is exactly the number of answers that",
);
console.log("  would be lost if it were switched on.");
console.log("");

// ── The finding that decides whether (c) can ever ship ─────────────────────
{
  const c = RULES.find((r) => r.id === "c")!;
  let correctButRejected = 0;
  for (const row of rows) {
    const shippingOk = validateAnswerOutput(row.answer, {
      question: row.question,
      promptTemplate: INTERVIEW_SYSTEM_PROMPT,
    }).ok;
    if (shippingOk && c.fires(row.answer, row.question)) correctButRejected++;
  }
  console.log(
    `(c) would reject ${correctButRejected} answer(s) the shipping validator ACCEPTS.`,
  );
  console.log(
    `    These are the answers a user would lose if (c) were enforced.`,
  );
  console.log("");
}

// ── Structural assertions on the run itself ────────────────────────────────
checkTrue("the dump contained answers", total > 0);
checkTrue("every dump row carries its question", rows.every((r) => r.question.length > 0));
checkTrue(
  "every dump row carries a model name",
  rows.every((r) => typeof r.model === "string" && r.model.length > 0),
);

if (failures.length) {
  console.log("FAILURES:\n" + failures.join("\n"));
  process.exit(1);
}
console.log(`${pass} structural checks passed.`);
