/**
 * Regression harness for Ghostly's OWN window opacity.
 *
 * Run: `npx tsx scripts/verify-overlay-opacity.mts`
 *
 * ── What is under test, and why it needs a real Electron run ────────────────
 * The requirement is that the interview app stays VISIBLE behind Ghostly while
 * the answer text stays READABLE. Those two pull in opposite directions, and
 * whether they are actually satisfied is a question about the compositor, not
 * about a pure function — so Part A boots the REAL application, drives the REAL
 * slider, and reads back both the value the main process applied and the value
 * the renderer is actually painting with.
 *
 * ── The mechanism, and the one place this differs from the obvious one ─────
 * `BrowserWindow.setOpacity(userValue)` is the obvious implementation and it is
 * WRONG here: it is a single scalar over the whole composited window, so it
 * dims text exactly as hard as it dims the panel behind it. At 20% the answer
 * would be 20% white. Instead the alpha multiplies only Ghostly's own surfaces
 * (via `--ghostly-alpha`) and text is left at full strength, while
 * `setOpacity` keeps its original, unrelated job: 0 = hidden, 1 = shown.
 * Part A asserts that separation rather than assuming it.
 *
 * Part B is the pure policy (range, clamping, persistence, restore) with no
 * Electron at all. Part C asserts the wiring Electron cannot drive from here.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  createOverlayOpacityController,
  normalizeOverlayOpacity,
  opacityFromSliderValue,
  opacityToPercent,
  opacityToSliderValue,
  DEFAULT_OVERLAY_OPACITY,
  MAX_OVERLAY_OPACITY,
  MIN_OVERLAY_OPACITY,
  formatOpacityLog,
} from "../electron/overlayOpacity";

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
// This file is ESM (`.mts`), so there is no bare `require`. `verify-region-picker.ts`
// is CommonJS and can use one; this cannot.
const nodeRequire = createRequire(import.meta.url);
const read = (p: string): string => readFileSync(path.join(root, p), "utf8");

/**
 * Source with comments removed.
 *
 * Several checks below assert that a call does NOT appear in a file. Running
 * that against raw source produces false passes as soon as the pattern is
 * mentioned in a comment explaining why it was removed — which is exactly what
 * happened to `win.getOpacity()` in `hotkeys.ts`. Stripping comments first makes
 * "this code does not call X" mean what it says.
 */
const code = (p: string): string =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

// ═══════════════════════════════════════════════════════════════════════════
// Part B — the pure policy. Runs first so a policy regression is reported
// even when the GUI run below cannot start on this machine.
// ═══════════════════════════════════════════════════════════════════════════

check("B1 the default is 85%", DEFAULT_OVERLAY_OPACITY, 0.85);
check("B2 the range is 20% to 100%", [MIN_OVERLAY_OPACITY, MAX_OVERLAY_OPACITY], [0.2, 1]);

// The four values the requirement asks to be exercised.
for (const pct of [20, 50, 85, 100]) {
  check(`B3 ${pct}% normalizes to itself`, normalizeOverlayOpacity(pct / 100), pct / 100);
}

// Clamping, and the deliberate choice that garbage becomes the DEFAULT rather
// than the minimum — a corrupt persisted value must not make Ghostly invisible.
check("B4 below the floor clamps to the minimum", normalizeOverlayOpacity(0.05), 0.2);
check("B5 zero clamps to the minimum, not to hidden", normalizeOverlayOpacity(0), 0.2);
check("B6 above the ceiling clamps to the ceiling", normalizeOverlayOpacity(4), 1);
check("B7 a fractional string is accepted", normalizeOverlayOpacity("0.5"), 0.5);
check("B8 NaN falls back to the default", normalizeOverlayOpacity(Number.NaN), 0.85);
check("B9 undefined falls back to the default", normalizeOverlayOpacity(undefined), 0.85);
// `Number(null)` and `Number("")` are both 0, so without an explicit guard a
// missing persisted value would resolve to the MINIMUM and make Ghostly nearly
// invisible on every launch.
check("B10 null falls back to the default, not the minimum", normalizeOverlayOpacity(null), 0.85);
check("B10b an empty string falls back to the default", normalizeOverlayOpacity(""), 0.85);
check("B11 an object falls back to the default", normalizeOverlayOpacity({}), 0.85);

// Percent round trip.
for (const pct of [20, 50, 85, 100]) {
  check(`B12 ${pct}% survives the slider round trip`, opacityToSliderValue(pct / 100), String(pct));
  check(`B13 slider value "${pct}" parses back`, opacityFromSliderValue(String(pct)), pct / 100);
  check(`B14 ${pct}% reports as ${pct}`, opacityToPercent(pct / 100), pct);
}
check("B15 a bare 1 is read as a fraction, not 1%", opacityFromSliderValue(1), 1);
check("B16 a bare 100 is read as a percent", opacityFromSliderValue(100), 1);
// The regression that made this channel dangerous: the renderer sends percent,
// the controller stores a fraction. Feeding 50 to the fraction normalizer clamps
// it to 1, i.e. dragging the slider to the middle would set fully opaque.
check(
  "B16b a bare 50 percent is NOT read as a fraction",
  normalizeOverlayOpacity(50),
  1,
);
check("B16c the slider parser reads 50 as 50%", opacityFromSliderValue(50), 0.5);
check("B16d the slider parser reads 20 as 20%", opacityFromSliderValue(20), 0.2);
check("B16e the slider parser reads '85' as 85%", opacityFromSliderValue("85"), 0.85);

// The controller: hide/show must be INDEPENDENT of the chosen alpha. This is
// the exact regression that made the feature impossible before — `setOpacity(0)`
// used to mean "hidden", so any transparency control collided with Ctrl+B.
{
  const applied: number[] = [];
  const persisted: number[] = [];
  const logged: string[] = [];
  const c = createOverlayOpacityController({
    setWindowOpacity: (n) => applied.push(n),
    setChromeAlpha: (a) => void a,
    persist: (a) => persisted.push(a),
    log: (l) => logged.push(l),
  });

  check("B17 the window starts opaque and visible", [c.windowOpacity(), c.isVisible()], [1, true]);
  check("B18 the default chrome alpha is 85%", c.chromeAlpha(), 0.85);

  check("B19 setting 50% returns 50%", c.setOpacity(0.5), 0.5);
  check("B20 the WINDOW opacity is unaffected by the alpha", c.windowOpacity(), 1);
  check("B21 the chrome alpha followed", c.chromeAlpha(), 0.5);
  check("B22 it persisted", persisted.at(-1), 0.5);

  check("B23 every window opacity applied so far was 0 or 1", [...new Set(applied)].sort(), [1]);

  c.setHidden(true);
  check("B24 hidden means window opacity 0", c.windowOpacity(), 0);
  check("B25 hidden is not 'visible'", c.isVisible(), false);
  check("B26 hidden PRESERVES the chosen alpha", c.chromeAlpha(), 0.5);

  c.setOpacity(0.2);
  check("B27 setting the alpha while hidden does not unhide", c.isVisible(), false);
  check("B28 the new alpha was still recorded", c.chromeAlpha(), 0.2);

  c.setHidden(false);
  check("B29 showing restores the CHOSEN alpha, not 100%", c.chromeAlpha(), 0.2);
  check("B30 and the window is opaque again", c.windowOpacity(), 1);

  c.toggleHidden();
  check("B31 toggle hides", c.isVisible(), false);
  c.toggleHidden();
  check("B32 toggle shows", c.isVisible(), true);

  // `reapply` must not log: a focus storm would otherwise spam the log.
  const before = logged.length;
  c.reapply();
  check("B33 reapply is silent", logged.length, before);
  check("B34 reapply re-asserts the same value", applied.at(-1), 1);
}

// Restore-after-restart: a fresh controller fed the persisted value must land on
// exactly the same alpha. This is literally what main.ts does at boot.
{
  const persistedValue: number[] = [];
  const first = createOverlayOpacityController({
    setWindowOpacity: () => {},
    persist: (a) => persistedValue.push(a),
  });
  first.setOpacity(0.5);
  const saved = persistedValue.at(-1);

  const afterRestart = createOverlayOpacityController({
    setWindowOpacity: () => {},
    initial: saved,
  });
  check("B35 the chosen value survives a restart", afterRestart.chromeAlpha(), 0.5);
}

// A store written before this feature existed has no key at all.
{
  const legacy = createOverlayOpacityController({
    setWindowOpacity: () => {},
    initial: undefined,
  });
  check("B36 a store with no opacity key starts at the default", legacy.chromeAlpha(), 0.85);
}

check(
  "B37 the log line carries only a percentage",
  formatOpacityLog(0.85, false),
  "[Ghostly] overlay opacity=85%",
);
checkTrue(
  "B38 the log line can never contain a key or a transcript",
  !/key|token|api/i.test(formatOpacityLog(0.2, false)),
);

// ═══════════════════════════════════════════════════════════════════════════
// Part A — the real application, driven through the real slider.
// ═══════════════════════════════════════════════════════════════════════════

const tmpDir = path.join(root, ".verify-overlay-opacity");
const driverCjs = path.join(tmpDir, "driver.cjs");

/**
 * Plain CommonJS on purpose: it `require`s the BUILT main bundle, which is
 * CommonJS, and importing a TypeScript module here would need a bundler step
 * that cannot resolve an Electron `require` at build time anyway.
 */
const DRIVER = `
const path = require("path");
const fs = require("fs");
const os = require("os");
const { app, BrowserWindow } = require("electron");

// Hermetic store: point userData at a temp dir BEFORE anything constructs an
// electron-store, so this run can never read or write the real user's settings.
const userData = process.env.GHOSTLY_E2E_USERDATA;
app.setPath("userData", userData);
app.setPath("sessionData", userData);

// Boot the REAL application.
require(process.env.GHOSTLY_E2E_MAIN);

function emit(payload, code) {
  console.log("RESULT:" + JSON.stringify(payload));
  app.exit(code);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reads everything the requirement asks about in ONE executeJavaScript, because
// the renderer's state is only internally consistent at a single instant.
//
// Returns a JSON STRING, not an object. executeJavaScript ships its result
// back over IPC, which uses the structured clone algorithm; anything it cannot
// clone fails the whole call with a bare "An object could not be cloned" and no
// indication of which property was at fault. Serializing in the page removes
// that entire failure mode.
const PROBE = "(function(){" +
  "var slider=document.querySelector('[data-ghostly=\\\\'opacity-slider\\\\']');" +
  "var readout=document.querySelector('[data-ghostly=\\\\'opacity-value\\\\']');" +
  "var root=getComputedStyle(document.documentElement);" +
  "if(!slider){return JSON.stringify({found:false});}" +
  "var r=slider.getBoundingClientRect();" +
  // elementFromPoint is the honest test of "the control is still clickable":
  // it answers whether the compositor would route a real click to the slider.
  "var hit=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);" +
  "var ctl=slider.closest('div');" +
  "return JSON.stringify({" +
  "found:true," +
  "sliderValue:slider.value," +
  "min:slider.min, max:slider.max, step:slider.step," +
  "readout:readout?readout.textContent:null," +
  "alphaVar:root.getPropertyValue('--ghostly-alpha').trim()," +
  "hitIsSlider:hit===slider||(hit&&slider.contains(hit))," +
  "hitTag:hit?hit.tagName:null," +
  "pointerEvents:getComputedStyle(slider).pointerEvents," +
  "ctlBg:getComputedStyle(ctl).backgroundColor," +
  "ctlPointerEvents:getComputedStyle(ctl).pointerEvents," +
  "appRegion:ctl.style.webkitAppRegion||getComputedStyle(ctl).webkitAppRegion," +
  "});})()";

/**
 * Installed once into the page. Sets the slider the way a real drag does:
 * through the native value setter, then input + change.
 *
 * The native setter is the important part — React tracks the last value it
 * wrote, and a plain slider.value assignment is swallowed because the tracker
 * thinks nothing changed. Without this the slider would appear dead and the test
 * would be measuring the test, not the app.
 */
const INSTALL_SETTER =
  "(function(){" +
  "window.__gsSet=function(v){" +
  "var s=document.querySelector('[data-ghostly=\\\\'opacity-slider\\\\']');" +
  "if(!s) return false;" +
  "s.focus();" +
  "var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;" +
  "setter.call(s, String(v));" +
  "s.dispatchEvent(new Event('input',{bubbles:true}));" +
  "s.dispatchEvent(new Event('change',{bubbles:true}));" +
  "return true;};" +
  // Must evaluate to a boolean, not to the assigned function: the completion
  // value of a bare assignment IS the function, and executeJavaScript ships its
  // result over IPC, where a function cannot be cloned.
  "return typeof window.__gsSet === 'function';" +
  "})()";

async function probe(win) {
  const raw = await win.webContents.executeJavaScript(PROBE);
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/**
 * Poll for a page predicate instead of racing a load event.
 *
 * did-finish-load cannot be used here: between isLoading() returning true
 * and once("did-finish-load") being registered, the load can complete, and
 * the await then never resolves. Polling the DOM for the element the test
 * actually needs has no such window and doubles as proof the React tree
 * mounted — which is the precondition for every other check here.
 */
async function waitForPage(win, expr, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await win.webContents.executeJavaScript("String(!!(" + expr + "))");
      if (last === "true") return true;
    } catch (e) {
      last = "ERR:" + e;
    }
    await sleep(150);
  }
  return false;
}

app.whenReady().then(async () => {
  const out = { steps: [] };
  try {
    let win = null;
    for (let i = 0; i < 150 && !win; i++) {
      win = BrowserWindow.getAllWindows()[0] || null;
      if (!win) await sleep(100);
    }
    if (!win) { emit({ error: "the app created no window" }, 1); return; }

    out.url = win.webContents.getURL();
    const mounted = await waitForPage(win, "document.querySelector('#root')", 30000);
    const hasControl = await waitForPage(
      win,
      "document.querySelector('[data-ghostly=\\\\'opacity-slider\\\\']')",
      30000
    );
    out.reactMounted = mounted;
    out.controlPresent = hasControl;
    out.rootHtml = await win.webContents
      .executeJavaScript("(document.getElementById('root')||{}).childElementCount ?? -1")
      .catch(() => "ERR");
    if (!hasControl) {
      out.bodyText = await win.webContents
        .executeJavaScript("(document.body||{}).innerText?.slice(0,400) ?? '(no body)'")
        .catch((e) => "ERR:" + e);
      emit(out, 1);
      return;
    }
    await win.webContents.executeJavaScript(INSTALL_SETTER);

    const Store = require(path.join(process.env.GHOSTLY_E2E_ROOT, "node_modules", "electron-store"));
    const store = new Store({ name: "ghostly-data", encryptionKey: "ghostly-secure-key-v1" });
    const persistedNow = () => {
      try { return (store.get("settings") || {}).overlayOpacity; } catch (e) { return "ERR:" + e; }
    };

    out.persistedAtStart = persistedNow();
    out.storeFileExists = fs.existsSync(path.join(userData, "ghostly-data.json"));
    out.initial = await probe(win);
    out.windowOpacityAtStart = win.getOpacity();

    for (const pct of [20, 50, 100, 85]) {
      const set = await win.webContents.executeJavaScript("window.__gsSet(" + pct + ")");
      await sleep(450);
      out.steps.push({
        requested: pct,
        setAccepted: set,
        probe: await probe(win),
        persisted: persistedNow(),
        windowOpacity: win.getOpacity(),
      });
    }

    // Hiding must not disturb the chosen alpha; showing must restore it.
    //
    // Driven THROUGH the renderer (window.ghostly.hide()) rather than with a
    // main-process webContents.send. The hide channel is a renderer -> main
    // channel, so sending it from main would test nothing at all — and going
    // through the preload bridge additionally covers the channel name, the
    // contextBridge exposure and the controller, which is the path a user's
    // Ctrl+B actually takes.
    await win.webContents.executeJavaScript("window.ghostly.hide(), true");
    await sleep(500);
    out.hiddenWindowOpacity = win.getOpacity();
    await win.webContents.executeJavaScript("window.ghostly.show(), true");
    await sleep(500);
    out.shownWindowOpacity = win.getOpacity();
    out.afterShowAlpha = (await probe(win)).alphaVar;

    out.finalPersisted = persistedNow();
    emit(out, 0);
  } catch (err) {
    emit({ ...out, error: String((err && err.stack) || err) }, 1);
  }
});

setTimeout(() => emit({ error: "driver timed out" }, 1), 150000);
`;

let e2e: Record<string, any> | null = null;
try {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(driverCjs, DRIVER, "utf8");

  const electronPath = nodeRequire("electron") as unknown as string;
  const userData = path.join(tmpDir, "userdata");
  mkdirSync(userData, { recursive: true });

  let output = "";
  try {
    output = execFileSync(electronPath, [driverCjs], {
      encoding: "utf8",
      timeout: 180_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GHOSTLY_E2E_USERDATA: userData,
        GHOSTLY_E2E_MAIN: path.join(root, "out", "main", "index.js"),
        GHOSTLY_E2E_ROOT: root,
        // Must be unset: the app would otherwise try to load a dev-server URL.
        ELECTRON_RENDERER_URL: "",
      },
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    output = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
  }
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.includes("RESULT:"));
  if (!line) {
    console.log("\n--- electron driver output ---");
    console.log(output.split(/\r?\n/).slice(-45).join("\n"));
    console.log("--- end driver output ---\n");
  }
  checkTrue("A0 the real app booted and answered", Boolean(line));
  if (line) {
    e2e = JSON.parse(line.slice(line.indexOf("RESULT:") + "RESULT:".length));
  }
} catch (err) {
  failures.push(`  A0 the Electron run could not start: ${String(err)}`);
} finally {
  if (!process.env.KEEP_DRIVER) rmSync(tmpDir, { recursive: true, force: true });
}

if (e2e) {
  const initial = (e2e.initial ?? {}) as Record<string, any>;
  if (e2e.error || !initial.found) {
    console.log("\n--- raw driver result ---");
    console.log(JSON.stringify(e2e, null, 2).slice(0, 4000));
    console.log("--- end raw result ---\n");
  }
  checkTrue("A1 the opacity control is rendered in the running app", initial.found === true);
  check("A2 the slider defaults to 85%", initial.sliderValue, "85");
  check("A3 the slider spans 20% to 100%", [initial.min, initial.max], ["20", "100"]);
  check("A4 the current percentage is displayed", initial.readout, "85%");
  check("A5 the default alpha reaches the renderer", initial.alphaVar, "0.85");
  checkTrue(
    "A6 the control is hit-testable (a real click would land on it)",
    initial.hitIsSlider === true,
  );
  check("A7 the control is not pointer-events:none", initial.pointerEvents, "auto");
  check("A8 the control opts out of the drag region", initial.appRegion, "no-drag");

  const steps = (e2e.steps ?? []) as Array<Record<string, any>>;
  check("A9 all four required values were exercised", steps.length, 4);
  check(
    "A10 the four requested values",
    steps.map((s) => s.requested),
    [20, 50, 100, 85],
  );
  checkTrue(
    "A11 the slider tracked every value",
    steps.every((s) => String(s.requested) === s.probe?.sliderValue),
  );
  checkTrue(
    "A12 the displayed percentage tracked the slider",
    steps.every((s) => s.probe?.readout === `${s.requested}%`),
  );
  checkTrue(
    "A13 the alpha actually applied to the renderer matched the slider",
    steps.every(
      (s) => Math.abs(Number(s.probe?.alphaVar) - s.requested / 100) < 0.001,
    ),
  );
  checkTrue(
    "A14 every value was persisted",
    steps.every((s) => Math.abs(Number(s.persisted) - s.requested / 100) < 0.001),
  );
  checkTrue(
    "A15 the control stayed hit-testable at EVERY value, including 20%",
    steps.every((s) => s.probe?.hitIsSlider === true),
  );
  checkTrue(
    "A16 the control kept a readable background at 20%",
    steps.every((s) => {
      const m = /rgba?\([^)]*?([\d.]+)\)$/.exec(String(s.probe?.ctlBg ?? ""));
      return m ? Number(m[1]) >= 0.8 : false;
    }),
  );
  checkTrue(
    "A17 the control was never made click-through at low opacity",
    steps.every((s) => s.probe?.ctlPointerEvents === "auto"),
  );
  // The whole point of the renderer-level mechanism: the WINDOW opacity must be
  // 1 (or 0 when hidden) at every setting. If this ever equals 20/50/100/85 the
  // mechanism has regressed to the version that also dims the text.
  checkTrue(
    "A18 the window opacity stayed 1 at every setting (text is never dimmed)",
    steps.every((s) => s.windowOpacity === 1),
  );
  check("A19 the window started opaque", e2e.windowOpacityAtStart, 1);

  check("A20 hiding sets window opacity to 0", e2e.hiddenWindowOpacity, 0);
  check("A21 showing sets it back to 1", e2e.shownWindowOpacity, 1);
  check("A22 showing restored the chosen alpha, not 100%", e2e.afterShowAlpha, "0.85");
  check("A23 the final value is what is on disk", e2e.finalPersisted, 0.85);
  checkTrue("A24 the settings file was really written", e2e.storeFileExists === true);

  // A restart must reload 0.85 from disk, not reset to a default.
  const persisted = Number(e2e.finalPersisted);
  check(
    "A25 a restart would restore the last chosen value",
    normalizeOverlayOpacity(persisted),
    0.85,
  );
} else {
  failures.push("  A0 no Electron result — the real-app checks could not run");
}

// ═══════════════════════════════════════════════════════════════════════════
// Part C — wiring Electron cannot drive from here.
// ═══════════════════════════════════════════════════════════════════════════

const main = read("electron/main.ts");
const ipc = read("electron/ipc.ts");
const preload = read("electron/preload.ts");
const hotkeys = read("electron/hotkeys.ts");
const topBar = read("src/components/TopBar.tsx");
const control = read("src/components/OpacityControl.tsx");
const css = read("src/styles/global.css");

checkTrue("C1 main.ts creates the opacity controller", /createOverlayOpacityController\(/.test(main));
checkTrue("C2 main.ts reads the persisted value at boot", /initial: readPersistedOverlayOpacity\(\)/.test(main));
checkTrue("C3 main.ts persists on every change", /persist: persistOverlayOpacity/.test(main));
checkTrue("C4 the store default is the 85% default", /overlayOpacity: DEFAULT_OVERLAY_OPACITY/.test(ipc));
checkTrue(
  "C5 the controller logs the required line shape",
  /overlay opacity=/.test(read("electron/overlayOpacity.ts")),
);
checkTrue(
  "C6 the required '[AI] primary provider=gemini' style log is NOT conflated here",
  !/\[AI\] primary provider/.test(read("electron/overlayOpacity.ts")),
);

// ── The control must be reachable WITHOUT opening Settings ────────────────
checkTrue("C7 the TopBar renders the opacity control", /<OpacityControl\s*\/>/.test(topBar));
checkTrue(
  "C8 TopBar is rendered unconditionally (not behind a settings flag)",
  /<TopBar[\s\S]*?onStartInterview=/.test(read("src/pages/Home.tsx")) &&
    !/\{settingsOpen && <TopBar/.test(read("src/pages/Home.tsx")),
);
checkTrue("C9 the control is not inside SettingsPanel", !/OpacityControl/.test(read("src/components/SettingsPanel.tsx")));
checkTrue("C10 the slider carries a stable test hook", /data-ghostly="opacity-slider"/.test(control));
checkTrue("C11 the readout carries a stable test hook", /data-ghostly="opacity-value"/.test(control));
checkTrue("C12 the readout shows a percentage", /\{shown\}%/.test(control));
checkTrue(
  "C13 the control opts back into OS mouse on hover",
  /onMouseEnter=\{onEnter\}/.test(control) && /enableMouse\(\)/.test(control),
);
checkTrue(
  "C14 leaving re-enables click-through",
  /const onLeave = useCallback\(\(\) => \{[\s\S]*?disableMouse\(\)/.test(control),
);

// ── The alpha reaches the surfaces, and ONLY the surfaces ────────────────
checkTrue(
  "C15 the alpha custom property is declared with the default",
  /--ghostly-alpha:\s*0\.85/.test(css),
);
checkTrue(
  "C16 surfaces multiply their alpha by the custom property",
  /calc\(var\(--gs-a[^)]*\)\s*\*\s*var\(--ghostly-alpha\)\)/.test(css),
);
checkTrue(
  "C17 the surfaces class exists for class-based panels",
  /\.gs\s*\{/.test(css),
);
checkTrue(
  "C18 the answer panel background is alpha-aware",
  /gs\("20 20 23", 0\.65\)/.test(read("src/pages/Home.tsx")),
);
checkTrue(
  "C19 no surface scales its TEXT with the alpha",
  !/opacity:\s*var\(--ghostly-alpha\)/.test(css) &&
    !/opacity:\s*calc\([^)]*--ghostly-alpha/.test(css),
);
checkTrue(
  "C20 the renderer never sets a window-level opacity from the slider",
  !/setOverlayOpacity[\s\S]{0,200}setOpacity\(/.test(preload),
);

// ── Independence from the Region Picker's dim overlay ─────────────────────
// The Region Picker — and with it the 20%-70% dim overlay and its own slider —
// was removed entirely. The two opacity systems can no longer interfere, so
// the independence is now asserted as ABSOLUTE rather than as a range check.
checkTrue(
  "C21 the Region Picker module is gone",
  !existsSync(path.join(root, "electron/regionPicker.ts")),
);
checkTrue(
  "C22 the picker's dim-overlay constants exist nowhere in the live sources",
  !/MIN_OVERLAY_ALPHA|MAX_OVERLAY_ALPHA|DEFAULT_OVERLAY_ALPHA/.test(
    [main, ipc, preload, css, control, topBar].join("\n"),
  ),
);
checkTrue(
  "C23 Ghostly's default is NOT the picker's dim default",
  DEFAULT_OVERLAY_OPACITY !== 0.4,
);
checkTrue(
  "C24 the picker's slider id is not reused by the window control",
  !/id="opacity"/.test(control) && /id="ghostly-opacity"/.test(control),
);
checkTrue(
  "C25 no live file can spawn the picker window again",
  !/regionPicker/i.test([main, ipc, preload].join("\n")),
);

// ── Hide/show must not be hijacked by the alpha any more ─────────────────
// Checked against comment-stripped source: the raw text mentions
// `win.getOpacity()` only to explain why it is gone.
checkTrue(
  "C26 hotkeys ask the controller, never the window opacity",
  /isOverlayVisible\(\)/.test(code("electron/hotkeys.ts")) &&
    !/win\.getOpacity\(\)/.test(code("electron/hotkeys.ts")),
);
checkTrue(
  "C26b Ctrl+B branches on the controller",
  /if \(isOverlayVisible\(\)\) \{\s*hideWindow\(\);/.test(code("electron/hotkeys.ts")) &&
    /if \(!isOverlayVisible\(\)\) \{\s*showWindow\(\);/.test(code("electron/hotkeys.ts")),
);
checkTrue(
  "C27 main.ts asks the controller for visibility",
  /isOverlayVisible\(\)/.test(code("electron/main.ts")) &&
    !/getOpacity\(\) > 0/.test(code("electron/main.ts")),
);
checkTrue(
  "C28 showing restores the chosen alpha rather than forcing 1",
  /setHidden\(false\)/.test(code("electron/main.ts")) &&
    /setOverlayHidden\(false\)/.test(code("electron/hotkeys.ts")),
);
// The load-bearing invariant of the whole mechanism, asserted where it is
// decided rather than at each call site: the value handed to Electron is derived
// ONLY from the hidden flag, so the user's alpha can never reach the window.
// A literal `setOpacity(1)` at some call site is fine; `setOpacity(alpha)` is not.
const opacitySrc = code("electron/overlayOpacity.ts");
checkTrue(
  "C28b the window opacity is derived from `hidden` alone",
  /const windowOpacity = hidden \? 0 : 1;/.test(opacitySrc) &&
    /deps\.setWindowOpacity\(windowOpacity\)/.test(opacitySrc),
);
checkTrue(
  "C28c the user's alpha is only ever sent to the renderer",
  /deps\.setChromeAlpha\?\.\(opacity\)/.test(opacitySrc) &&
    !/setWindowOpacity\(opacity\)/.test(opacitySrc) &&
    !/setWindowOpacity\(this\./.test(opacitySrc),
);
checkTrue(
  "C28d the derived window opacity is exposed as 0 or 1 only",
  /windowOpacity: \(\) => \(hidden \? 0 : 1\)/.test(opacitySrc),
);
checkTrue(
  "C29 the IPC channel parses percent, not fraction",
  /setOpacity\(opacityFromSliderValue\(value\)\)/.test(code("electron/main.ts")),
);

console.log(`\nGHOSTLY OVERLAY OPACITY`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.join("\n"));
  process.exit(1);
}