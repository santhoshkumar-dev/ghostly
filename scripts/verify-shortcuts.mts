/**
 * Verification harness for the Start/Stop Interview and Next Question shortcuts.
 *
 * Run: `npx tsx scripts/verify-shortcuts.mts`
 *
 * Mixes pure unit tests (registry / conflict detection / guards / bridge) with
 * source-level wiring assertions, the same style `verify-stealth.mts` uses. The
 * source assertions are what prove the listeners are actually registered and
 * that Next Question cannot submit to the AI.
 */
import fs from "node:fs";
import {
  createShortcutGuard,
  findShortcutConflicts,
  INTERVIEW_SHORTCUTS,
  isEditableTarget,
  normalizeAccelerator,
  type ShortcutDefinition,
} from "../src/lib/interviewShortcuts";
import {
  consumePendingStart,
  getInterviewControls,
  planInterviewToggle,
  registerInterviewControls,
  requestPendingStart,
} from "../src/lib/interviewControls";

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
function checkTrue(name: string, actual: boolean) {
  check(name, actual, true);
}

const byId = (id: string) => INTERVIEW_SHORTCUTS.find((s) => s.id === id)!;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Start shortcut starts interview
// ─────────────────────────────────────────────────────────────────────────────
check(
  "1: registry has Ctrl+I toggle",
  byId("toggle-interview").accelerator,
  "CommandOrControl+I",
);
{
  let starts = 0;
  registerInterviewControls({
    start: () => starts++,
    stop: () => {},
    isRecording: () => false,
    canStart: () => true,
  });
  const controls = getInterviewControls()!;
  check(
    "1b: idle + ready plans a start",
    planInterviewToggle({ isRecording: controls.isRecording(), canStart: controls.canStart() }),
    "start",
  );
  controls.start();
  check("1c: start invoked", starts, 1);
  registerInterviewControls(null);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Start shortcut does not start twice on key repeat
// ─────────────────────────────────────────────────────────────────────────────
{
  const guard = createShortcutGuard(400);
  check("2: auto-repeat is rejected", guard.shouldHandle("toggle-interview", { repeat: true, now: 1000 }), false);
  check("2b: first press accepted", guard.shouldHandle("toggle-interview", { now: 2000 }), true);
  check("2c: immediately repeated press rejected", guard.shouldHandle("toggle-interview", { now: 2100 }), false);
  check("2d: press after cooldown accepted", guard.shouldHandle("toggle-interview", { now: 2600 }), true);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Stop shortcut stops interview
// ─────────────────────────────────────────────────────────────────────────────
{
  let stops = 0;
  registerInterviewControls({
    start: () => {},
    stop: () => stops++,
    isRecording: () => true,
    canStart: () => true,
  });
  const controls = getInterviewControls()!;
  check(
    "3: recording plans a stop",
    planInterviewToggle({ isRecording: controls.isRecording(), canStart: controls.canStart() }),
    "stop",
  );
  controls.stop();
  check("3b: stop invoked", stops, 1);
  registerInterviewControls(null);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Start/Stop shortcut toggles correctly
// ─────────────────────────────────────────────────────────────────────────────
check("4: idle → start", planInterviewToggle({ isRecording: false, canStart: true }), "start");
check("4b: recording → stop", planInterviewToggle({ isRecording: true, canStart: true }), "stop");
check("4c: no controls → defer", planInterviewToggle(null), "defer-start");
check("4d: not ready → defer", planInterviewToggle({ isRecording: false, canStart: false }), "defer-start");
{
  // Pending-start: the deferred press is remembered and consumed exactly once.
  consumePendingStart(); // clear any prior
  requestPendingStart();
  check("4e: pending start consumed", consumePendingStart(), true);
  check("4f: pending start cleared", consumePendingStart(), false);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5-8. Next Question semantics (source-level, because the logic owns React refs)
// ─────────────────────────────────────────────────────────────────────────────
const home = fs.readFileSync("src/pages/Home.tsx", "utf8");
const nextStart = home.indexOf("const nextQuestion = useCallback");
const nextEnd = home.indexOf("}, [", nextStart);
const nextBody = nextStart >= 0 && nextEnd > nextStart ? home.slice(nextStart, nextEnd) : "";

checkTrue("5: nextQuestion resets the transcript (reuses clearInterviewMessages)", nextBody.includes("clearInterviewMessages()"));
checkTrue("5b: nextQuestion resets the question banners", nextBody.includes("setDetectedQuestion(null)"));
checkTrue("6: nextQuestion does NOT call the AI", !nextBody.includes("runAIStream"));
checkTrue("7: nextQuestion does NOT stop interview", !nextBody.includes("stopInterview") && !nextBody.includes(".stop()"));
checkTrue("8: nextQuestion does NOT start capture", !nextBody.includes("startInterview") && !nextBody.includes(".start()"));
check(
  "8b: registry has Ctrl+N next-question",
  byId("next-question").accelerator,
  "CommandOrControl+N",
);

// ─────────────────────────────────────────────────────────────────────────────
// 9-11. Existing shortcuts unchanged
// ─────────────────────────────────────────────────────────────────────────────
const hotkeys = fs.readFileSync("electron/hotkeys.ts", "utf8");
checkTrue("9: Ctrl+Enter still Ask AI (solve)", hotkeys.includes('"CommandOrControl+Return"') && hotkeys.includes('"ghostly:solve"'));
checkTrue("10: Ctrl+H still Screenshot", hotkeys.includes('"CommandOrControl+H"') && hotkeys.includes("ghostly:screenshot"));
checkTrue("11: Ctrl+B still Show/Hide", hotkeys.includes('"CommandOrControl+B"'));
checkTrue("11b: Ctrl+I and Ctrl+N registered", hotkeys.includes('"CommandOrControl+I"') && hotkeys.includes('"CommandOrControl+N"'));
checkTrue(
  "11c: Home subscribes to both new channels",
  home.includes("onToggleInterview(") && home.includes("onNextQuestion("),
);
const preload = fs.readFileSync("electron/preload.ts", "utf8");
checkTrue(
  "11d: preload exposes both channels",
  preload.includes('"ghostly:toggle-interview"') && preload.includes('"ghostly:next-question"'),
);

// ─────────────────────────────────────────────────────────────────────────────
// 12. Typing inside a text input does not trigger a global shortcut
// ─────────────────────────────────────────────────────────────────────────────
checkTrue("12: textarea is editable", isEditableTarget({ tagName: "TEXTAREA" }));
checkTrue("12b: input is editable", isEditableTarget({ tagName: "INPUT" }));
checkTrue("12c: contenteditable is editable", isEditableTarget({ tagName: "DIV", isContentEditable: true }));
check("12d: plain element is not editable", isEditableTarget({ tagName: "DIV" }), false);
{
  const guard = createShortcutGuard(400);
  check(
    "12e: guard rejects a press while typing",
    guard.shouldHandle("next-question", { target: { tagName: "TEXTAREA" }, now: 5000 }),
    false,
  );
  check(
    "12f: same press outside an input is accepted",
    guard.shouldHandle("next-question", { target: { tagName: "BODY" }, now: 5100 }),
    true,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. Shortcut conflicts are detected
// ─────────────────────────────────────────────────────────────────────────────
check("13: no conflicts in the shipped registry", findShortcutConflicts(INTERVIEW_SHORTCUTS), []);
{
  const conflicting: ShortcutDefinition[] = [
    { id: "toggle-interview", label: "a", accelerator: "CommandOrControl+K", keys: ["Ctrl", "K"] },
    { id: "next-question", label: "b", accelerator: "commandorcontrol+k", keys: ["Ctrl", "K"] },
  ];
  const conflicts = findShortcutConflicts(conflicting);
  check("13b: a shared key is detected", conflicts.length, 1);
  checkTrue("13c: conflict names both actions", conflicts[0].ids.includes("toggle-interview") && conflicts[0].ids.includes("next-question"));
}
check("13d: accelerator normalization", normalizeAccelerator(" CommandOrControl+K "), "commandorcontrol+k");

// ─────────────────────────────────────────────────────────────────────────────
// 14. Listener registration is mounted/unmounted cleanly
// ─────────────────────────────────────────────────────────────────────────────
{
  registerInterviewControls(null);
  check("14: starts unregistered", getInterviewControls(), null);
  registerInterviewControls({ start: () => {}, stop: () => {}, isRecording: () => false, canStart: () => false });
  checkTrue("14b: registers controls", getInterviewControls() !== null);
  registerInterviewControls(null);
  check("14c: unmount clears controls", getInterviewControls(), null);
}
// The Home listener effect must tear down everything it subscribes to.
const effectReturn = home.slice(home.indexOf("const offToggleInterview"), home.indexOf("}, [", home.indexOf("const offToggleInterview")));
checkTrue("14d: toggle listener removed on cleanup", effectReturn.includes("offToggleInterview()"));
checkTrue("14e: next-question listener removed on cleanup", effectReturn.includes("offNextQuestion()"));
const hookSrc = fs.readFileSync("src/hooks/useInterviewAudio.ts", "utf8");
checkTrue(
  "14f: capture hook unregisters the bridge on unmount",
  /registerInterviewControls\(\{[\s\S]*?\}\);[\s\S]*?return \(\) => registerInterviewControls\(null\)/.test(hookSrc),
);

// ─────────────────────────────────────────────────────────────────────────────
// 15. No duplicate keyboard listeners after restarting the interview
// ─────────────────────────────────────────────────────────────────────────────
check(
  "15: Home subscribes to the toggle channel exactly once",
  (home.match(/onToggleInterview\(/g) ?? []).length,
  1,
);
check(
  "15b: Home subscribes to the next-question channel exactly once",
  (home.match(/onNextQuestion\(/g) ?? []).length,
  1,
);
checkTrue(
  "15c: bridge registration effect runs once (empty deps)",
  /registerInterviewControls\(\{[\s\S]*?\}, \[\]\);/.test(hookSrc),
);

// ─────────────────────────────────────────────────────────────────────────────
// 16. Capture Screen — ONE visible action, ONE documented shortcut, one path
// ─────────────────────────────────────────────────────────────────────────────
const topBar = fs.readFileSync("src/components/TopBar.tsx", "utf8");
const settings = fs.readFileSync("src/components/SettingsPanel.tsx", "utf8");

checkTrue(
  "16: Ctrl+Shift+S is registered as a global accelerator",
  hotkeys.includes('"CommandOrControl+Shift+S"'),
);
checkTrue(
  "16b: it forwards an EVENT to the renderer — no capture logic in main",
  hotkeys.includes('win.webContents.send("ghostly:capture-screen")') &&
    /Capture Screen registered: Ctrl\+Shift\+S/.test(hotkeys),
);
checkTrue(
  "16c: preload exposes the channel, and Home runs the SAME callback the button runs",
  preload.includes('"ghostly:capture-screen"') &&
    /window\.ghostly\.onCaptureScreen\(/.test(home) &&
    /onCaptureScreen=\{captureScreen\}/.test(topBar + home),
);
check(
  "16d: exactly ONE capture action is wired in the TopBar",
  (topBar.match(/onCaptureScreen\(\)/g) ?? []).length,
  1,
);
checkTrue(
  "16e: the old Capture hotkey hint is gone from the overlay",
  !/label="Capture"/.test(topBar) && !/\["Ctrl", "H"\]/.test(topBar),
);
checkTrue(
  "16f: Settings documents Capture Screen = Ctrl+Shift+S",
  /\{ label: "Capture Screen", keys: \["Ctrl", "Shift", "S"\] \}/.test(settings),
);
checkTrue(
  "16g: Settings no longer advertises the old Ctrl+H Screenshot entry",
  !/label: "Screenshot"/.test(settings) && !/\["Ctrl", "H"\]/.test(settings),
);

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
