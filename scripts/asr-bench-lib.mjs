/**
 * Pure benchmark primitives for the Moonshine / Parakeet / Groq comparison.
 *
 * ── Why this file exists separately from `asr-bench.mjs` ────────────────────
 * Everything here is deterministic and side-effect free: WAV parsing, manifest
 * parsing, WER, completeness, technical-term matching, percentiles, and report
 * formatting. Keeping it free of engines, native addons and network calls is
 * what makes it unit-testable without a model, a key, or an audio file.
 *
 * ── Raw vs corrected ────────────────────────────────────────────────────────
 * Nothing in this module applies Ghostly's transcript correction, candidate
 * correction, or technical-term normalization. Accuracy must measure the ASR
 * engine, not the layer that repairs its mistakes. `normalizeForWer` is a
 * benchmark-only text normalizer (case, punctuation, whitespace) and is applied
 * to BOTH sides of every comparison.
 */

/** The exact WAV shape every clip must have. */
export const REQUIRED_SAMPLE_RATE = 16000;
export const REQUIRED_CHANNELS = 1;
export const REQUIRED_BITS_PER_SAMPLE = 16;

export class WavFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "WavFormatError";
  }
}

/**
 * Parse a RIFF/WAVE header.
 *
 * Returns the declared format WITHOUT reading samples, so a format check can
 * run against a large file cheaply.
 *
 * @param {Buffer|Uint8Array} buf
 */
export function parseWavHeader(buf) {
  if (!buf || buf.length < 44) {
    throw new WavFormatError("file is too short to be a WAV");
  }
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const tag = (offset, len) => view.toString("ascii", offset, offset + len);

  if (tag(0, 4) !== "RIFF") throw new WavFormatError("missing RIFF header");
  if (tag(8, 4) !== "WAVE") throw new WavFormatError("missing WAVE header");

  // Walk the chunk list rather than assuming a fixed 44-byte header: WAV files
  // commonly carry LIST/INFO chunks before the data chunk.
  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= view.length) {
    const id = tag(offset, 4);
    const size = view.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      if (size < 16) throw new WavFormatError("fmt chunk is truncated");
      fmt = {
        audioFormat: view.readUInt16LE(offset + 8),
        channels: view.readUInt16LE(offset + 10),
        sampleRate: view.readUInt32LE(offset + 12),
        bitsPerSample: view.readUInt16LE(offset + 22),
      };
    } else if (id === "data") {
      dataOffset = offset + 8;
      // Some encoders write 0xFFFFFFFF here; clamp to what the file holds.
      dataSize = Math.min(size, view.length - dataOffset);
      break;
    }
    offset += 8 + size + (size % 2);
  }

  if (!fmt) throw new WavFormatError("no fmt chunk found");
  if (dataOffset < 0) throw new WavFormatError("no data chunk found");

  return {
    ...fmt,
    dataOffset,
    dataSize,
    durationSeconds:
      fmt.sampleRate > 0
        ? dataSize / (fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8))
        : 0,
  };
}

/**
 * Whether a clip matches the required format.
 *
 * Returns a structured reason rather than a bare boolean so the report can say
 * exactly what is wrong with a clip.
 */
export function checkWavFormat(header) {
  const problems = [];
  if (header.sampleRate !== REQUIRED_SAMPLE_RATE) {
    problems.push(
      `sample rate ${header.sampleRate} Hz (expected ${REQUIRED_SAMPLE_RATE})`,
    );
  }
  if (header.channels !== REQUIRED_CHANNELS) {
    problems.push(
      `${header.channels} channels (expected ${REQUIRED_CHANNELS}, mono)`,
    );
  }
  if (header.bitsPerSample !== REQUIRED_BITS_PER_SAMPLE) {
    problems.push(
      `${header.bitsPerSample}-bit (expected ${REQUIRED_BITS_PER_SAMPLE})`,
    );
  }
  if (header.audioFormat !== 1) {
    problems.push(`audioFormat ${header.audioFormat} (expected 1, PCM)`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Parse the fixture manifest.
 *
 * Structural validation only — it never touches the filesystem, so it can be
 * tested without any audio present.
 */
export function parseManifest(raw) {
  const manifest = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!manifest || typeof manifest !== "object") {
    throw new Error("manifest is not an object");
  }
  const questions = Array.isArray(manifest.questions) ? manifest.questions : [];
  const shortSegments = Array.isArray(manifest.shortSegments)
    ? manifest.shortSegments
    : [];

  for (const entry of [...questions, ...shortSegments]) {
    if (!entry || typeof entry !== "object") {
      throw new Error("manifest entry is not an object");
    }
    if (typeof entry.id !== "string" || !entry.id) {
      throw new Error("manifest entry is missing an id");
    }
    if (typeof entry.file !== "string" || !entry.file) {
      throw new Error(`manifest entry ${entry.id} is missing a file`);
    }
    // `phraseId` is OPTIONAL. It links a clip to the row in the exported live
    // comparison JSON that measured it; without it a clip can only be joined by
    // duration, which is ambiguous whenever two segments share a rounded
    // length. Absent is fine — it just means this clip cannot be paired to a
    // live Moonshine result, and the report says so rather than guessing.
    if (
      entry.phraseId !== undefined &&
      entry.phraseId !== null &&
      typeof entry.phraseId !== "number"
    ) {
      throw new Error(`manifest entry ${entry.id} has a non-numeric phraseId`);
    }
    if (typeof entry.reference !== "string" || !entry.reference) {
      // An empty reference is almost always a stub from
      // `scripts/import-debug-audio.mjs` waiting to be filled in, so say that
      // rather than leaving the user with a bare field name. The wording also
        // restates WHY it refuses: a fabricated reference yields a real-looking
      // WER that measures nothing.
      throw new Error(
        `manifest entry "${entry.id}" has no reference text. ` +
          `Imported clips start empty on purpose — fill "reference" in ` +
          `tests/fixtures/asr/manifest.json with the exact words spoken. ` +
          `This harness refuses to score a clip with no reference rather than ` +
          `inventing one, because a WER against a guessed reference looks like ` +
          `a measurement while measuring nothing.`,
      );
    }
  }

  const ids = [...questions, ...shortSegments].map((e) => e.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) {
    throw new Error(`duplicate manifest ids: ${[...new Set(dupes)].join(", ")}`);
  }

  return { ...manifest, questions, shortSegments };
}

/**
 * Benchmark-only text normalization for WER.
 *
 * Lowercase, strip punctuation, collapse whitespace. Applied to the reference
 * AND the hypothesis, so casing and punctuation can never decide a score.
 * This is NOT Ghostly's production normalization.
 */
export function normalizeForWer(text) {
  if (!text) return "";
  return String(text)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split normalized text into WER tokens. */
export function werTokens(text) {
  const n = normalizeForWer(text);
  return n ? n.split(" ") : [];
}

/** Standard Levenshtein edit distance over token arrays. */
export function tokenEditDistance(ref, hyp) {
  if (ref.length === 0) return hyp.length;
  if (hyp.length === 0) return ref.length;
  // Two rolling rows: `prev` is the row above, `curr` the row being filled.
  let prev = Array.from({ length: hyp.length + 1 }, (_, i) => i);
  let curr = new Array(hyp.length + 1).fill(0);

  for (let i = 1; i <= ref.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[hyp.length];
}

/**
 * Word Error Rate with the usual sub/ins/del breakdown.
 *
 * A hypothesis with no reference words has WER 0 by definition (nothing was
 * expected), which is what keeps an empty reference from producing Infinity.
 */
export function computeWer(reference, hypothesis) {
  const ref = werTokens(reference);
  const hyp = werTokens(hypothesis);
  if (ref.length === 0) {
    return {
      wer: hyp.length === 0 ? 0 : 1,
      errors: hyp.length,
      refWords: 0,
      hypWords: hyp.length,
    };
  }
  const errors = tokenEditDistance(ref, hyp);
  return {
    wer: errors / ref.length,
    errors,
    refWords: ref.length,
    hypWords: hyp.length,
  };
}

/**
 * Completeness against the exact spoken reference.
 *
 * Deliberately not an invented percentage. A question is COMPLETE only when the
 * reference's final content words are present; a transcript missing the ending
 * ("…requests at the same time." with no "How would you scale the backend?")
 * is INCOMPLETE even though it reproduces most of the words.
 */
export function computeCompleteness(reference, hypothesis) {
  const ref = werTokens(reference);
  const hyp = new Set(werTokens(hypothesis));

  if (ref.length === 0) return { complete: true, coverage: 1, missing: [] };

  // The closing clause is what distinguishes a finished question from a
  // transcript that stopped early, so the last 5 reference words are required.
  const tail = ref.slice(-5);
  const missingTail = tail.filter((w) => !hyp.has(w));

  const missing = ref.filter((w) => !hyp.has(w));
  const coverage = (ref.length - missing.length) / ref.length;

  return {
    complete: missingTail.length === 0,
    coverage,
    missing,
    missingFinalClause: missingTail,
  };
}

/**
 * Technical-term correctness, independent of capitalisation.
 *
 * "mongodb" and "MongoDB" both count as MongoDB. "mango" does NOT, and
 * neither does "Spring boat" for "Spring Boot": matching is on the full
 * normalized phrase, so a near-miss stays a miss. That is deliberate — the
 * production correction engine must never hide an ASR error in the raw metric.
 */
export function checkTechnicalTerms(terms, hypothesis) {
  const haystack = normalizeForWer(hypothesis);
  return (terms ?? []).map((term) => {
    const needle = normalizeForWer(term);
    return {
      term,
      // Whole-token containment: "mango" cannot satisfy "mongodb".
      found: needle.length > 0 && haystack.includes(needle),
    };
  });
}

/** Percentile over an unsorted numeric array (nearest-rank). */
export function percentile(values, p) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Real-time factor: decode time / audio duration.
 *
 * Lower is better; below 1.0 means faster than real time. Returns null for a
 * zero-length clip rather than dividing by zero.
 */
export function computeRtf(decodeMs, audioSeconds) {
  if (!audioSeconds || audioSeconds <= 0) return null;
  return decodeMs / 1000 / audioSeconds;
}

/**
 * Prepend/append `ms` of digital silence.
 *
 * Used only by the padding test. Returns Float32 samples in [-1, 1]; callers
 * re-encode at the original sample rate.
 */
export function padSilence(samples, sampleRate, ms) {
  const padLen = Math.max(0, Math.round((sampleRate * ms) / 1000));
  if (padLen === 0) return samples;
  const out = new Float32Array(samples.length + padLen * 2);
  out.set(samples, padLen);
  return out;
}

/** Round to a fixed number of decimals for stable, diffable output. */
export function round(value, decimals = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * Aggregate per-question results for one engine.
 *
 * `hasAccuracyData` is false when no real reference matched the clips (e.g.
 * only synthetic audio exists). In that case WER/completeness/term metrics are
 * reported as null and MUST NOT be presented as accuracy.
 */
export function summarizeEngine(engine, rows, { hasAccuracyData }) {
  const decodeMs = rows.map((r) => r.decodeMs).filter((v) => v != null);
  const rtfs = rows.map((r) => r.rtf).filter((v) => v != null);
  const empties = rows.filter((r) => !String(r.transcript ?? "").trim()).length;
  const failures = rows.filter((r) => r.failure).length;

  const accuracyRows = hasAccuracyData
    ? rows.filter((r) => r.reference)
    : [];

  const werSum = accuracyRows.reduce((a, r) => a + (r.wer?.wer ?? 0), 0);
  const complete = accuracyRows.filter((r) => r.completeness?.complete).length;
  const termTotal = accuracyRows.reduce(
    (a, r) => a + (r.terms?.length ?? 0),
    0,
  );
  const termHit = accuracyRows.reduce(
    (a, r) => a + (r.terms?.filter((t) => t.found).length ?? 0),
    0,
  );

  return {
    engine,
    clips: rows.length,
    wer: hasAccuracyData && accuracyRows.length
      ? round(werSum / accuracyRows.length, 4)
      : null,
    emptyRate: rows.length ? round(empties / rows.length, 4) : null,
    completeness: hasAccuracyData && accuracyRows.length
      ? round(complete / accuracyRows.length, 4)
      : null,
    technicalTermAccuracy: termTotal ? round(termHit / termTotal, 4) : null,
    technicalTermsSeen: termTotal,
    latencyP50: round(percentile(decodeMs, 50), 2),
    latencyP95: round(percentile(decodeMs, 95), 2),
    rtf: rtfs.length ? round(rtfs.reduce((a, b) => a + b, 0) / rtfs.length, 4) : null,
    failures,
  };
}

/** Pad/align a cell for the fixed-width summary table. */
export function fmtCell(value, width) {
  const s = value === null || value === undefined ? "—" : String(value);
  return s.length >= width ? s.slice(0, width) : s.padEnd(width);
}

/**
 * Render the engine summary table deterministically.
 *
 * Fixed column order and fixed rounding so two runs on the same data produce
 * byte-identical output.
 */
export function formatSummaryTable(summaries, banner) {
  const header = [
    "Engine",
    "WER",
    "Empty",
    "Complete",
    "Terms",
    "p50 ms",
    "p95 ms",
    "RTF",
  ];
  const widths = [14, 8, 8, 10, 8, 10, 10, 8];
  const lines = [];
  if (banner) lines.push(banner, "");
  lines.push(header.map((h, i) => fmtCell(h, widths[i])).join(" "));
  lines.push(widths.map((w) => "-".repeat(w)).join(" "));
  for (const s of summaries) {
    lines.push(
      [
        fmtCell(s.engine, widths[0]),
        fmtCell(s.wer === null ? "n/a" : s.wer, widths[1]),
        fmtCell(s.emptyRate, widths[2]),
        fmtCell(s.completeness === null ? "n/a" : s.completeness, widths[3]),
        fmtCell(
          s.technicalTermAccuracy === null ? "n/a" : s.technicalTermAccuracy,
          widths[4],
        ),
        fmtCell(s.latencyP50, widths[5]),
        fmtCell(s.latencyP95, widths[6]),
        fmtCell(s.rtf, widths[7]),
      ].join(" "),
    );
  }
  return lines.join("\n");
}

/**
 * The single banner used whenever audio is synthetic or missing.
 *
 * Accuracy columns are null in that case; this string is printed alongside so a
 * latency number can never be misread as an accuracy result.
 */
export const SYNTHETIC_BANNER =
  "synthetic: latency/RAM only, not valid for accuracy";

export const NO_AUDIO_BANNER =
  "no real fixtures present - accuracy metrics unavailable (skipped cleanly)";