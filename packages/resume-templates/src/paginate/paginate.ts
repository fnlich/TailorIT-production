// The resume's page breaks, decided from measured box heights. Pure: the editor feeds it heights read from the page it
// is showing, the API feeds it heights read from headless Chrome, and both draw the same breaks.
//
// The rules are Enhancv's. A box never splits: a whole entry (or row of short entries) that does not fit moves to the
// next page. A section's heading stays with the box after it, and a section that continues on the next page draws its
// heading again at the top. Each column flows on its own; the page count is the larger of the two. The first box of a
// page loses its top margin. Only a box taller than a page is placed where it is and left for the print to split; the
// templates split an entry that tall into a head and its bullets before it gets here, so it is a single bullet.
//
// The plan does not depend on the gap the editor draws between pages, so the editor's plan and the PDF's compare
// directly. `breakSpacer` turns a break into the height of the spacer the layout draws there.

export type BoxRole = 'heading' | 'entry' | 'row' | 'block' | 'part';

export interface BoxSpec {
  id: string;
  /** The column it flows in: 'main' or 'side'. */
  flow: string;
  role: BoxRole;
  /** The section it belongs to (a section ref); every box of a section shares it, its heading included. */
  group: string;
  /** Stays on the page of the box after it: a heading, an entry's head. */
  keepWithNext?: boolean;
}

/** What a box measures: CSS px, fractional. `marginTop` is the space above it unless it starts a page. */
export interface BoxMetrics {
  height: number;
  marginTop: number;
}

export interface PageGeometry {
  pageHeight: number;
  marginTop: number;
  marginBottom: number;
  /** What page 1 gives up in each flow to what sits above the columns (the header and the space under it). */
  firstPageReserve: Readonly<Record<string, number>>;
}

export interface PageBreak {
  /** The box that starts the new page in this flow. */
  before: string;
  /** The index of the page it starts (1 is the second page). */
  page: number;
  /** The room left below the last box of the page it ends. */
  remaining: number;
  /** The section heading drawn again at the top of the new page when the section continues; else null. */
  repeatHeading: string | null;
}

export interface PagePlan {
  pageCount: number;
  breaks: Readonly<Record<string, readonly PageBreak[]>>;
  /** The box ids on each page of each flow, in order (a repeated heading is not listed: it has no box of its own). */
  pages: Readonly<Record<string, readonly (readonly string[])[]>>;
  /** Boxes taller than a page's room: placed where they fall, and the print splits them wherever it needs to. */
  overflow: readonly string[];
}

/** A box ending this far past the room still counts as fitting: it lands in the bottom margin, out of sight. */
export const FIT_TOLERANCE_PX = 0.5;

export type FlowInput = Readonly<Record<string, readonly BoxSpec[]>>;
export type MetricsInput = ReadonlyMap<string, BoxMetrics> | Readonly<Record<string, BoxMetrics>>;

function metricsOf(metrics: MetricsInput, id: string): BoxMetrics {
  const found = metrics instanceof Map ? metrics.get(id) : (metrics as Readonly<Record<string, BoxMetrics>>)[id];
  if (!found || !Number.isFinite(found.height) || !Number.isFinite(found.marginTop)) {
    throw new Error(`paginate: no measure for box ${id}`);
  }
  return found;
}

/** The boxes of one flow placed on pages. */
function placeFlow(
  flow: string,
  boxes: readonly BoxSpec[],
  metrics: MetricsInput,
  geometry: PageGeometry,
  overflow: Set<string>,
): { breaks: PageBreak[]; pages: string[][] } {
  const content = geometry.pageHeight - geometry.marginTop - geometry.marginBottom;
  const room = (page: number) => content - (page === 0 ? (geometry.firstPageReserve[flow] ?? 0) : 0);
  const measure = boxes.map((box) => metricsOf(metrics, box.id));
  const headingAt = new Map<string, number>();
  boxes.forEach((box, index) => {
    if (box.role === 'heading' && !headingAt.has(box.group)) headingAt.set(box.group, index);
  });

  /** The height of the box at `index` and the boxes it must stay with, the first one at the top of a page or not. */
  const chainHeight = (index: number, first: boolean): number => {
    let total = (first ? 0 : measure[index]!.marginTop) + measure[index]!.height;
    let at = index;
    while (boxes[at]!.keepWithNext && at + 1 < boxes.length) {
      at += 1;
      total += measure[at]!.marginTop + measure[at]!.height;
    }
    return total;
  };

  const breaks: PageBreak[] = [];
  const pages: string[][] = [[]];
  let page = 0;
  let used = 0;
  let first = true;

  boxes.forEach((box, index) => {
    const own = measure[index]!;
    const fits = (need: number) => used + need <= room(page) + FIT_TOLERANCE_PX;
    const alone = (first ? 0 : own.marginTop) + own.height;
    let breakHere = false;
    if (!first) {
      if (box.keepWithNext) {
        // A heading or an entry's head moves to the next page with what follows it, unless that chain could not fit a
        // page either (then it stays and the print splits it).
        breakHere = !fits(chainHeight(index, first)) && chainHeight(index, true) <= room(page + 1) + FIT_TOLERANCE_PX;
      } else {
        breakHere = !fits(alone);
      }
    }
    if (!breakHere) {
      used += alone;
      first = false;
      pages[page]!.push(box.id);
      if (alone > room(page) + FIT_TOLERANCE_PX) overflow.add(box.id);
      return;
    }
    const headingIndex = headingAt.get(box.group);
    const repeatIndex =
      box.role !== 'heading' && headingIndex !== undefined && headingIndex < index ? headingIndex : null;
    breaks.push({
      before: box.id,
      page: page + 1,
      remaining: room(page) - used,
      repeatHeading: repeatIndex === null ? null : boxes[repeatIndex]!.id,
    });
    page += 1;
    pages.push([box.id]);
    // The new page starts with the repeated heading (if any), which loses its margin; the box then keeps its own.
    used = repeatIndex === null ? own.height : measure[repeatIndex]!.height + own.marginTop + own.height;
    first = false;
    if (used > room(page) + FIT_TOLERANCE_PX) overflow.add(box.id);
  });

  return { breaks, pages };
}

/**
 * Decides the page breaks of every flow. Throws when a box has no measure (a caller bug: a box that was never
 * measured would silently change the plan).
 */
export function paginate(flows: FlowInput, metrics: MetricsInput, geometry: PageGeometry): PagePlan {
  const overflow = new Set<string>();
  const breaks: Record<string, readonly PageBreak[]> = {};
  const pages: Record<string, readonly (readonly string[])[]> = {};
  let pageCount = 1;
  for (const [flow, boxes] of Object.entries(flows)) {
    const placed = placeFlow(flow, boxes, metrics, geometry, overflow);
    breaks[flow] = placed.breaks;
    pages[flow] = placed.pages;
    pageCount = Math.max(pageCount, placed.pages.length);
  }
  return { pageCount, breaks, pages, overflow: [...overflow] };
}

/**
 * The height of the spacer the layout draws before the box that starts a page. It fills the rest of the page it ends,
 * the bottom margin, the gap the editor draws between pages (0 in print) and the top margin of the next, less the
 * margin the first box of that page brings itself (`firstMarginTop`: the repeated heading's, or the box's).
 */
export function breakSpacer(
  pageBreak: PageBreak,
  geometry: Pick<PageGeometry, 'marginTop' | 'marginBottom'>,
  firstMarginTop: number,
  gap: number,
): number {
  return Math.max(0, pageBreak.remaining + geometry.marginBottom + gap + geometry.marginTop - firstMarginTop);
}
