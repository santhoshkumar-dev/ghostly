/**
 * THE REAL screenshot -> answer path, under real Electron.
 *
 * A separate plain BrowserWindow shows a real interview question. Ghostly
 * captures the whole screen (the question window is visible in it), then solves.
 * Everything is production: real capture, real Gemini, real validator, real UI.
 *
 * Run: `npx tsx scripts/diagnose-screenshot-answer.mts`
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const nodeRequire = createRequire(import.meta.url);

const DRIVER = String.raw`
const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.env.GH_UD);
app.setPath("sessionData", process.env.GH_UD);
require(process.env.GH_MAIN);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (p, c) => { process.stdout.write("RESULT:" + JSON.stringify(p) + "\n"); app.exit(c); };
const js = async (w, e) => {
  const r = await w.webContents.executeJavaScript(e);
  return typeof r === "string" ? JSON.parse(r) : r;
};

const LOG = [];

app.whenReady().then(async () => {
  const out = {};
  try {
    let win = null;
    for (let i = 0; i < 250 && !win; i++) {
      win = BrowserWindow.getAllWindows()[0] || null;
      if (!win) await sleep(100);
    }
    if (!win) { emit({ error: "no ghostly window" }, 1); return; }

    // ---- A plain window showing a REAL interview question -------------------
    const q = new BrowserWindow({
      width: 900, height: 420, x: 40, y: 40,
      frame: false, transparent: false, backgroundColor: "#ffffff",
      alwaysOnTop: true, skipTaskbar: true,
    });
    await q.loadURL("data:text/html," + encodeURIComponent(
      "<body style='font-family:Segoe UI,monospace;background:#fff;color:#000;padding:28px'>" +
      "<h2 style='font-size:26px'>Question</h2>" +
      "<p style='font-size:30px;font-weight:700'>Write a SQL query to find the second highest salary from the employees table.</p>" +
      "</body>"
    ));
    await sleep(2500);

    win.webContents.on("console-message", (_e, _lvl, msg) => LOG.push(String(msg)));
    const ml = console.log.bind(console);
    console.log = (...a) => { LOG.push(a.map(String).join(" ")); ml(...a); };

    for (let i = 0; i < 250; i++) {
      const t = await js(win, "JSON.stringify(document.body.innerText||'')").catch(()=>"");
      if (t && t.indexOf("Start Interview") !== -1) break;
      await sleep(150);
    }
    await sleep(1500);

    // ---- What does the app believe it has? --------------------------------
    out.settings = await js(win, "window.ghostly.getSettings().then(s=>JSON.stringify({activeProvider:s.activeProvider,order:s.providerOrder,gemini:!!(s.apiKeys&&s.apiKeys.gemini),openrouter:!!(s.apiKeys&&s.apiKeys.openrouter),model:s.models&&s.models[s.activeProvider]})).catch(e=>JSON.stringify({error:String(e)}))");

    // ---- 1. CAPTURE, exactly as the Ctrl+H hotkey does --------------------
    const captured = await js(win, "window.ghostly.captureFullscreen().then(b=>JSON.stringify({len:b.length,head:b.slice(0,30)})).catch(e=>JSON.stringify({error:String(e)}))");
    out.captured = captured;
    if (!captured || !captured.ok && !captured.len) { emit({ ...out, error: "capture failed" }, 1); return; }
    const dataUrl = await win.webContents.executeJavaScript(
      "window.ghostly.captureFullscreen().then(function(b){return JSON.stringify({u:b});})"
    ).then(function(s){ return JSON.parse(s).u; });
    out.pngDims = await js(win,
      "new Promise(function(res){var i=new Image();i.onload=function(){res(JSON.stringify({w:i.naturalWidth,h:i.naturalHeight}));};i.onerror=function(){res(JSON.stringify({err:1}));};i.src=" +
      JSON.stringify(String(dataUrl).slice(0,64)) + "';})").catch(()=>({err:1}));

    // Feed it through the SAME channel the hotkey uses.
    win.webContents.send("ghostly:screenshot", dataUrl);
    await sleep(2000);

    out.stripText = await js(win, "JSON.stringify((document.body.innerText||'').slice(0,900))").catch(()=>"");

    // ---- 2. SOLVE ----------------------------------------------------------
    win.webContents.send("ghostly:solve", { pressedAt: Date.now() });

    let answer = null;
    for (let i = 0; i < 400; i++) {
      await sleep(700);
      const card = await js(win,
        "(function(){var els=document.querySelectorAll('pre,code,p,div');" +
        "for(var i=0;i<els.length;i++){var t=(els[i].innerText||'').trim();" +
        "if(t.length>60&&/SELECT|salary|second highest|query|WITH/i.test(t)&&!/Start Interview|Capture Screen/.test(t))" +
        "return JSON.stringify({found:true,text:t.slice(0,600)});}" +
        "return JSON.stringify({found:false});})()").catch(()=>({found:false}));
      if (card && card.found) { answer = card.text; break; }
    }
    out.answer = answer;
    out.bodyAfter = await js(win, "JSON.stringify((document.body.innerText||'').slice(0,1800))").catch(()=>"");
    out.log = LOG.slice(0, 200);

    q.destroy();
    emit(out, 0);
  } catch (err) {
    emit({ ...out, error: String((err && err.stack) || err) }, 1);
  }
});
setTimeout(() => emit({ error: "driver timed out" }), 330000);
`;

const tmp = path.join(os.tmpdir(), `ghostly-shot-${process.pid}`);
mkdirSync(path.join(tmp, "userdata"), { recursive: true });
writeFileSync(path.join(tmp, "driver.cjs"), DRIVER, "utf8");

const res = spawnSync(nodeRequire("electron") as unknown as string, [path.join(tmp, "driver.cjs")], {
  encoding: "utf8",
  env: {
    ...process.env,
    GH_UD: process.env.APPDATA + "\\ghostly",
    GH_MAIN: path.resolve(process.cwd(), "out", "main", "index.js"),
  },
  timeout: 345000,
  windowsHide: true,
});
const raw = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
rmSync(tmp, { recursive: true, force: true });

const line = raw.split(/\r?\n/).find((l) => l.startsWith("RESULT:"));
const e2e: any = line ? JSON.parse(line.slice(7)) : { error: "no RESULT", raw: raw.slice(-4000) };
if (e2e.raw) console.log("=== RAW ===\n" + e2e.raw);

console.log("=== settings        :", JSON.stringify(e2e.settings));
console.log("=== captured        :", JSON.stringify(e2e.captured));
console.log("=== png dims        :", JSON.stringify(e2e.pngDims));
console.log("=== strip text      :", String(e2e.stripText).replace(/\\n/g, " | ").slice(0, 500));
console.log("=== ANSWER          :", JSON.stringify(e2e.answer)?.slice(0, 700));
if (e2e.error) console.log("=== error           :", String(e2e.error).slice(0, 900));
console.log("\n=== LOG ===");
(e2e.log ?? []).slice(0, 60).forEach((l: string) => console.log("  | " + l.slice(0, 260)));
console.log("\n=== BODY AFTER ===");
console.log(String(e2e.bodyAfter).replace(/\\n/g, "\n").slice(0, 1200));
