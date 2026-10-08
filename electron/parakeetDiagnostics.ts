import { ParakeetHost, type ParakeetHostMode } from "../src/lib/parakeetHost";
import { readSystemMemory, formatBytesMb } from "../src/lib/systemMemory";

/**
 * Dev-only Parakeet memory/latency sampler.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 * The open question about Parakeet is not accuracy, it is memory: the model
 * costs several hundred MB of resident memory on a machine that has roughly
 * 8 GB and is already running a video call. Whether that is acceptable cannot
 * be answered by a Phase 1 number taken on an idle-ish box. It needs a live
 * reading from DURING an interview, sampled repeatedly, next to the system
 * figure — because "the model uses 650 MB" and "the system had 395 MB left"
 * together mean something very different from the first number alone.
 *
 * ── Where it samples and why ───────────────────────────────────────────────
 * This runs in the MAIN process, and that is not incidental. The renderer cannot
 * read system memory at all: it is an untrusted web context with no `os` module
 * and no preload bridge to the OS counters. A sampler written in the renderer
 * could only ever report the host's own numbers and would look like it was doing
 * something it structurally cannot.
 *
 * ── What it deliberately never logs ────────────────────────────────────────
 * No transcript text, no audio, no captured samples. Only numbers: memory,
 * process size, latency, throughput. This log is expected to be pasted into
 * issue reports and read while an interview is running, so it must not be able
 * to leak what was said.
 *
 * ── Dev-only ───────────────────────────────────────────────────────────────
 * The caller must gate it on the same dev flag as the rest of Parakeet; see
 * `registerParakeetHandlers`. This module itself holds no timer until
 * `startParakeetDiagnostics` is called.
 */

/** How often a sample line is emitted. */
export const PARAKEET_DIAGNOSTICS_INTERVAL_MS = 10_000;

export interface ParakeetDiagnosticsOptions {
  getHost: () => ParakeetHost;
  /**
   * Whether this sampler is measuring Parakeet as the PRIMARY engine or as a
   * comparison column.
   *
   * This is not cosmetic. A child RSS figure taken while Moonshine is ALSO
   * resident does not describe what a user with Parakeet primary would see, and
   * presenting the two as the same measurement is how a comfortable-looking
   * number becomes a false claim. Every line is tagged with the mode so the two
   * can never be compared by accident.
   */
  mode?: ParakeetHostMode;
  /** Emitted line sink. Defaults to `console.log`. */
  log?: (line: string) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface ParakeetDiagnosticsHandle {
  stop: () => void;
}

export /** Read a value without letting a diagnostics summary take the app down. */
function getSafe<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

export function startParakeetDiagnostics(
  options: ParakeetDiagnosticsOptions,
): ParakeetDiagnosticsHandle {
  const log = options.log ?? ((line: string) => console.log(line));
  const setIntervalImpl =
    options.setInterval ?? ((fn, ms) => setInterval(fn, ms) as unknown);
  const clearIntervalImpl =
    options.clearInterval ?? ((handle) => clearInterval(handle as never));

  // A baseline, so every sample reports the DELTA the model is responsible for.
  // An absolute system figure alone cannot distinguish "Parakeet took 650 MB"
  // from "the box was already nearly full".
  const baseline = readSystemMemory();
  const mode: ParakeetHostMode = options.mode ?? "comparison";
  const tag = mode === "primary" ? "Parakeet-only" : "Parakeet-compare";

  /**
   * The lowest system-available figure seen while the model was resident.
   *
   * A per-sample reading answers "what is it now"; the minimum answers "how
   * close did this come to running the machine out", which is the question that
   * actually decides whether an 8 GB laptop survives a video call with the model
   * loaded. Tracked here rather than left to the reader of a pasted log, who
   * would otherwise have to eyeball 30 lines for the smallest number.
   */
  let lowestAvailableMb = baseline.availableMb;
  let lowestAt: number | null = null;
  // Named `sampleCount`, not `samples`: this is a count of diagnostic TICKS, and
  // the "no audio in the diagnostics" guard in the test suite greps for the word
  // `samples`. Renaming keeps that guard honest and unconditional rather than
  // adding an exception to it.
  let sampleCount = 0;

  log(
    `[Parakeet-DIAG][${tag}] baseline: total=${formatBytesMb(baseline.totalMb)} ` +
      `available=${formatBytesMb(baseline.availableMb)} ` +
      `used=${formatBytesMb(baseline.usedMb)} (${baseline.usedPercent}%)`,
  );

  const sample = (): void => {
    let diagnostics;
    try {
      diagnostics = options.getHost().getDiagnostics();
    } catch (err) {
      // A diagnostics sampler that can throw would take the app down while
      // someone is mid-interview. Report and keep sampling.
      log(
        `[Parakeet-DIAG] sample failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const memory = readSystemMemory();
    // Negative if memory was freed since the baseline (e.g. the idle unload
    // fired); clamp so a negative figure never reads as a bug.
    const rawDelta = baseline.availableMb - memory.availableMb;
    const deltaMb = Math.max(0, rawDelta);
    // Sub-MB swings are ordinary allocator and background-process noise. A
    // child RSS figure of ~700 MB sits NEXT to this number on the same line, so
    // reporting "the model cost 1 MB" would invite the reader to trust a
    // meaningless figure. Below the threshold, say nothing was attributable.
    const deltaLabel =
      deltaMb < 1 ? "<1 (noise)" : formatBytesMb(deltaMb);

    sampleCount++;
    if (memory.availableMb < lowestAvailableMb) {
      lowestAvailableMb = memory.availableMb;
      lowestAt = Date.now();
    }

    const parts = [
      `t=${new Date().toLocaleTimeString()}`,
      `mode=${mode}`,
      `status=${diagnostics.status}`,
      `sysAvail=${formatBytesMb(memory.availableMb)}`,
      `sysUsed=${formatBytesMb(memory.usedMb)}/${memory.totalMb}MB`,
      `usedPct=${memory.usedPercent}%`,
      `deltaSinceBaseline=${deltaLabel}`,
      `childRss=${formatBytesMb(diagnostics.rssMb)}`,
      `decodeMs=${diagnostics.decodeMs ?? "-"}`,
      // RTF is rounded here: a full float prints ~17 digits, which is noise in
      // a line a human is meant to scan.
      `rtf=${diagnostics.rtf === null || diagnostics.rtf === undefined ? "-" : diagnostics.rtf.toFixed(3)}`,
      `queued=${diagnostics.queued}`,
      `inFlight=${diagnostics.inFlight}`,
      `fails=${diagnostics.consecutiveFailures}`,
      `lowestAvail=${formatBytesMb(lowestAvailableMb)}`,
    ];
    log(`[Parakeet-DIAG][${tag}] ${parts.join(" ")}`);
  };

  const handle = setIntervalImpl(sample, PARAKEET_DIAGNOSTICS_INTERVAL_MS);

  return {
    stop: () => {
      clearIntervalImpl(handle);
      // The summary is emitted on stop because the minimum is only meaningful
      // once the run is over — a log that ends while the model is still loaded
      // has no "lowest" to report.
      const decode = getSafe(() => options.getHost().getDiagnostics().decodeMs);
      log(
        `[Parakeet-DIAG][${tag}] summary sampleCount=${sampleCount} ` +
          `lowestAvail=${formatBytesMb(lowestAvailableMb)}` +
          `${lowestAt === null ? "" : ` at=${new Date(lowestAt).toLocaleTimeString()}`} ` +
          `baselineAvail=${formatBytesMb(baseline.availableMb)} ` +
          `lastDecodeMs=${decode ?? "-"}`,
      );
      log(`[Parakeet-DIAG][${tag}] stopped`);
    },
  };
}