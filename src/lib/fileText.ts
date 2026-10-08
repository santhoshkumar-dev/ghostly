/**
 * Extract plain text from an uploaded resume file.
 *
 * Plain-text formats are read directly. PDF and DOCX need parsers, so those
 * libraries are loaded lazily (`import()`) — they are large and only pulled in
 * when the user actually uploads such a file, keeping the main bundle small.
 *
 * Throws an `Error` with a user-facing message when a file can't be read.
 *
 * IMPORTANT — keep `pdfjs-dist` on the **v4** line. v6 requires
 * `Uint8Array.prototype.toHex`/`toBase64` (Chrome 140+) and throws
 * `n.toHex is not a function` on older Chromium; Electron 33 is Chromium 130.
 * v4 guards both with a fallback, so it runs anywhere.
 */

const TEXT_EXTENSIONS = [
  ".txt",
  ".md",
  ".markdown",
  ".rst",
  ".json",
  ".csv",
  ".rtf",
  ".tex",
  ".yml",
  ".yaml",
  ".html",
];

/** Resumes can be long; cap what we ship to the model to protect the token budget. */
export const MAX_RESUME_CHARS = 20000;

export async function extractTextFromFile(file: File): Promise<string> {
  const lower = file.name.toLowerCase();

  if (lower.endsWith(".doc")) {
    throw new Error(
      "Legacy .doc isn't supported — save it as .docx or PDF, or paste the text.",
    );
  }
  const isText = TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
  const isPdf = lower.endsWith(".pdf");
  const isDocx = lower.endsWith(".docx");
  if (!isText && !isPdf && !isDocx) {
    throw new Error("Unsupported file type — paste the text instead.");
  }

  try {
    if (isText) return await file.text();
    if (isPdf) return await extractPdf(file);
    return await extractDocx(file);
  } catch (err) {
    // Surface *why* it failed instead of a minified internal error — e.g. the
    // older pdfjs-dist builds threw `n.toHex is not a function` on Chromium
    // versions predating Uint8Array.prototype.toHex.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Couldn't read ${file.name}: ${detail}. Try pasting the resume text instead.`,
    );
  }
}

async function extractPdf(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  // Vite resolves this to a bundled asset URL at build time.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item: any) =>
          item && typeof item.str === "string" ? item.str : "",
        )
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) pages.push(text);
      page.cleanup();
    }
    return pages.join("\n\n");
  } finally {
    await doc.destroy();
  }
}

async function extractDocx(file: File): Promise<string> {
  const mammothModule: any = await import("mammoth");
  const mammoth = mammothModule.default ?? mammothModule;
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value as string;
}
