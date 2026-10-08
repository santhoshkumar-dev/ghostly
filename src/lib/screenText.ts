/**
 * Read the text on a captured screen image, LOCALLY.
 *
 * ── One implementation, two callers ─────────────────────────────────────────
 * The local fallback provider needs screen text because it cannot see images,
 * and the interview prompt wants the same text as explicit screen context when
 * a screenshot is attached. Both go through here so the behaviour (and the
 * privacy rules) cannot drift between them.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────
 * It does not upload anything, does not write anything to disk, and does not log
 * the recognised text — only a character count, which is enough to tell "OCR ran
 * and found nothing" apart from "OCR failed" without reproducing a candidate's
 * screen in a log file.
 *
 * ── Failure is ordinary ─────────────────────────────────────────────────────
 * OCR needs a Windows OCR language pack. A machine without one must still answer
 * the question, so every failure here resolves to `undefined` rather than
 * throwing: no screen context is a slightly vaguer answer, never a broken one.
 */

export interface ScreenTextBridge {
  ocrImageText?: (payload: { dataUrl: string }) => Promise<{
    ok: boolean;
    text?: string;
    code?: string;
    message?: string;
  }>;
}

export interface ScreenTextDetail {
  ok: boolean;
  text: string;
  code?: string;
  message?: string;
  /** Wall-clock OCR duration in ms (renderer-local). */
  ms: number;
  /** Byte length of the image the OCR was given. Never the pixels. */
  imageBytes: number;
}

/**
 * Recognise the text in an image, returning the full diagnostic detail.
 *
 * The plain {@link readScreenText} is kept for the interview path where a vague
 * `undefined` is the right contract. The screenshot OCR path needs the numbers
 * (duration, image size) and the failure code to log `[OCR]` metadata and to
 * decide between the text path and the manual image fallback.
 */
export async function readScreenTextDetailed(
  dataUrl: string,
  bridge: ScreenTextBridge | undefined = typeof window !== "undefined"
    ? (window.ghostly as unknown as ScreenTextBridge)
    : undefined,
): Promise<ScreenTextDetail> {
  const imageBytes = typeof dataUrl === "string" ? dataUrl.length : 0;
  const started = performance.now();
  const done = (
    ok: boolean,
    text = "",
    code?: string,
    message?: string,
  ): ScreenTextDetail => ({
    ok,
    text,
    code,
    message,
    ms: Math.round(performance.now() - started),
    imageBytes,
  });

  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    return done(false, "", "no_image", "No screenshot was attached.");
  }
  if (typeof bridge?.ocrImageText !== "function") {
    return done(false, "", "ocr_bridge_missing", "Local OCR is unavailable.");
  }

  try {
    const res = await bridge.ocrImageText({ dataUrl });
    if (!res?.ok || !res.text?.trim()) {
      return done(
        false,
        "",
        res?.code ?? "empty",
        res?.message ?? "No text was recognised.",
      );
    }
    return done(true, res.text.trim());
  } catch (err) {
    return done(
      false,
      "",
      "ocr_failed",
      err instanceof Error ? err.message : "Local OCR failed.",
    );
  }
}

/**
 * Recognise the text in a `data:` image URL.
 *
 * @returns the text, or `undefined` when there is none or OCR is unavailable.
 */
export async function readScreenText(
  dataUrl: string,
  bridge: ScreenTextBridge | undefined = typeof window !== "undefined"
    ? (window.ghostly as unknown as ScreenTextBridge)
    : undefined,
): Promise<string | undefined> {
  if (typeof dataUrl !== "string" || dataUrl.length === 0) return undefined;
  if (typeof bridge?.ocrImageText !== "function") return undefined;

  try {
    const res = await bridge.ocrImageText({ dataUrl });
    if (!res?.ok || !res.text?.trim()) return undefined;
    const text = res.text.trim();
    console.log(`[SCREEN] local OCR provided ${text.length} chars of screen text`);
    return text;
  } catch {
    return undefined;
  }
}
