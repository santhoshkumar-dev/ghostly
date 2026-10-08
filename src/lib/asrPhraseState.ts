/**
 * "Is the interviewer mid-sentence?", derived from the VAD rather than from
 * partial transcripts.
 *
 * ── The problem this solves ──────────────────────────────────────────────────
 * Moonshine publishes partial transcripts, and the question gate uses a
 * non-empty interim as its "the interviewer is still speaking" signal
 * (`interviewAgent.ts`). Parakeet is a batch/offline recogniser: it decodes a
 * finished utterance and produces no partials at all. Left alone, switching the
 * primary engine would silently delete that signal — the gate would become
 * strictly more permissive and could answer a question the interviewer is still
 * in the middle of asking.
 *
 * ── How it is derived without touching capture or the VAD ────────────────────
 * The worklet already publishes everything needed, and the renderer already
 * receives it:
 *
 *   • `{ type: "level", speaking }` at ~20 Hz, where `speaking` is literally
 *     `this.speechSeconds > 0` inside the worklet (`vadWorklet.ts`). This is the
 *     authoritative "a phrase is open" edge, available 50 ms after the
 *     interviewer starts talking.
 *   • `{ type: "phraseClosed", phraseId }`, ALWAYS emitted when a phrase ends,
 *     including for discarded audio (`vadWorklet.ts`).
 *
 * So no new message, no worklet change, and no capture change is needed. This
 * module is a pure reducer over those two events precisely so it can be tested
 * without an AudioContext.
 *
 * ── Why this is a separate module ────────────────────────────────────────────
 * The reducer is the part that has to be provably right (an off-by-one here
 * means a permanently stuck gate, or a permanently answerable interview). It has
 * no React, DOM, worker or Electron dependency, so the existing tsx harness can
 * exercise every transition directly.
 */

/**
 * The placeholder shown in the interim line while a Parakeet phrase is open.
 *
 * ── Why a placeholder, and why it lives in the interim ───────────────────────
 * The gate reads `interim.text.trim().length >= 4` and nothing else. Feeding the
 * gate through the interim is therefore the ONLY way to restore the "still
 * speaking" behaviour without editing `evaluateInterviewTurn`, which is
 * explicitly out of scope for this work.
 *
 * It is safe there because the interim reaches only three places, none of them
 * the prompt:
 *   • `evaluateInterviewTurn` — exactly the gate we want to re-arm;
 *   • `turnSignature` — a CONSTANT suffix, so two different turns stay distinct
 *     and the same turn still collapses to one submit;
 *   • the interim line in the overlay, where an honest marker reads better than
 *     a blank panel.
 *
 * It is deliberately not a plausible word. If this string ever reached a prompt
 * or a transcript it would be a lie about what the interviewer said; the brackets
 * make that immediately obvious instead.
 */
export const PARAKEET_PHRASE_OPEN_MARKER = "[speaking]";

/** The VAD events that can move the phrase-open edge. */
export type PhraseStateEvent =
  /** A worklet level sample; `speaking` is true while a phrase is accumulating. */
  | { kind: "level"; speaking: boolean }
  /** A rolling partial snapshot — proof a phrase is open. */
  | { kind: "partial" }
  /** A finished phrase was emitted for transcription. */
  | { kind: "speech" }
  /** A phrase ended, whether or not it produced audio. Always emitted. */
  | { kind: "phraseClosed" };

/**
 * The phrase-open state.
 *
 * `latched` is the part that is easy to get wrong, so it is explicit rather than
 * hidden in a boolean. It records "a phrase closed, and no silence has been
 * observed since".
 */
export interface PhraseOpenState {
  open: boolean;
  latched: boolean;
}

export const INITIAL_PHRASE_OPEN_STATE: PhraseOpenState = {
  open: false,
  latched: false,
};

/**
 * Reduce one VAD event.
 *
 * ── The latch, and why it exists ────────────────────────────────────────────
 * `endPhrase()` posts `level` (still `speaking: true`) and then, in the SAME
 * `process()` tick, posts `speech` and `phraseClosed`. `MessagePort` preserves
 * order, so the level sample always arrives first — but that is an invariant of
 * the worklet's internals, not of this API, and a reducer that depends on it
 * would break silently the moment the worklet's ordering changed.
 *
 * So the close is LATCHED instead: after `phraseClosed`, a `speaking: true` level
 * sample is ignored until real silence is seen. This is safe in normal operation
 * because `endPhrase()` calls `reset()`, so `speechSeconds` is 0 for the whole
 * 1.5 s gap (`MAX_SILENCE_SECONDS`) before any new speech — roughly 30
 * `speaking: false` samples arrive well before the next phrase.
 *
 * Without the latch the failure mode is the worst kind: a marker stuck on screen
 * forever, which satisfies the gate's "still speaking" check permanently and
 * blocks every subsequent question.
 */
export function reducePhraseOpen(
  state: PhraseOpenState,
  event: PhraseStateEvent,
): PhraseOpenState {
  switch (event.kind) {
    case "phraseClosed":
    case "speech":
      return { open: false, latched: true };
    case "level":
      // Real silence releases the latch, so the NEXT utterance can open again.
      if (!event.speaking) return { open: false, latched: false };
      return state.latched ? { open: false, latched: true } : { open: true, latched: false };
    case "partial":
      return { open: true, latched: false };
  }
}

/** Fold a whole event sequence, returning just the final "is open" value. */
export function phraseOpenAfter(
  events: PhraseStateEvent[],
  initial: PhraseOpenState = INITIAL_PHRASE_OPEN_STATE,
): boolean {
  return events.reduce(reducePhraseOpen, initial).open;
}

/**
 * Whether the fallback marker should be published as the interim line.
 *
 * True only when the phrase is open AND no engine has supplied real interim text
 * for it. A lazily-loaded Moonshine fallback can emit genuine partials while
 * Parakeet is still the primary engine, and those must win: the marker is a
 * placeholder for the absence of text, never an override of real text.
 */
export function shouldPublishPhraseOpenMarker(
  state: PhraseOpenState,
  hasRealInterim: boolean,
): boolean {
  return state.open && !hasRealInterim;
}
