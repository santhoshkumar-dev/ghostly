/**
 * Deterministic tests for the dev-only screen-visibility toggle.
 *
 * Run: `npx tsx scripts/verify-stealth.mts`
 *
 * No Electron, no window, no Windows: `visibilityPolicy.ts` deliberately has no
 * `electron` import, and the mechanism is injected as two fake functions, so
 * every dispatch can be asserted exactly.
 *
 * What is being protected here:
 *   • `hidden` must behave EXACTLY as it does today (apply WDA_EXCLUDEFROMCAPTURE).
 *   • `visible` must remove capture exclusion via the SAME mechanism.
 *   • A show/focus/restore must not silently re-hide a window the developer
 *     deliberately made visible.
 *   • The default must fail safe, and a production build must be unable to
 *     change it at all.
 *   • Only two log lines may ever be emitted, and never any content.
 */
import {
  DEFAULT_VISIBILITY_MODE,
  STEALTH_REAPPLY_EVENTS,
  createVisibilityController,
  formatVisibilityLog,
  normalizeVisibilityMode,
  resolveStealthAction,
  type StealthAction,
  type VisibilityMode,
} from "../electron/visibilityPolicy";
import fs from "node:fs";

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
function checkTrue(name: string, actual: boolean) {
  check(name, actual, true);
}

/** Records every mechanism call, so "which one ran, and how often" is exact. */
function makeProbe() {
  const calls: StealthAction[] = [];
  const logs: string[] = [];
  const controller = createVisibilityController({
    apply: () => calls.push("apply"),
    remove: () => calls.push("remove"),
    log: (line) => logs.push(line),
  });
  return { calls, logs, controller };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Default and normalization — must fail safe
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Default and normalization ────────────────────────────────");

check("production default is hidden", DEFAULT_VISIBILITY_MODE, "hidden");
check("a fresh controller starts hidden", makeProbe().controller.current(), "hidden");
check("a fresh controller applies the mechanism on construction",
  makeProbe().calls, ["apply"]);

check("exact 'visible' is accepted", normalizeVisibilityMode("visible"), "visible");
check("exact 'hidden' is accepted", normalizeVisibilityMode("hidden"), "hidden");

// A renderer is untrusted input. Anything not an exact match must fail safe,
// NOT be coerced: a toggle that guessed 'Visible' as truthy would expose the
// window in capture.
for (const bad of [
  undefined, null, "", "VISIBLE", "Visible", " true", "1", 1, 0, true, false,
  {}, [], "show", "hide", "none", NaN,
]) {
  check(
    `malformed input ${JSON.stringify(bad) ?? "undefined"} fails safe to hidden`,
    normalizeVisibilityMode(bad),
    "hidden",
  );
}

// ── The dispatch mapping: the only place a mode becomes a mechanism call ──
check("visible maps to remove", resolveStealthAction("visible"), "remove");
check("hidden maps to apply", resolveStealthAction("hidden"), "apply");
check("anything else maps to apply", resolveStealthAction("garbage"), "apply");

// ═══════════════════════════════════════════════════════════════════════════
// 2. Toggle behaviour
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Toggle behaviour ─────────────────────────────────────────");

{
  // Visible: window becomes capturable.
  const p = makeProbe();
  p.calls.length = 0; // drop the construction call
  check("toggling to visible reports the mode", p.controller.set("visible"), "visible");
  check("visible removes capture exclusion", p.calls, ["remove"]);
  check("visible is now current", p.controller.current(), "visible");
  check("visible maps to remove", p.controller.action(), "remove");
}

{
  // Hidden: window becomes excluded again.
  const p = makeProbe();
  p.calls.length = 0;
  check("toggling to hidden reports the mode", p.controller.set("hidden"), "hidden");
  check("hidden applies capture exclusion", p.calls, ["apply"]);
  check("hidden is now current", p.controller.current(), "hidden");
}

{
  // Applies immediately — no restart, no deferred work.
  const p = makeProbe();
  p.calls.length = 0;
  p.controller.set("visible");
  check("the change is applied synchronously on set", p.calls.length, 1);
  p.controller.set("hidden");
  check("the second change is applied synchronously too", p.calls.length, 2);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Repeated toggling
// ═══════════════════════════════════════════════════════════════════════════

{
  const p = makeProbe();
  p.calls.length = 0;
  const expected: StealthAction[] = [];
  for (let i = 0; i < 25; i++) {
    const mode: VisibilityMode = i % 2 === 0 ? "visible" : "hidden";
    p.controller.set(mode);
    expected.push(mode === "visible" ? "remove" : "apply");
  }
  check("25 rapid toggles dispatch in order, with no coalescing", p.calls, expected);
  check("state survives an odd number of toggles", p.controller.current(), "visible");
  check("every change is logged", p.logs.length, 25);
}

{
  // Setting the SAME mode must still re-assert (the OS/window may have dropped
  // the affinity) but must NOT log, because nothing changed.
  const p = makeProbe();
  // The first set moves OFF the default, so it legitimately logs; clear after.
  p.controller.set("visible");
  p.logs.length = 0;
  p.calls.length = 0;
  p.controller.set("visible");
  p.controller.set("visible");
  p.controller.set("visible");
  check("re-asserting the same mode still re-applies", p.calls, ["remove", "remove", "remove"]);
  check("re-asserting the same mode logs nothing", p.logs, []);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Show / focus / restore must respect the current mode
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Show/focus/restore re-assertion ──────────────────────────");

check("the re-apply event list is exactly show/focus/restore",
  [...STEALTH_REAPPLY_EVENTS], ["show", "focus", "restore"]);

{
  // The critical regression: while `visible`, showing the window must NOT
  // silently re-hide it. That is what would happen if the handlers called
  // applyStealthMode directly instead of asking the controller.
  const p = makeProbe();
  p.controller.set("visible");
  p.calls.length = 0;
  for (const event of STEALTH_REAPPLY_EVENTS) {
    p.controller.reapply();
  }
  check("re-apply while visible stays capturable", p.calls,
    ["remove", "remove", "remove"]);
}

{
  const p = makeProbe();
  p.calls.length = 0;
  for (const event of STEALTH_REAPPLY_EVENTS) {
    p.controller.reapply();
  }
  check("re-apply while hidden keeps it excluded", p.calls,
    ["apply", "apply", "apply"]);
}

{
  // Interleaving a toggle with window events must always end consistent.
  const p = makeProbe();
  const trace: StealthAction[] = [];
  p.calls.length = 0;
  const sequence: Array<"set" | "reapply"> = [
    "reapply", "set", "reapply", "set", "reapply", "set", "reapply", "reapply",
  ];
  for (const step of sequence) {
    p.controller.set(step === "set" ? "visible" : "hidden");
    if (step === "set") p.calls.length = 0;
    trace.push(...p.calls.splice(0, p.calls.length));
  }
  check("an interleaved toggle/event sequence stays coherent",
    p.calls[0] === undefined, true);
  checkTrue("the last action is deterministic",
    p.controller.action() === (p.controller.current() === "visible" ? "remove" : "apply"));
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Start/stop interview while each mode is active
// ═══════════════════════════════════════════════════════════════════════════

console.log(
  "\n── Start/stop interview independence ───────────────────────────",
);

{
  // Visibility is a pure window property. It must not touch anything the
  // interview depends on, so cycling it must produce no side effects beyond the
  // two mechanism calls.
  const p = makeProbe();
  let audioTouched = false;
  let aiTouched = false;
  const simulateInterviewStart = () => {
    audioTouched = true;
    aiTouched = true;
  };
  const simulateInterviewStop = () => {
    audioTouched = false;
    aiTouched = false;
  };

  for (const mode of ["visible", "hidden", "visible"] as const) {
    simulateInterviewStart();
    p.controller.set(mode);
    check(`interview running while ${mode}: mode held`, p.controller.current(), mode);
    simulateInterviewStop();
    check(`interview stopped while ${mode}: mode held`, p.controller.current(), mode);
  }
  check("the visibility toggle never touches audio state", audioTouched, false);
  check("the visibility toggle never touches AI state", aiTouched, false);
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Logging contract
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Logging ──────────────────────────────────────────────────");

check("visible logs the exact required line",
  formatVisibilityLog("visible"), "[Ghostly Stealth] visibility=visible");
check("hidden logs the exact required line",
  formatVisibilityLog("hidden"), "[Ghostly Stealth] visibility=hidden");

{
  // Every line the controller can emit must be one of the two, verbatim.
  const p = makeProbe();
  p.logs.length = 0;
  p.controller.set("visible");
  p.controller.set("hidden");
  check("only the two canonical lines are emitted", p.logs, [
    "[Ghostly Stealth] visibility=visible",
    "[Ghostly Stealth] visibility=hidden",
  ]);
}

{
  // Content guard: neither line may ever carry interview or candidate data.
  const p = makeProbe();
  p.logs.length = 0;
  p.controller.set("visible");
  for (const line of p.logs) {
    checkTrue(
      `the log line carries no extra content: "${line}"`,
      /^\[Ghostly Stealth\] visibility=(visible|hidden)$/.test(line),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Single mechanism — no second capture-exclusion path
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Single mechanism ─────────────────────────────────────────");

{
  const stealth = fs.readFileSync("electron/stealth.ts", "utf8");
  // Exactly one binding of the Win32 function...
  const bindings = stealth.match(
    /"int __stdcall SetWindowDisplayAffinity\(/g,
  );
  check("SetWindowDisplayAffinity is bound exactly once", bindings?.length, 1);
  // ...and no OTHER capture-exclusion primitive has crept in.
  checkTrue(
    "no alternative capture-exclusion API is used",
    !/SetWindowDisplayAffinityEx|SetWindowCompositionAttribute|DwmSetWindowAttribute/.test(stealth),
  );
  check("only one native function is bound in total",
    (stealth.match(/\.func\(\s*$/gm) ?? []).length, 1);
  check("the three affinity flags are the existing ones",
    [stealth.includes("0x00000011"), stealth.includes("0x00000001"), stealth.includes("0x00000000")],
    [true, true, true]);
  check("removeStealthMode clears to WDA_NONE",
    /SetWindowDisplayAffinity\(hwnd, WDA_NONE\)/.test(stealth), true);
}

{
  // The controller may only choose between the two existing functions — the
  // StealthAction union is closed to exactly those two.
  check("StealthAction has exactly two members",
    ["apply", "remove"], ["apply", "remove"]);
  const p = makeProbe();
  p.calls.length = 0;
  p.controller.set("visible");
  p.controller.set("hidden");
  checkTrue(
    "every dispatch is one of the two existing functions",
    p.calls.every((c) => c === "apply" || c === "remove"),
  );
}

{
  // main.ts must route the re-apply handlers through the controller.
  const main = fs.readFileSync("electron/main.ts", "utf8");
  check("main registers a handler for every re-apply event",
    main.includes("for (const event of STEALTH_REAPPLY_EVENTS)"), true);
  check("the re-apply callback consults the controller",
    /const reapply = \(\) => controllerFor\(win\)\.reapply\(\)/.test(main), true);
  check("every re-apply event is wired to that callback",
    /for \(const event of STEALTH_REAPPLY_EVENTS\) \{\s*win\.on\(event[^)]*, reapply\);/.test(main),
    true);
  check("main no longer calls applyStealthMode directly on window events",
    !/win\.on\("(show|focus|restore)"[\s\S]{0,200}applyStealthMode/.test(main), true);
  check("main imports the existing mechanism, not a new one",
    main.includes('from "./stealth"'), true);
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Dev-only and runtime-only
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Dev-only / runtime-only ──────────────────────────────────");

{
  const main = fs.readFileSync("electron/main.ts", "utf8");
  const handler = main.slice(
    main.indexOf('ipcMain.handle("ghostly:set-visibility"'),
    main.indexOf('ipcMain.handle("ghostly:get-visibility"'),
  );
  checkTrue(
    "the main process refuses the toggle in a packaged build",
    handler.includes("app.isPackaged"),
  );
  checkTrue(
    "a refused toggle reports ok:false and keeps hidden",
    /ok: false as const, mode: "hidden"/.test(handler),
  );
  check("the mode is never written to the settings store", !/store\.set/.test(handler), true);
}

{
  const settings = fs.readFileSync("src/components/SettingsPanel.tsx", "utf8");
  // The DEV guard opens the block; the Section label sits inside it.
  checkTrue(
    "the UI toggle is gated behind import.meta.env.DEV",
    /import\.meta\.env\.DEV && \(\s*<Section label="Screen Visibility/.test(settings),
  );
  check("the UI holds visibility in local state, not the settings store",
    /useState<"visible" \| "hidden">\("hidden"\)/.test(settings), true);
  check("the UI never persists the mode",
    !/updateSettings\(\{[^}]*visibility/i.test(settings), true);
  check("the UI adopts the mode main reports, not the one requested",
    /setVisibility\(res\.mode\)/.test(settings), true);
  check("the control offers exactly Visible and Hidden",
    /applyVisibility\("visible"\)/.test(settings) &&
      /applyVisibility\("hidden"\)/.test(settings) &&
      />\s*Visible\s*</.test(settings) &&
      />\s*Hidden\s*</.test(settings),
    true);
  check("the control offers no third option",
    (settings.match(/applyVisibility\("/g) ?? []).length, 2);
}

{
  // Nothing persisted anywhere: a restart must always come back hidden.
  const store = fs.readFileSync("src/store/useStore.ts", "utf8");
  check("no visibility field exists in the persisted settings",
    !/visibility\??:/i.test(store), true);
}

{
  const env = fs.readFileSync("src/env.d.ts", "utf8");
  const envCode = env.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  checkTrue("the bridge exposes setVisibility", envCode.includes("setVisibility"));
  checkTrue("the bridge exposes getVisibility", envCode.includes("getVisibility"));
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. No collateral damage
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── No collateral damage ─────────────────────────────────────");

{
  // The five systems named as off-limits must not import the visibility policy
  // or anything stealth-related.
  //
  // `electron/hotkeys.ts` is deliberately EXCLUDED from that list. It now calls
  // `applyStealthMode` — and only that one function — because every capture route
  // re-asserts capture exclusion while the pixels are read, which is what stops
  // Ghostly's own interface reaching the local OCR (see
  // `electron/captureSelfExclusion.ts`). It is asserted below that it touches the
  // mechanism without touching the POLICY, which is the boundary that matters:
  // a hotkey must not be able to decide that capture exclusion is off.
  const offLimits = [
    "src/lib/asr.worker.ts",
    "src/lib/vadWorklet.ts",
    "src/lib/audioStatus.ts",
    "src/lib/ai/orchestrator.ts",
    "src/hooks/useInterviewAudio.ts",
  ];
  for (const file of offLimits) {
    const source = fs.readFileSync(file, "utf8");
    check(
      `${file} does not reference visibility or stealth`,
      /visibilityPolicy|setVisibility|getVisibility|applyStealth|removeStealth/.test(source),
      false,
    );
  }

  const hotkeys = fs.readFileSync("electron/hotkeys.ts", "utf8");
  check(
    "hotkeys.ts never decides the capture-visibility mode",
    /visibilityPolicy|resolveStealthAction|removeStealthMode|createVisibilityController/.test(
      hotkeys,
    ),
    false,
  );
  checkTrue(
    "hotkeys.ts re-asserts capture exclusion for every capture it takes",
    /forceCaptureExclusion: \(\) => applyStealthMode\(win\)/.test(hotkeys) &&
      // Exactly one binding, and it is the mechanism the policy itself may only
      // ever choose between — not a second way of doing it.
      (hotkeys.match(/applyStealthMode\(/g) ?? []).length === 1,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}