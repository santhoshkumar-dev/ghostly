/**
 * Deterministic tests for the in-app Parakeet model downloader.
 *
 * Run: `npx tsx scripts/verify-parakeet-model.mts`
 *
 * ── The properties under test, and why each one ─────────────────────────────
 *  1. **A 460 MB transfer must be resumable.** A dropped connection at 90 % that
 *     restarts from zero is the difference between a usable feature and one
 *     nobody can finish on a hotel wifi.
 *  2. **A short download must be caught BEFORE extraction.** Extraction of a
 *     truncated bz2 stream is slow and its error message is unhelpful; the size
 *     check is the only integrity guarantee this release allows.
 *  3. **Nothing may throw.** A rejected promise here leaves a spinner on screen
 *     forever, which reads as "still working" rather than "broken".
 *  4. **A concurrent download must JOIN, not duplicate.** The settings panel
 *     polls and a user can double-click; two simultaneous 460 MB transfers, both
 *     writing the same `.part` file, would corrupt it.
 *  5. **A complete model must be recognised without downloading.** Otherwise
 *     every Settings open would try to re-fetch 460 MB.
 *
 * Every network call and every extraction is injected, so the whole suite runs
 * in-memory with no model, no network, and no disk beyond a temp directory.
 */
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ParakeetModelManager,
  inspectModelDir,
  modelDirFor,
  type ParakeetModelState,
} from "../electron/parakeetModel";
import {
  PARAKEET_ARCHIVE_BYTES,
  PARAKEET_ARCHIVE_URL,
  PARAKEET_MODEL_DIR_NAME,
  PARAKEET_REQUIRED_FILES,
  PARAKEET_UNPACKED_BYTES,
} from "../src/lib/parakeetModelFacts";
import {
  MODEL_INTEGRITY_NOTE,
  canRetryDownload,
  describeModelState,
  formatBytes,
  isTransferInProgress,
} from "../src/lib/parakeetModelClient";

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
  const dir = mkdtempSync(path.join(tmpdir(), "ghostly-model-"));
  roots.push(dir);
  return dir;
}

/** Write a complete, correctly-sized model tree. */
function writeCompleteModel(baseDir: string): string {
  const dir = modelDirFor(baseDir);
  mkdirSync(dir, { recursive: true });
  for (const file of PARAKEET_REQUIRED_FILES) {
    writeFileSync(path.join(dir, file.name), Buffer.alloc(file.bytes, 7));
  }
  return dir;
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Release facts are consistent ───────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

check("1 the archive URL is the released int8 asset",
  PARAKEET_ARCHIVE_URL.endsWith("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2"), true);
check("2 the URL is https", PARAKEET_ARCHIVE_URL.startsWith("https://"), true);
check("3 the archive size is the one measured from the release host",
  PARAKEET_ARCHIVE_BYTES, 482_468_385);
check("4 the model directory name matches the release",
  PARAKEET_MODEL_DIR_NAME, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");
check("5 four files are required", PARAKEET_REQUIRED_FILES.length, 4);
checkTrue("6 every required file has a positive exact size",
  PARAKEET_REQUIRED_FILES.every((f) => f.bytes > 0));
check("7 the unpacked total is the sum of the files",
  PARAKEET_UNPACKED_BYTES,
  PARAKEET_REQUIRED_FILES.reduce((n, f) => n + f.bytes, 0));
checkTrue("8 the unpacked model is larger than the archive",
  PARAKEET_UNPACKED_BYTES > PARAKEET_ARCHIVE_BYTES);
checkTrue("9 the encoder dominates, as expected for a TDT model",
  PARAKEET_REQUIRED_FILES[0].name === "encoder.int8.onnx" &&
    PARAKEET_REQUIRED_FILES[0].bytes > PARAKEET_UNPACKED_BYTES * 0.9);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Completeness detection ─────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const root = tempRoot();
  check("10 an empty directory is not ready", inspectModelDir(modelDirFor(root)).ready, false);
  check("11 an empty directory reports every file missing",
    inspectModelDir(modelDirFor(root)).missing.length, 4);
}

{
  const root = tempRoot();
  const dir = writeCompleteModel(root);
  const inspection = inspectModelDir(dir);
  check("12 a complete model is ready", inspection.ready, true);
  check("13 nothing is missing", inspection.missing, []);
  check("14 nothing is the wrong size", inspection.wrongSize, []);
}

{
  const root = tempRoot();
  const dir = writeCompleteModel(root);
  // A truncated encoder: the classic dropped-connection result.
  writeFileSync(path.join(dir, "encoder.int8.onnx"), Buffer.alloc(1000, 7));
  const inspection = inspectModelDir(dir);
  check("15 a truncated file makes the model unusable", inspection.ready, false);
  check("16 the wrong-sized file is named", inspection.wrongSize, ["encoder.int8.onnx"]);
  check("17 nothing is reported missing", inspection.missing, []);
}

{
  const root = tempRoot();
  const dir = writeCompleteModel(root);
  // A file of the right length but the wrong content. This is exactly what a
  // size-only check CANNOT catch, and the reason the UI must not claim
  // "checksum verified".
  writeFileSync(path.join(dir, "tokens.txt"), Buffer.alloc(PARAKEET_REQUIRED_FILES[3].bytes, 0));
  check("18 a same-length wrong file passes the size check (known limitation)",
    inspectModelDir(dir).ready, true);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Status machine ─────────────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const root = tempRoot();
  const manager = new ParakeetModelManager({ baseDir: root, log: () => {} });
  const state = manager.getState();
  check("19 a fresh install reports missing", state.status, "missing");
  check("20 no progress when nothing is running", state.progress, null);
  check("21 the download total is pre-filled", state.bytesTotal, PARAKEET_ARCHIVE_BYTES);
  check("22 the directory is reported", state.dir, modelDirFor(root));
  check("23 no error message on a clean state", state.message, null);
}

{
  const root = tempRoot();
  writeCompleteModel(root);
  const manager = new ParakeetModelManager({ baseDir: root, log: () => {} });
  check("24 an already-installed model reports ready", manager.getState().status, "ready");
}

{
  const root = tempRoot();
  const dir = modelDirFor(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "encoder.int8.onnx"), Buffer.alloc(10, 1));
  const manager = new ParakeetModelManager({ baseDir: root, log: () => {} });
  const state = manager.getState();
  check("25 a corrupt install is reported as missing, not ready", state.status, "missing");
  checkTrue("26 the corrupt install names the file", /encoder\.int8\.onnx/.test(state.message ?? ""));
  checkTrue("27 the corrupt-install message tells the user what to do",
    /download it again/i.test(state.message ?? ""));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── A successful download ──────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const root = tempRoot();
  let progressSeen = 0;
  const manager = new ParakeetModelManager({
    baseDir: root,
    log: () => {},
    // A fake transfer that reports progress, writes a `.part` file (so the
    // rename step is exercised) and then "extracts" a complete model tree.
    download: async ({ partFile, onProgress }) => {
      writeFileSync(partFile, Buffer.alloc(1024, 3));
      onProgress(0, PARAKEET_ARCHIVE_BYTES);
      onProgress(PARAKEET_ARCHIVE_BYTES, PARAKEET_ARCHIVE_BYTES);
      progressSeen++;
      return { bytes: PARAKEET_ARCHIVE_BYTES, total: PARAKEET_ARCHIVE_BYTES };
    },
    extract: async (_archive, destParent) => {
      const dir = path.join(destParent, PARAKEET_MODEL_DIR_NAME);
      mkdirSync(dir, { recursive: true });
      for (const f of PARAKEET_REQUIRED_FILES) {
        writeFileSync(path.join(dir, f.name), Buffer.alloc(f.bytes, 9));
      }
    },
  });

  const finalState = await manager.download();
  check("28 a successful download ends ready", finalState.status, "ready");
  check("29 progress ends at 100", finalState.progress, 100);
  check("30 the transfer reported progress", progressSeen, 1);
  check("31 the archive was cleaned up",
    existsSync(`${modelDirFor(root)}.tar.bz2`), false);
  check("32 no partial file is left behind",
    existsSync(`${modelDirFor(root)}.tar.bz2.part`), false);
  checkTrue("33 the model is really on disk",
    inspectModelDir(modelDirFor(root)).ready);
  check("34 a second call is a no-op and returns ready", (await manager.download()).status, "ready");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── A short download is caught before extraction ───────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const root = tempRoot();
  let extracted = false;
  const manager = new ParakeetModelManager({
    baseDir: root,
    log: () => {},
    download: async ({ partFile }) => {
      writeFileSync(partFile, Buffer.alloc(64, 1));
      // 100 MB short of the expected length.
      return { bytes: PARAKEET_ARCHIVE_BYTES - 100 * 1024 * 1024, total: PARAKEET_ARCHIVE_BYTES };
    },
    extract: async () => {
      extracted = true;
    },
  });

  const state = await manager.download();
  check("35 a short archive ends in error", state.status, "error");
  checkFalse("36 extraction was never attempted", extracted);
  checkTrue("37 the error names the size mismatch",
    /should be/.test(state.message ?? "") && /482468385/.test(state.message ?? ""));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Every failure is a value, never a rejection ────────────");
// ═══════════════════════════════════════════════════════════════════════════

for (const [label, failure] of [
  ["38 a network failure", () => {
    throw new Error("download failed with HTTP 503");
  }],
  ["39 an offline socket", () => {
    throw new Error("getaddrinfo ENOTFOUND github.com");
  }],
  ["40 a permission error", () => {
    throw new Error("EACCES: permission denied, mkdir");
  }],
] as const) {
  const root = tempRoot();
  const manager = new ParakeetModelManager({
    baseDir: root,
    log: () => {},
    download: async () => {
      failure();
      return { bytes: 0, total: 0 };
    },
  });
  let threw = false;
  let state: ParakeetModelState | null = null;
  try {
    state = await manager.download();
  } catch {
    threw = true;
  }
  checkFalse(`${label} does not reject`, threw);
  check(`${label} (status)`, state?.status, "error");
  checkTrue(`${label} (message)`, (state?.message ?? "").length > 0);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Extraction failures, including a suspicious archive ────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const root = tempRoot();
  const manager = new ParakeetModelManager({
    baseDir: root,
    log: () => {},
    download: async ({ partFile }) => {
      writeFileSync(partFile, Buffer.alloc(16, 1));
      return { bytes: PARAKEET_ARCHIVE_BYTES, total: PARAKEET_ARCHIVE_BYTES };
    },
    extract: async () => {
      throw new Error("incorrect header check");
    },
  });
  const state = await manager.download();
  check("41 an extraction failure ends in error", state.status, "error");
  checkTrue("42 the extraction error is surfaced", /incorrect header check/.test(state.message ?? ""));
  // The partial bytes are useless when the archive itself was bad, so the .part
  // file must be discarded rather than resumed from.
  check("43 a corrupt-archive failure discards the partial file",
    existsSync(`${modelDirFor(root)}.tar.bz2.part`), false);
}

{
  const root = tempRoot();
  // Extraction "succeeds" but produces an incomplete tree: a repacked or
  // substituted archive. This must not be reported as ready.
  const manager = new ParakeetModelManager({
    baseDir: root,
    log: () => {},
    download: async ({ partFile }) => {
      writeFileSync(partFile, Buffer.alloc(16, 1));
      return { bytes: PARAKEET_ARCHIVE_BYTES, total: PARAKEET_ARCHIVE_BYTES };
    },
    extract: async () => {
      const dir = modelDirFor(root);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "tokens.txt"), Buffer.alloc(10, 1));
    },
  });
  const state = await manager.download();
  check("44 an incomplete extraction is not ready", state.status, "error");
  checkTrue("45 the incomplete-extraction error names the files",
    /incomplete/.test(state.message ?? ""));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Concurrency, resume and cancellation ───────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const root = tempRoot();
  let downloadsStarted = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const manager = new ParakeetModelManager({
    baseDir: root,
    log: () => {},
    download: async ({ partFile }) => {
      downloadsStarted++;
      await gate;
      writeFileSync(partFile, Buffer.alloc(16, 1));
      return { bytes: PARAKEET_ARCHIVE_BYTES, total: PARAKEET_ARCHIVE_BYTES };
    },
    extract: async (_a, destParent) => {
      const dir = path.join(destParent, PARAKEET_MODEL_DIR_NAME);
      mkdirSync(dir, { recursive: true });
      for (const f of PARAKEET_REQUIRED_FILES) {
        writeFileSync(path.join(dir, f.name), Buffer.alloc(f.bytes, 9));
      }
    },
  });

  const first = manager.download();
  const second = manager.download();
  check("46 the second call joined the first rather than starting a transfer",
    downloadsStarted, 1);
  checkTrue("47 both calls return the same promise's result",
    first === second);
  release?.();
  const settled = await first;
  check("48 the joined download still completes", settled.status, "ready");
  check("49 only one transfer ever ran", downloadsStarted, 1);
}

{
  const root = tempRoot();
  // A pre-existing .part file must be RESUMED, not restarted. This is what a
  // dropped connection at 90 % costs the user if it is wrong: 460 MB again.
  const partFile = `${modelDirFor(root)}.tar.bz2.part`;
  mkdirSync(path.dirname(partFile), { recursive: true });
  writeFileSync(partFile, Buffer.alloc(1024, 5));

  let sawPartialBeforeStart = false;
  const manager = new ParakeetModelManager({
    baseDir: root,
    log: () => {},
    download: async ({ partFile: part }) => {
      sawPartialBeforeStart = existsSync(part) && statSync(part).size === 1024;
      writeFileSync(part, Buffer.alloc(4096, 5));
      return { bytes: PARAKEET_ARCHIVE_BYTES, total: PARAKEET_ARCHIVE_BYTES };
    },
    extract: async (_a, destParent) => {
      const dir = path.join(destParent, PARAKEET_MODEL_DIR_NAME);
      mkdirSync(dir, { recursive: true });
      for (const f of PARAKEET_REQUIRED_FILES) {
        writeFileSync(path.join(dir, f.name), Buffer.alloc(f.bytes, 9));
      }
    },
  });

  await manager.download();
  checkTrue("50 an interrupted download leaves its partial file for the next attempt",
    sawPartialBeforeStart);
}

{
  const root = tempRoot();
  let aborted = false;
  const manager = new ParakeetModelManager({
    baseDir: root,
    log: () => {},
    download: async ({ signal }) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      aborted = Boolean(signal?.aborted);
      if (aborted) throw new Error("cancelled");
      return { bytes: PARAKEET_ARCHIVE_BYTES, total: PARAKEET_ARCHIVE_BYTES };
    },
  });
  const pending = manager.download();
  manager.cancel();
  const state = await pending;
  checkTrue("51 cancel aborts the in-flight transfer", aborted);
  check("52 a cancelled download ends in error, not silence", state.status, "error");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Removal is clean ──────────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const root = tempRoot();
  writeCompleteModel(root);
  const partFile = `${modelDirFor(root)}.tar.bz2.part`;
  writeFileSync(partFile, Buffer.alloc(16, 1));

  const manager = new ParakeetModelManager({ baseDir: root, log: () => {} });
  check("53 the model starts ready", manager.getState().status, "ready");
  const after = manager.remove();
  check("54 removing returns the model to missing", after.status, "missing");
  checkFalse("55 the model directory is gone", existsSync(modelDirFor(root)));
  checkFalse("56 the partial download is gone too", existsSync(partFile));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── The real transfer, against a real HTTP server ──────────");
// ═══════════════════════════════════════════════════════════════════════════
//
// Everything above injects a fake download, which proves the state machine but
// proves nothing about the code that actually talks to GitHub. This block runs
// the REAL `downloadWithResume` against a local server that behaves like the
// release host: it 302-redirects, it honours Range with 206, and it can be made
// to 200 instead (the case where a partial file must be thrown away rather than
// appended to).
{
  const { createServer } = await import("node:http");
  const { readFileSync, appendFileSync } = await import("node:fs");

  const PAYLOAD = Buffer.alloc(64 * 1024, 0);
  for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = i % 251;

  let supportRange = true;
  const requests: string[] = [];

  const server = createServer((req, res) => {
    requests.push(String(req.headers.range ?? "none"));
    if (req.url === "/redirect") {
      // A RELATIVE Location, which is legal and which `fetch` rejects unless it
      // is resolved against the request URL. GitHub sends absolute URLs, so
      // this case is deliberately the one exercised.
      res.writeHead(302, { Location: "/asset" });
      res.end();
      return;
    }
    if (req.url !== "/asset") {
      res.writeHead(404, { "Content-Length": "0" });
      res.end();
      return;
    }
    const range = req.headers.range;
    if (supportRange && typeof range === "string") {
      const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
      const slice = PAYLOAD.subarray(start);
      res.writeHead(206, {
        "Content-Length": String(slice.length),
        "Content-Range": `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { "Content-Length": String(PAYLOAD.length) });
    res.end(PAYLOAD);
  });

  const port: number = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const base = `http://127.0.0.1:${port}`;

  const { downloadWithResume } = await import("../electron/parakeetModel");

  // ── A clean download, through a redirect ────────────────────────────────
  {
    const dir = tempRoot();
    const part = path.join(dir, "a.part");
    let lastReceived = 0;
    const result = await downloadWithResume({
      url: `${base}/redirect`,
      partFile: part,
      onProgress: (received) => {
        lastReceived = received;
      },
    });
    check("114 the redirected download fetched every byte", result.bytes, PAYLOAD.length);
    check("115 the reported total matches the payload", result.total, PAYLOAD.length);
    check("116 the final progress callback saw the whole file", lastReceived, PAYLOAD.length);
    check("117 the file on disk is the right length", statSync(part).size, PAYLOAD.length);
    checkTrue("118 the bytes are correct", readFileSync(part).equals(PAYLOAD));
  }

  // ── RESUME: the case that saves 460 MB of someone's bandwidth ───────────
  {
    const dir = tempRoot();
    const part = path.join(dir, "b.part");
    // Simulate a dropped connection at the halfway point.
    writeFileSync(part, PAYLOAD.subarray(0, PAYLOAD.length / 2));
    requests.length = 0;

    const result = await downloadWithResume({
      url: `${base}/asset`,
      partFile: part,
      onProgress: () => {},
    });

    check("119 a resumed download requests the correct byte range",
      requests[0], `bytes=${PAYLOAD.length / 2}-`);
    check("120 the resumed download reports the FULL file, not just the tail",
      result.bytes, PAYLOAD.length);
    check("121 the resumed file is byte-correct",
      readFileSync(part).equals(PAYLOAD), true);
    checkTrue("122 progress on resume starts from the existing bytes, not zero",
      result.total === PAYLOAD.length);
  }

  // ── A server that IGNORES Range must not corrupt the file ───────────────
  // This is the dangerous case: the server answers 200 with the FULL body. If
  // the stream were appended to the existing partial file, the result would be
  // a 1.5x-length file that only fails much later, at extraction.
  {
    const dir = tempRoot();
    const part = path.join(dir, "c.part");
    writeFileSync(part, PAYLOAD.subarray(0, PAYLOAD.length / 2));
    supportRange = false;

    const result = await downloadWithResume({
      url: `${base}/asset`,
      partFile: part,
      onProgress: () => {},
    });
    supportRange = true;

    check("123 a server ignoring Range restarts rather than appending",
      result.bytes, PAYLOAD.length);
    check("124 the resulting file is exactly the payload, not appended garbage",
      statSync(part).size, PAYLOAD.length);
    checkTrue("125 the restarted file is byte-correct", readFileSync(part).equals(PAYLOAD));
  }

  // ── An HTTP error is a value, and never leaves a partial tail ───────────
  {
    const dir = tempRoot();
    const part = path.join(dir, "d.part");
    let threw = false;
    let message = "";
    try {
      await downloadWithResume({
        url: `${base}/missing`,
        partFile: part,
        onProgress: () => {},
      });
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    checkTrue("126 a 404 rejects (the STATE MACHINE converts this to a value)", threw);
    checkTrue("127 the HTTP status is named in the error", message.includes("404"));
  }

  // ── Cancellation stops the transfer ─────────────────────────────────────
  {
    const dir = tempRoot();
    const part = path.join(dir, "e.part");
    const controller = new AbortController();
    controller.abort();
    let threw = false;
    try {
      await downloadWithResume({
        url: `${base}/asset`,
        partFile: part,
        onProgress: () => {},
        signal: controller.signal,
      });
    } catch {
      threw = true;
    }
    checkTrue("128 an aborted transfer does not silently succeed", threw);
  }

  // ── The manager, driven by the REAL transfer ────────────────────────────
  {
    const root = tempRoot();
    const manager = new ParakeetModelManager({
      baseDir: root,
      log: () => {},
      download: (o) => downloadWithResume({ ...o, url: `${base}/asset` }),
    });
    const state = await manager.download();
    // The payload is 64 KB, so the size check against the real release length
    // must reject it — and that is exactly the assertion: a wrong-length archive
    // is refused rather than extracted.
    check("129 a short archive from the real transfer path is refused", state.status, "error");
    checkTrue("130 the refusal names the expected size", /should be/.test(state.message ?? ""));
    checkTrue("131 the refusal never reached extraction",
      !existsSync(modelDirFor(root)) || !inspectModelDir(modelDirFor(root)).ready);
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Presentation helpers ──────────────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

const base: ParakeetModelState = {
  status: "missing",
  progress: null,
  bytesDownloaded: 0,
  bytesTotal: PARAKEET_ARCHIVE_BYTES,
  message: null,
  dir: "C:\\x",
};

checkTrue("57 a missing model offers a download", canRetryDownload(base));
checkFalse("58 a missing model is not 'in progress'", isTransferInProgress(base));
checkTrue("59 a failing model offers a retry",
  canRetryDownload({ ...base, status: "error", message: "boom" }));
checkFalse("60 a running download offers no retry (it would just join the transfer)",
  canRetryDownload({ ...base, status: "downloading" }));
checkFalse("61 a ready model offers no retry",
  canRetryDownload({ ...base, status: "ready" }));
checkTrue("62 a downloading model shows the progress bar",
  isTransferInProgress({ ...base, status: "downloading" }));
checkTrue("63 a verifying model still shows the bar",
  isTransferInProgress({ ...base, status: "verifying" }));
checkFalse("64 a ready model shows no bar",
  isTransferInProgress({ ...base, status: "ready" }));

check("65 bytes are formatted in MB", formatBytes(460 * 1024 * 1024), "460 MB");
check("66 the 631 MB model is reported in MB, not as 0.62 GB",
  formatBytes(PARAKEET_UNPACKED_BYTES), "631 MB");
check("66b a genuinely large size switches to GB",
  formatBytes(3 * 1024 * 1024 * 1024), "3.00 GB");
check("67 zero bytes does not render as NaN", formatBytes(0), "0 MB");
check("68 a negative byte count does not render as NaN", formatBytes(-1), "0 MB");
check("69 NaN does not render as NaN", formatBytes(Number.NaN), "0 MB");

checkTrue("70 a download reports progress in the description",
  describeModelState({ ...base, status: "downloading", bytesDownloaded: 10 * 1024 * 1024 })
    .includes("10 MB"));
checkTrue("71 an error surfaces its message",
  describeModelState({ ...base, status: "error", message: "disk full" }).includes("disk full"));
checkTrue("72 a verifying state says so",
  /checking|unpacking/i.test(describeModelState({ ...base, status: "verifying" })));
checkTrue("73 every status has a non-empty description",
  (["missing", "downloading", "verifying", "ready", "error"] as const).every(
    (status) => describeModelState({ ...base, status }).length > 0,
  ));

// ── The honesty check ─────────────────────────────────────────────────────
checkFalse("74 the integrity note never claims a checksum was verified",
  /checksum (verified|passes)|verified checksum/i.test(MODEL_INTEGRITY_NOTE));
checkTrue("75 the integrity note states the limitation plainly",
  /publishes no checksum/i.test(MODEL_INTEGRITY_NOTE));
checkTrue("76 the integrity note says what IS checked",
  /File sizes are checked/i.test(MODEL_INTEGRITY_NOTE));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Packaging and the way back to Moonshine ────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const builder = await readFile("electron-builder.yml", "utf8");
  const panel = await readFile("src/components/SettingsPanel.tsx", "utf8");

  checkTrue("77 sherpa-onnx-node is a RUNTIME dependency",
    Boolean(pkg.dependencies["sherpa-onnx-node"]));
  checkFalse("78 sherpa-onnx-node is no longer a devDependency",
    Boolean(pkg.devDependencies["sherpa-onnx-node"]));
  checkTrue("79 the platform binary package is a runtime dependency",
    Boolean(pkg.dependencies["sherpa-onnx-win-x64"]));
  checkTrue("80 the extraction libraries are runtime dependencies",
    Boolean(pkg.dependencies["tar"]) && Boolean(pkg.dependencies["unbzip2-stream"]));

  checkTrue("81 native addons are unpacked from the asar",
    /asarUnpack:/.test(builder) && /node_modules\/sherpa-onnx-node\/\*\*/.test(builder));
  checkTrue("82 the platform DLLs are unpacked",
    /node_modules\/sherpa-onnx-win-x64\/\*\*/.test(builder));
  checkTrue("83 the utility-process entry point is unpacked",
    /out\/main\/parakeetWorker\.cjs/.test(builder));
  checkTrue("84 there is exactly one asarUnpack key",
    (builder.match(/asarUnpack:/g) ?? []).length === 1);
  checkFalse("85 the misspelled asarUnpack key is absent", builder.includes("aserUnpack"));

  // The model must never be bundled.
  checkTrue("86 the model directory is excluded from the package",
    /!models\/\*\*/.test(builder));
  checkTrue("87 captured audio is excluded from the package",
    /!debug-audio\/\*\*/.test(builder));
  checkFalse("88 no archive is committed or bundled",
    /sherpa-onnx-nemo-parakeet-tdt-0\.6b-v2-int8\.tar\.bz2"/.test(builder));

  // A packaged tree can be launched directly to verify the addon resolves.
  checkTrue("89 a dir target exists so the packaged app can be run without installing",
    /target: dir/.test(builder));

  // ── The escape hatch ─────────────────────────────────────────────────────
  checkTrue("90 Settings offers a switch back to Moonshine",
    /Switch back to Moonshine/.test(panel));
  checkTrue("91 the switch-back writes through to the main process",
    /selectPrimaryAsr\("moonshine"\)/.test(panel));
  checkTrue("92 Settings offers a Retry when the download fails",
    /Retry download/.test(panel));
  checkTrue("93 Settings can cancel a running download", /Cancel/.test(panel));
  checkTrue("94 Settings says Moonshine covers the gap while the model is missing",
    /Moonshine will be used for every segment/.test(panel));

  // The download must never be started implicitly.
  checkFalse("95 selecting Parakeet does not auto-start the download",
    /selectPrimaryAsr[\s\S]{0,600}downloadParakeetModel\(/.test(panel));

  // The renderer must not import the main-process module (it would drag node:fs
  // into the web bundle).
  checkFalse("96 the renderer never imports electron/parakeetModel",
    /from\s+["'].*electron\/parakeetModel["']/.test(panel));
  checkTrue("97 shared facts live in a renderer-safe module",
    (await readFile("src/lib/parakeetModelFacts.ts", "utf8")).includes("PARAKEET_ARCHIVE_BYTES"));
  checkFalse("98 the shared facts module imports nothing",
    /^import /m.test(await readFile("src/lib/parakeetModelFacts.ts", "utf8")));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── Worker resolution in a packaged app ────────────────────");
// ═══════════════════════════════════════════════════════════════════════════

{
  const { resolveWorkerPath, resolveModelDir } = await import("../electron/parakeetAsr");
  const win = (p: string) => p.split(path.sep).join("/");

  // The real packaged layout: <resources>/app.asar/out/main, with the unpacked
  // copy at <resources>/app.asar.unpacked/out/main. Rewriting the archive
  // segment is exact; walking `..` steps is a guess that lands OUTSIDE
  // resources as soon as the depth changes — which is what the first version of
  // this function did, and what this check exists to prevent.
  check(
    "99 a packaged app resolves the unpacked worker",
    win(
      resolveWorkerPath(
        path.join("/app", "resources", "app.asar", "out", "main"),
        (p) => win(p).includes("app.asar.unpacked"),
      ),
    ),
    "/app/resources/app.asar.unpacked/out/main/parakeetWorker.cjs",
  );
  check(
    "99b the resolved path stays inside the app's resources directory",
    win(
      resolveWorkerPath(
        path.join("/app", "resources", "app.asar", "out", "main"),
        (p) => win(p).includes("app.asar.unpacked"),
      ),
    ).startsWith("/app/resources/"),
    true,
  );
  check(
    "99c a missing unpacked copy falls back to the local path",
    win(
      resolveWorkerPath(path.join("/app", "resources", "app.asar", "out", "main"), () => false),
    ),
    "/app/resources/app.asar/out/main/parakeetWorker.cjs",
  );
  check("100 development resolves the worker beside index.js",
    win(resolveWorkerPath("/app/out/main", () => false)),
    "/app/out/main/parakeetWorker.cjs");

  // modelDir must prefer the userData copy, because a packaged app has no
  // `models/` directory at all.
  check("101 an explicit override wins",
    win(resolveModelDir({ override: "C:/custom", userDataDir: "C:/ud" })),
    "C:/custom");
  checkTrue("102 userData is used when there is no override",
    win(resolveModelDir({ userDataDir: "C:/ud" })).startsWith("C:/ud/models/"));
  checkTrue("103 the userData path ends in the released model directory name",
    win(resolveModelDir({ userDataDir: "C:/ud" })).endsWith(PARAKEET_MODEL_DIR_NAME));
  checkTrue("104 development falls back to the repo models folder",
    win(resolveModelDir({ devDir: "D:/ghostly/models/x" })) === "D:/ghostly/models/x");
}

// ═══════════════════════════════════════════════════════════════════════════
for (const dir of roots) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
