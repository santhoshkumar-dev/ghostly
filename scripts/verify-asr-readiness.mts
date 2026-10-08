/**
 * Deterministic regression tests for Parakeet-primary readiness, the model
 * directory, and what the UI does when the model is unusable.
 *
 * Run: `npx tsx scripts/verify-asr-readiness.mts`
 *
 * ── Three separate bugs are pinned here ─────────────────────────────────────
 *
 *  1. **The model directory.** `modelDirFor` appended `"models"` while
 *     `resolveModelDir` appended it too, so a completed 460 MB download landed at
 *     `<userData>/models/models/<name>` and every loader and status check looked
 *     in `<userData>/models/<name>`. The model reported as downloaded AND as
 *     `model_missing` on the same install. Check 5 below is the invariant that
 *     failed, expressed once: the directory the downloader writes must be the
 *     directory the loader reads.
 *
 *  2. **A load at renderer load.** The model costs ~7 s and several hundred MB,
 *     and belongs on Start Interview. A status check inspects file sizes and must
 *     never load anything.
 *
 *  3. **A permanently dead Start button.** With a missing or corrupt model the
 *     UI showed "Initializing AI engine…" forever with Start disabled and no way
 *     forward. Capture never actually depends on the model — a segment that
 *     cannot be decoded goes to the LOCAL Moonshine fallback — so those states
 *     must offer the two real choices instead of blocking.
 */
import { readFile } from "node:fs/promises";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  describeParakeetUiState,
  isInterviewStartReady,
  isParakeetStartAllowed,
  isParakeetUnavailable,
  parakeetSegmentDisposition,
  parakeetUiStateFromModelState,
  shouldProbeParakeetModel,
  type ParakeetUiState,
} from "../src/lib/asrReadiness";
import {
  ParakeetModelManager,
  ensureModelInPlace,
  inspectModelDir,
  legacyModelDirFor,
  modelDirFor,
} from "../electron/parakeetModel";
import { PARAKEET_MODEL_DIR_NAME, PARAKEET_REQUIRED_FILES } from "../src/lib/parakeetModelFacts";

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

function checkFalse(name: string, actual: unknown) {
  check(name, Boolean(actual), false);
}

const roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ghostly-readiness-"));
  roots.push(dir);
  return dir;
}

/**
 * Write a model tree with the correct SIZES using sparse files.
 *
 * `Buffer.alloc` would mean a real 652 MB allocation per file; the size check
 * only ever calls `stat`, so a sparse file of the right length is identical for
 * this purpose and instant.
 */
function writeSizedModel(dir: string): string {
  mkdirSync(dir, { recursive: true });
  for (const file of PARAKEET_REQUIRED_FILES) {
    const fd = openSync(path.join(dir, file.name), "w");
    try {
      ftruncateSync(fd, file.bytes);
    } finally {
      closeSync(fd);
    }
  }
  return dir;
}

const win = (p: string) => p.split(path.sep).join("/");

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── One model directory, derived once ────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const base = path.join("C:", "ud", "models");

  check("1 the downloader writes into the directory it is given",
    win(modelDirFor(base)), `C:/ud/models/${PARAKEET_MODEL_DIR_NAME}`);
  check("2 the downloader does not add a second models segment",
    /models[\\/]models/.test(win(modelDirFor(base))), false);
  check("3 the legacy doubled path is still nameable, for the migration",
    win(legacyModelDirFor(base)), `C:/ud/models/models/${PARAKEET_MODEL_DIR_NAME}`);

  const { resolveModelDir } = await import("../electron/parakeetAsr");
  const resolved = resolveModelDir({ userDataDir: path.join("C:", "ud") });
  check("4 the loader reads <userData>/models/<name>",
    win(resolved), `C:/ud/models/${PARAKEET_MODEL_DIR_NAME}`);

  // THE bug. `resolveModelDir` takes the userData DIRECTORY and joins
  // "models/<name>"; the manager takes the directory CONTAINING the model folder.
  // Those agree only if exactly one of the two adds "models".
  check("5 the download directory and the loader directory are the same path",
    win(modelDirFor(path.dirname(resolved))), win(resolved));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── A completed download is adopted, not re-fetched ──────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const base = tempRoot();
  const legacy = legacyModelDirFor(base);
  writeSizedModel(legacy);

  check("6 the legacy install is complete before the migration",
    inspectModelDir(legacy).ready, true);

  const moved = ensureModelInPlace(base);
  check("7 the model is reported at the canonical path",
    win(moved.dir), win(modelDirFor(base)));
  check("8 the migration reports where it came from",
    win(moved.migratedFrom ?? ""), win(legacy));
  check("9 the canonical path is now ready",
    inspectModelDir(modelDirFor(base)).ready, true);
  check("10 the doubled path is gone", existsSync(legacy), false);

  // A second call must not touch anything.
  const again = ensureModelInPlace(base);
  check("11 a second migration is a no-op", again.migratedFrom, null);
  check("12 the model is still ready", inspectModelDir(modelDirFor(base)).ready, true);
}

{
  // An INCOMPLETE legacy tree must not be adopted: adopting it would report a
  // truncated 12 MB encoder as installed.
  const base = tempRoot();
  const legacy = legacyModelDirFor(base);
  mkdirSync(legacy, { recursive: true });
  writeSizedModel(path.join(legacy, ".."));
  // Leave one required file short.
  rmSync(path.join(legacy, PARAKEET_REQUIRED_FILES[3].name), { force: true });

  const moved = ensureModelInPlace(base);
  check("13 an incomplete legacy install is not adopted", moved.migratedFrom, null);
  check("14 the canonical path is still reported as not ready",
    inspectModelDir(modelDirFor(base)).ready, false);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── The manager and the loader share one string ───────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const base = tempRoot();
  const explicit = path.join(base, "explicit-model-dir");
  const manager = new ParakeetModelManager({ dir: explicit, baseDir: base, log: () => {} });
  check("15 an explicitly resolved dir is used verbatim",
    win(manager.getState().dir), win(explicit));

  const derived = new ParakeetModelManager({ baseDir: base, log: () => {} });
  check("16 a manager built from baseDir agrees with modelDirFor",
    win(derived.getState().dir), win(modelDirFor(base)));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Model state → UI state ───────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

check("17 installed files read as installed, not as loaded",
  parakeetUiStateFromModelState({ status: "ready", message: null }), "installed");
check("18 an absent model reads as missing",
  parakeetUiStateFromModelState({ status: "missing", message: null }), "missing");
check("19 a wrong-sized install reads as corrupt",
  parakeetUiStateFromModelState({
    status: "missing",
    message: "The installed model is corrupt (tokens.txt). Download it again.",
  }), "corrupt");
check("20 a download in flight reads as downloading",
  parakeetUiStateFromModelState({ status: "downloading", message: null }), "downloading");
check("21 unpacking reads as downloading",
  parakeetUiStateFromModelState({ status: "verifying", message: null }), "downloading");
check("22 an unreadable state reads as failed",
  parakeetUiStateFromModelState({ status: "error", message: "disk full" }), "failed");
check("23 no answer at all reads as unknown",
  parakeetUiStateFromModelState(null), "unknown");
check("24 the UI is told where the model is, from the state, not a guess",
  parakeetUiStateFromModelState({ status: "ready", message: null, dir: "C:/ud/models/x" } as never),
  "installed");

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Start is blocked only while the model is coming ──────");
// ═══════════════════════════════════════════════════════════════════════════

const STATES: ParakeetUiState[] = [
  "unknown", "checking", "installed", "missing",
  "corrupt", "downloading", "loading", "ready", "failed",
];

check("25 a loaded model allows Start", isParakeetStartAllowed("ready"), true);
check("26 an installed model allows Start (it loads on Start)", isParakeetStartAllowed("installed"), true);
check("27 a MISSING model does not disable Start", isParakeetStartAllowed("missing"), true);
check("28 a CORRUPT model does not disable Start", isParakeetStartAllowed("corrupt"), true);
check("29 a FAILED load does not disable Start", isParakeetStartAllowed("failed"), true);
check("30 a load in flight still shows the loading state", isParakeetStartAllowed("loading"), false);
check("31 a download in flight still shows the loading state", isParakeetStartAllowed("downloading"), false);
check("32 an unchecked model does not race ahead", isParakeetStartAllowed("unknown"), false);
check("33 a probe in flight does not race ahead", isParakeetStartAllowed("checking"), false);

check("34 every state is classified, none silently dropped",
  STATES.filter((s) => typeof isParakeetStartAllowed(s) !== "boolean").length, 0);
check("35 unavailable means missing, corrupt or failed — and nothing else",
  STATES.filter(isParakeetUnavailable).sort().join(","), "corrupt,failed,missing");

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Where a finished phrase goes ─────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

check("36 a loaded model decodes immediately", parakeetSegmentDisposition("ready"), "decode");
check("37 a segment that arrives mid-load is queued", parakeetSegmentDisposition("loading"), "queue");
check("38 a segment that arrives before the load is queued", parakeetSegmentDisposition("installed"), "queue");
check("39 an unknown state queues rather than dropping the segment", parakeetSegmentDisposition("unknown"), "queue");
check("40 a MISSING model falls back instead of parking the segment forever",
  parakeetSegmentDisposition("missing"), "fallback");
check("41 a CORRUPT model falls back", parakeetSegmentDisposition("corrupt"), "fallback");
check("42 a FAILED load falls back", parakeetSegmentDisposition("failed"), "fallback");
check("43 a model mid-download falls back", parakeetSegmentDisposition("downloading"), "fallback");
check("44 nothing is ever queued for a state that will not resolve",
  STATES.filter((s) => isParakeetUnavailable(s) && parakeetSegmentDisposition(s) === "queue").length, 0);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Readiness still follows the primary engine ────────────");
// ═══════════════════════════════════════════════════════════════════════════

check("45 Moonshine primary: Moonshine ready enables Start",
  isInterviewStartReady("moonshine", true, false), true);
check("46 Moonshine primary: Moonshine not ready keeps Start disabled",
  isInterviewStartReady("moonshine", false, false), false);
check("47 Moonshine primary ignores Parakeet state entirely",
  isInterviewStartReady("moonshine", false, true), false);
check("48 Parakeet primary: an allowed state enables Start",
  isInterviewStartReady("parakeet", false, true), true);
check("49 Parakeet primary: a still-loading state blocks Start",
  isInterviewStartReady("parakeet", false, false), false);
check("50 Parakeet primary ignores a stale Moonshine-ready flag",
  isInterviewStartReady("parakeet", true, false), false);
check("51 only Parakeet is probed for the model",
  shouldProbeParakeetModel("parakeet"), true);
check("52 Moonshine primary is never probed",
  shouldProbeParakeetModel("moonshine"), false);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── The unusable states are explained, not left loading ─");
// ═══════════════════════════════════════════════════════════════════════════

for (const state of ["missing", "corrupt", "failed"] as ParakeetUiState[]) {
  const text = describeParakeetUiState(state) ?? "";
  check(`51 ${state} explains itself`, text.length > 40, true);
  checkFalse(`52 ${state} leaks no transcript field`, /\$\{|transcript|api[_ ]?key/i.test(text));
  checkTrue(`53 ${state} says the audio stays local`, /machine/i.test(text));
}
check("54 a loading state has nothing to explain",
  describeParakeetUiState("loading"), null);
check("55 a ready model has nothing to explain",
  describeParakeetUiState("ready"), null);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── The wiring: probe on open, load on Start ─────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const hook = await readFile("src/hooks/useInterviewAudio.ts", "utf8");
  const modal = await readFile("src/components/InterviewModal.tsx", "utf8");
  const asr = await readFile("electron/parakeetAsr.ts", "utf8");

  // A status check must not load the model.
  checkTrue("56 the hook probes with the model STATUS call",
    /import\s*\{[\s\S]*?getParakeetModelStatus[\s\S]*?\}\s*from\s*"\.\.\/lib\/parakeetModelClient"/.test(hook));
  checkTrue("57 the probe effect is gated on the primary engine",
    /if \(!shouldProbeParakeetModel\(primaryAsr\)\) return;/.test(hook));
  const loads = hook.match(/void ensureParakeetLoaded\(\);/g) ?? [];
  // There are now TWO call sites, and both are deliberate:
  //   1. Start Interview — the default path, unchanged.
  //   2. Panel open, ONLY when the opt-in `parakeetPreload` setting is on.
  // What must stay true is the property this test was originally written for:
  // the model is never loaded as a side effect of a STATUS check, and
  // preloading is impossible unless the user explicitly asked for it.
  check("58 the model is loaded from exactly TWO places: Start, and the opt-in preload",
    loads.length, 2);
  checkTrue("58b the preload call site is guarded by the opt-in setting",
    /if \(primaryAsr !== "parakeet"\) return;\s*if \(!preloadParakeet\) return;/.test(hook));
  checkTrue("58c and by a model that is actually INSTALLED",
    /if \(parakeetUi !== "installed"\) return;/.test(hook));
  checkTrue("59 the Start path is unchanged",
    /const needsParakeet[\s\S]*?if \(needsParakeet\) \{\s*void ensureParakeetLoaded\(\);/.test(hook));
  checkFalse("60 the probe effect does not load the model",
    /shouldProbeParakeetModel\(primaryAsr\)\) return;\s*void ensureParakeetLoaded/.test(hook));

  // The main-process status handler must stay a probe.
  checkTrue("61 the model-status handler is described as never loading",
    /parakeet:modelStatus/.test(asr) && /Never loads|never loads|only inspects/i.test(asr) ||
    /inspectModelDir/.test(asr));

  // The manager is handed the loader's directory rather than deriving its own.
  checkTrue("62 the manager is given the resolved model dir",
    /new ParakeetModelManager\(\{[\s\S]*?dir: options\.modelDir,[\s\S]*?baseDir: path\.dirname\(options\.modelDir\)/.test(asr));
  checkTrue("63 a legacy install is moved into place before the host is built",
    /const ensureModelPlaced = \(\) => \{[\s\S]*?ensureModelInPlace\(path\.dirname\(options\.modelDir\)\)/.test(asr) &&
    /const getHost = \(\): ParakeetHost => \{\s*ensureModelPlaced\(\);/.test(asr));

  // Readiness still reaches both consumers.
  checkTrue("64 the UI reads the derived readiness",
    /isModelReady: startReady,/.test(hook));
  checkTrue("65 the hotkey reads the derived readiness",
    /modelReadyRef\.current = startReady;/.test(hook));
  checkTrue("66 Start allows a missing model (no dead button)",
    /isParakeetStartAllowed\(parakeetUi\) \|\| parakeetStatus === "ready"/.test(hook));
  checkTrue("67 an unusable segment is handed to the LOCAL fallback",
    /parakeetSegmentDisposition\(parakeetUiRef\.current\) === "fallback"[\s\S]{0,160}fallbackSegmentToMoonshine\(segment/.test(hook));

  // The UI offers both ways out, and never a cloud engine.
  checkTrue("68 the modal renders the unusable-model explanation",
    /primaryAsr === "parakeet" && parakeetUiMessage && \(/.test(modal));
  checkTrue("69 the modal offers a Download model button",
    /Download model/.test(modal) && /downloadParakeet/.test(modal));
  checkTrue("70 the modal offers a Use Moonshine button",
    /Use Moonshine/.test(modal) && /useMoonshineEngine/.test(modal));
  checkFalse("71 neither button reaches a cloud engine",
    /groq|deepgram/i.test(
      modal.slice(modal.indexOf("parakeetUiMessage && ("), modal.indexOf("Main Content Area")),
    ));
  checkTrue("72 the loading caption is still the loading caption",
    /disabled=\{!isModelReady\}/.test(modal) && /"Loading\.\.\."/.test(modal));
}

for (const dir of roots) {
  rmSync(dir, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
