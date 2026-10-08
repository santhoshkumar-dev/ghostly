#!/usr/bin/env node
/**
 * Provision the Parakeet TDT 0.6B v2 int8 model for LOCAL evaluation.
 *
 * ── Rules this script obeys ─────────────────────────────────────────────────
 * • The model is downloaded from the official k2-fsa/sherpa-onnx release
 *   asset. No third-party mirror.
 * • The model is NEVER bundled into the application and NEVER committed: the
 *   target directory is gitignored (`models/`).
 * • Status is explicit: `missing` / `ready` / `error`. Nothing is assumed.
 * • No packaging changes. This only populates a local directory.
 *
 * Usage:
 *   node scripts/provision-parakeet-model.mjs            # status only
 *   node scripts/provision-parakeet-model.mjs --download # download if absent
 *   node scripts/provision-parakeet-model.mjs --dir <path>
 *
 * Overridable via PARAKEET_MODEL_DIR.
 */

import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/**
 * The official release asset.
 *
 * Verified with HTTP 200 before being hard-coded here. Note the documentation
 * site now advertises a different model (parakeet-unified), so the docs page is
 * NOT a reliable source for this filename.
 */
const MODEL_NAME = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";
const RELEASE_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/" +
  `${MODEL_NAME}.tar.bz2`;

const REQUIRED_FILES = [
  "encoder.int8.onnx",
  "decoder.int8.onnx",
  "joiner.int8.onnx",
  "tokens.txt",
];

function resolveModelDir(explicit) {
  return path.resolve(
    explicit ?? process.env.PARAKEET_MODEL_DIR ?? path.join(ROOT, "models", MODEL_NAME),
  );
}

/** @returns {"ready"|"missing"|"error"} plus a human-readable detail. */
export async function inspectModel(modelDir) {
  if (!existsSync(modelDir)) {
    return { status: "missing", detail: "directory does not exist", missing: REQUIRED_FILES };
  }
  const missing = REQUIRED_FILES.filter((f) => !existsSync(path.join(modelDir, f)));
  if (missing.length) {
    return { status: "missing", detail: `incomplete: missing ${missing.join(", ")}`, missing };
  }
  // A truncated download is worse than an absent one: the encoder would fail at
  // load time with an opaque onnxruntime error. Check sizes up front.
  try {
    const encoder = await stat(path.join(modelDir, "encoder.int8.onnx"));
    // The published int8 encoder is ~652 MB; anything under 100 MB is truncated.
    if (encoder.size < 100 * 1024 * 1024) {
      return {
        status: "error",
        detail: `encoder.int8.onnx is only ${(encoder.size / 1048576).toFixed(1)} MB — download looks truncated`,
        missing: [],
      };
    }
  } catch (err) {
    return { status: "error", detail: `could not stat encoder: ${err.message}`, missing: [] };
  }
  return { status: "ready", detail: "all required files present", missing: [] };
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = spawn("curl", ["-sL", "--fail", "-o", dest, url], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    req.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    req.on("error", reject);
    req.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`curl exited ${code}: ${stderr.trim() || "no output"}`));
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const wantDownload = argv.includes("--download");
  const dirIdx = argv.indexOf("--dir");
  const modelDir = resolveModelDir(dirIdx >= 0 ? argv[dirIdx + 1] : undefined);

  console.log("=== Parakeet model provisioning ===");
  console.log(`target : ${path.relative(ROOT, modelDir) || modelDir}`);
  console.log(`source : ${RELEASE_URL}`);
  console.log("");

  let state = await inspectModel(modelDir);
  console.log(`status : ${state.status} (${state.detail})`);

  if (state.status === "ready" && !wantDownload) {
    console.log("");
    console.log("Nothing to do. Pass --download to re-provision.");
    return;
  }

  if (!wantDownload) {
    console.log("");
    if (state.status === "missing") {
      console.log("To download the model:");
      console.log("  node scripts/provision-parakeet-model.mjs --download");
    } else {
      console.log("Re-provision after fixing the problem above:");
      console.log("  node scripts/provision-parakeet-model.mjs --download");
    }
    process.exit(state.status === "error" ? 1 : 0);
  }

  // ---- download ----
  const parent = path.dirname(modelDir);
  await mkdir(parent, { recursive: true });
  const archive = path.join(parent, `${MODEL_NAME}.tar.bz2`);

  console.log("");
  console.log("Downloading (about 461 MB compressed)... this can take a few minutes.");
  try {
    await download(RELEASE_URL, archive);
  } catch (err) {
    console.error(`FAIL: download failed — ${err.message}`);
    console.error(`      ${RELEASE_URL}`);
    process.exit(1);
  }

  const size = (await stat(archive)).size;
  if (size < 1024 * 1024) {
    console.error(`FAIL: archive is only ${(size / 1048576).toFixed(2)} MB — refusing to extract.`);
    process.exit(1);
  }
  console.log(`downloaded ${(size / 1048576).toFixed(1)} MB, extracting...`);

  const extract = spawn("tar", ["xjf", archive, "-C", parent], { stdio: "inherit" });
  const extractCode = await new Promise((res) => extract.on("exit", res));
  if (extractCode !== 0) {
    console.error(`FAIL: tar exited ${extractCode}`);
    process.exit(1);
  }
  await rm(archive, { force: true });

  state = await inspectModel(modelDir);
  console.log(`status : ${state.status} (${state.detail})`);

  if (state.status !== "ready") {
    console.error("");
    console.error("FAIL: the model did not provision cleanly.");
    process.exit(1);
  }

  const entries = await readdir(modelDir);
  console.log("");
  console.log(`files in ${path.basename(modelDir)}:`);
  for (const e of entries.sort()) {
    const s = await stat(path.join(modelDir, e)).catch(() => null);
    console.log(`  ${s && s.isFile() ? (s.size / 1048576).toFixed(1).padStart(8) : "        -"} MB  ${e}`);
  }
  console.log("");
  console.log("The model is gitignored and is never bundled into the application.");
}

// Run only when invoked directly. `pathToFileURL` is used rather than string
// concatenation because a Windows path like `D:\ghostly\script.mjs` does not
// produce a matching `file://` URL when hand-assembled.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}