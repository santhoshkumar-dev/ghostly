/**
 * Keeping Ghostly's OWN window out of the image it captures — the POLICY,
 * separated from the mechanism.
 *
 * ── The failure this exists to prevent ──────────────────────────────────────
 * Every capture route funnels into `captureFullScreen()`
 * (`desktopCapturer.getSources({ types: ["screen"] })`). That reads the COMPOSITED
 * desktop, so anything Ghostly has on screen is in the image by default. The
 * image is then handed to the LOCAL OCR engine, and whatever OCR reads becomes
 * the problem statement that goes to the model.
 *
 * There is exactly ONE mechanism that keeps Ghostly's pixels out:
 * `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` in `stealth.ts`. Relying on
 * that alone is what let Ghostly's own interface reach OCR, for three reasons
 * that are all real and all silent:
 *
 *   1. `applyStealthMode` FALLS BACK to `WDA_MONITOR` when the strongest flag is
 *      unavailable (older Windows, or koffi failing to load). `WDA_MONITOR`
 *      blacks the window out for legacy capture APIs; it is not the same
 *      guarantee, and it is not re-checked afterwards.
 *   2. The dev-only "Screen Visibility: visible" control calls
 *      `removeStealthMode`, which clears the affinity for the rest of the run.
 *      Nothing warns the capture path, and a capture taken afterwards contains
 *      Ghostly's whole interface.
 *   3. Whether the flag survives focus/show/restore cycles is up to the OS, and
 *      the capture path never re-asserted it at the moment it mattered.
 *
 * ── Why hiding is the primary fix and the flag is the belt ──────────────────
 * `setOpacity(0)` removes the window from the composited desktop, so its pixels
 * are not merely transparent to the capturer — they are not drawn at all. That
 * is the SAME mechanism the existing Ctrl+H capture has always used, so this is
 * a reuse of established behaviour rather than a new one, and it holds even when
 * the affinity flag is missing or has been cleared. The affinity is re-asserted
 * as well, because it costs one call and covers the capturer's own exclusions.
 *
 * ── Why the timing lives here ───────────────────────────────────────────────
 * Hiding is asynchronous with respect to the compositor: a capture issued in the
 * same frame as the hide can still contain the window. Hence
 * {@link CAPTURE_SETTLE_MS}. It is deliberately the same order as the delay the
 * Ctrl+H path already used, so the proven path's behaviour does not change.
 *
 * ── Why this file has no `electron` import ──────────────────────────────────
 * Same reason `visibilityPolicy.ts` and `overlayOpacity.ts` do not: the decision
 * (hide? force the affinity? restore?) is a plain function, so it can be tested
 * with no window, no Electron and no Windows. The mechanism stays in `main.ts`,
 * which is the only process that owns both the window and the FFI binding.
 */

import type { OverlayOpacityController } from "./overlayOpacity";

/**
 * How long to wait after hiding, before the pixels are read.
 *
 * One compositor frame is ~16 ms; 180 ms is roughly eleven of them, which is the
 * same budget the existing Ctrl+H capture already spent hiding. Long enough to
 * be reliable, short enough that a capture still feels instant.
 */
export const CAPTURE_SETTLE_MS = 180;

/**
 * The single log line for a self-excluding capture.
 *
 * Closed vocabulary only — `hide`/`keep` and `affinity`/`no-affinity` say exactly
 * what the mechanism did. No image, no dimensions, no coordinates, no text.
 */
export function formatSelfExclusionLog(plan: SelfExclusionPlan): string {
  return `[SCREEN-CAPTURE] selfExclusion=${plan.hide ? "hide" : "keep"} affinity=${
    plan.forceCaptureExclusion ? "on" : "off"
  } restore=${plan.restore ? "yes" : "no"}`;
}

export interface SelfExclusionInput {
  /** Is Ghostly on screen right now? Asks the opacity controller, never the opacity. */
  overlayVisible: boolean;
  /**
   * Should capture exclusion be asserted for the duration?
   *
   * True by default and deliberately NOT conditional on the current mode: the
   * whole point is that a capture must be self-excluding regardless of what the
   * dev-only visibility control last did. Set false only by a caller that has
   * already established the window does not exist.
   */
  forceCaptureExclusion?: boolean;
}

export interface SelfExclusionPlan {
  /** Hide the overlay for the duration of the capture. */
  hide: boolean;
  /** Re-assert `WDA_EXCLUDEFROMCAPTURE` for the duration of the capture. */
  forceCaptureExclusion: boolean;
  /** Bring the overlay back afterwards, because this call was what hid it. */
  restore: boolean;
}

/**
 * Decide what a capture has to do to keep Ghostly out of its own image.
 *
 * A HIDDEN overlay is already out of the composited desktop, so nothing has to be
 * hidden — but the affinity is still asserted, because "hidden" and "excluded"
 * are different states and only the second one survives the OS dropping it.
 */
export function planSelfExclusion(input: SelfExclusionInput): SelfExclusionPlan {
  const hide = input.overlayVisible;
  return {
    hide,
    forceCaptureExclusion: input.forceCaptureExclusion !== false,
    restore: hide,
  };
}

export interface SelfExcludingCaptureDeps {
  /** `OverlayOpacityController.isVisible`. */
  isOverlayVisible: () => boolean;
  /** `OverlayOpacityController.setHidden(true)`. */
  hide: () => void;
  /** `OverlayOpacityController.setHidden(false)`. */
  restore: () => void;
  /**
   * `applyStealthMode(win)`. Re-asserts capture exclusion for the duration, so a
   * capture can never be taken while the flag is off.
   */
  forceCaptureExclusion: () => void;
  /** Optional log sink. Never receives image data. */
  log?: (line: string) => void;
  /** Injectable clock, for the tests. Defaults to `setTimeout`. */
  wait?: (ms: number) => Promise<void>;
}

export interface SelfExcludingCapture {
  /**
   * Run `capture` with Ghostly out of the picture.
   *
   * `restore` runs in a `finally`, so a capture that throws still leaves the
   * overlay exactly as visible as it was. The previous visible state is the one
   * that decides: a capture taken while the user had Ghostly deliberately hidden
   * must not un-hide it, which is the bug the old "read the opacity back" logic
   * had.
   */
  run<T>(capture: () => Promise<T>): Promise<T>;
  /** The plan the last `run` used. For tests and diagnostics. Never logged itself. */
  lastPlan(): SelfExclusionPlan | null;
}

const defaultWait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createSelfExcludingCapture(
  deps: SelfExcludingCaptureDeps,
): SelfExcludingCapture {
  const wait = deps.wait ?? defaultWait;
  let plan: SelfExclusionPlan | null = null;

  return {
    lastPlan: () => plan,
    async run<T>(capture: () => Promise<T>): Promise<T> {
      const decided = planSelfExclusion({
        overlayVisible: deps.isOverlayVisible(),
      });
      plan = decided;
      deps.log?.(formatSelfExclusionLog(decided));

      if (decided.hide) deps.hide();
      // Unconditional: this is the assertion that makes the capture correct even
      // when the dev-only visibility control has cleared the affinity.
      deps.forceCaptureExclusion();
      try {
        await wait(CAPTURE_SETTLE_MS);
        return await capture();
      } finally {
        if (decided.restore) deps.restore();
      }
    },
  };
}

/** Build the controller from the one thing the main process already owns. */
export function createSelfExcludingCaptureForWindow(
  opacity: OverlayOpacityController,
  win: { blur: () => void; focus: () => void },
  applyStealth: () => void,
  log?: (line: string) => void,
): SelfExcludingCapture {
  return createSelfExcludingCapture({
    isOverlayVisible: () => opacity.isVisible(),
    hide: () => {
      opacity.setHidden(true);
      win.blur();
    },
    restore: () => {
      opacity.setHidden(false);
      win.focus();
    },
    forceCaptureExclusion: applyStealth,
    log,
  });
}