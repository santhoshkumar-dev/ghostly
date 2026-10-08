/** TEMPORARY probe (deleted after use): does desktopCapturer see Ghostly when visible? */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const nodeRequire = createRequire(import.meta.url);

const DRIVER = `
const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.env.GH_UD);
app.setPath("sessionData", process.env.GH_UD);
require(process.env.GH_MAIN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (p, c) => { process.stdout.write("RESULT:" + JSON.stringify(p) + "\\n"); app.exit(c); };

app.whenReady().then(async () => {
  const out = {};
  try {
    let win = null;
    for (let i = 0; i < 200 && !win; i++) { win = BrowserWindow.getAllWindows()[0] || null; if (!win) await sleep(100); }
    if (!win) { emit({ error: "no ghostly window" }, 1); return; }
    await sleep(2500);
    const probe = new BrowserWindow({
      width: 460, height: 220, x: 60, y: 60,
      frame: false, transparent: false, alwaysOnTop: true, skipTaskbar: true,
      backgroundColor: "#050505",
    });
    probe.loadURL("data:text/html,<!doctype html><html><head><meta charset=\"utf-8\"></head><body style=\"margin:0;background:#000;color:#0f0;font-family:monospace\"><pre id=\"o\" style=\"padding:8px\">ready</pre><script>(async()=>{const o=document.getElementById('o');const log=(s)=>{o.textContent+=(o.textContent?'\\n':'')+s;o.scrollTop=o.scrollHeight;};try{const ghostly=window.ghostly;const before=await ghostly.captureFullscreen().then(b=>JSON.stringify({len:b.length})).catch(e=>JSON.stringify({error:String(e)}));log('BEFORE_HIDE='+before);await ghostly.hide();await new Promise(r=>setTimeout(r,350));const after=await ghostly.captureFullscreen().then(b=>JSON.stringify({len:b.length}))||'{error}';log('AFTER_HIDE='+after);await ghostly.show();log('DONE');}catch(e){log('ERR='+e.message);}})();<\/script></body></html>");
    await sleep(2500);
    const probeTrace = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("TIMEOUT"), 9000);
      let logged = "";
      probe.webContents.on("console-message", (_, __, m) => {
        if (typeof m === "string") logged += String(m) + "\\n";
        if (m && String(m).indexOf("DONE") !== -1) { clearTimeout(timer); resolve(logged); }
      });
      probe.once("closed", () => resolve(logged || "no-probe-output"));
    });
    probe.destroy();
    out.probeTrace = probeTrace;
    emit(out, 0);
  } catch (err) { emit({ error: String((err && err.stack) || err) }, 1); }
});
setTimeout(() => emit({ error: "timeout" }), 60000);
`;

const tmp = path.join(os.tmpdir(), `ghostly-cap-${process.pid}`);
mkdirSync(tmp, { recursive: true });
writeFileSync(path.join(tmp, "driver.cjs"), DRIVER, "utf8");

const res = spawnSync(nodeRequire("electron") as unknown as string, [path.join(tmp, "driver.cjs")], {
  encoding: "utf8",
  env: { ...process.env, GH_UD: process.env.APPDATA + "\\ghostly-cap-probe", GH_MAIN: path.resolve(process.cwd(), "out", "main", "index.js") },
  timeout: 70000,
  windowsHide: true,
});
const raw = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
rmSync(tmp, { recursive: true, force: true });
const line = raw.split(/\r?\n/).find((l) => l.startsWith("RESULT:"));
const e2e: any = line ? JSON.parse(line.slice(7)) : { error: "no RESULT", raw: raw.slice(-2500) };
console.log("=== probe trace ===");
console.log(e2e.probeTrace);
if (e2e.error) console.log("=== error:", String(e2e.error).slice(0, 900));
