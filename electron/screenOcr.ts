/**
 * Local screen-text extraction for the LOCAL fallback.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The local model is TEXT ONLY (a vision model that fits in the memory left over
 * after Parakeet does not exist on this machine), so a screenshot has to become
 * TEXT before the local provider can use it. This module is that step, and it is
 * the only place in the app that converts an image into text.
 *
 * ── Privacy, stated precisely ───────────────────────────────────────────────
 *   • Nothing is written to disk. There is no cache and no frame store.
 *   • The recognised TEXT is returned to the renderer, because the local
 *     provider runs there and needs it. It is never logged — only the character
 *     COUNT is, which is enough to debug a failure without reproducing the
 *     screen.
 *   • The pixels never leave this process: the caller hands over a data URL, the
 *     BGRA buffer is a local, and it is released when the function returns.
 *   • This is NOT used for the cloud providers. A cloud provider receives the
 *     image itself, as it always has, and only when the user's own action asked
 *     for it.
 *
 * ── Deliberately not the Live Screen path ───────────────────────────────────
 * `liveScreen.ts` watches a region on a timer. This is a one-shot read of an
 * image the caller already captured, which is what makes it usable from inside a
 * provider call without coupling the two features.
 */

import { nativeImage } from "electron";
import { isOcrAvailable, recognizeBgraSync } from "./windowsOcr";

/** A data URL larger than this is refused before it is decoded. */
export const MAX_OCR_IMAGE_CHARS = 40 * 1024 * 1024; // ~30 MB of base64

export interface ScreenTextResult {
  ok: boolean;
  /** Recognised text. Present only when `ok` is true. */
  text?: string;
  /** Stable machine-readable reason when `ok` is false. */
  code?: string;
  /** Human-readable reason when `ok` is false. */
  message?: string;
  /** Decoded image size, for diagnostics. Never the pixels. */
  width?: number;
  height?: number;
}

/**
 * Recognise the text in an already-captured image.
 *
 * Never throws: every failure is an `ok: false` with a stable code, because the
 * caller treats "no screen context" as an ordinary state rather than an error.
 */
export function readImageText(dataUrl: unknown): ScreenTextResult {
  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    return { ok: false, code: "invalid_request", message: "No image was supplied." };
  }
  if (dataUrl.length > MAX_OCR_IMAGE_CHARS) {
    return { ok: false, code: "too_large", message: "The image was too large to read." };
  }

  if (!isOcrAvailable()) {
    // OCR needs a Windows OCR language pack. A machine without one still gets
    // the text-only fallback for the spoken question.
    return {
      ok: false,
      code: "ocr_unavailable",
      message:
        "Local OCR is unavailable (Windows needs an OCR language pack). The question was answered without screen context.",
    };
  }

  let image;
  try {
    image = nativeImage.createFromDataURL(dataUrl);
  } catch {
    return { ok: false, code: "decode_failed", message: "The image could not be decoded." };
  }
  if (!image || image.isEmpty()) {
    return { ok: false, code: "decode_failed", message: "The image could not be decoded." };
  }

  // `toBitmap()` is documented as raw BGRA, which is exactly what the OCR engine
  // takes — see `recognizeBgraSync`. Keeping the two ends on the same layout is
  // what makes the read correct without a conversion step.
  const { width, height } = image.getSize();
  let bitmap: Buffer;
  try {
    bitmap = image.toBitmap();
  } catch {
    return { ok: false, code: "decode_failed", message: "The image could not be read." };
  }

  try {
    const text = recognizeBgraSync(bitmap, width, height);
    return { ok: true, text, width, height };
  } catch (err) {
    return {
      ok: false,
      code: "ocr_failed",
      message: err instanceof Error ? err.message : "Local OCR failed.",
      width,
      height,
    };
  }
}
