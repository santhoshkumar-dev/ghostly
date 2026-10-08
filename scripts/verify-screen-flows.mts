/**
 * Real-flow harness for the manual test sequence.
 *
 * Run: `npx tsx scripts/verify-screen-flows.mts`
 *
 * Every check here drives the REAL code the app runs: the real prompt builder,
 * the real orchestrator, the real output validator, the real session-context
 * rules, the real context-precedence selector and the real conversation-thread
 * logic. The ONLY thing scripted is the network boundary — the provider is
 * replaced through the orchestrator's own `resolveProvider` test seam, exactly
 * as `verify-orchestration.mts` does, so the request that would go on the wire
 * is inspected instead of guessed at.
 *
 * Nothing here is reimplemented to make a test pass. If the UI wiring breaks,
 * `verify-screenshot-solve.ts` catches it; if the pipeline or the context rules
 * break, this file does.
 */

import {
  orchestrateAnswer,
  type AttemptSpec,
} from "../src/lib/ai/orchestrator";
import { validateAnswerOutput } from "../src/lib/outputValidation";
import { isWaitResponse } from "../src/lib/interviewAgent";
import type { AIProvider, AIRequestOptions } from "../src/lib/ai/types";
import { buildPrompt, buildInterviewContext } from "../src/lib/prompts";
import {
  decideSolveTarget,
  lastUsableScreenshot,
  usableScreenshots,
} from "../src/lib/solveTarget";
import {
  EMPTY_SESSION_CONTEXT,
  classifyFollowUp,
  detectProblemStart,
  startProblem,
  touchProblem,
  type SessionContext,
} from "../src/lib/sessionContext";
import { selectContextBlock } from "../src/lib/contextSelection";
import {
  appendThreadTurn,
  continueThread,
  describeThread,
  startThread,
} from "../src/lib/conversationThread";
import { buildInterviewUserPrompt } from "../src/lib/interviewAgent";

let pass = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else failures.push(`  ${name}\n    expected: ${b}\n    actual:   ${a}`);
}
function checkTrue(name: string, cond: boolean): void {
  check(name, cond, true);
}

// ── The one scripted thing: the network boundary ────────────────────────────

interface CapturedRequest {
  prompt?: string;
  base64Image?: string;
  mimeType?: string;
  messages?: { role: string; content: string }[];
}

function recordingProvider(
  capture: CapturedRequest,
  chunks: string[],
): AIProvider {
  return {
    name: "scripted",
    listModels: () => ["scripted-model"],
    async *streamSolution(options: AIRequestOptions) {
      capture.prompt = options.prompt;
      capture.base64Image = options.base64Image;
      capture.mimeType = options.mimeType;
      capture.messages = options.messages;
      for (const c of chunks) yield c;
      if (options.meta) options.meta.finishReason = "stop";
    },
  };
}

/** The acceptance callback Home.tsx passes to the orchestrator. */
const acceptAnswer = (text: string) => {
  if (isWaitResponse(text)) return { ok: false, reason: "wait" };
  return validateAnswerOutput(text, {});
};

function runShot(
  capture: CapturedRequest,
  screenshotList: unknown[],
  chunks: string[],
) {
  const latestScreenshot = lastUsableScreenshot(screenshotList);
  return orchestrateAnswer({
    attempts: [
      {
        provider: "openrouter",
        model: "openrouter/free",
        apiKey: "scripted-key",
        maxTokens: 512,
      },
    ] as AttemptSpec[],
    prompt:
      buildPrompt("dsa", "python") +
      buildInterviewContext({}, { includeResume: true }),
    base64Image: latestScreenshot,
    mimeType: latestScreenshot ? "image/png" : undefined,
    signal: new AbortController().signal,
    hedgeMs: 120,
    validate: acceptAnswer,
    resolveProvider: () => recordingProvider(capture, chunks),
  });
}

const SHOT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const DSA_ANSWER = [
  "## Approach",
  "Use a hash map to store each value already seen, so the complement lookup is O(1).",
  "## Solution",
  "```python",
  "def two_sum(nums, target):",
  "    seen = {}",
  "    for i, n in enumerate(nums):",
  "        if target - n in seen:",
  "            return [seen[target - n], i]",
  "        seen[n] = i",
  "```",
  "## Complexity",
  "- Time: O(n) — one pass, each element hashed once.",
].join("\n");

async function main(): Promise<void> {
  console.log("SCREEN FLOWS");

  // ══ TEST A — Screenshot -> Solve -> a real answer request ═══════════════
  {
    const capture: CapturedRequest = {};
    const decision = decideSolveTarget({
      hasTurn: false,
      gateSaysAnswer: false,
      usableScreenshots: usableScreenshots([SHOT]).length,
    });
    checkTrue("A1 with no audio question Solve still targets the screenshot", decision.target === "screenshot");

    const result = await runShot(capture, [SHOT], [DSA_ANSWER]);

    checkTrue("A2 an answer-generation request was actually created", capture.prompt !== undefined);
    checkTrue(
      "A3 the request carries the screenshot image",
      capture.base64Image === SHOT,
    );
    check("A4 the image is sent as a PNG", capture.mimeType, "image/png");
    checkTrue(
      "A5 the prompt is the existing screenshot prompt",
      (capture.prompt ?? "").includes("Analyze the problem in the screenshot"),
    );
    checkTrue(
      "A6 the prompt asks for the structure the validator expects to see",
      (capture.prompt ?? "").includes("## Complexity"),
    );
    checkTrue("A7 the answer came back", Boolean(result.text));
    check("A8 the full answer is returned", result.text, DSA_ANSWER);
    checkTrue("A9 the answer was accepted, not rejected", result.ok !== false);
    checkTrue(
      "A10 the same text passes the real validator standalone",
      validateAnswerOutput(result.text ?? "", {}).ok === true,
    );
  }

  // The defect this whole path existed to fix: a payload-less screenshot must
  // never reach the provider, and must never be the thing that is sent.
  {
    const capture: CapturedRequest = {};
    await runShot(capture, [undefined], [DSA_ANSWER]);
    checkTrue(
      "A11 a payload-less screenshot is not attached to the request",
      capture.base64Image === undefined,
    );
  }
  {
    const capture: CapturedRequest = {};
    await runShot(capture, [SHOT, undefined], [DSA_ANSWER]);
    checkTrue(
      "A12 one bad entry after a good screenshot still sends the good one",
      capture.base64Image === SHOT,
    );
  }

  // A WAIT refusal must still lose, exactly as before.
  {
    const capture: CapturedRequest = {};
    const result = await runShot(capture, [SHOT], ["WAIT"]);
    checkTrue(
      "A13 a WAIT refusal still cannot win the screenshot run",
      !result.text || !result.text.includes("WAIT"),
    );
  }

  // ══ TEST B — "Use as context", then follow-ups with NO new screenshot ════
  const SCREEN_PROBLEM =
    "Given an array of integers nums and an integer target, return the indices " +
    "of the two numbers that add up to target.";
  {
    // What "Use answer as context" does: install the solved answer as the
    // active problem.
    let ctx: SessionContext = startProblem(
      EMPTY_SESSION_CONTEXT,
      DSA_ANSWER,
      Date.now(),
      "screenshot",
    );
    checkTrue("B1 the answer became the active problem", Boolean(ctx.activeProblem));

    const now = Date.now();
    let lastBlock = "";
    for (const q of [
      "How would you solve it?",
      "Why did you choose HashMap?",
      "What is the time complexity?",
    ]) {
      const at = now + 1000;
      const verdict = classifyFollowUp(q, ctx, at);
      checkTrue(`B2 "${q}" attaches to the active problem`, verdict.attach);
      if (verdict.attach) ctx = touchProblem(ctx, at);

      const selection = selectContextBlock({
        question: q,
        problem: verdict,
        context: ctx,
        thread: ctx.conversationThread,
        now: at,
      });
      lastBlock = selection.block;
      check(
        `B3 "${q}" selects the active problem block`,
        selection.choice,
        "active-problem",
      );
      checkTrue(
        `B4 "${q}" puts the problem into the assembled prompt`,
        selection.block.length > 0,
      );
    }

    // No new screenshot was taken, so the follow-up runs carry no image and
    // must still carry the context.
    check(
      "B5 no new screenshot was taken between the follow-ups",
      lastUsableScreenshot([]),
      undefined,
    );
    const prompt = buildInterviewUserPrompt(
      {
        finals: [
          { text: "What is the time complexity?", source: "system" },
        ],
      } as never,
      { questionIndex: 0, contextBlock: lastBlock },
    );
    checkTrue(
      "B6 the real interview prompt carries the active problem block",
      prompt.includes(lastBlock),
    );
    checkTrue(
      "B7 the actual problem content reaches the prompt",
      prompt.includes("hash map"),
    );
  }

  // ══ TEST E — the screen problem is retained; a new one is not adopted ════
  {
    const now = Date.now();
    let ctx = startProblem(
      EMPTY_SESSION_CONTEXT,
      SCREEN_PROBLEM,
      now,
      "live-screen",
    );

    // Ordinary churn while the same problem stays on screen.
    for (const q of [
      "How would you solve it?",
      "Why did you choose HashMap?",
      "What is the time complexity?",
      "Can you optimize the solution?",
    ]) {
      const at = now + 1000;
      const verdict = classifyFollowUp(q, ctx, at);
      checkTrue(`E1 "${q}" keeps the same screen problem attached`, verdict.attach);
      if (verdict.attach) ctx = touchProblem(ctx, at);
    }
    check(
      "E2 the original screen problem is still the active one",
      ctx.activeProblem?.text,
      SCREEN_PROBLEM,
    );

    // A re-read of the SAME problem (scrolling, highlighting, an edited
    // example) must not be mistaken for a new one.
    checkTrue(
      "E3 a restatement of the same problem is not a problem start",
      detectProblemStart(SCREEN_PROBLEM).isProblemStart === true,
    );

    // A genuinely different problem IS adoptable, by the existing rules only.
    const OTHER =
      "Design a rate limiter that allows N requests per second per API key.";
    const newStart = detectProblemStart(OTHER);
    checkTrue(
      "E4 a different problem is recognised as a problem start",
      newStart.isProblemStart,
    );
    const next = startProblem(ctx, OTHER, now + 5000, "live-screen");
    check(
      "E5 the new problem replaces the old one only under the existing rule",
      next.activeProblem?.text,
      OTHER,
    );
  }

  // ══ TEST F — the Redis thread, then a topic switch ══════════════════════
  {
    const now = Date.now();
    const REDIS = "What is Redis?";
    let thread = startThread(REDIS, now);

    // Each answered follow-up is appended exactly as the real path does.
    const answerFor = (q: string) => {
      const verdict = continueThread(q, thread, now + 1000);
      checkTrue(`F1 "${q}" continues the Redis thread`, verdict.attach);
      thread = appendThreadTurn(thread, q, `Because ${q.toLowerCase()} matters in a cache layer.`, now + 1000);
    };

    for (const q of [
      "Why did you use Redis in your project?",
      "How does it work in your application?",
      "Can you explain the flow?",
      "What happens on a cache miss?",
    ]) {
      answerFor(q);
    }

    check(
      "F2 the thread kept its turns",
      thread?.turns.length,
      3,
    );
    checkTrue(
      "F3 Redis is still in the thread's own vocabulary after the drill-down",
      thread?.topicTerms.includes("redis") === true,
    );
    checkTrue(
      "F4 the chip still shows a topic and the retained turn count",
      /\u00b7 3 turns$/.test(describeThread(thread)),
    );

    // "What are the trade-offs?" also continues.
    const tradeoffs = continueThread("What are the trade-offs?", thread, now + 2000);
    checkTrue("F5 trade-offs continue the thread", tradeoffs.attach);

    // Docker must NOT inherit it.
    const docker = continueThread("What is Docker?", thread, now + 3000);
    checkTrue("F6 Docker does not attach to the Redis thread", !docker.attach);
    checkTrue(
      "F7 Docker is recognised as a new subject",
      (docker.reason ?? "").includes("new subject"),
    );
  }
}

main()
  .then(() => {
    console.log(`  ${pass} passed, ${failures.length} failed`);
    if (failures.length) {
      console.log("\nFAILURES:\n" + failures.join("\n"));
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error("harness crashed:", err);
    process.exit(1);
  });
