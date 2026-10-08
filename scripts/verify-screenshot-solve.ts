/**
 * Regression harness for the Screenshot -> Solve answer path.
 *
 * Run: `npx tsx scripts/verify-screenshot-solve.ts`
 *
 * The reported failure was "I took a screenshot and no answer arrived". Two
 * separate defects sat behind it, and this harness pins both:
 *
 *   1. The tray's "Capture Screen" item emitted `ghostly:screenshot` with NO
 *      payload. The renderer appended `undefined` to its screenshot list, so
 *      `screenshots.length > 0` satisfied the "you forgot to capture" guard
 *      while the provider was asked to read a picture that was never sent.
 *      `runAIStream` also took `screenshotList[length - 1]`, so one bad entry
 *      suppressed the image entirely.
 *
 *   2. `onSolve` routed on "is the interview panel open" rather than on "is
 *      there a live question to answer". With the panel open and the local gate
 *      saying WAIT, the run stopped at the WAIT notice and the screenshot was
 *      never sent. Solve therefore required an audio submission it does not
 *      need, and does not need Live Screen or Parakeet either.
 *
 * The decision itself (`lib/solveTarget.ts`) and the real store action are
 * exercised directly — not mocked — and the wiring that connects them to the
 * answer-generation call is asserted against the actual source, so this
 * harness fails if the UI path is broken even while the helpers stay green.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  decideSolveTarget,
  isUsableScreenshot,
  lastUsableScreenshot,
  usableScreenshots,
} from "../src/lib/solveTarget";
import { useStore } from "../src/store/useStore";

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

const root = process.cwd();
const read = (p: string): string => readFileSync(path.join(root, p), "utf8");

const IMG = "data:image/png;base64,iVBORw0KGgo=";
const IMG2 = "data:image/png;base64,iVBORw0KGgp=";

console.log("SCREENSHOT -> SOLVE");

// ── A. The screenshot list only ever holds attachable images ───────────────

check("A1 a non-empty data URL is usable", isUsableScreenshot(IMG), true);
check("A2 undefined is not usable", isUsableScreenshot(undefined), false);
check("A3 the empty string is not usable", isUsableScreenshot(""), false);

check(
  "A4 payload-less entries are filtered out",
  usableScreenshots([IMG, undefined, IMG2]),
  [IMG, IMG2],
);

// The exact shape the tray menu used to produce.
check(
  "A5 a list holding only a payload-less entry yields nothing to send",
  usableScreenshots([undefined]),
  [],
);
check(
  "A6 the newest ATTACHABLE screenshot is used, not merely the last entry",
  lastUsableScreenshot([IMG, IMG2, undefined]),
  IMG2,
);
check(
  "A7 no usable screenshot at all resolves to undefined",
  lastUsableScreenshot([undefined, ""]),
  undefined,
);

// ── B. The real store action rejects a payload-less screenshot ─────────────
// Exercised against the actual zustand store, not a stand-in.

const store = useStore.getState();
store.clearScreenshots();
store.addScreenshot(undefined as unknown as string);
check("B1 a payload-less screenshot never enters the store", useStore.getState().screenshots, []);
store.addScreenshot(IMG);
check("B2 a real screenshot does enter the store", useStore.getState().screenshots, [IMG]);
check("B3 the store exposes it as the current screenshot", useStore.getState().currentScreenshot, IMG);
// ── The explicit-capture ARM ───────────────────────────────────────────────
// A capture is a deliberate user action, and it is recorded as one. These are
// the store-level halves of the rule the solver applies below.
check("B4 a capture ARMS the screenshot for the next Solve", useStore.getState().screenshotArmed, true);
useStore.getState().consumeScreenshotArm();
check("B5 solving consumes the arm", useStore.getState().screenshotArmed, false);
store.addScreenshot(IMG2);
check("B6 a new capture re-arms it", useStore.getState().screenshotArmed, true);
store.removeScreenshot(0);
check("B7 removing one of two screenshots keeps the arm", useStore.getState().screenshotArmed, true);
store.removeScreenshot(0);
// The arm points AT an image; with no image left there is nothing for it to mean.
check("B8 removing the LAST screenshot disarms it", useStore.getState().screenshotArmed, false);
store.clearScreenshots();

// ── C. What a Solve press answers ──────────────────────────────────────────

check(
  "C1 a live question wins over an available screenshot",
  decideSolveTarget({ hasTurn: true, gateSaysAnswer: true, usableScreenshots: 1 }),
  { target: "interview", reason: "interview question wins" },
);
check(
  "C2 with no transcript the screenshot is solved — no audio required",
  decideSolveTarget({ hasTurn: false, gateSaysAnswer: false, usableScreenshots: 1 }),
  { target: "screenshot", reason: "no live question — solving the screenshot" },
);
check(
  "C3 an open panel whose gate said WAIT no longer swallows the screenshot",
  decideSolveTarget({ hasTurn: true, gateSaysAnswer: false, usableScreenshots: 1 }),
  { target: "screenshot", reason: "no live question — solving the screenshot" },
);
check(
  "C4 with nothing to solve from, the live path is left completely unchanged",
  decideSolveTarget({ hasTurn: true, gateSaysAnswer: false, usableScreenshots: 0 }),
  { target: "interview", reason: "screenshot solve is not possible" },
);
check(
  "C5 a panel-less press with no screenshot keeps the 'capture one first' error",
  decideSolveTarget({ hasTurn: false, gateSaysAnswer: false, usableScreenshots: 0 }),
  { target: "interview", reason: "screenshot solve is not possible" },
);

// ── Cb. The EXPLICIT-CAPTURE rule ──────────────────────────────────────────
// Capture Screen → Solve must solve the capture, even though a live question is
// gated as answerable. That is the reported failure shape: screenshot taken →
// Solve → the transcript stole the run → no answer.
//
// The signal is the ARM, not a timestamp. A transcript only needs to be NEWER
// than the capture for a "which is newer" check to lose the run, and ASR commit
// lag produces exactly that on its own: the interviewer's earlier sentence is
// still decoding when the user presses Capture, and it lands in the transcript
// afterwards. These checks pin the behaviour that survives that.
check(
  "Cb1 an explicit capture wins over a live question",
  decideSolveTarget({
    hasTurn: true,
    gateSaysAnswer: true,
    usableScreenshots: 1,
    screenshotArmed: true,
  }),
  { target: "screenshot", reason: "the screenshot was captured explicitly and is not yet solved" },
);
check(
  "Cb2 the SAME state without the arm leaves the audio path exactly as it was",
  decideSolveTarget({
    hasTurn: true,
    gateSaysAnswer: true,
    usableScreenshots: 1,
    screenshotArmed: false,
  }),
  { target: "interview", reason: "interview question wins" },
);
check(
  "Cb3 an armed capture with no speech at all still solves the screenshot",
  decideSolveTarget({
    hasTurn: false,
    gateSaysAnswer: false,
    usableScreenshots: 1,
    screenshotArmed: true,
  }),
  { target: "screenshot", reason: "the screenshot was captured explicitly and is not yet solved" },
);
check(
  "Cb4 with no arm the ORIGINAL rule is preserved exactly",
  decideSolveTarget({ hasTurn: true, gateSaysAnswer: true, usableScreenshots: 1 }),
  { target: "interview", reason: "interview question wins" },
);
check(
  "Cb5 an arm cannot conjure a screenshot that was never captured",
  decideSolveTarget({
    hasTurn: true,
    gateSaysAnswer: true,
    usableScreenshots: 0,
    screenshotArmed: true,
  }),
  { target: "interview", reason: "interview question wins" },
);
check(
  "Cb6 with no arm a screenshot is still the fallback when no question is live",
  decideSolveTarget({
    hasTurn: true,
    gateSaysAnswer: false,
    usableScreenshots: 1,
    screenshotArmed: false,
  }),
  { target: "screenshot", reason: "no live question — solving the screenshot" },
);

// ── D. The wiring that actually reaches the answer-generation call ─────────

const home = read("src/pages/Home.tsx");
const storeSrc = read("src/store/useStore.ts");
const hotkeys = read("electron/hotkeys.ts");
const main = read("electron/main.ts");

checkTrue(
  "D1 the Solve handler routes through the tested decision",
  /decideSolveTarget\(\{[\s\S]{0,300}?gateSaysAnswer/.test(home),
);
checkTrue(
  "D2 the Solve handler hands the decision's target to the answer pipeline",
  /runAIStream\(shots,\s*decision\.target === "interview" \? turn : undefined\)/.test(home),
);
checkTrue(
  // The variable was renamed `latestScreenshot` -> `attachedScreenshot` so the
  // image is resolved ONCE per run, before the prompt is built, and the identical
  // one is used for the prompt and every attempt. The behaviour asserted here is
  // unchanged: the newest attachable screenshot is the one that answers.
  "D3 the screenshot actually attached to the run is the newest usable one",
  /const attachedScreenshot = lastUsableScreenshot\(screenshotList\)/.test(home),
);
checkTrue(
  "D4 the 'capture a screenshot first' guard counts attachable screenshots",
  /usableScreenshots\(screenshotList\)\.length === 0/.test(home),
);
checkTrue(
  // The OCR-first feature changed WHERE the image goes, and the OCR-context work
  // then narrowed WHEN it goes at all. Asserted as the positive rule rather than
  // deleted: "the image never reaches a provider unless this exact request asked
  // for it" is the stronger property, and it is the one that stops a follow-up
  // from re-sending the same screenshot forever.
  "D5 the image reaches the orchestrator only on an explicit vision screenshot solve",
  /const imageAttached =[\s\S]{0,200}?solveTarget === "screenshot"[\s\S]{0,200}?=== "vision"/.test(
    home,
  ) && /base64Image: imageAttached \? latestScreenshot : undefined/.test(home),
);
checkTrue(
  "D6 the store refuses a payload-less screenshot",
  /if \(typeof b64 !== "string" \|\| b64\.length === 0\)/.test(storeSrc),
);
checkTrue(
  "D7 the Solve handler feeds the explicit-capture arm into the decision",
  /const armed = useStore\.getState\(\)\.screenshotArmed/.test(home) &&
    /screenshotArmed: armed/.test(home),
);
checkTrue(
  "D7a the Solve handler CONSUMES the arm once a run targets the screenshot",
  /decision\.target === "screenshot"[\s\S]{0,500}?consumeScreenshotArm\(\)/.test(home),
);
checkTrue(
  "D7b nothing in the decision is derived from capture timestamps any more",
  !/lastScreenshotAt/.test(home) && !/lastSpeechAt/.test(home),
);
checkTrue(
  "D7c the capture path arms it, and the arm is in-memory only",
  /addScreenshot[\s\S]{0,900}?screenshotArmed: true/.test(storeSrc) &&
    /consumeScreenshotArm: \(\) => set\(\{ screenshotArmed: false \}\)/.test(storeSrc) &&
    // `clearSolution` (Ctrl+G) drops every session slice, including the ones the
    // OCR context added; the list may grow, so the assertion is "the arm is
    // cleared here", not a verbatim snapshot of the object.
    /screenshotArmed: false,[\s\S]{0,300}?currentScreenshot: null,[\s\S]{0,120}?error: null,/.test(
      storeSrc,
    ),
);
checkTrue(
  "D7d the request builder traces whether an image is attached, per attempt",
  /const imageTrace = opts\.base64Image/.test(read("src/lib/ai/orchestrator.ts")) &&
    /image=\$\{imageTrace\}/.test(read("src/lib/ai/orchestrator.ts")),
);
checkTrue(
  "D8 screenshot payloads and their capture instants stay in lockstep",
  /addScreenshot[\s\S]{0,700}?screenshotTimestamps: \[\.\.\.s\.screenshotTimestamps, Date\.now\(\)\]/.test(
    storeSrc,
  ) &&
    /clearScreenshots[\s\S]{0,300}?screenshotTimestamps:\s*\[\]/.test(storeSrc) &&
    /removeScreenshot[\s\S]{0,300}?screenshotTimestamps: s\.screenshotTimestamps\.filter/.test(
      storeSrc,
    ),
);

// ── E. Screenshot capture always produces an image ─────────────────────────

checkTrue(
  "E1 both capture entry points share one implementation",
  /export async function captureAndSendScreenshot/.test(hotkeys) &&
    /await captureAndSendScreenshot\(win\)/.test(hotkeys) &&
    /captureAndSendScreenshot\(mainWindow\)/.test(main),
);
checkTrue(
  "E2 the tray menu no longer emits a payload-less screenshot",
  !/send\("ghostly:screenshot"\)/.test(main),
);
const screenshotSends = [
  ...hotkeys.matchAll(/send\("ghostly:screenshot"([^)]*)\)/g),
].map((m) => m[1].trim());
checkTrue(
  "E3 every ghostly:screenshot send carries the captured image",
  screenshotSends.length >= 1 &&
    screenshotSends.every((args) => args.startsWith(",")),
);
checkTrue(
  "E4 no send can emit a payload-less screenshot anywhere in the main process",
  ![hotkeys, main].some((src) =>
    /send\("ghostly:screenshot"\s*\)/.test(src),
  ),
);

// ── F. Solve needs no Live Screen, no Parakeet and no ASR ───────────────────

checkTrue(
  "F1 the Solve handler passes the screenshots into the answer pipeline",
  /const shots = screenshotsRef\.current/.test(home) &&
    /runAIStream\(shots,/.test(home),
);
checkTrue(
  // F2's INTENT is "Solve reuses the existing prompt path — there is no second,
  // screenshot-only code path". With the category dropdown removed the shared
  // builder is `buildUniversalPrompt`, so the same property is asserted against
  // it, PLUS the stronger claim that the per-category builder is now unreachable
  // from the app: a screenshot solve can no longer pick a template by category.
  "F2 the screenshot prompt is the shared universal prompt, not a category path",
  /prompt = buildUniversalPrompt\(settings\.language\)/.test(home),
);
checkTrue(
  "F2a the legacy per-category prompt builder is not reachable from the app",
  !/buildPrompt\(/.test(home) && !/buildPrompt\(/.test(read("src/pages/Home.tsx")),
);
const solveTargetSrc = read("src/lib/solveTarget.ts");
checkTrue(
  "F3 the Solve decision is pure — it cannot pull in Live Screen or any ASR",
  !/^import /m.test(solveTargetSrc),
);
const decisionBlock = home.slice(
  home.indexOf("const decision = decideSolveTarget("),
  home.indexOf("await runAIStream(shots, decision.target"),
);
checkTrue(
  "F4 the Solve decision touches no ASR, Live Screen or provider code",
  !/liveScreen|parakeet|moonshine|deepgram|groq|orchestrat/i.test(decisionBlock),
);
checkTrue(
  "F5 the screenshot is carried into the run independently of the panel",
  /const shots = screenshotsRef\.current/.test(home),
);

console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.join("\n"));
  process.exit(1);
}
