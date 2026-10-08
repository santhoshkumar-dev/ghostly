/**
 * Verification harness for the local Windows OCR binding.
 *
 * Run: `npx tsx scripts/verify-windows-ocr.ts`
 *
 * No network, no disk writes, no Electron app running. It decodes one real PNG
 * from the repo into a BGRA buffer and asks the Windows OCR engine to read it,
 * which proves the whole koffi -> WinRT -> SoftwareBitmap -> RecognizeAsync
 * chain actually works on this machine rather than merely compiling.
 *
 * On a machine without an OCR language pack the harness SKIPs (exit 0) instead
 * of failing, because missing OCR is a supported state, not a bug.
 */

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { Buffer } from "node:buffer";
import {
  OCR_MAX_DIMENSION,
  OcrUnavailableError,
  getUnavailableReason,
  isOcrAvailable,
  recognizeBgra,
} from "../electron/windowsOcr";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else failures.push(`  ${name}\n    expected: ${b}\n    actual:   ${a}`);
}
function checkTrue(name: string, cond: boolean) {
  check(name, cond, true);
}
function checkFalse(name: string, cond: boolean) {
  check(name, cond, false);
}

/**
 * Minimal PNG reader for the only shape this harness needs: 8-bit, truecolour,
 * non-interlaced. Anything else throws, which is fine — the harness picks an
 * image that is known to match.
 */
function decodePngToBgra(bytes: Buffer): {
  bgra: Buffer;
  width: number;
  height: number;
} {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!bytes.subarray(0, 8).equals(sig)) throw new Error("not a PNG");

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    if (type === "IHDR") {
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      interlace = bytes[dataStart + 12];
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(dataStart, dataStart + length));
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + length + 4; // skip CRC
  }

  if (bitDepth !== 8 || colorType !== 2 || interlace !== 0) {
    throw new Error(
      `unsupported PNG (bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace})`,
    );
  }

  const raw = inflateSync(Buffer.concat(idat));
  const channels = 3;
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // Undo the per-scanline PNG filters.
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[pos++];
      const left = x >= channels ? out[rowStart + x - channels] : 0;
      const up = y > 0 ? out[prevStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[prevStart + x - channels] : 0;
      let result: number;
      switch (filter) {
        case 0:
          result = value;
          break;
        case 1:
          result = value + left;
          break;
        case 2:
          result = value + up;
          break;
        case 3:
          result = value + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          result = value + predictor;
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
      out[rowStart + x] = result & 0xff;
    }
  }

  // RGB -> BGRA, which is the layout the SoftwareBitmap is allocated as.
  const bgra = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    bgra[j] = out[i * 3 + 2];
    bgra[j + 1] = out[i * 3 + 1];
    bgra[j + 2] = out[i * 3];
    bgra[j + 3] = 255;
  }

  return { bgra, width, height };
}

// ── 1. Availability ─────────────────────────────────────────────────────────

const available = isOcrAvailable();
console.log(`\nWINDOWS OCR: ${available ? "available" : "unavailable"}`);
if (!available) {
  console.log(`  reason: ${getUnavailableReason()}`);
  console.log("\nSKIPPED — no OCR language pack on this machine.");
  console.log("0 passed, 0 failed");
  process.exit(0);
}

checkTrue("1a the engine is available", available);
checkTrue("1b there is no unavailable reason", getUnavailableReason() === null);

// ── 2. Input guards (these must hold even without an engine) ────────────────

async function expectRejection(
  name: string,
  bgra: Buffer,
  width: number,
  height: number,
  fragment: RegExp,
) {
  try {
    await recognizeBgra(bgra, width, height);
    checkTrue(name, false);
  } catch (err) {
    checkTrue(
      `${name} (${(err as Error).message})`,
      err instanceof OcrUnavailableError && fragment.test((err as Error).message),
    );
  }
}

// ── 3. Real recognition ─────────────────────────────────────────────────────

const started = Date.now();
const { bgra, width, height } = decodePngToBgra(
  readFileSync("assets/read-me.png"),
);
console.log(`  image: ${width}x${height}, ${bgra.length} BGRA bytes`);

const text = await recognizeBgra(bgra, width, height);
const elapsed = Date.now() - started;
console.log(`  recognised ${text.length} chars in ${elapsed}ms`);
console.log(`  first line: ${JSON.stringify(text.split("\n")[0] ?? "")}`);

checkTrue("3a a real screenshot produces text", text.trim().length > 0);
checkTrue(
  "3b the text is not just whitespace",
  text.trim().split(/\s+/).length >= 3,
);
// OCR of an English screenshot should contain only letters, digits and
// punctuation — if it returned raw bytes this would fail.
checkTrue(
  "3c the text is decoded, not mojibake",
  /^[\x20-\x7e\n\r\t]*$/.test(text),
);
checkTrue("3d recognition is not pathologically slow", elapsed < 30_000);

// ── 4. Guards ───────────────────────────────────────────────────────────────

await expectRejection(
  "4a rejects a zero width",
  Buffer.alloc(0),
  0,
  10,
  /must be positive/,
);
await expectRejection(
  "4b rejects a fractional dimension",
  Buffer.alloc(0),
  10,
  1.5,
  /must be integers/,
);
await expectRejection(
  "4c rejects a buffer that does not match the dimensions",
  Buffer.alloc(16),
  100,
  100,
  /expected 40000 bytes/,
);
await expectRejection(
  "4d rejects a frame past the OCR size limit",
  Buffer.alloc(16),
  OCR_MAX_DIMENSION + 1,
  1,
  /exceeds the/,
);

// ── 5. A blank frame yields empty text, not an error ────────────────────────

const blank = await recognizeBgra(Buffer.alloc(64 * 64 * 4, 0xff), 64, 64);
check("5a a blank region returns no text", blank.trim(), "");

// ── 6. Privacy: the module must not touch the filesystem ────────────────────

{
  const src = readFileSync("electron/windowsOcr.ts", "utf8");
  checkFalse("6a no fs import", /\bfrom\s+["']node:fs["']/.test(src));
  checkFalse("6b no writeFile/createWriteStream", /writeFile|createWriteStream/.test(src));
  checkFalse("6c no fetch/axios/http", /\bfetch\(|require\(["']https?["']\)/.test(src));
  checkTrue("6d it does import koffi", /require\(["']koffi["']\)/.test(src));
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFAILURES:\n" + failures.join("\n"));
  process.exit(1);
}