/**
 * Ghostly's own window opacity — the POLICY, separated from the mechanism.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * `main.ts` already used `BrowserWindow.setOpacity()` for something completely
 * different: it used `0` to mean HIDDEN and `1` to mean SHOWN. That is why there
 * was no opacity control — the single knob the window had was already spoken
 * for, and hijacking it would have made "hide" and "see the app behind Ghostly"
 * the same gesture.
 *
 * So this module owns the distinction explicitly as TWO pieces of state:
 *
 *   hidden   — is Ghostly shown at all? (Ctrl+B / tray toggle)
 *   opacity  — how see-through is Ghostly while it IS shown?
 *
 * and derives the one number Electron actually wants:
 *
 *   effective() = hidden ? 0 : opacity
 *
 * Keeping the derivation here rather than inline is what makes it testable with
 * no window, no Electron and no Windows — the same reason
 * `visibilityPolicy.ts` exists for the screen-capture mode.
 *
 * ── Why the transparency is applied by the RENDERER, not by setOpacity ──────
 * This module deliberately does NOT call `BrowserWindow.setOpacity(value)` with
 * the user's chosen transparency, even though that would have been the obvious
 * implementation. Window opacity is a single scalar applied to the whole
 * composited window, so it scales *everything* inside it by the same factor —
 * text included. At the bottom of the required range (20%) a window-level 0.2
 * makes the answer text 20% white, which is not "see the interview behind
 * Ghostly", it is "cannot read the answer". The two requirements (the app behind
 * must stay visible; the answer must stay readable) are not simultaneously
 * satisfiable through that one knob.
 *
 * They ARE simultaneously satisfiable by scaling only Ghostly's own *surfaces*:
 * panel backgrounds, borders and washes are multiplied by the alpha while text
 * colours are left at full strength. That is what `--ghostly-alpha` does in
 * `src/styles/global.css`, and it is why this module's `apply` has two separate
 * halves:
 *
 *   setWindowOpacity(0 | 1)  — hide / show ONLY. Restores the exact semantics
 *                              `setOpacity` had before this feature existed.
 *   setChromeAlpha(alpha)    — the value the renderer reads to scale surfaces.
 *
 * CSS alpha also cannot affect hit-testing or screen capture, which is the
 * interaction risk requirement 10 warns about, and it leaves the desktop behind
 * untouched (requirement 8).
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 * This is NOT the Region Picker's dim-layer opacity. That is a different window,
 * a different file (`regionPicker.ts`), a different range (20–70%) and a
 * different question ("how dark is everything outside my selection?"). Mixing
 * the two would mean dragging one slider silently changed the other. The two
 * are asserted to be independent in `scripts/verify-overlay-opacity.mts`.
 *
 * ── Range and default ───────────────────────────────────────────────────────
 * 20% is the floor rather than 0 for two reasons: at 0 Ghostly is gone (which is
 * what `hidden` is FOR, and is bound to a hotkey), and below ~20% the surfaces
 * stop being distinguishable from the app behind, which makes the control look
 * broken. 85% is the default: opaque enough that panels read as panels, sheer
 * enough that the interviewer's window is legible behind them.
 */

/** Lowest selectable value. Deliberately not 0 — see the note above. */
export const MIN_OVERLAY_OPACITY = 0.2;

/** Highest selectable value, i.e. fully opaque. */
export const MAX_OVERLAY_OPACITY = 1;

/** Shipped default. */
export const DEFAULT_OVERLAY_OPACITY = 0.85;

/** The single log line shape. Never contains anything but the percentage. */
export function formatOpacityLog(opacity: number, hidden: boolean): string {
  return `[Ghostly] overlay opacity=${Math.round(opacity * 100)}%${hidden ? " (hidden)" : ""}`;
}

/**
 * Coerce anything into a legal opacity, in the FRACTION domain (0.2–1.0).
 *
 * This is the internal/persistence normalizer. For UI input — which arrives as a
 * whole percent — use {@link opacityFromSliderValue}, which decides which domain
 * it is looking at before calling this.
 *
 * A renderer is untrusted input here, so this is a real coercion rather than a
 * cast, and it CLAMPS rather than rejects: a user dragging a slider must never
 * be able to put the window into a state it cannot be dragged back out of.
 *
 * Anything non-numeric — `undefined`, `null`, `""`, `NaN`, an object, a value
 * written by an older build — resolves to the DEFAULT rather than to the
 * minimum. That distinction is load-bearing: `Number(null)` is `0` and
 * `Number("")` is `0`, so without the explicit guard below a missing persisted
 * value would resolve to 20% and make Ghostly nearly invisible on every launch.
 * A corrupt value must cost the user their setting, not their ability to read
 * the interview.
 */
export function normalizeOverlayOpacity(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_OVERLAY_OPACITY;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_OVERLAY_OPACITY;
  if (n <= 0) return MIN_OVERLAY_OPACITY;
  return Math.min(MAX_OVERLAY_OPACITY, Math.max(MIN_OVERLAY_OPACITY, n));
}

/** Round-trip helper for the UI, which works in whole percent. */
export function opacityToPercent(opacity: number): number {
  return Math.round(normalizeOverlayOpacity(opacity) * 100);
}

/** `0.85` → `"85"`. The slider's own value unit. */
export function opacityToSliderValue(opacity: number): string {
  return String(opacityToPercent(opacity));
}

/**
 * Parse UI input, which is a whole PERCENT (20–100), into a fraction.
 *
 * ── Why the domain has to be decided, not assumed ───────────────────────────
 * The overlay slider speaks percent; the persisted setting and everything
 * internal speak fraction. Getting that backwards is silent and severe: the
 * renderer sends `50` for "50%", and a normalizer that treats `50` as a
 * fraction clamps it to `1` — so dragging the slider to the middle would set
 * Ghostly to fully opaque, and dragging it anywhere below 100% would look
 * broken.
 *
 * The two domains cannot overlap above 1, so magnitude is a sound discriminator
 * rather than a guess: a fraction can never exceed 1, and a percent of a window
 * is always ≥ 20.
 */
export function opacityFromSliderValue(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_OVERLAY_OPACITY;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_OVERLAY_OPACITY;
  return normalizeOverlayOpacity(n > 1 ? n / 100 : n);
}

export interface OverlayOpacityState {
  /** The user's chosen opacity while the window is shown. */
  opacity: number;
  /** True when Ghostly is hidden entirely (Ctrl+B / tray). */
  hidden: boolean;
}

export interface OverlayOpacityController {
  /** Both pieces of state, always valid. */
  current(): OverlayOpacityState;
  /** The chosen surface alpha (0.2–1.0), ignoring `hidden`. */
  opacity(): number;
  /** Whether Ghostly is currently hidden. */
  hidden(): boolean;
  /**
   * The value that must be on the WINDOW right now.
   *
   * `0` when hidden, `1` when shown — never the user's alpha. See the module
   * comment: the alpha is applied to surfaces by the renderer, because a
   * window-level scalar cannot dim a panel without also dimming its text.
   */
  windowOpacity(): number;
  /** The alpha the renderer must apply to Ghostly's surfaces. */
  chromeAlpha(): number;
  /** Whether the window is on screen at all. */
  isVisible(): boolean;
  /**
   * Change the surface alpha. Records the value, persists it and pushes it, but
   * does NOT unhide a hidden window — setting the slider to 85% must not
   * resurrect Ghostly the user deliberately hid. Returns the normalized value
   * that took effect.
   */
  setOpacity(value: unknown): number;
  /** Show / hide. */
  setHidden(hidden: boolean): OverlayOpacityState;
  /** Flip hidden/visible. Returns the new hidden flag. */
  toggleHidden(): boolean;
  /**
   * Re-assert the current state without changing it. Called on show/focus,
   * because the OS and the window manager can both drop the composite state.
   * Returns the window opacity that was applied.
   */
  reapply(): number;
}

export interface OverlayOpacityControllerDeps {
  /**
   * `BrowserWindow.setOpacity`. Injected so the tests can drive hide/show/adjust
   * with no window at all. Only ever receives 0 or 1.
   */
  setWindowOpacity: (windowOpacity: number) => void;
  /**
   * Push the surface alpha to the renderer. Optional: the renderer normally
   * reads the value over IPC on mount instead, and this exists for the boot path
   * and for the tests.
   */
  setChromeAlpha?: (alpha: number) => void;
  /** Persist the chosen alpha. Optional so tests need no store. */
  persist?: (opacity: number) => void;
  /**
   * Called on an actual CHANGE, and on every `setHidden`. Deliberately not
   * called by `reapply`, so a focus storm stays silent.
   */
  log?: (line: string) => void;
  /** Initial alpha. Defaults to {@link DEFAULT_OVERLAY_OPACITY}. */
  initial?: unknown;
  /** Initial hidden flag. Defaults to false (Ghostly starts visible). */
  initialHidden?: boolean;
}

export function createOverlayOpacityController(
  deps: OverlayOpacityControllerDeps,
): OverlayOpacityController {
  let opacity = normalizeOverlayOpacity(deps.initial);
  let hidden = deps.initialHidden === true;

  const apply = (announce: boolean): number => {
    const windowOpacity = hidden ? 0 : 1;
    deps.setWindowOpacity(windowOpacity);
    deps.setChromeAlpha?.(opacity);
    if (announce) deps.log?.(formatOpacityLog(opacity, hidden));
    return windowOpacity;
  };

  // Assert the starting state immediately, so a window that was built at the
  // user's alpha really is at it rather than merely believing it.
  apply(false);

  return {
    current: () => ({ opacity, hidden }),
    opacity: () => opacity,
    hidden: () => hidden,
    windowOpacity: () => (hidden ? 0 : 1),
    chromeAlpha: () => opacity,
    isVisible: () => !hidden,
    setOpacity(value) {
      const next = normalizeOverlayOpacity(value);
      const changed = next !== opacity;
      opacity = next;
      // Persist even when unchanged by rounding, so a restart restores exactly
      // what the UI shows. Persistence is configuration, not transient state.
      deps.persist?.(opacity);
      apply(changed);
      return opacity;
    },
    setHidden(next) {
      const changed = next !== hidden;
      hidden = next;
      // Always dispatch: unhiding after the OS dropped the composite state must
      // re-assert it. Log only on an actual change.
      apply(changed);
      return { opacity, hidden };
    },
    toggleHidden() {
      this.setHidden(!hidden);
      return hidden;
    },
    reapply() {
      return apply(false);
    },
  };
}