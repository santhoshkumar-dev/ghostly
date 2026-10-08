import type React from "react";

/**
 * Alpha-aware inline surface styles.
 *
 * ── Why a helper instead of the `.gs` CSS class ────────────────────────────
 * Most of the overlay's panels are styled with inline `background:` /
 * `border:` shorthands, and an inline style beats any stylesheet — so the `.gs`
 * class in `global.css` cannot reach them. Rather than rewrite every panel's
 * styling approach, the same `rgb(... / calc(a * var(--ghostly-alpha)))`
 * expression is produced here and dropped into the existing inline `style`
 * objects.
 *
 * ── Why text is never touched ───────────────────────────────────────────────
 * Only `backgroundColor` and `borderColor` are scaled. Font colours are left at
 * their full value, which is what keeps the answer readable at 20%: the panel
 * goes see-through, the words on it do not.
 *
 * The result is a typed `React.CSSProperties`, so a site that forgets to pass a
 * border, or passes a malformed triplet, fails the build rather than rendering a
 * transparent panel at runtime.
 */

/** `"R G B"` triplets are used because `rgb()`'s space syntax takes components. */
export interface GhostlySurface {
  backgroundColor: string;
  border?: string;
}

const alpha = (a: number) => `calc(${a} * var(--ghostly-alpha))`;

/**
 * Build an alpha-aware background (and, by default, a 1px border).
 *
 * @param rgb      surface colour as `"R G B"`, e.g. `"20 20 23"`
 * @param a        design alpha 0–1, BEFORE the user's transparency
 * @param borderRgb border colour triplet; defaults to white
 * @param borderA  border design alpha; defaults to 0.08
 * @param withBorder `false` for panels that genuinely have no border (the answer
 *                   card), so no phantom 1px line appears.
 */
export function gs(
  rgb: string,
  a: number,
  borderRgb = "255 255 255",
  borderA = 0.08,
  withBorder = true,
): GhostlySurface {
  const surface: GhostlySurface = {
    backgroundColor: `rgb(${rgb} / ${alpha(a)})`,
  };
  if (withBorder) {
    surface.border = `1px solid rgb(${borderRgb} / ${alpha(borderA)})`;
  }
  return surface;
}

/**
 * Merge a surface into an existing inline style object.
 *
 * Order matters: the surface is spread FIRST so an explicit property already in
 * the style object (a boxShadow, a WebkitAppRegion) always wins. A call site that
 * needs to override the background can simply set it afterwards.
 */
export function withSurface(
  style: React.CSSProperties,
  ...surfaces: GhostlySurface[]
): React.CSSProperties {
  return Object.assign({}, ...surfaces, style);
}