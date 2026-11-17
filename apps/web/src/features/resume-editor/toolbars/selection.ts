import { customSectionRef } from '@tailorit/shared/resume';
import { PLACEHOLDER_ENTRY_ID, entryListPath, entryOfPath, entryPath, parseFieldPath } from '../store/paths';

// What the toolbars act on: the header, a section, or one entry of a section. The page says what was clicked or
// focused through its data attributes (a field's path, an entry box's path, a section's ref); these pure helpers turn
// those into a selection, so the toolbars never parse the page's markup themselves.

export type Selection =
  | { type: 'header' }
  /** `path`: the field the person was in, if any (a chip of a skill group, say). */
  | { type: 'section'; ref: string; path?: string }
  | {
      type: 'entry';
      /** The section the entry is in. */
      ref: string;
      /** The entry list: `experience`, `customSections.<key>.entries`. */
      list: string;
      id: string;
      /** `<list>.<id>`. */
      path: string;
      /** The row an empty section shows; it is not in the document yet. */
      placeholder: boolean;
    };

/** The section an entry list belongs to: `experience`, or `custom:<key>`. */
export function sectionRefOfList(list: string): string | null {
  const target = parseFieldPath(`${list}.${PLACEHOLDER_ENTRY_ID}`);
  if (!target || target.type !== 'entry') return null;
  return target.list.kind === 'custom' ? customSectionRef(target.list.key) : target.list.kind;
}

/** An entry's selection from its path (`experience.e-1`, `customSections.cs-1.entries.p-1`). */
export function selectionOfEntry(path: string): Extract<Selection, { type: 'entry' }> | null {
  const entry = entryOfPath(path);
  if (!entry || entryPath(entry.list, entry.id) !== path) return null;
  const list = entryListPath(entry.list);
  const ref = sectionRefOfList(list);
  if (!ref) return null;
  return { type: 'entry', ref, list, id: entry.id, path, placeholder: entry.id === PLACEHOLDER_ENTRY_ID };
}

/** Where the skills, soft skills and interests chips live, by the head of their paths. */
const CHIP_SECTIONS: Readonly<Record<string, string>> = {
  skills: 'skills',
  skillCategories: 'skills',
  softSkills: 'softSkills',
  interests: 'interests',
};

/**
 * What a field's path selects: a header field the header, a field of an entry that entry (a role's "Skills used"
 * too), a section title, the summary or a chip their section. Null for a path the page does not draw.
 */
export function selectionOfPath(path: string): Selection | null {
  const target = parseFieldPath(path);
  if (!target) return null;
  switch (target.type) {
    case 'text':
      return target.field === 'summary' ? { type: 'section', ref: 'summary', path } : { type: 'header' };
    case 'contact':
      return { type: 'header' };
    case 'heading':
      return { type: 'section', ref: target.kind, path };
    case 'customTitle':
      return { type: 'section', ref: customSectionRef(target.key), path };
    case 'groupName':
      return { type: 'section', ref: 'skills', path };
    case 'chip': {
      if (target.list.kind === 'roleSkills') return selectionOfEntry(entryPath({ kind: 'experience' }, target.list.id));
      const ref = CHIP_SECTIONS[path.split('.')[0] ?? ''];
      return ref ? { type: 'section', ref, path } : null;
    }
    default: {
      const entry = entryOfPath(path);
      return entry ? selectionOfEntry(entryPath(entry.list, entry.id)) : null;
    }
  }
}

/** The section a selection is in (none for the header). */
export function sectionOfSelection(selection: Selection | null): string | null {
  return selection && selection.type !== 'header' ? selection.ref : null;
}

/** One string per selection, for comparing two (the field inside a section does not count). */
export function selectionKey(selection: Selection | null): string {
  if (!selection) return '';
  if (selection.type === 'header') return 'header';
  return selection.type === 'section' ? `section:${selection.ref}` : `entry:${selection.path}`;
}

export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  return selectionKey(a) === selectionKey(b) && (a?.type !== 'section' || b?.type !== 'section' || a.path === b.path);
}

/** The skill group a section selection was made in (a chip or a group name of `skillCategories.<n>`), or null. */
export function skillGroupOf(selection: Selection | null): number | null {
  if (selection?.type !== 'section' || !selection.path) return null;
  const match = /^skillCategories\.(\d+)\./.exec(selection.path);
  return match ? Number(match[1]) : null;
}
