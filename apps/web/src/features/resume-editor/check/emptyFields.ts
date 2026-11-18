import type { ResumeDocument } from '@tailorit/shared/resume';
import type { RichView, TextView } from '@tailorit/resume-templates';
import { viewOf } from '../pages/views';

// The fields the editor shows but that hold nothing: each one prints as a gap in Preview and the PDF, so Download and
// Preview first say how many there are, and the page can show them in yellow. Read from the edit view, so a field the
// person switched off is not counted. The empty row of a section with no entries and the empty chip of a list with
// none are what the page offers to type into, not fields of the resume, so they do not count.

export interface EmptyField {
  path: string;
  /** What the page shows in it ("Company Name"). */
  placeholder: string;
  /** The section it is in; null for the header. */
  section: string | null;
}

const blankText = (field: TextView) => field.text.trim() === '';
const blankRich = (field: RichView) => field.runs.every((run) => run.text.trim() === '');

/** Every field of the edit view that is shown and empty, in page order (the header first, then each section). */
export function emptyVisibleFields(document: ResumeDocument): EmptyField[] {
  const view = viewOf(document, 'edit');
  const out: EmptyField[] = [];
  const text = (field: TextView | null | undefined, section: string | null) => {
    if (field && blankText(field)) out.push({ path: field.path, placeholder: field.placeholder, section });
  };
  const rich = (field: RichView | null | undefined, section: string | null) => {
    if (field && blankRich(field)) out.push({ path: field.path, placeholder: field.placeholder, section });
  };

  text(view.header.name, null);
  text(view.header.title, null);
  for (const contact of view.header.contacts) text(contact, null);

  for (const section of view.sections) {
    const ref = section.ref;
    text(section.heading, ref);
    const body = section.body;
    if (body.type === 'summary') rich(body.text, ref);
    // A chip with no text is the empty one a list with none shows: only a group's name counts.
    else if (body.type === 'skills') for (const group of body.groups) text(group.name, ref);
    else if (body.type === 'entries') {
      for (const entry of body.entries) {
        if (entry.placeholder) continue;
        text(entry.title, ref);
        text(entry.subtitle, ref);
        text(entry.date, ref);
        text(entry.location, ref);
        text(entry.link, ref);
        for (const detail of entry.details) text(detail, ref);
        rich(entry.description, ref);
        for (const bullet of entry.bullets) rich(bullet, ref);
        // The proficiency label prints only while the section shows it.
        if (section.options.showProficiency ?? true) text(entry.level?.label, ref);
      }
    }
  }
  return out;
}

/** A path the page can be asked about in a CSS attribute selector without escaping. */
const SAFE_PATH = /^[A-Za-z0-9_.:-]+$/;

/**
 * The page CSS that shows `paths` in yellow: a background only, so nothing moves. Scoped to the editor's page; a path
 * that is not a plain field path is left out.
 */
export function emptyFieldsCss(paths: readonly string[]): string {
  const selectors = paths.filter((path) => SAFE_PATH.test(path)).map((path) => `[data-resume-canvas] [data-edit-path="${path}"]`);
  if (selectors.length === 0) return '';
  return `${selectors.join(',')}{background-color:color-mix(in srgb,var(--color-tape) 50%,var(--color-surface));border-radius:2px}`;
}
