/**
 * Screen-visibility mode — the POLICY, separated from the mechanism.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * There is exactly ONE capture-exclusion mechanism in Ghostly: the Win32
 * `SetWindowDisplayAffinity` path in `stealth.ts`
 * (`applyStealthMode` / `removeStealthMode`). This module decides WHEN that
 * mechanism runs. It deliberately contains no `electron` import and no FFI, so
 * the dispatch rules are unit-testable without a window or a Windows host.
 *
 * The alternative — putting the mode inside `stealth.ts` and exporting it —
 * would make it untestable, because importing `stealth.ts` pulls in `electron`
 * and `koffi`. Everything worth testing here is a plain decision.
 *
 * ── The two modes ──────────────────────────────────────────────────────────
 *   `hidden`  — today's production behaviour, unchanged: apply
 *               WDA_EXCLUDEFROMCAPTURE (falling back to WDA_MONITOR).
 *   `visible` — remove capture exclusion entirely so Ghostly appears normally
 *               in screen capture. This is the DEBUG mode: it exists so the
 *               app can be screenshotted and screen-shared while testing.
 *
 * ── Default is `hidden`, and that default is load-bearing ──────────────────
 * A dev/test affordance must never become the shipping default. If the mode is
 * missing, malformed, or arrives from a renderer that has been tampered with,
 * `normalizeVisibilityMode` resolves to `hidden`. Failing "safe" here means
 * failing towards the behaviour a user expects of a stealth tool.
 */

/**
 * `hidden` = excluded from screen capture (production behaviour).
 * `visible` = appears normally in screen capture (developer/test only).
 */
export type VisibilityMode = "visible" | "hidden";

/**
 * Which action the existing stealth mechanism should perform.
 *
 * Named for the mechanism, not the outcome, so there is no way to accidentally
 * route around it: the controller can only ever choose between the two
 * functions that already exist.
 */
export type StealthAction = "apply" | "remove";

/**
 * Production default. Ghostly is hidden from capture unless someone explicitly
 * opts out.
 */
export const DEFAULT_VISIBILITY_MODE: VisibilityMode = "hidden";

/**
 * Coerce anything into a valid mode, defaulting to `hidden`.
 *
 * Accepts only the two exact strings. A renderer is untrusted input here, so
 * no coercion beyond an exact match: `'Visible'`, `'true'` and `1` are all
 * rejected into the safe mode rather than being guessed at.
 */
export function normalizeVisibilityMode(value: unknown): VisibilityMode {
  return value === "visible" || value === "hidden" ? value : DEFAULT_VISIBILITY_MODE;
}

/**
 * The single place that maps a mode onto the mechanism.
 *
 * `hidden` → `apply` (exactly today's behaviour).
 * `visible` → `remove` (capture exclusion lifted).
 */
export function resolveStealthAction(mode: unknown): StealthAction {
  return normalizeVisibilityMode(mode) === "visible" ? "remove" : "apply";
}

/**
 * Window events after which capture exclusion must be re-applied.
 *
 * `SetWindowDisplayAffinity` is lost across hide/show and minimize/restore
 * cycles, so the affinity has to be re-asserted on each. This list is the
 * single source of truth for that, and the tests assert every one of them is
 * wired — a missing event silently un-stealths the window.
 */
export const STEALTH_REAPPLY_EVENTS = ["show", "focus", "restore"] as const;

/** The one canonical log line per mode change. Never any other content. */
export function formatVisibilityLog(mode: VisibilityMode): string {
  return `[Ghostly Stealth] visibility=${mode}`;
}

/**
 * The controller.
 *
 * Owns the current mode and dispatches to the injected mechanism. Injecting
 * `apply`/`remove` rather than importing `stealth.ts` is what lets the tests
 * drive every path — including repeated toggles and re-apply cycles — with no
 * window and no Windows.
 */
export interface VisibilityController {
  /** Current mode. Always a valid mode, never undefined. */
  current(): VisibilityMode;
  /**
   * Set the mode and apply it immediately. Returns the mode that ended up in
   * effect, which may differ from the request if the request was invalid.
   */
  set(mode: unknown): VisibilityMode;
  /**
   * Re-assert the current mode without changing it and without logging.
   * Called on show/focus/restore.
   */
  reapply(): VisibilityMode;
  /** Which action the current mode maps to. */
  action(): StealthAction;
}

export interface VisibilityControllerDeps {
  /** The existing `applyStealthMode`. */
  apply: () => void;
  /** The existing `removeStealthMode`. */
  remove: () => void;
  /**
   * Called once per actual mode CHANGE. Injected so tests can assert the log
   * contract, and so a re-apply storm stays silent.
   */
  log?: (line: string) => void;
  /** Initial mode. Defaults to {@link DEFAULT_VISIBILITY_MODE}. */
  initial?: unknown;
}

export function createVisibilityController(
  deps: VisibilityControllerDeps,
): VisibilityController {
  let mode = normalizeVisibilityMode(deps.initial);

  // Re-assert the starting mode. Done through `reapply` so an `initial` of
  // `visible` is actually enforced rather than merely recorded.
  const dispatch = (target: StealthAction) => {
    if (target === "remove") deps.remove();
    else deps.apply();
  };

  dispatch(resolveStealthAction(mode));

  return {
    current: () => mode,
    action: () => resolveStealthAction(mode),
    set(next: unknown) {
      const normalized = normalizeVisibilityMode(next);
      // Dispatch on EVERY set, even when the mode is unchanged: the user may be
      // toggling back after the OS or a window rebuild dropped the affinity, and
      // re-asserting is always safe. Log only on an actual change.
      const changed = normalized !== mode;
      mode = normalized;
      dispatch(resolveStealthAction(mode));
      if (changed) deps.log?.(formatVisibilityLog(mode));
      return mode;
    },
    reapply() {
      dispatch(resolveStealthAction(mode));
      return mode;
    },
  };
}