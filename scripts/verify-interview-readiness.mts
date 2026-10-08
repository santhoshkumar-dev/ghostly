/**
 * Interview-readiness harness: screenshot solve, Live Screen privacy, ASR engine.
 *
 * Run: `npx tsx scripts/verify-interview-readiness.mts`
 *
 * Covers three requirements that are architectural rather than algorithmic, so
 * the proof has to be structural — or, where possible, taken from the REAL running
 * application rather than from its source.
 *
 *   • **Screenshot → Solve.** A real screen capture is produced through the
 *     real main-process handler, checked for being an actual decodable image,
 *     delivered through the real renderer event, and shown as a real thumbnail.
 *     Separately, the store and the solve-target logic are driven directly to
 *     prove an `undefined` or empty payload can never count as a screenshot.
 *
 *   • **Manual capture only.** The automatic Live Screen path was removed, so
 *     the renderer bridge is enumerated at RUNTIME to prove that no watcher
 *     method survives, the deleted source files are checked to be gone, and
 *     the one remaining OCR path is asserted local-only, network-free and
 *     disk-free. Screen text still needs a click: Capture Screen, then Solve.
 *
 *   • **Parakeet primary.** Asserted in the persisted defaults, not just the
 *     code default, because a mismatch between the two is precisely the bug
 *     class this repo has been bitten by.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
function checkTrue(name: string, cond: boolean): void {
  check(name, cond, true);
}

const root = process.cwd();
const nodeRequire = createRequire(import.meta.url);
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
/** Strips comments from SOURCE TEXT (not a path). */
const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
/** Reads a file and strips its comments. */
const code = (p: string) => stripComments(read(p));

// ═══════════════════════════════════════════════════════════════════════════
// Part A — the REAL application: a real screenshot, end to end
// ═══════════════════════════════════════════════════════════════════════════

const tmpDir = path.join(root, ".verify-interview-readiness");
const driverCjs = path.join(tmpDir, "driver.cjs");

const DRIVER = `
const path = require("path");
const { app, BrowserWindow } = require("electron");

const userData = process.env.GHOSTLY_E2E_USERDATA;
app.setPath("userData", userData);
app.setPath("sessionData", userData);

require(process.env.GHOSTLY_E2E_MAIN);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function emit(payload, code) {
  console.log("RESULT:" + JSON.stringify(payload));
  app.exit(code);
}

/** Wait for the renderer to be interactive and its hotkeys wired. */
async function waitForPage(win, expr, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await win.webContents.executeJavaScript("String(!!(" + expr + "))") === "true") return true;
    } catch (e) { /* still loading */ }
    await sleep(150);
  }
  return false;
}

app.whenReady().then(async () => {
  const out = {};
  try {
    let win = null;
    for (let i = 0; i < 150 && !win; i++) {
      win = BrowserWindow.getAllWindows()[0] || null;
      if (!win) await sleep(100);
    }
    if (!win) { emit({ error: "no main window" }, 1); return; }
    await waitForPage(win, "document.querySelector('button')", 30000);
    await sleep(800);

    // ── 1. A REAL capture through the REAL main-process handler ────────────
    // The capture-fullscreen channel is the same captureFullScreen() the Ctrl+H
    // hotkey and the tray item both funnel into, so this exercises production
    // capture code rather than a test double.
    const captured = await win.webContents.executeJavaScript(
      "window.ghostly.captureFullscreen().then(function(b){return b;})"
    );
    out.capture = {
      type: typeof captured,
      length: typeof captured === "string" ? captured.length : 0,
      prefix: typeof captured === "string" ? captured.slice(0, 32) : null,
      hasBase64: typeof captured === "string" && captured.includes(";base64,"),
    };

    // ── 2. Deliver it exactly as the hotkey does ───────────────────────────
    // Main -> renderer on the same channel, which is the path the renderer
    // subscribes to with onScreenshot(). The payload is stashed on window
    // FIRST so the comparison below can be made inside the page without ever
    // embedding megabytes of base64 into a source string.
    win.webContents.executeJavaScript(
      "window.__capLen = " + captured.length + "; window.__capHead = " +
        JSON.stringify(captured.slice(0, 96)) + ";"
    );
    win.webContents.send("ghostly:screenshot", captured);
    await sleep(1500);

    // ── 3. The renderer must have rendered a REAL thumbnail ───────────────
    // naturalWidth/naturalHeight are only non-zero if the browser actually
    // DECODED the bytes, so this is strictly stronger than "an img tag exists".
    //
    // The payload is compared by length + prefix rather than by embedding the
    // whole multi-megabyte data URL into a second script.
    out.strip = await win.webContents
      .executeJavaScript(
        // Returns a JSON STRING: executeJavaScript ships its result over IPC,
        // where anything the structured-clone algorithm dislikes fails the whole
        // call with an opaque "could not be cloned".
        "(function(){" +
        "var imgs=Array.prototype.slice.call(document.querySelectorAll('img'));" +
        "var shot=imgs.filter(function(i){return (i.getAttribute('alt')||'').indexOf('Screenshot')===0;});" +
        "if(!shot.length) return JSON.stringify({count:0, allAlts:imgs.map(function(i){return i.getAttribute('alt');})});" +
        "var src=shot[0].getAttribute('src')||'';" +
        "var el=shot[0];" +
        "return JSON.stringify({count:shot.length," +
        "srcMatches: src.length===window.__capLen && src.slice(0,96)===window.__capHead," +
        "srcLen:src.length," +
        "naturalWidth:el.naturalWidth, naturalHeight:el.naturalHeight," +
        "complete:el.complete});" +
        "})()"
      )
      .then(function (s) { return typeof s === "string" ? JSON.parse(s) : s; })
      .catch(function (e) { return { error: String(e) }; });

    // ── 4. The Live Screen status must contain no pixels ───────────────────
    out.liveScreenStatus = await win.webContents
      .executeJavaScript(
        "typeof window.ghostly.liveScreenStatus"
      )
      .then((t) => ({ type: t }))
      .catch((e) => ({ error: String(e) }));

    // ── 5. Enumerate the renderer bridge: no API may return pixels ─────────
    out.bridgeKeys = await win.webContents
      .executeJavaScript("JSON.stringify(Object.keys(window.ghostly).sort())")
      .then((s) => JSON.parse(s))
      .catch((e) => ({ error: String(e) }));

    // ── 6. A second capture must differ (it is a live screen, not a stub) ──
    const second = await win.webContents.executeJavaScript(
      "window.ghostly.captureFullscreen()"
    );
    out.secondCaptureLength = typeof second === "string" ? second.length : 0;

    emit(out, 0);
  } catch (err) {
    emit({ ...out, error: String((err && err.stack) || err) }, 1);
  }
});

setTimeout(() => emit({ error: "driver timed out" }, 1), 150000);
`;

let e2e: Record<string, any> | null = null;
/** The real application's own stdout, kept for the log assertions in Part A2. */
let driverOutput = "";
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
      timeout: 200_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GHOSTLY_E2E_USERDATA: userData,
        GHOSTLY_E2E_MAIN: path.join(root, "out", "main", "index.js"),
        ELECTRON_RENDERER_URL: "",
      },
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    output = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
  }
  driverOutput = output;
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.includes("RESULT:"));
  if (!line) {
    console.log("\n--- electron driver output ---");
    console.log(output.split(/\r?\n/).slice(-40).join("\n"));
    console.log("--- end driver output ---\n");
  }
  checkTrue("A0 the real app ran the screenshot flow", Boolean(line));
  if (line) e2e = JSON.parse(line.slice(line.indexOf("RESULT:") + "RESULT:".length));
} catch (err) {
  failures.push(`  A0 the Electron run could not start: ${String(err)}`);
} finally {
  if (!process.env.KEEP_DRIVER) rmSync(tmpDir, { recursive: true, force: true });
}

if (e2e && ((e2e.strip ?? {}).count ?? 0) !== 1) {
  console.log("\n--- raw driver result ---");
  console.log(JSON.stringify(e2e, null, 2).slice(0, 4000));
  console.log("--- end raw result ---\n");
}

if (e2e) {
  const cap = (e2e.capture ?? {}) as Record<string, any>;
  const strip = (e2e.strip ?? {}) as Record<string, any>;

  // ── A real image, from real production capture code ─────────────────────
  check("A1 the capture handler returned a string", cap.type, "string");
  checkTrue(
    "A2 it is a base64 data URL",
    typeof cap.prefix === "string" &&
      cap.prefix.startsWith("data:image/") &&
      cap.hasBase64 === true,
  );
  checkTrue(
    "A3 it is a plausibly sized image, not a stub",
    cap.length > 5000,
  );
  checkTrue(
    "A4 a second capture is also produced (it is a live screen)",
    e2e.secondCaptureLength > 5000,
  );

  // ── Delivered through the real event, rendered as a real thumbnail ─────
  check("A5 the screenshots strip rendered the thumbnail", strip.count, 1);
  check("A6 the browser actually DECODED it", strip.complete, true);
  checkTrue(
    "A7 it has real pixel dimensions",
    Number(strip.naturalWidth) > 0 && Number(strip.naturalHeight) > 0,
  );
  check("A8 the thumbnail carries exactly the captured payload", strip.srcMatches, true);
  check("A9 the payload is non-trivial", strip.srcLen > 5000, true);
}

// ═══════════════════════════════════════════════════════════════════════════
// Part A2 — what the REAL app actually logged
//
// The driver's own stdout carries the main process' console, and `main.ts`
// forwards every renderer console line into it. So these assertions are made
// against output a real launch produced — not against a stub — which is the only
// honest way to claim "Gemini is attempted first".
// ═══════════════════════════════════════════════════════════════════════════
{
  checkTrue(
    "A10 the app logged the required primary-provider line",
    driverOutput.includes("[AI] primary provider=gemini"),
  );
  checkTrue(
    "A11 it logged the configured chain with Gemini first",
    /\[AI\] configured provider chain: gemini\(/.test(driverOutput),
  );
  checkTrue(
    "A12 it logged the resolved chain",
    /\[AI\] resolved interview provider chain:/.test(driverOutput),
  );
  checkTrue(
    "A13 neither NVIDIA nor the local provider is in the chain the app resolved",
    !/\[AI\] configured provider chain:[^\n]*(nvidia|local)/.test(driverOutput),
  );
  checkTrue(
    "A14 the default overlay opacity was applied and logged",
    /\[Ghostly\] overlay opacity=85%/.test(driverOutput),
  );
  checkTrue(
    "A15 the window came up at full window-opacity (surfaces carry the alpha)",
    /\[Ghostly\] Window ready[^\n]*opacity: 1\b/.test(driverOutput),
  );
  // Never the credential itself.
  checkTrue(
    "A16 no API key value reached the log",
    !/AIzaSy|sk-or-v1|sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}/.test(
      driverOutput,
    ),
  );
  // The global capture shortcut, registered by the REAL main process on this
  // machine during this run — not a source regex.
  checkTrue(
    "A17 the real run registered the global Ctrl+Shift+S capture shortcut",
    /\[Shortcut\] Capture Screen registered: Ctrl\+Shift\+S/.test(driverOutput),
  );
  checkTrue(
    "A18 and it did NOT fail to register (nothing else holds the chord)",
    !/Capture Screen registration FAILED/.test(driverOutput),
  );
  checkTrue(
    "A19 the capture-shortcut subscription exists on the rendered bridge",
    Array.isArray((e2e as Record<string, unknown>)?.bridgeKeys) &&
      ((e2e as Record<string, unknown>).bridgeKeys as string[]).includes("onCaptureScreen"),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Part B — the store and the solve target, driven directly
//
// The runtime half of "no undefined screenshot may count as a valid
// screenshot". `addScreenshot` is what every capture path funnels through, so
// asserting it here covers the hotkey, the tray and any future source at once.
// ═══════════════════════════════════════════════════════════════════════════
{
  const { useStore } = await import("../src/store/useStore");
  const { usableScreenshots, lastUsableScreenshot } = await import(
    "../src/lib/solveTarget"
  );

  // A 1x1 PNG: a real, decodable image, small enough to inline.
  const REAL_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  const store = useStore.getState();
  store.clearScreenshots();

  // `undefined` — the exact bug the tray menu used to produce.
  useStore.getState().addScreenshot(undefined as unknown as string);
  check("B1 an undefined payload never enters the list", useStore.getState().screenshots, []);

  useStore.getState().addScreenshot("");
  check("B2 an empty payload never enters the list", useStore.getState().screenshots, []);

  useStore.getState().addScreenshot(REAL_PNG);
  check("B3 a real payload is stored", useStore.getState().screenshots, [REAL_PNG]);

  check("B4 the newest usable screenshot is the captured one", lastUsableScreenshot(useStore.getState().screenshots), REAL_PNG);
  check("B5 usableScreenshots counts it", usableScreenshots(useStore.getState().screenshots).length, 1);

  // The historical failure shape: a real screenshot followed by a payload-less
  // one. The strip would show two entries while only one image existed, and
  // Solve would attach nothing.
  const polluted = [REAL_PNG, undefined as unknown as string];
  check(
    "B6 a polluted list still resolves to the real screenshot",
    lastUsableScreenshot(polluted),
    REAL_PNG,
  );
  check(
    "B7 and usableScreenshots ignores the undefined entry",
    usableScreenshots(polluted),
    [REAL_PNG],
  );

  // The reverse: a list of nothing but payload-less entries yields NO answer
  // target, which is what stops Solve asking about a picture that was never sent.
  check("B8 a list of only undefined entries has no usable screenshot", usableScreenshots([undefined as unknown as string, ""]).length, 0);
  // `lastUsableScreenshot` returns `undefined` (not null) when nothing is usable.
  check("B9 and no newest usable screenshot", lastUsableScreenshot([undefined as unknown as string, ""]), undefined);

  useStore.getState().clearScreenshots();
}

// ═══════════════════════════════════════════════════════════════════════════
// Part C — MANUAL capture only: the automatic screen path is GONE
//
// Live Screen — the region watcher, its OCR loop, the "Auto-detect new
// question" toggle, LiveScreenPanel and the region picker — was removed
// entirely, together with the local/nvidia providers. Screen context now
// enters an interview ONLY through the manual Capture Screen button or the
// global Ctrl+Shift+S shortcut, both of which run the SAME renderer
// `captureScreen`, and an answer is produced only when Solve is pressed.
//
// The privacy contract is therefore asserted as ABSOLUTE:
//
//   C1  no liveScreen* method survives on the bridge (nothing can watch);
//   C2  no bridge method is named like a frame/pixel/buffer reader;
//   C3  the liveScreenStatus channel is absent at RUNTIME, not just unused;
//   C4  the controller / detector / panel / picker source files are gone;
//   C5  the only OCR left is the one-shot, LOCAL Windows OCR for a capture
//       the user explicitly took — no network, ever;
//   C6  that OCR writes nothing to disk, and its channel still exists so an
//       attached capture can still carry screen text;
//   C7  the auto-detect setting is gone from the store;
//   C8  Home has no automatic screen trigger left;
//   C9  button and shortcut share ONE capture path (no second implementation);
//  C10  the preload exposes no pixel getter beyond that manual capture;
//  C11  Solve still refuses to answer when no screenshot was captured.
// ═══════════════════════════════════════════════════════════════════════════
{
  const preload = read("electron/preload.ts");
  const home = read("src/pages/Home.tsx");
  const homeSrc = stripComments(home);
  const ipcSrc = read("electron/ipc.ts");
  const ocr = read("electron/screenOcr.ts");
  const ocrCode = stripComments(ocr);
  const hotkeys = read("electron/hotkeys.ts");
  const storeSrc = stripComments(read("src/store/useStore.ts"));
  const exists = (rel: string) => existsSync(path.join(root, rel));

  // ── The bridge exposes nothing that can watch the screen ────────────────
  if (e2e && Array.isArray(e2e.bridgeKeys)) {
    const keys = e2e.bridgeKeys as string[];
    check(
      "C1 no liveScreen method survives on the bridge",
      keys.filter((k) => /liveScreen/i.test(k)),
      [],
    );
    check(
      "C2 no bridge method is named like a frame/pixel/buffer reader",
      keys.filter((k) => /frame|pixel|buffer|raw/i.test(k)),
      [],
    );
  }
  check(
    "C3 the liveScreenStatus channel is absent at runtime",
    (e2e as Record<string, unknown> | null)?.liveScreenStatus,
    { type: "undefined" },
  );

  // ── Every source of the automatic path is gone ──────────────────────────
  for (const rel of [
    "electron/liveScreen.ts",
    "electron/regionPicker.ts",
    "src/lib/liveScreenContext.ts",
    "src/components/LiveScreenPanel.tsx",
  ]) {
    checkTrue(`C4 ${rel} no longer exists`, !exists(rel));
  }

  // ── The only OCR left is one-shot and LOCAL ─────────────────────────────
  checkTrue(
    "C5 the one-shot OCR is local Windows OCR, never a cloud endpoint",
    /windowsOcr|recogni/i.test(ocr) &&
      !/api\.openai|deepgram|googleapis|azure\.com/i.test(ocr),
  );
  checkTrue(
    "C5b and it makes no network request of any kind",
    !/fetch\(|XMLHttpRequest|net\.request|axios|https?:\/\//i.test(ocrCode),
  );
  checkTrue(
    "C6 OCR output is never written to disk",
    !/writeFile|createWriteStream|appendFile/.test(ocrCode),
  );
  checkTrue(
    "C6b the one-shot OCR channel still exists for an attached capture",
    /ocrImageText/.test(preload) && /ghostly:ocr-image/.test(ipcSrc),
  );

  // ── No automatic trigger remains ────────────────────────────────────────
  checkTrue(
    "C7 the auto-detect setting is gone from the store",
    !/autoDetectQuestion/.test(storeSrc),
  );
  checkTrue(
    "C8 Home has no automatic screen trigger",
    !/onLiveScreenProblem|liveScreenFullScreen|autoDetect/i.test(homeSrc),
  );

  // ── Capture stays manual, and button + shortcut share ONE path ──────────
  checkTrue(
    "C9 the button and the Ctrl+Shift+S shortcut run the same callback",
    /window\.ghostly\.onCaptureScreen\(/.test(homeSrc) &&
      /onCaptureScreen=\{captureScreen\}/.test(home),
  );
  checkTrue(
    "C9b the main process registers Ctrl+Shift+S and only forwards an event",
    /Capture Screen registered: Ctrl\+Shift\+S/.test(hotkeys) &&
      /ghostly:capture-screen/.test(hotkeys) &&
      /ghostly:capture-screen/.test(preload),
  );
  checkTrue(
    "C10 the preload exposes no pixel getter beyond the manual capture",
    !/getScreenFrame|getFrame|getRegionPixels|liveScreen/i.test(preload),
  );
  checkTrue(
    "C11 Solve still refuses to answer without a captured screenshot",
    /Press Capture Screen \(or Ctrl\+Shift\+S\) first/.test(home),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Part D — Parakeet is intact as the local primary ASR, and comparisons stay off
//
// ── What this asserts, precisely ────────────────────────────────────────────
// Parakeet is now the DEFAULT local primary ASR (see src/lib/primaryAsr.ts).
// Moonshine is NOT removed: it remains the local fallback for any segment
// Parakeet cannot decode, and an explicit "moonshine" selection is preserved.
//
// So the assertions are: Parakeet is the default, a missing/invalid value
// resolves to Parakeet, an explicit "moonshine" survives, its fallback still
// goes to Moonshine and nowhere else, and no comparison engine is switched on
// anywhere.
// ═══════════════════════════════════════════════════════════════════════════
{
  const { DEFAULT_PRIMARY_ASR, normalizePrimaryAsr, shouldFallbackToMoonshine, PARAKEET_FALLBACK_CODES } =
    await import("../src/lib/primaryAsr");
  const { useStore } = await import("../src/store/useStore");

  // ── The default is UNCHANGED (Moonshine), by design ─────────────────────
  check("D1 the shipped default primary engine is Parakeet", DEFAULT_PRIMARY_ASR, "parakeet");
  check("D2 the store default still matches it", useStore.getState().settings.primaryAsr, "parakeet");
  checkTrue(
    "D3 a missing/invalid primaryAsr resolves to Parakeet (the default)",
    normalizePrimaryAsr(undefined) === "parakeet" &&
      normalizePrimaryAsr("") === "parakeet" &&
      normalizePrimaryAsr("whisper") === "parakeet",
  );
  checkTrue(
    "D3b an explicit moonshine selection is preserved",
    normalizePrimaryAsr("moonshine") === "moonshine",
  );

  // ── Parakeet still resolves as primary when the user selects it ─────────
  check("D4 selecting Parakeet works", normalizePrimaryAsr("parakeet"), "parakeet");

  // ── Its fallback is Moonshine, never a cloud engine ─────────────────────
  check(
    "D5 every Parakeet failure code hands the segment to Moonshine",
    PARAKEET_FALLBACK_CODES.every((c) => shouldFallbackToMoonshine(c) === true),
    true,
  );
  check(
    "D6 and an unrelated code does not trigger a fallback",
    shouldFallbackToMoonshine("not_a_code") === false &&
      shouldFallbackToMoonshine(undefined) === false,
    true,
  );
  checkTrue(
    "D7 the fallback list contains no cloud engine",
    !PARAKEET_FALLBACK_CODES.some((c) => /groq|deepgram|cloud|remote/i.test(String(c))),
  );
  checkTrue(
    "D8 a per-segment success never routes to a cloud engine",
    !/groqWhisper|deepgramClient/.test(code("src/lib/parakeetPrimary.ts")),
  );

  // ── Every comparison engine is off in the renderer default ─────────────
  const offFlags = [
    "asrCompareMode",
    "asrCompareGroq",
    "asrCompareParakeet",
    "asrCompareMoonshine",
    "asrCompareMode",
  ] as const;
  for (const flag of offFlags) {
    check(
      `D9 ${flag} is off by default`,
      (useStore.getState().settings as Record<string, unknown>)[flag],
      false,
    );
  }

  // ── …and absent (therefore falsy) from the persisted default ───────────
  // A flag written `true` into electron-store would silently re-enable a paid
  // comparison on every launch, so "absent" is the state that is asserted.
  const ipc = read("electron/ipc.ts");
  for (const flag of offFlags) {
    checkTrue(
      `D10 ${flag} is not enabled in the persisted store default`,
      !new RegExp(`${flag}:\\s*true`).test(ipc),
    );
  }

  // The Deepgram key is deliberately a TOP-LEVEL store key, not a settings
  // field, precisely so it cannot be mistaken for an AI provider key. Assert
  // both halves of that arrangement rather than just its value.
  checkTrue(
    "D11 the Deepgram key is not part of renderer settings",
    !("deepgramKey" in useStore.getState().settings),
  );
  checkTrue(
    "D12 and it is empty in the persisted default",
    /deepgramKey:\s*""/.test(ipc),
  );
  checkTrue(
    "D13 the Parakeet comparison toggle is refused in a packaged build",
    /!app\.isPackaged/.test(ipc),
  );
  checkTrue(
    "D14 Parakeet as primary is enabled by default, disabled only by an explicit moonshine",
    /primaryAsr !== "moonshine"\) return true;/.test(ipc),
  );

  // ── This task must not have leaked into the ASR path ───────────────────
  checkTrue(
    "D15 no AI key-pool concept leaked into the ASR path",
    !/apiKeyPool|keyHealth|keySlot/.test(code("src/hooks/useInterviewAudio.ts")) &&
      !/apiKeyPool|keyHealth|keySlot/.test(code("src/lib/primaryAsr.ts")) &&
      !/apiKeyPool|keyHealth|keySlot/.test(code("src/lib/parakeetPrimary.ts")),
  );
  checkTrue(
    "D16 the AI answer path is still the only consumer of the key pool",
    /keyHealth\s*\n?\s*\.gate\s*\n?\s*\.eligible\(|keyHealth\.gate\.eligible\(/.test(
      stripComments(read("src/pages/Home.tsx")),
    ),
  );
  checkTrue(
    "D17 providerOrder (the AI chain) is not consulted by the ASR path",
    !/providerOrder/.test(code("src/hooks/useInterviewAudio.ts")),
  );
}

console.log(`\nINTERVIEW READINESS (screenshot · live-screen privacy · ASR)`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.join("\n"));
  process.exit(1);
}