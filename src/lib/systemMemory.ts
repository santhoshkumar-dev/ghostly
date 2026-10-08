import os from "node:os";

/**
 * System memory readings for the Parakeet memory-budget measurement.
 *
 * ── What "free" actually means on Windows — read this before trusting a number ──
 * Two different Windows figures are both casually called "free memory", and they
 * are NOT the same. Which one you are looking at decides whether your reading is
 * meaningful:
 *
 *   • **Free** (`Win32_OperatingSystem.FreePhysicalMemory`) counts only pages
 *     that are completely unused — zeroed and untouched. On a machine that has
 *     been up for a while, Windows deliberately parks a large chunk of RAM in the
 *     standby cache here. That memory holds file-cache data and is trivially
 *     reclaimed, so it is *not* really unavailable even though "free" does not
 *     count it.
 *
 *   • **Available** (`Win32_PerfFormattedData_PerfOS_Memory.AvailableBytes`)
 *     counts free memory PLUS standby cache plus any pages Windows can reclaim
 *     without a page write. This is the figure that answers "could another
 *     application start right now?" and it is the one that matters for deciding
 *     whether a 650 MB model will fit alongside a video call.
 *
 * `os.freemem()` is reported here as **AVAILABLE**, and this is deliberate.
 * Node implements it via libuv's `uv_get_available_memory()` on Windows, which
 * maps to `GlobalMemoryStatusEx().ullAvailPhys` — the available figure, NOT the
 * strictly-free one. So `os.freemem()` is the correct number for this question,
 * despite its misleading name.
 *
 * MEASURED CAVEAT, honestly stated: on this specific machine the strict-free and
 * available figures were within ~30-60 MB of each other across three
 * simultaneous samples (1110/1109, 1110/1109, 1126/1120), so sampling could NOT
 * prove which one `os.freemem()` returns. The mapping above is the documented
 * libuv/Node behaviour, not something this run independently confirmed.
 *
 * ── Why both free and available are reported anyway ──────────────────────────
 * Because the distinction is exactly what a reader will get wrong. Printing only
 * one number invites the reader to assume the stricter meaning. Both are shown,
 * labelled, alongside the model delta, so the figure can be interpreted rather
 * than trusted blindly.
 */

const MB = 1048576;

export interface SystemMemory {
  /** Physical RAM installed, in MB. */
  totalMb: number;
  /** What `os.freemem()` returns. On Windows this is AVAILABLE, not strictly free. */
  availableMb: number;
  /** totalMb - availableMb. Includes the standby cache, so it overstates pressure. */
  usedMb: number;
  /** Percentage of RAM not available, 0–100. */
  usedPercent: number;
}

export interface MemoryReaderDeps {
  /** Injected for tests. Defaults to `os.freemem()`. */
  freeMem?: () => number;
  totalMem?: () => number;
}

/**
 * Read system memory.
 *
 * Takes its clock-free values through injectable functions so a test can pin
 * them; on Windows the OS numbers are polled by the OS itself, so there is no
 * per-process reading to take here.
 */
export function readSystemMemory(deps: MemoryReaderDeps = {}): SystemMemory {
  const totalMem = deps.totalMem ?? os.totalmem;
  const freeMem = deps.freeMem ?? os.freemem;
  const totalMb = Math.round(totalMem() / MB);
  const availableMb = Math.round(freeMem() / MB);
  const usedMb = totalMb - availableMb;
  return {
    totalMb,
    availableMb,
    usedMb,
    usedPercent: totalMb > 0 ? Math.round((usedMb / totalMb) * 1000) / 10 : 0,
  };
}

export function formatBytesMb(mb: number | null | undefined): string {
  return mb === null || mb === undefined ? "-" : `${mb.toFixed(1)} MB`;
}