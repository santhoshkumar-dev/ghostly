/**
 * TEMPORARY diagnostic (Phase 1 of the OCR task): does the image that reaches
 * local OCR still contain Ghostly's OWN overlay text?
 *
 * It boots the REAL built main process (`out/main/index.js`), so the real
 * window, the real stealth call and the real `captureFullScreen()` run. The
 * capture and the OCR are driven through the REAL preload bridge
 * (`window.ghostly.captureFullscreen` / `window.ghostly.ocrImageText`), i.e.
 * exactly the route the Capture Screen button and Ctrl+Shift+S use.
 *
 * A separate, deliberately NOT-stealthed window stands in for the user's target
 * application and shows a coding problem. The probe window is `show: false`, so
 * it is never composited into the capture it triggers.
 *
 * NOTHING about the image or the recognised text is printed. Only booleans and
 * counts.
 */

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";

const nodeRequire = createRequire(import.meta.url);

const DRIVER = process.env.GH_DRIVER;

const res = spawnSync(nodeRequire("electron") as unknown as string, [DRIVER], {
  encoding: "utf8",
  env: {
    ...process.env,
    GH_UD: path.join(process.env.APPDATA ?? ".", "ghostly-ocr-probe"),
    GH_MAIN: path.resolve(process.cwd(), "out", "main", "index.js"),
    GH_PRELOAD: path.resolve(process.cwd(), "out", "preload", "index.js"),
  },
  timeout: 140000,
  windowsHide: true,
});
const raw = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
const line = raw.split(/\r?\n/).find((l) => l.startsWith("RESULT:"));
const parsed: any = line
  ? JSON.parse(line.slice(7))
  : { error: "no RESULT", raw: raw.slice(-3000) };
console.log(JSON.stringify(parsed, null, 2));
const noise = raw
  .split(/\r?\n/)
  .filter((l) => /Stealth|visibility=|opacity=|Shortcut|Window ready/i.test(l));
console.log("--- main-process lines ---");
console.log(noise.slice(0, 40).join("\n"));