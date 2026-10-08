import React, { useCallback, useEffect, useRef, useState } from "react";

/**
 * Ghostly's window opacity, controllable from the overlay itself.
 *
 * ── Why this is in the TopBar and not in Settings ───────────────────────────
 * The whole point of the control is to be usable *while the interview is
 * running*. A setting buried behind a gear that the user must open, scroll and
 * close again — with the interview in progress — is not a control, it is a
 * chore. The TopBar is rendered unconditionally (it stays mounted while
 * Settings is open and while an interview streams), so putting it here makes it
 * reachable at every moment without opening anything.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 * This is NOT the Region Picker's dim-overlay slider. That one controls how dark
 * everything *outside a dragged selection* looks, lives in a different window,
 * and has a different range. The two are unrelated and deliberately not shared:
 * dragging this one must never change how the picker dims, or vice versa.
 *
 * ── Why the value is owned by the main process ──────────────────────────────
 * The window's opacity is real (`BrowserWindow.setOpacity`), so the main process
 * is the only thing that actually knows what is applied. The slider is therefore
 * a view: it reads the current value on mount, and writes optimistically on drag
 * so the thumb tracks the pointer, then reconciles with whatever the main
 * process clamped the value to. A control that displayed its own optimistic
 * number could disagree with the window, which is the one thing that must never
 * happen for a setting whose entire purpose is "make Ghostly less in the way".
 */
export const OpacityControl: React.FC = () => {
  /**
   * `null` until the persisted value arrives. Rendered as the default so the
   * control never flashes a wrong number or collapses to zero width; the main
   * process normalizes an unknown value to 85% anyway, so this cannot lie.
   */
  const [percent, setPercent] = useState<number | null>(null);
  const shown = percent ?? DEFAULT_PERCENT;

  // Read the persisted value once on mount. A rejection is deliberately
  // swallowed: the control must degrade to "working at the default", never to a
  // broken slider, because it sits in the always-on TopBar.
  useEffect(() => {
    let cancelled = false;
    void window.ghostly
      ?.getOverlayOpacity()
      .then((state) => {
        if (!cancelled) setPercent(state.percent);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // The window ignores mouse events by default and the overlay root is
  // `pointer-events-none`, so the OS-level click-through has to be opted out of
  // on hover — exactly like every other interactive panel in this app.
  const onEnter = useCallback(() => window.ghostly?.enableMouse(), []);

  /**
   * True while a drag is in progress.
   *
   * Dragging the thumb to either end walks the pointer out of the input's box,
   * which fires `mouseleave` mid-drag. Re-enabling click-through there would
   * hand the drag back to the OS halfway through, which is exactly the
   * "the slider jumps back" failure this control must not have. So leave is a
   * no-op until the button is actually released, wherever that happens.
   */
  const draggingRef = useRef(false);
  useEffect(() => {
    const stop = () => {
      draggingRef.current = false;
    };
    // `mouseup` on the window, not on the control: the release can land outside
    // it, and that is the case this exists for.
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
    };
  }, []);

  const onLeave = useCallback(() => {
    if (draggingRef.current) return;
    window.ghostly?.disableMouse();
  }, []);

  const commit = useCallback((next: number) => {
    // Optimistic: the thumb must follow the pointer, not lag a round trip.
    setPercent(next);
    void window.ghostly
      ?.setOverlayOpacity(next)
      .then((state) => {
        // Reconcile with what the main process actually applied (it clamps to
        // 20–100%), so the readout can never drift from the window.
        setPercent(state.percent);
      })
      .catch(() => undefined);
  }, []);

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full gs-control border"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      title="How see-through Ghostly's own window is, so the interview stays visible behind it."
    >
      <label
        htmlFor="ghostly-opacity"
        className="text-[10px] font-mono text-white/50 select-none"
      >
        Opacity
      </label>
      <input
        id="ghostly-opacity"
        data-ghostly="opacity-slider"
        type="range"
        min={MIN_PERCENT}
        max={MAX_PERCENT}
        step={5}
        value={shown}
        onChange={(e) => commit(Number(e.target.value))}
        onPointerDown={() => {
          draggingRef.current = true;
        }}
        // The pill is a drag region; a range input inside one would move the
        // window instead of the slider.
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        className="w-[68px] accent-[#ff9f43] bg-transparent"
        aria-label="Ghostly window opacity"
        aria-valuetext={`${shown}%`}
      />
      <span
        data-ghostly="opacity-value"
        className="text-[10px] font-mono text-white/80 tabular-nums w-[30px] text-right"
      >
        {shown}%
      </span>
    </div>
  );
};

/**
 * Mirrors `DEFAULT_OVERLAY_OPACITY` / MIN / MAX in `electron/overlayOpacity.ts`.
 *
 * Duplicated rather than imported because that module is main-process code and
 * this is the renderer: importing it across the boundary would pull the whole
 * Electron-side policy into the React bundle. The harness
 * (`scripts/verify-overlay-opacity.mts`) asserts these three numbers agree with
 * the main-process constants, so the duplication cannot drift silently.
 */
export const MIN_PERCENT = 20;
export const MAX_PERCENT = 100;
export const DEFAULT_PERCENT = 85;