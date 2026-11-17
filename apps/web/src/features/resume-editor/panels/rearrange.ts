import type { PagePlan } from '@tailorit/resume-templates';

// The Rearrange dialog's board, worked out from the page plan: which sections each page holds in each column, how much
// of the page each takes (by its boxes there), and where a drop lands in the layout's order. A section that runs over
// a page break shows on both pages; dragging either part moves the whole section.

export type BoardColumnName = 'main' | 'side';

export interface BoardItem {
  /** The section ref. */
  ref: string;
  /** Unique on the board: the same section can show on two pages. */
  key: string;
  page: number;
  column: BoardColumnName;
  /** This part continues a section begun on an earlier page. */
  continued: boolean;
  /** The boxes it has on this page. */
  boxes: number;
  /** How tall it is on the page (CSS px): its boxes and the space between them; 0 when not measured. */
  height: number;
}

/** A box as the page measured it: its height, and the space above it within its section. */
export interface BoxMeasure {
  height: number;
  marginTop: number;
}

export interface BoardPage {
  page: number;
  columns: Record<BoardColumnName, BoardItem[]>;
}

/** The section a box belongs to: `h:<ref>`, or `<e|r|p>:<ref>:<n>` (a ref may hold a colon: `custom:<key>`). */
export function refOfBoxId(id: string): string | null {
  if (id.startsWith('h:')) return id.slice(2) || null;
  const match = /^[erpb]:(.+):[^:]+$/.exec(id);
  return match ? match[1]! : null;
}

/** The board of `plan`; `measure` gives each box's size, so each section is as tall on the board as on the page. */
export function boardOf(
  plan: PagePlan,
  columns: readonly BoardColumnName[],
  measure: (id: string) => BoxMeasure | undefined = () => undefined,
): BoardPage[] {
  const pages: BoardPage[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < plan.pageCount; page += 1) {
    const board: BoardPage = { page, columns: { main: [], side: [] } };
    for (const column of columns) {
      for (const id of plan.pages[column]?.[page] ?? []) {
        const ref = refOfBoxId(id);
        if (!ref) continue;
        const items = board.columns[column];
        const last = items[items.length - 1];
        const size = measure(id);
        if (last && last.ref === ref) {
          last.boxes += 1;
          last.height += (size?.marginTop ?? 0) + (size?.height ?? 0);
          continue;
        }
        // A section's first box on a page: the space above it is the section's, not part of it.
        items.push({ ref, key: `${ref}@${page}`, page, column, continued: seen.has(ref), boxes: 1, height: size?.height ?? 0 });
        seen.add(ref);
      }
    }
    pages.push(board);
  }
  return pages;
}

/** Each column's sections in the layout's order, once each (what moveSectionTo's index counts in). */
export function columnOrder(board: readonly BoardPage[], column: BoardColumnName): string[] {
  const order: string[] = [];
  for (const page of board) for (const item of page.columns[column]) if (!order.includes(item.ref)) order.push(item.ref);
  return order;
}

export type Drop =
  /** Onto a section's box: before it. */
  | { kind: 'before'; ref: string; column: BoardColumnName }
  /** Onto the end of a column on one page: after that page's last section in it. */
  | { kind: 'end'; page: number; column: BoardColumnName };

/** Where `moved` goes for a drop: the column and its index among that column's other sections; null to stay put. */
export function dropTarget(
  board: readonly BoardPage[],
  moved: string,
  drop: Drop,
): { column: BoardColumnName; index: number } | null {
  const order = columnOrder(board, drop.column).filter((ref) => ref !== moved);
  if (drop.kind === 'before') {
    if (drop.ref === moved) return null;
    const at = order.indexOf(drop.ref);
    return at < 0 ? null : { column: drop.column, index: at };
  }
  // After the last section this page shows in the column; on a page with none there, after the last one before it.
  let after = -1;
  for (const page of board) {
    if (page.page > drop.page) break;
    for (const item of page.columns[drop.column]) {
      const at = order.indexOf(item.ref);
      if (at > after) after = at;
    }
  }
  return { column: drop.column, index: after + 1 };
}
