// v1.4 E (decision 17): the full-page preview's sums. A document is a stack of pages `width` wide, each `pageHeight`
// tall with `gap` between them; the dialog draws it at a scale: fitted to the width it has (the default), or one of
// the zoom steps. Pure, so the dialog only draws.

/** The zoom steps − and + walk through. */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
/** "Fit width" never draws a page more than a quarter over its size (a wide window would make the text huge). */
export const FIT_MAX = 1.25;
const FIT_MIN = 0.2;

export type Zoom = { mode: 'fit' } | { mode: 'fixed'; scale: number };

export const FIT_WIDTH: Zoom = { mode: 'fit' };

/** The scale that makes a page `pageWidth` wide fill `available` pixels. */
export function fitScale(available: number, pageWidth: number): number {
  if (!(available > 0) || !(pageWidth > 0)) return 1;
  return Math.min(FIT_MAX, Math.max(FIT_MIN, available / pageWidth));
}

export function scaleOf(zoom: Zoom, available: number, pageWidth: number): number {
  return zoom.mode === 'fit' ? fitScale(available, pageWidth) : zoom.scale;
}

/** The next zoom step above (1) or below (-1) the scale drawn now; null past the last step. */
export function stepZoom(scale: number, direction: 1 | -1): Zoom | null {
  const next =
    direction === 1
      ? ZOOM_STEPS.find((step) => step > scale + 0.001)
      : [...ZOOM_STEPS].reverse().find((step) => step < scale - 0.001);
  return next === undefined ? null : { mode: 'fixed', scale: next };
}

/** "Fit width" or "125%". */
export function zoomLabel(zoom: Zoom, scale: number): string {
  return zoom.mode === 'fit' ? 'Fit width' : `${Math.round(scale * 100)}%`;
}

export interface PageStack {
  /** One page's width and height, unscaled (CSS px). */
  width: number;
  pageHeight: number;
  gap: number;
  /** Pages, at least 1. */
  count: number;
  /** The stack's own height, unscaled, when it is not whole pages (a letter's frame is as tall as its text). */
  height?: number;
}

/** The stack's height, unscaled: whole pages and the gaps between them, or its own measure. */
export function stackHeight(stack: PageStack): number {
  if (stack.height !== undefined) return stack.height;
  const pages = Math.max(1, stack.count);
  return pages * stack.pageHeight + (pages - 1) * stack.gap;
}

/** Where page `index` (0-based) starts, unscaled. */
export function pageTop(stack: PageStack, index: number): number {
  return index * (stack.pageHeight + stack.gap);
}

/**
 * The page being read (0-based) when the scroller shows `scrollTop` to `scrollTop + viewport` (scaled px, after
 * `padding` above the first page): the one under a line a third of the way down, so a page counts once most of the
 * window shows it. The last page counts once the scroller reaches the bottom.
 */
export function pageAt(stack: PageStack, scale: number, scrollTop: number, viewport: number, padding = 0): number {
  const pages = Math.max(1, stack.count);
  const total = stackHeight(stack) * scale + padding * 2;
  if (scrollTop + viewport >= total - 2) return pages - 1;
  const line = (scrollTop + viewport / 3 - padding) / scale;
  const index = Math.floor(line / (stack.pageHeight + stack.gap));
  return Math.min(pages - 1, Math.max(0, index));
}

/** A letter frame `height` tall on pages `pageHeight` tall: how many pages it takes. */
export function pagesIn(height: number, pageHeight: number): number {
  if (!(pageHeight > 0)) return 1;
  // A pixel or two over a page is rounding, not a page.
  return Math.max(1, Math.ceil((height - 2) / pageHeight));
}
