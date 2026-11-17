import type { Caret } from './paths';

// Undo and redo for the on-page editor: a list of document snapshots. Each step keeps the document before and after
// it, which costs little because the actions share every part they do not change. Typing is one step per field: pushes
// with the same group key (the field's path) less than `groupMs` apart merge. A batch (a slider drag, a Rearrange
// session) is one step however many pushes it holds. Each step remembers what to call it ("typing in Job title") and
// where the caret was before and after it, so Undo can say what it undid and put the caret back.

export const HISTORY_LIMIT = 100;
export const HISTORY_GROUP_MS = 1_000;

export interface StepSelection {
  /** Where the caret was before the change (restored by Undo). */
  before?: Caret | null;
  /** Where it was after (restored by Redo). */
  after?: Caret | null;
}

export interface PushOptions {
  label: string;
  /** Pushes with the same key in quick succession are one step (the field's path while typing). */
  groupKey?: string;
  selection?: StepSelection;
}

/** What Undo or Redo moved to. */
export interface HistoryMove<D> {
  document: D;
  /** The step's label, for "Undone: typing in Job title". */
  label: string;
  selection: Caret | null;
}

export interface History<D> {
  /** The document as it is now. */
  present(): D;
  /** `next` is the document now. The same document as the present one is no step. */
  push(next: D, options: PushOptions): void;
  undo(): HistoryMove<D> | null;
  redo(): HistoryMove<D> | null;
  canUndo(): boolean;
  canRedo(): boolean;
  /** The label of the step Undo (or Redo) would take; null when there is none. */
  undoLabel(): string | null;
  redoLabel(): string | null;
  /** Opens a batch: every push until the matching `end` is one step, labelled `label`. Batches nest. */
  begin(label: string): void;
  end(): void;
  /** The next push starts a step of its own, whatever its key (the caret left the field). */
  seal(): void;
  /** Starts again from `document`, with nothing to undo or redo. */
  reset(document: D): void;
}

export interface HistoryOptions {
  limit?: number;
  groupMs?: number;
  now?: () => number;
}

interface Step<D> {
  before: D;
  after: D;
  label: string;
  groupKey?: string;
  selectionBefore: Caret | null;
  selectionAfter: Caret | null;
  /** When it last grew. */
  at: number;
}

interface Batch<D> {
  label: string;
  depth: number;
  start: D;
  selectionBefore?: Caret | null;
  selectionAfter?: Caret | null;
}

export function createHistory<D>(initial: D, options: HistoryOptions = {}): History<D> {
  const limit = Math.max(1, Math.trunc(options.limit ?? HISTORY_LIMIT));
  const groupMs = options.groupMs ?? HISTORY_GROUP_MS;
  const now = options.now ?? Date.now;
  let present = initial;
  let past: Step<D>[] = [];
  let future: Step<D>[] = [];
  let batch: Batch<D> | null = null;
  let sealed = false;

  function record(step: Step<D>): void {
    past.push(step);
    if (past.length > limit) past = past.slice(past.length - limit);
    sealed = false;
  }

  function closeBatch(): void {
    const open = batch;
    batch = null;
    if (!open || open.start === present) return;
    record({
      before: open.start,
      after: present,
      label: open.label,
      selectionBefore: open.selectionBefore ?? null,
      selectionAfter: open.selectionAfter ?? null,
      at: now(),
    });
  }

  return {
    present: () => present,
    push(next, { label, groupKey, selection }) {
      if (Object.is(next, present)) return;
      future = [];
      if (batch) {
        if (batch.selectionBefore === undefined) batch.selectionBefore = selection?.before ?? null;
        if (selection?.after !== undefined) batch.selectionAfter = selection.after;
        present = next;
        return;
      }
      const at = now();
      const last = past.at(-1);
      if (!sealed && groupKey !== undefined && last?.groupKey === groupKey && at - last.at < groupMs) {
        last.after = next;
        last.at = at;
        if (selection?.after !== undefined) last.selectionAfter = selection.after;
        present = next;
        return;
      }
      record({
        before: present,
        after: next,
        label,
        groupKey,
        selectionBefore: selection?.before ?? null,
        selectionAfter: selection?.after ?? null,
        at,
      });
      present = next;
    },
    undo() {
      if (batch) closeBatch();
      const step = past.pop();
      if (!step) return null;
      future.push(step);
      present = step.before;
      sealed = true;
      return { document: present, label: step.label, selection: step.selectionBefore };
    },
    redo() {
      if (batch) closeBatch();
      const step = future.pop();
      if (!step) return null;
      past.push(step);
      present = step.after;
      sealed = true;
      return { document: present, label: step.label, selection: step.selectionAfter };
    },
    canUndo: () => past.length > 0 || (batch !== null && batch.start !== present),
    canRedo: () => future.length > 0,
    undoLabel: () => (batch && batch.start !== present ? batch.label : (past.at(-1)?.label ?? null)),
    redoLabel: () => future.at(-1)?.label ?? null,
    begin(label) {
      if (batch) batch.depth += 1;
      else batch = { label, depth: 1, start: present };
    },
    end() {
      if (!batch) return;
      batch.depth -= 1;
      if (batch.depth <= 0) closeBatch();
    },
    seal() {
      sealed = true;
    },
    reset(document) {
      present = document;
      past = [];
      future = [];
      batch = null;
      sealed = false;
    },
  };
}
