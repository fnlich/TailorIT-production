import {
  RESUME_TEMPLATES,
  type HeaderField,
  type HeaderPhotoShape,
  type LayoutColumn,
  type PageSizeId,
  type Period,
  type RandomBytes,
  type ResumeDocument,
  type ResumeTemplateId,
  type SectionOptions,
  type SingleDate,
} from '@tailorit/shared/resume';
import * as actions from './actions';
import type { ActionContext, ActionResult, DesignPatch } from './actions';
import { createHistory, type HistoryMove, type StepSelection } from './history';
import { fieldLabel, groupNamePath, type Caret } from './paths';

// The editor's store: the document, its undo history, and every action as a method that records a step. React reads
// it with useSyncExternalStore: `getState()` for the bar (Undo, Redo and their labels), `select(path)` for one field,
// which changes only when that field's own value does. Every change to the document is handed to `onChange` (the
// autosave queue); loading a document is not a change.

export interface EditorState {
  document: ResumeDocument;
  canUndo: boolean;
  canRedo: boolean;
  /** What Undo would take back ("typing in Job title"); null when there is nothing. */
  undoLabel: string | null;
  redoLabel: string | null;
  /**
   * The last change was typing in a field the page has already (its address unchanged): the browser shows the text,
   * so the page may draw it a moment later. False after anything else (a new bullet or entry, Undo, a load).
   */
  typing: boolean;
}

export interface EditorStoreDeps {
  /** Where new ids come from (tests inject a seeded source). */
  random?: RandomBytes;
  now?: () => number;
  /** Every change to the document: an edit, an Undo, a Redo. */
  onChange?: (document: ResumeDocument) => void;
  historyLimit?: number;
  groupMs?: number;
}

/** What a method records besides its change. */
export interface StepOptions {
  /** Replaces the method's own label. */
  label?: string;
  /** Where the caret was before and after the change (a bullet edit supplies its own `after`). */
  selection?: StepSelection;
}

type Runner = <R extends ActionResult>(
  label: string,
  action: (document: ResumeDocument) => R,
  step?: { groupKey?: (result: R) => string | undefined; path?: string; typing?: boolean },
) => R;

const named = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

function commandsFor(run: Runner, current: () => ResumeDocument, context: ActionContext) {
  const section = (ref: string) => actions.sectionLabel(current(), ref);
  const chip = (path: string) => named(actions.valueAt(current(), path), fieldLabel(path));
  const typing = (path: string) => `typing in ${fieldLabel(path) || 'a field'}`;
  const headerLabel = (field: HeaderField) => fieldLabel(field === 'title' ? 'title' : `contact.${field}`);
  return {
    // Fields. Typing in one field within a second is one step (keyed by the field's path).
    setText: (path: string, value: string) =>
      run(typing(path), (d) => actions.setText(d, path, value, context), { groupKey: (result) => result.path, path, typing: true }),
    setRich: (path: string, markup: string) =>
      run(typing(path), (d) => actions.setRich(d, path, markup, context), { groupKey: (result) => result.path, path, typing: true }),
    setPeriod: (path: string, period: Period | null) =>
      run('Changed the date period', (d) => actions.setPeriod(d, path, period, context), { path }),
    setDate: (path: string, value: string | SingleDate | null) =>
      run('Changed the date', (d) => actions.setDate(d, path, value, context), { path }),
    setLevel: (path: string, level: number | null) =>
      run('Changed the level', (d) => actions.setLevel(d, path, level, context), { path }),

    // Bullets.
    splitBullet: (entry: string, index: number, before: string, after: string) =>
      run('New bullet', (d) => actions.splitBullet(d, entry, index, before, after, context)),
    mergeBulletWithPrevious: (entry: string, index: number) =>
      run('Joined bullets', (d) => actions.mergeBulletWithPrevious(d, entry, index, context)),
    removeBullet: (entry: string, index: number) =>
      run('Removed a bullet', (d) => actions.removeBullet(d, entry, index, context)),
    insertBullets: (entry: string, index: number, lines: string | readonly string[]) =>
      run('Pasted bullets', (d) => actions.insertBullets(d, entry, index, lines, context)),
    replaceBullets: (entry: string, lines: string | readonly string[]) =>
      run('Wrote bullets with AI', (d) => actions.replaceBullets(d, entry, lines, context)),

    // Entries.
    insertEntryAfter: (list: string, afterId: string | null) =>
      run('Added an entry', (d) => actions.insertEntryAfter(d, list, afterId, context)),
    removeEntry: (list: string, id: string) => run('Removed an entry', (d) => actions.removeEntry(d, list, id)),
    moveEntry: (list: string, id: string, delta: number) =>
      run('Moved an entry', (d) => actions.moveEntry(d, list, id, delta)),
    moveEntryTo: (list: string, id: string, index: number) =>
      run('Moved an entry', (d) => actions.moveEntryTo(d, list, id, index)),
    setEntryHidden: (path: string, hidden: readonly string[]) =>
      run('Changed the fields shown', (d) => actions.setEntryHidden(d, path, hidden, context), { path }),
    applyHiddenToSection: (list: string, hidden: readonly string[]) =>
      run('Applied the fields to the whole section', (d) => actions.applyHiddenToSection(d, list, hidden)),

    // Header.
    setHeaderHidden: (field: HeaderField, hidden: boolean) =>
      run(`${hidden ? 'Hid' : 'Showed'} ${headerLabel(field)}`, (d) => actions.setHeaderHidden(d, field, hidden)),
    setUppercaseName: (uppercase: boolean | null) =>
      run('Changed the name capitals', (d) => actions.setUppercaseName(d, uppercase)),
    setPhoto: (photo: { photoId: string; shape: HeaderPhotoShape } | null) =>
      run(photo ? 'Added a photo' : 'Removed the photo', (d) => actions.setPhoto(d, photo)),
    setPhotoShape: (shape: HeaderPhotoShape) => run('Changed the photo shape', (d) => actions.setPhotoShape(d, shape)),
    setYearsOfExperience: (years: number | null) =>
      run('typing in Years of experience', (d) => actions.setYearsOfExperience(d, years), {
        groupKey: () => 'totalYearsExperience',
      }),

    // Chips and skill groups.
    addChip: (list: string, name: string, index?: number) =>
      run(`Added ${named(name, 'a chip')}`, (d) => actions.addChip(d, list, name, index)),
    removeChip: (path: string) => run(`Removed ${chip(path)}`, (d) => actions.removeChip(d, path)),
    renameChip: (path: string, name: string) => run(`Renamed ${chip(path)}`, (d) => actions.renameChip(d, path, name)),
    moveChip: (list: string, from: number, to: number) =>
      run(`Moved ${chip(`${list}.${from}`)}`, (d) => actions.moveChip(d, list, from, to)),
    moveChipToGroup: (fromGroup: number | null, index: number, toGroup: number | null, toIndex: number) =>
      run(
        `Moved ${chip(fromGroup === null ? `skills.${index}` : `skillCategories.${fromGroup}.skills.${index}`)}`,
        (d) => actions.moveChipToGroup(d, fromGroup, index, toGroup, toIndex),
      ),
    addGroup: (name?: string) => run('Added a group', (d) => actions.addGroup(d, name)),
    renameGroup: (group: number, name: string) =>
      run('typing in Group name', (d) => actions.renameGroup(d, group, name), { groupKey: () => groupNamePath(group) }),
    removeGroup: (group: number) => run('Removed a group', (d) => actions.removeGroup(d, group)),

    // Sections.
    addSection: (ref: string, options?: { afterRef?: string }) =>
      run(`Added ${section(ref)}`, (d) => actions.addSection(d, ref, options)),
    disableSection: (ref: string) => run(`Removed ${section(ref)}`, (d) => actions.disableSection(d, ref)),
    renameSection: (ref: string, heading: string | null) =>
      run(`Renamed ${section(ref)}`, (d) => actions.renameSection(d, ref, heading)),
    moveSection: (ref: string, delta: number) => run(`Moved ${section(ref)}`, (d) => actions.moveSection(d, ref, delta)),
    moveSectionTo: (ref: string, target: { column: LayoutColumn; index: number }) =>
      run(`Moved ${section(ref)}`, (d) => actions.moveSectionTo(d, ref, target)),
    setSectionOptions: (ref: string, patch: SectionOptions) =>
      run(`Changed ${section(ref)} settings`, (d) => actions.setSectionOptions(d, ref, patch)),
    addCustomSection: (title: string, options?: { fields?: readonly string[]; afterRef?: string }) =>
      run(`Added ${named(title, actions.DEFAULT_CUSTOM_SECTION_TITLE)}`, (d) =>
        actions.addCustomSection(d, title, options, context),
      ),

    // Template and design. Repeated changes to one control within a second are one step, like typing.
    setTemplate: (templateId: ResumeTemplateId) =>
      run(`Changed the template to ${RESUME_TEMPLATES[templateId]?.name ?? templateId}`, (d) =>
        actions.setTemplate(d, templateId),
      ),
    setDesign: (patch: DesignPatch) =>
      run('Changed the design', (d) => actions.setDesign(d, patch), {
        groupKey: () => `design:${Object.keys(patch).sort().join(',')}`,
      }),
    setPageSize: (pageSize: PageSizeId) => run('Changed the page size', (d) => actions.setPageSize(d, pageSize)),
    setUppercaseHeadings: (uppercase: boolean | null) =>
      run('Changed the section titles', (d) => actions.setUppercaseHeadings(d, uppercase)),
  };
}

export type EditorCommands = ReturnType<typeof commandsFor>;

export interface EditorStore extends EditorCommands {
  getState(): EditorState;
  subscribe(listener: () => void): () => void;
  /** The value at a field's path (see `valueAt`): the same value until that field changes. */
  select(path: string): unknown;
  /** The methods again, recording `options` with the step (the caret before and after, another label). */
  with(options: StepOptions): EditorCommands;
  /** Any action as one step. */
  apply<R extends ActionResult>(label: string, action: (document: ResumeDocument) => R, options?: StepOptions): R;
  undo(): HistoryMove<ResumeDocument> | null;
  redo(): HistoryMove<ResumeDocument> | null;
  /** Opens a batch (a slider drag, a Rearrange session): every change until `end` is one step. */
  begin(label: string): void;
  end(): void;
  /** `run` as one step labelled `label`. */
  batch<T>(label: string, run: () => T): T;
  /** The next change starts a step of its own (the caret left the field). */
  seal(): void;
  /** Replaces the document (a reload after another tab saved); history starts again and nothing is saved. */
  load(document: ResumeDocument): void;
}

export function createEditorStore(initial: ResumeDocument, deps: EditorStoreDeps = {}): EditorStore {
  const history = createHistory(actions.loadDocument(initial).document, {
    limit: deps.historyLimit,
    groupMs: deps.groupMs,
    now: deps.now,
  });
  const listeners = new Set<() => void>();
  const context: ActionContext = { random: deps.random };
  let typing = false;
  let state = snapshot();

  function snapshot(): EditorState {
    return {
      document: history.present(),
      canUndo: history.canUndo(),
      canRedo: history.canRedo(),
      undoLabel: history.undoLabel(),
      redoLabel: history.redoLabel(),
      typing,
    };
  }

  /** A new state when anything in it moved; listeners hear of it. */
  function refresh(): void {
    const next = snapshot();
    const same = (Object.keys(next) as Array<keyof EditorState>).every((key) => Object.is(next[key], state[key]));
    if (same) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  function changed(document: ResumeDocument): void {
    refresh();
    deps.onChange?.(document);
  }

  function runnerWith(options: StepOptions): Runner {
    return (label, action, step = {}) => {
      const before = history.present();
      const result = action(before);
      if (result.document === before) return result;
      // The caret after a write to a placeholder row is in the entry it became.
      const ended = 'path' in result && typeof result.path === 'string' ? result.path : undefined;
      const retarget = (caret: Caret | null | undefined) =>
        caret && step.path && ended && caret.path === step.path ? { ...caret, path: ended } : caret;
      const own = 'caret' in result ? (result.caret as Caret | null) : undefined;
      const after = options.selection?.after !== undefined ? retarget(options.selection.after) : own;
      history.push(result.document, {
        label: options.label ?? label,
        groupKey: step.groupKey?.(result),
        selection: { before: options.selection?.before ?? null, after: after ?? null },
      });
      // A placeholder row written to became an entry: the page must draw it before the caret can go in.
      typing = step.typing === true && (ended === undefined || ended === step.path);
      changed(result.document);
      return result;
    };
  }

  const commands = (options: StepOptions) => commandsFor(runnerWith(options), history.present, context);

  return {
    ...commands({}),
    with: commands,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select: (path) => actions.valueAt(state.document, path),
    apply: (label, action, options = {}) => runnerWith(options)(label, action),
    undo() {
      const move = history.undo();
      typing = false;
      if (move) changed(move.document);
      return move;
    },
    redo() {
      const move = history.redo();
      typing = false;
      if (move) changed(move.document);
      return move;
    },
    begin(label) {
      history.begin(label);
    },
    end() {
      history.end();
      refresh();
    },
    batch(label, run) {
      history.begin(label);
      try {
        return run();
      } finally {
        history.end();
        refresh();
      }
    },
    seal() {
      history.seal();
    },
    load(document) {
      history.reset(actions.loadDocument(document).document);
      typing = false;
      refresh();
    },
  };
}
