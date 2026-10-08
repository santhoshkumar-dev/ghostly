/**
 * Facts about the Parakeet model release — URL, archive size, file sizes.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 * Both the main process (which downloads and verifies) and the renderer (which
 * shows "631 MB installed" and the progress total) need these numbers. They
 * cannot import from each other: `electron/parakeetModel.ts` imports `node:fs`,
 * `node:path` and `node:crypto`, and pulling that into the renderer bundle would
 * break the web build outright. Duplicating the numbers would be worse — the two
 * copies would drift, and a drifted size constant turns a real integrity check
 * into a permanently failing one.
 *
 * So the numbers live here, with no imports at all, and both sides read them.
 *
 * ── On the absence of a checksum ────────────────────────────────────────────
 * The release publishes no `.sha256`, `.md5` or `.sha256sum` asset (all 404).
 * There is therefore no hash to verify against, and the integrity guarantee is
 * size-based only. That limitation is stated in the UI and in the report rather
 * than hidden behind the word "verified" — a size check cannot detect a
 * correctly-sized corrupted file, and pretending otherwise would be the most
 * misleading thing this feature could do.
 */

/** The archive GitHub actually publishes. The non-int8 asset 404s. */
export const PARAKEET_ARCHIVE_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2";

/**
 * Byte length of the archive, as reported by the release host.
 *
 * Used to detect a short download BEFORE spending a minute on extraction: 460 MB
 * received out of 460 MB expected is the one integrity check available.
 */
export const PARAKEET_ARCHIVE_BYTES = 482_468_385;

/** The model directory name, inside `<userData>/models`. */
export const PARAKEET_MODEL_DIR_NAME =
  "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8";

/**
 * Required files and their exact sizes, in bytes.
 *
 * EXACT, not a minimum. These are the sizes of the published int8 model, and a
 * file of a different length is a different file. Accepting it "because it is
 * big enough" would defeat the only integrity check available here.
 *
 * Measured from the release archive itself, not estimated.
 */
export const PARAKEET_REQUIRED_FILES: ReadonlyArray<{
  readonly name: string;
  readonly bytes: number;
}> = [
  { name: "encoder.int8.onnx", bytes: 652_184_296 },
  { name: "decoder.int8.onnx", bytes: 7_257_753 },
  { name: "joiner.int8.onnx", bytes: 1_739_080 },
  { name: "tokens.txt", bytes: 9_384 },
];

/** Total unpacked size, for the "631 MB" figure the UI shows. */
export const PARAKEET_UNPACKED_BYTES = PARAKEET_REQUIRED_FILES.reduce(
  (n, f) => n + f.bytes,
  0,
);

/**
 * Resident memory the loaded model costs, in MB, and where that number comes
 * from.
 *
 * ── MEASURED, not estimated ──────────────────────────────────────────────────
 * Taken from three consecutive real loads through the production
 * `utilityProcess` path (`npx electron scripts/smoke-parakeet-host.cjs` on this
 * machine, 7.8 GB total RAM):
 *
 *   child RSS immediately after load      725.5 / 736.6 / —  MB
 *   child RSS after one 7.4 s decode      783.6 / — / —    MB
 *
 * So ~740 MB is the honest number to quote for "the model is loaded", and ~785
 * MB once it has decoded something. The extra ~45 MB is decoder scratch space,
 * not weights, and it is not returned between segments.
 *
 * ── Why this is a separate constant ─────────────────────────────────────────
 * It appears in three places that cannot import each other (Settings copy, the
 * interview panel caption, and the doc comment on the setting itself), and a
 * figure that drifts between them is worse than no figure.
 */
export const PARAKEET_LOADED_RSS_MB = 740;

/** RSS after the first decode, when decoder scratch has been allocated. */
export const PARAKEET_DECODED_RSS_MB = 785;

/**
 * One-line statement of what preloading costs, for the Settings toggle.
 *
 * Deliberately names both the RAM and the time it buys, so the choice is an
 * informed one rather than a preference between "on" and "off".
 */
export function describeParakeetPreloadCost(): string {
  return (
    `Loads the model (~${PARAKEET_LOADED_RSS_MB} MB of memory, ~7s) as soon as ` +
    `you open the Live Interview panel instead of when you press Start. ` +
    `It stays in memory until Stop Interview or 5 minutes of no speech.`
  );
}
