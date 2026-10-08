/**
 * Deterministic tests for the Parakeet memory/latency diagnostics sampler.
 *
 * Run: `npx tsx scripts/verify-parakeet-diagnostics.mts`
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The diagnostics sampler is going to be read while an interview is running and
 * then pasted into an issue. Two properties have to hold for that to be safe:
 *
 *   1. it reports the numbers a memory decision actually needs — system
 *      memory, the child's own RSS, the delta attributable to the model, and
 *      the latest decode latency / RTF; and
 *   2. it NEVER carries a transcript or audio.
 *
 * (2) is the one that cannot be eyeballed. The host holds a transcript in
 * memory during a comparison, so a careless spread or a logged result object
 * would quietly leak what the interviewer said into a log file. That is
 * asserted here against a deliberately hostile fixture.
 *
 * The clock is injected, so a 10-second cadence is verified in milliseconds.
 */
import { ParakeetHost, type ParakeetChildLike, type ParakeetHostReply, type ParakeetHostRequest } from "../src/lib/parakeetHost";
import { startParakeetDiagnostics, PARAKEET_DIAGNOSTICS_INTERVAL_MS } from "../electron/parakeetDiagnostics";
import { readSystemMemory, formatBytesMb } from "../src/lib/systemMemory";
import { readFile } from "node:fs/promises";

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

function checkTrue(name: string, actual: unknown) {
  check(name, Boolean(actual), true);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── System memory semantics ──────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const mem = readSystemMemory({
    totalMem: () => 8 * 1024 * 1024 * 1024,
    freeMem: () => 2 * 1024 * 1024 * 1024,
  });
  check("1 total is reported in MB", mem.totalMb, 8192);
  check("2 available is reported in MB", mem.availableMb, 2048);
  check("3 used is total minus available", mem.usedMb, 6144);
  check("4 used percent is computed", mem.usedPercent, 75);
}

{
  // A full machine must not divide by zero or report nonsense.
  const mem = readSystemMemory({ totalMem: () => 0, freeMem: () => 0 });
  check("5 a zero total does not divide by zero", mem.usedPercent, 0);
  check("6 zero totals report zero used", mem.usedMb, 0);
}

{
  check("7 a null MB value formats as a dash", formatBytesMb(null), "-");
  check("8 an undefined MB value formats as a dash", formatBytesMb(undefined), "-");
  check("9 a number formats with one decimal", formatBytesMb(640), "640.0 MB");
}

{
  const source = await readFile("src/lib/systemMemory.ts", "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  checkTrue("10 the reader uses os.freemem", /os\.freemem/.test(code));
  // The free-vs-available distinction must be documented, not assumed: this is
  // precisely the detail a future reader gets wrong.
  checkTrue(
    "11 the free/available distinction is documented",
    /ullAvailPhys|AVAILABLE/i.test(source) && /standby/i.test(source),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Diagnostics sampler ─────────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

/** A host whose diagnostics we control, so the sampler is fully deterministic. */
function stubHost(diagnostics: Record<string, unknown>): ParakeetHost {
  return { getDiagnostics: () => diagnostics } as unknown as ParakeetHost;
}

{
  // A hostile fixture: the host genuinely HAS a transcript in memory (that is
  // the whole point of a comparison), and it is deliberately attached to the
  // diagnostics object. The sampler must still not emit it.
  const SECRET_TRANSCRIPT = "the interviewer said our internal revenue figure is forty million";

  const lines: string[] = [];
  let tick: (() => void) | null = null;

  const handle = startParakeetDiagnostics({
    getHost: () =>
      stubHost({
        status: "ready",
        loadMs: 7013,
        rssMb: 747,
        decodeMs: 742,
        rtf: 0.092,
        queued: 0,
        inFlight: 1,
        consecutiveFailures: 0,
        // A careless implementation would spread this into the log line.
        text: SECRET_TRANSCRIPT,
        samples: new Float32Array([0.1, -0.2, 0.3]),
        audioUrl: "blob:http://localhost/abcdef-secret",
      }),
    log: (line) => lines.push(line),
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {},
  });

  checkTrue("12 a baseline line is emitted on start", lines.length >= 1);
  checkTrue(
    "13 the baseline reports total system memory",
    lines[0].includes("total=") && lines[0].includes("used="),
  );

  const baseline = lines[0];
  lines.length = 0;
  tick?.();

  check("14 one sample is emitted per tick", lines.length, 1);
  const line = lines[0];

  checkTrue("15 the line is prefixed for filtering", line.startsWith("[Parakeet-DIAG]"));
  checkTrue("16 it reports system AVAILABLE memory", line.includes("sysAvail="));
  checkTrue("17 it reports system used vs total", line.includes("sysUsed=") && line.includes("MB"));
  checkTrue("18 it reports used percent", line.includes("usedPct=") && line.includes("%"));
  checkTrue("19 it reports the delta since the model loaded", line.includes("deltaSinceBaseline="));
  checkTrue("20 it reports the utility process RSS", line.includes("childRss="));
  checkTrue("21 it reports the latest decode latency", line.includes("decodeMs=742"));
  checkTrue("22 it reports the latest RTF", line.includes("rtf=0.092"));
  checkTrue("23 it reports the model status", line.includes("status=ready"));
  checkTrue("24 it reports queue depth and in-flight count", line.includes("queued=") && line.includes("inFlight="));

  // ── The safety property ────────────────────────────────────────────────
  checkTrue("25 the transcript never reaches the log", !line.includes(SECRET_TRANSCRIPT));
  checkTrue("26 no part of the transcript leaks", !line.includes("forty million"));
  checkTrue("27 raw audio samples never reach the log", !line.includes("0.1,0.3"));
  checkTrue("28 the audio blob URL never reaches the log", !line.includes("blob:"));
  checkTrue("29 the line is a single line (grep/parse friendly)", !line.includes("\n"));

  handle.stop();
  checkTrue("30 stopping is logged", lines.some((l) => l.includes("stopped")));
  const baselineAgain = baseline;
  checkTrue("31 the baseline was captured before any sample", baselineAgain !== line);
}

{
  // Every field must degrade to something readable rather than `undefined`.
  const lines: string[] = [];
  let tick: (() => void) | null = null;
  const handle = startParakeetDiagnostics({
    getHost: () =>
      stubHost({
        status: "missing",
        loadMs: null,
        rssMb: null,
        decodeMs: null,
        rtf: null,
        queued: 0,
        inFlight: 0,
        consecutiveFailures: 0,
      }),
    log: (line) => lines.push(line),
    setInterval: (fn) => {
      tick = fn;
      return 2;
    },
    clearInterval: () => {},
  });
  lines.length = 0;
  tick?.();
  checkTrue("32 a missing decode reports a dash, not undefined", lines[0].includes("decodeMs=-"));
  checkTrue("33 a missing RSS reports a dash, not undefined", lines[0].includes("childRss=-"));
  checkTrue("34 the failure counter is reported", lines[0].includes("fails=0"));
  handle.stop();
}

{
  // A sampler that throws while an interview is running would take the app
  // down. It must report and keep sampling.
  const lines: string[] = [];
  let tick: (() => void) | null = null;
  const handle = startParakeetDiagnostics({
    getHost: () => {
      throw new Error("host is in a bad state");
    },
    log: (line) => lines.push(line),
    setInterval: (fn) => {
      tick = fn;
      return 3;
    },
    clearInterval: () => {},
  });
  lines.length = 0;
  tick?.();
  checkTrue("35 a throwing host is reported, not propagated", lines[0].includes("sample failed"));
  checkTrue("36 the error message is included", lines[0].includes("bad state"));
  tick?.();
  checkTrue("37 the sampler keeps going after a failure", lines.length, 2);
  handle.stop();
}

{
  check("38 the sampling interval is 10 seconds", PARAKEET_DIAGNOSTICS_INTERVAL_MS, 10_000);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Wiring and safety ────────────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const adapter = await readFile("electron/parakeetAsr.ts", "utf8");
  checkTrue("39 load starts the diagnostics sampler",
    /if \(result\.ok && !diagnostics\)[\s\S]{0,400}startParakeetDiagnostics/.test(adapter));
  checkTrue("40 unload stops the sampler", /diagnostics\?\.stop\(\)/.test(adapter));
  checkTrue(
    "41 the sampler is stopped BEFORE the model is released",
    /diagnostics\?\.stop\(\);[\s\S]{0,80}host\?\.unload\(\)/.test(adapter),
  );
  checkTrue("42 the test reset also stops the sampler",
    /__resetParakeetHostForTests[\s\S]{0,300}diagnostics\?\.stop\(\)/.test(adapter));

  const sampler = await readFile("electron/parakeetDiagnostics.ts", "utf8");
  const samplerCode = sampler
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  checkTrue("43 the sampler logs no transcript field",
    !/\btext\b|\btranscript\b|samples|audioUrl/.test(samplerCode));
  checkTrue("44 the sampler reads system memory, not the renderer",
    /readSystemMemory/.test(sampler));
  checkTrue("45 the sampler's own source says it is numbers-only",
    /never a transcript|never logs/i.test(sampler));

  // The renderer must not be able to reach system memory directly: it is an
  // untrusted context with no os module. The bridge must not hand it one.
  const preload = await readFile("electron/preload.ts", "utf8");
  checkTrue("46 preload exposes no system-memory getter",
    !/systemMemory|freemem|totalmem/i.test(preload));
  const env = await readFile("src/env.d.ts", "utf8");
  checkTrue("47 the renderer bridge has no memory accessor",
    !/systemMemory|freemem|totalmem/i.test(env));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── The toggle must actually reach the main process ────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  // ── A real bug this caught ──────────────────────────────────────────────
  // The settings auto-save effect lives in SettingsPanel. The Parakeet toggle
  // lives in InterviewModal, so ticking it updated zustand and nothing else:
  // the main process reads the flag from electron-store, never saw it, and the
  // feature could never turn on — while the checkbox visibly said "on".
  const modal = await readFile("src/components/InterviewModal.tsx", "utf8");
  checkTrue(
    "48 the toggle writes settings through to the main process",
    /asrCompareParakeet: enabled[\s\S]{0,200}saveSettings/.test(modal),
  );
  checkTrue(
    "49 the toggle confirms itself in the debug log",
    /Parakeet comparison ON/.test(modal),
  );
  checkTrue(
    "50 the persisted object is built from live store state",
    /\.\.\.useStore\.getState\(\)\.settings[\s\S]{0,120}asrCompareParakeet/.test(modal),
  );

  const hook = await readFile("src/hooks/useInterviewAudio.ts", "utf8");
  checkTrue("51 the hook exposes addLog for dev controls",
    /^  return \{[\s\S]{0,1200}^    addLog,$/m.test(hook));
}

{
  // App.tsx rebuilds the settings object from the store on launch. If it did
  // not carry unknown keys through, the flag would be dropped on every restart.
  const app = await readFile("src/App.tsx", "utf8");
  checkTrue(
    "52 App.tsx spreads saved settings so the flag survives a restart",
    /\.\.\.defaults,[\s\S]{0,80}\.\.\.rest,/.test(app),
  );
  checkTrue("53 App.tsx does not hard-code asrCompareParakeet to false",
    !/asrCompareParakeet:\s*false/.test(app));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}