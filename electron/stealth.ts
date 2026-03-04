/**
 * Native Win32 stealth utilities for Ghostly.
 *
 * Uses SetWindowDisplayAffinity (user32.dll) to apply the strongest
 * capture-exclusion flag available on the current Windows version.
 *
 * Flag hierarchy:
 *   WDA_EXCLUDEFROMCAPTURE (0x11) — Win10 2004+ — completely invisible in any capture
 *   WDA_MONITOR            (0x01) — Win10 older  — hidden from most capture APIs
 *   WDA_NONE               (0x00) — normal window
 *
 * Uses `koffi` for FFI (no gyp compilation needed, works on all Node versions).
 */
import { BrowserWindow } from "electron";

// Win32 affinity constants
const WDA_NONE = 0x00000000;
const WDA_MONITOR = 0x00000001;
const WDA_EXCLUDEFROMCAPTURE = 0x00000011;

// Cache the koffi function so we don't reload the DLL every call
let cachedSetWindowDisplayAffinity:
  | ((hwnd: number, affinity: number) => number)
  | null = null;
let koffiAvailable: boolean | null = null;

function getSetWindowDisplayAffinity():
  | ((hwnd: number, affinity: number) => number)
  | null {
  if (koffiAvailable === false) return null;
  if (cachedSetWindowDisplayAffinity) return cachedSetWindowDisplayAffinity;

  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");

    // HWND is a pointer-sized integer — use intptr for the handle value
    cachedSetWindowDisplayAffinity = user32.func(
      "int __stdcall SetWindowDisplayAffinity(intptr hwnd, uint32 dwAffinity)",
    );
    koffiAvailable = true;
    return cachedSetWindowDisplayAffinity;
  } catch (err) {
    console.warn("[Ghostly Stealth] koffi not available:", err);
    koffiAvailable = false;
    return null;
  }
}

/**
 * Extract the HWND integer value from Electron's getNativeWindowHandle() Buffer.
 * On x64 Windows, HWND is 8 bytes; on x86 it's 4 bytes.
 */
function readHWND(hwndBuffer: Buffer): number {
  if (process.arch === "x64" || process.arch === "arm64") {
    // 8-byte handle — read as BigInt, convert to Number
    // Window handles are small values, safe to convert
    return Number(hwndBuffer.readBigUInt64LE(0));
  }
  return hwndBuffer.readUInt32LE(0);
}

/**
 * Apply the strongest available capture exclusion to a BrowserWindow.
 * MUST be called on every win.show() — the affinity can be lost on hide/show cycles.
 */
export function applyStealthMode(win: BrowserWindow): void {
  // Always set Electron's built-in protection as baseline (uses WDA_MONITOR internally)
  win.setContentProtection(true);

  if (process.platform !== "win32") {
    // macOS: setContentProtection(true) already calls NSWindowSharingType.none
    return;
  }

  const SetWindowDisplayAffinity = getSetWindowDisplayAffinity();
  if (!SetWindowDisplayAffinity) return;

  try {
    const hwndBuffer = win.getNativeWindowHandle();
    const hwnd = readHWND(hwndBuffer);

    // Try strongest flag first — WDA_EXCLUDEFROMCAPTURE (Win10 2004+)
    let success = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
    if (success) {
      console.log(
        "[Ghostly Stealth] ✅ WDA_EXCLUDEFROMCAPTURE applied — fully invisible to capture",
      );
      return;
    }

    // Fall back to WDA_MONITOR for older Windows builds
    success = SetWindowDisplayAffinity(hwnd, WDA_MONITOR);
    if (success) {
      console.log(
        "[Ghostly Stealth] ⚠️ WDA_MONITOR applied — standard stealth",
      );
      return;
    }

    console.warn(
      "[Ghostly Stealth] ❌ SetWindowDisplayAffinity failed, relying on Electron fallback",
    );
  } catch (err) {
    console.warn("[Ghostly Stealth] FFI call error:", err);
  }
}

/**
 * Remove capture exclusion (restore normal window behavior).
 */
export function removeStealthMode(win: BrowserWindow): void {
  win.setContentProtection(false);

  if (process.platform !== "win32") return;

  const SetWindowDisplayAffinity = getSetWindowDisplayAffinity();
  if (!SetWindowDisplayAffinity) return;

  try {
    const hwnd = readHWND(win.getNativeWindowHandle());
    SetWindowDisplayAffinity(hwnd, WDA_NONE);
  } catch {
    // Best-effort
  }
}
