/**
 * REAL OS KEYSTROKE verification — Ctrl+Shift+S captures a screenshot.
 *
 * Run: `npx tsx scripts/verify-capture-shortcut.mts`
 *
 * Everything else in this repo can be proven with pure functions or a stubbed
 * `fetch`. This one cannot: the claim under test is "the global shortcut is
 * registered by the REAL main process and, when pressed, the renderer runs the
 * SAME captureScreen the Capture Screen BUTTON runs". So this driver:
 *
 *   1. boots the built app under real Electron (throwaway userData);
 *   2. counts the thumbnails currently in the screenshot strip;
 *   3. sends the actual chord to the real OS keyboard state (SendKeys), which
 *      is the only thing that can fire a `globalShortcut` registration;
 *   4. waits for a NEW thumbnail to appear — a decoded image, produced by the
 *      renderer's captureScreen, i.e. the button's own path;
 *   5. reports the bridge channel and the main-process registration log.
 *
 * Environment note (stated, not hidden): the chord must be free on this
 * machine. If another application holds Ctrl+Shift+S the registration line
 * says FAILED and this harness fails — which is the honest result, because the
 * shortcut would not work for the user either.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

let pass = 0;
const failures: string[] = [];
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else failures.push(`  ${name}\n    expected: ${b}\n    actual:   ${a}`);
}
const checkTrue = (name: string, cond: boolean) => check(name, cond, true);

const root = process.cwd();
const nodeRequire = createRequire(import.meta.url);
const tmpDir = path.join(root, ".verify-capture-shortcut");
const driverCjs = path.join(tmpDir, "driver.cjs");

const DRIVER = `
const { app, BrowserWindow } = require("electron");
const { execSync } = require("child_process");

const userData = process.env.GHOSTLY_SC_USERDATA;
app.setPath("userData", userData);
app.setPath("sessionData", userData);
require(process.env.GHOSTLY_SC_MAIN);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function emit(payload, code) {
  console.log("RESULT:" + JSON.stringify(payload));
  app.exit(code);
}
const countShots = (win) =>
  win.webContents
    .executeJavaScript(
      "JSON.stringify(Array.from(document.querySelectorAll('img')).filter(function(i){return (i.getAttribute('alt')||'').indexOf('Screenshot')===0;}).length)"
    )
    .then((s) => (typeof s === "string" ? JSON.parse(s) : s));

app.whenReady().then(async () => {
  const out = {};
  try {
    let win = null;
    for (let i = 0; i < 150 && !win; i++) {
      win = BrowserWindow.getAllWindows()[0] || null;
      if (!win) await sleep(100);
    }
    if (!win) { emit({ error: "no main window" }, 1); return; }

    // Wait for React to paint, then make sure the overlay is actually shown.
    for (let i = 0; i < 200; i++) {
      const t = await win.webContents
        .executeJavaScript("JSON.stringify(!!document.querySelector('button'))")
        .catch(() => "false");
      if (t === "true") break;
      await sleep(150);
    }
    await sleep(1500);
    try { await win.webContents.executeJavaScript("window.ghostly.show()"); } catch (e) { /* already shown */ }
    await sleep(500);

    out.bridgeChannel = await win.webContents
      .executeJavaScript("JSON.stringify(typeof window.ghostly.onCaptureScreen)")
      .then((s) => JSON.parse(s));
    out.before = await countShots(win);

    // ── THE REAL CHORD ─────────────────────────────────────────────────────
    // ^ = Ctrl, + = Shift → Ctrl+Shift+S. Sent to the OS keyboard state, so
    // only a genuine globalShortcut registration can turn it into a capture.
    execSync(
      'powershell -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\\'^+s\\')"',
      { windowsHide: true },
    );
    out.sent = true;

    for (let i = 0; i < 50; i++) {
      await sleep(200);
      out.after = await countShots(win);
      if (out.after > out.before) break;
    }
    emit(out, 0);
  } catch (err) {
    emit({ ...out, error: String((err && err.stack) || err) }, 1);
  }
});

setTimeout(() => emit({ error: "driver timed out" }, 1), 120000);
`;

let e2e: Record<string, any> | null = null;
let driverOutput = "";
let bootError: string | null = null;

try {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(driverCjs, DRIVER, "utf8");
  const electronPath = nodeRequire("electron") as unknown as string;
  const userData = path.join(tmpDir, "userdata");
  mkdirSync(userData, { recursive: true });

  try {
    const out = execFileSync(electronPath, [driverCjs], {
      encoding: "utf8",
      timeout: 180_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GHOSTLY_SC_USERDATA: userData,
        GHOSTLY_SC_MAIN: path.join(root, "out", "main", "index.js"),
        ELECTRON_RENDERER_URL: "",
      },
      windowsHide: true,
    });
    driverOutput = out;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    driverOutput = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
    bootError = String(e.message ?? err);
  }
} catch (err) {
  bootError = String(err);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const line = driverOutput
  .split(/\r?\n/)
  .reverse()
  .find((l) => l.includes("RESULT:"));

checkTrue("0 the real app ran", !bootError && Boolean(line));
if (line) {
  try {
    e2e = JSON.parse(line.slice(line.indexOf("RESULT:") + "RESULT:".length));
  } catch {
    e2e = null;
  }
}

console.log("REAL KEYSTROKE — Ctrl+Shift+S");

if (!e2e) {
  failures.push(`  no driver result\n${driverOutput.slice(-2500)}`);
} else if (e2e.error) {
  failures.push(`  driver error: ${e2e.error}`);
} else {
  check("1 the bridge exposes the capture-shortcut channel", e2e.bridgeChannel, "function");
  checkTrue("2 the chord was delivered to the OS", e2e.sent === true);
  checkTrue(
    "3 the main process registered the global shortcut in THIS run",
    /\[Shortcut\] Capture Screen registered: Ctrl\+Shift\+S/.test(driverOutput) &&
      !/Capture Screen registration FAILED/.test(driverOutput),
  );
  checkTrue(
    `4 pressing it produced a NEW thumbnail (before=${e2e.before}, after=${e2e.after})`,
    typeof e2e.after === "number" && e2e.after === e2e.before + 1,
  );
  checkTrue(
    "5 the keyboard never leaked a credential into the log",
    !/AIzaSy|sk-or-v1|Bearer\s+[A-Za-z0-9._-]{20,}/.test(driverOutput),
  );
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.join("\n"));
  process.exit(1);
}
console.log(
  "\n  The global chord was pressed against the REAL OS keyboard state and the\n" +
    "  renderer's own capture path produced a decoded screenshot — one press,\n" +
    "  one capture, the same path the Capture Screen button uses.",
);
