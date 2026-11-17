import type { Box } from './dom';

// Where a dragged entry lands among the other entries of its section (pure, node-tested). The other entries' boxes
// come in page order, the dragged one taken out; the answer is its new place in the list counted the same way, and
// the line that shows it. Entries side by side (the cells of a row: Languages, Interests) split by halves across,
// entries one under another by halves down.

export interface Point {
  x: number;
  y: number;
}

/** The insertion line: across the top or bottom of an entry, or down the side of a cell. */
export interface DropLine {
  left: number;
  top: number;
  /** Across (`width`) or down (`height`). */
  width: number;
  height: number;
}

const LINE = 3;

/** Whether another box shares a row with `box` (their heights overlap by more than half the smaller one). */
function hasRowMate(boxes: readonly Box[], box: Box): boolean {
  return boxes.some((other) => {
    if (other === box) return false;
    const overlap = Math.min(box.top + box.height, other.top + other.height) - Math.max(box.top, other.top);
    return overlap > Math.min(box.height, other.height) / 2;
  });
}

function isAfter(box: Box, point: Point, across: boolean): boolean {
  if (point.y >= box.top + box.height) return true;
  if (point.y < box.top) return false;
  return across ? point.x > box.left + box.width / 2 : point.y > box.top + box.height / 2;
}

/** The dragged entry's new place: how many of the other entries come before `point`. */
export function dropIndex(others: readonly Box[], point: Point): number {
  return others.filter((box) => isAfter(box, point, hasRowMate(others, box))).length;
}

/** The line for a drop at `index` (before `others[index]`, or after the last); null when there is nothing to place it by. */
export function dropLine(others: readonly Box[], index: number): DropLine | null {
  const before = others[index];
  const after = others[index - 1];
  const box = before ?? after;
  if (!box) return null;
  if (hasRowMate(others, box)) {
    const x = before ? before.left : box.left + box.width;
    return { left: x - LINE / 2 - 1, top: box.top, width: LINE, height: box.height };
  }
  const y = before ? before.top : box.top + box.height;
  return { left: box.left, top: y - LINE / 2 - 1, width: box.width, height: LINE };
}
