/**
 * The renderer's view of the Parakeet model download.
 *
 * ── What this side does and does not do ─────────────────────────────────────
 * It starts the download, cancels it, asks for its status, and renders the
 * result. It does NOT touch the network, the filesystem, or the archive: the
 * renderer is an untrusted web context with no access to any of them, and a
 * 460 MB body must never be buffered there.
 *
 * ── Never throws ────────────────────────────────────────────────────────────
 * Every function resolves. A model-download control that could reject would
 * leave the Settings panel showing a spinner forever, which reads as "still
 * working" rather than "broken" — the worst of the two failure modes.
 */

export type ParakeetModelStatus =
  | "missing"
  | "downloading"
  | "verifying"
  | "ready"
  | "error";

export interface ParakeetModelState {
  status: ParakeetModelStatus;
  /** 0-100 while downloading, null when there is no meaningful percentage. */
  progress: number | null;
  bytesDownloaded: number;
  bytesTotal: number;
  message: string | null;
  dir: string;
}

const UNKNOWN: ParakeetModelState = {
  status: "error",
  progress: null,
  bytesDownloaded: 0,
  bytesTotal: 0,
  message: "The model manager is unavailable in this build.",
  dir: "",
};

function bridge(): Window["ghostly"] | null {
  if (typeof window === "undefined") return null;
  // The bridge is absent in a plain browser/test context, and in a build where
  // the preload did not expose it. Presence is checked by typeof so a declared
  // but missing function cannot be mistaken for one that exists.
  return typeof window.ghostly?.parakeetModelStatus === "function"
    ? window.ghostly
    : null;
}

/** Whether the main process exposes model management at all. */
export function isParakeetModelManagerAvailable(): boolean {
  return bridge() !== null;
}

export async function getParakeetModelStatus(): Promise<ParakeetModelState> {
  const b = bridge();
  if (!b) return UNKNOWN;
  try {
    return (await b.parakeetModelStatus()) ?? UNKNOWN;
  } catch {
    return { ...UNKNOWN, message: "Could not read the model state." };
  }
}

/**
 * Start (or join) the download.
 *
 * Resolves only when the download finishes, fails, or is cancelled — the main
 * process holds the request open for its whole duration. The UI should poll
 * {@link getParakeetModelStatus} while this is pending so the progress bar
 * actually moves; awaiting it alone would show nothing until the end.
 */
export async function downloadParakeetModel(): Promise<ParakeetModelState> {
  const b = bridge();
  if (!b) return UNKNOWN;
  try {
    return (await b.parakeetModelDownload()) ?? UNKNOWN;
  } catch {
    return { ...UNKNOWN, message: "The download could not be started." };
  }
}

export async function cancelParakeetModelDownload(): Promise<boolean> {
  const b = bridge();
  if (!b) return false;
  try {
    return (await b.parakeetModelCancel())?.ok ?? false;
  } catch {
    return false;
  }
}

export async function removeParakeetModel(): Promise<ParakeetModelState> {
  const b = bridge();
  if (!b) return UNKNOWN;
  try {
    return (await b.parakeetModelRemove()) ?? UNKNOWN;
  } catch {
    return { ...UNKNOWN, message: "The model could not be removed." };
  }
}

// ── Presentation helpers ────────────────────────────────────────────────────
// Kept here rather than inline in the component so they can be unit-tested
// without rendering React.

/** Bytes as a short human string. `1024`-based, one decimal. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** One line describing the current state, for the Settings panel. */
export function describeModelState(state: ParakeetModelState): string {
  switch (state.status) {
    case "missing":
      return "The local speech model is not installed yet.";
    case "downloading":
      return `Downloading the speech model — ${formatBytes(state.bytesDownloaded)} of ${formatBytes(state.bytesTotal)}.`;
    case "verifying":
      return "Checking the downloaded files…";
    case "ready":
      return "The local speech model is installed and ready.";
    case "error":
      return state.message ?? "The download failed.";
  }
}

/**
 * Whether a Retry button should be offered.
 *
 * Offered for `missing` and `error`, never while a download is running — a
 * Retry during a download would just join the in-flight one and look like
 * nothing happened.
 */
export function canRetryDownload(state: ParakeetModelState): boolean {
  return state.status === "missing" || state.status === "error";
}

/** Whether the progress bar should be shown. */
export function isTransferInProgress(state: ParakeetModelState): boolean {
  return state.status === "downloading" || state.status === "verifying";
}

/**
 * The exact attestation to show next to a "ready" badge.
 *
 * Deliberately does NOT say "verified" or "checksum verified". The release
 * publishes no checksum, so the only integrity guarantee is that the archive
 * was the expected length and every extracted file is the expected size. A
 * stronger claim would be a lie, and this string is the one users read.
 */
export const MODEL_INTEGRITY_NOTE =
  "File sizes are checked after extraction. The model release publishes no checksum, so a byte-for-byte hash check is not possible.";
