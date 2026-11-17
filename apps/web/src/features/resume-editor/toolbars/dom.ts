import { isBulletPath, isDatePath } from '../fields/bridge';
import { headingPath } from '../store/paths';
import { selectionOfEntry, selectionOfPath, type Selection } from './selection';

// Reading the editor's page for the toolbars, through the page's own data attributes only (see ResumeLayout): a
// section is `[data-rt-section]`, an entry box (or a row's cell) `[data-rt-entry]`, the header `[data-rt-box=header]`,
// a field `[data-edit-path]`. The page may be scaled down on a narrow screen, so every place is read from the
// rectangles the browser draws, relative to the canvas the toolbars float in.

/** A rectangle in the canvas's coordinates (CSS px of the screen, after any scale). */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Refs, paths and ids are plain words; anything else is never put in a selector. */
const SAFE = /^[A-Za-z0-9_.:-]+$/;
const attr = (name: string, value: string) => (SAFE.test(value) ? `[${name}="${value}"]` : null);

/**
 * Whether Backspace in `field` points at its Settings ("Click here to hide fields"): a field that is empty already,
 * not a bullet (Backspace removes an empty one), a date (the picker clears it) or the name (it always prints).
 */
export function wantsSettingsHint(field: HTMLElement): boolean {
  const path = field.getAttribute('data-edit-path');
  if (!path || path === 'name' || !field.isContentEditable || isBulletPath(path) || isDatePath(path)) return false;
  return (field.textContent ?? '') === '';
}

export function pageOf(canvas: HTMLElement): HTMLElement | null {
  return canvas.querySelector<HTMLElement>('[data-resume-canvas]');
}

/** What a click or the caret at `target` selects on the page; null outside the header and the sections. */
export function selectionAt(target: Element): Selection | null {
  if (target.closest('[data-rt-box="header"]')) return { type: 'header' };
  const entry = target.closest('[data-rt-entry]');
  const entryPath = entry?.getAttribute('data-rt-entry');
  if (entryPath) {
    const selection = selectionOfEntry(entryPath);
    if (selection) return selection;
  }
  const field = target.closest('[data-edit-path]')?.getAttribute('data-edit-path') ?? undefined;
  const ref = target.closest('[data-rt-section]')?.getAttribute('data-rt-section');
  if (ref) return { type: 'section', ref, ...(field ? { path: field } : {}) };
  return field ? selectionOfPath(field) : null;
}

/** The element a selection stands for: the header box, the section, or the entry box (or cell). */
export function elementOf(page: ParentNode, selection: Selection): HTMLElement | null {
  if (selection.type === 'header') return page.querySelector<HTMLElement>('[data-rt-box="header"]');
  const selector =
    selection.type === 'section' ? attr('data-rt-section', selection.ref) : attr('data-rt-entry', selection.path);
  return selector ? page.querySelector<HTMLElement>(selector) : null;
}

export function sectionElement(page: ParentNode, ref: string): HTMLElement | null {
  const selector = attr('data-rt-section', ref);
  return selector ? page.querySelector<HTMLElement>(selector) : null;
}

export function boxOf(rect: DOMRect, origin: DOMRect): Box {
  return { left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height };
}

/**
 * A section's outline: one rectangle per page it is on (the boxes before each page break, then those after it), so
 * an outline never spans the gap between two pages.
 */
export function sectionBoxes(section: Element, origin: DOMRect): Box[] {
  const out: Box[] = [];
  let open: { left: number; top: number; right: number; bottom: number } | null = null;
  const close = () => {
    if (open) out.push({ left: open.left, top: open.top, width: open.right - open.left, height: open.bottom - open.top });
    open = null;
  };
  for (const child of Array.from(section.children)) {
    if (child.classList.contains('rt-break')) {
      close();
      continue;
    }
    const rect = child.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const box = { left: rect.left - origin.left, top: rect.top - origin.top, right: rect.right - origin.left, bottom: rect.bottom - origin.top };
    open = open
      ? { left: Math.min(open.left, box.left), top: Math.min(open.top, box.top), right: Math.max(open.right, box.right), bottom: Math.max(open.bottom, box.bottom) }
      : box;
  }
  close();
  return out;
}

/** The fields the caret can go into, in page order. */
function textFields(container: ParentNode): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-edit-path][role="textbox"]'));
}

/** The caret at the end of a field, the field scrolled into view if it is not. */
export function caretInto(field: HTMLElement): void {
  field.focus({ preventScroll: true });
  field.scrollIntoView({ block: 'nearest' });
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(field);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** The first field of an entry. */
export function firstEntryField(page: ParentNode, entryPath: string): HTMLElement | null {
  const selector = attr('data-rt-entry', entryPath);
  const entry = selector ? page.querySelector(selector) : null;
  return entry ? (textFields(entry)[0] ?? null) : null;
}

/** The first field of a section after its title (its first entry, the summary, a chip), else the title itself. */
export function firstSectionField(page: ParentNode, ref: string): HTMLElement | null {
  const section = sectionElement(page, ref);
  if (!section) return null;
  const fields = textFields(section);
  const title = headingPath(ref);
  return fields.find((field) => field.getAttribute('data-edit-path') !== title) ?? fields[0] ?? null;
}

/** A field by its path. */
export function fieldAt(page: ParentNode, path: string): HTMLElement | null {
  const selector = attr('data-edit-path', path);
  return selector ? page.querySelector<HTMLElement>(selector) : null;
}

/** The entries of a section in page order, by path (a row's cells one by one). */
export function entryPathsIn(page: ParentNode, ref: string): string[] {
  const section = sectionElement(page, ref);
  if (!section) return [];
  return Array.from(section.querySelectorAll('[data-rt-entry]'))
    .filter((element) => !element.hasAttribute('data-placeholder-entry'))
    .map((element) => element.getAttribute('data-rt-entry') ?? '')
    .filter(Boolean);
}

/** The sections on the page in reading order (the main column, then the side). */
export function sectionRefsOnPage(page: ParentNode): string[] {
  return Array.from(page.querySelectorAll('[data-rt-section]')).map((element) => element.getAttribute('data-rt-section') ?? '');
}
