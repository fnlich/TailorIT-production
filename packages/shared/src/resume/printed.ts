import type { SectionKind } from './catalogue';
import type { ResumeDocument } from './document';
import { effectiveLayout } from './layout';
import { ENTRY_TOGGLES, isFieldShown, isHeaderFieldShown, type ToggleKind } from './toggles';

// A resume as it prints: what matching, the analysis and the AI read, so a field the person hid or a section they
// switched off stops counting. Only a document of the on-page editor has toggles and switches; any other comes back
// as the same object, so its reading does not change.

type Entry = Record<string, unknown> & { hidden?: string[] };

const ENTRY_KINDS: ReadonlyArray<Exclude<SectionKind, 'summary' | 'skills' | 'softSkills' | 'interests'>> = [
  'experience',
  'strengths',
  'education',
  'certifications',
  'projects',
  'volunteering',
  'awards',
  'publications',
  'courses',
  'languages',
  'references',
];

/** The entry with every field a toggle hides emptied. */
function printedEntry(kind: ToggleKind, entry: Entry): Entry {
  let out = entry;
  for (const toggle of ENTRY_TOGGLES[kind]) {
    if (isFieldShown(kind, entry, toggle.key)) continue;
    if (out === entry) out = { ...entry };
    for (const field of toggle.fields) {
      if (Array.isArray(out[field])) out[field] = [];
      else if (typeof out[field] === 'string') out[field] = '';
      if (field === 'startDate' || field === 'endDate') delete out.period;
    }
  }
  return out;
}

const printedList = (kind: ToggleKind, list: unknown): Entry[] =>
  Array.isArray(list) ? (list as Entry[]).map((entry) => printedEntry(kind, entry)) : [];

/** The document as it prints: switched-off sections empty, hidden fields and header details blank. */
export function printedDocument<T extends Partial<ResumeDocument>>(document: T): T {
  if (document.templateId === undefined) return document;
  const layout = effectiveLayout(document as ResumeDocument);
  const enabled = new Set(layout.filter((item) => item.enabled).map((item) => item.ref));
  const out: Record<string, unknown> = { ...document };

  if (!enabled.has('summary')) out.summary = '';
  if (!enabled.has('skills')) {
    out.skills = [];
    delete out.skillCategories;
  } else {
    const options = layout.find((item) => item.ref === 'skills')?.options;
    // Group names that do not print are not words of the resume.
    if (options?.showGroupNames === false) delete out.skillCategories;
  }
  for (const chips of ['softSkills', 'interests'] as const) if (!enabled.has(chips)) out[chips] = [];
  for (const kind of ENTRY_KINDS) out[kind] = enabled.has(kind) ? printedList(kind, document[kind]) : [];
  if (Array.isArray(document.customSections)) {
    out.customSections = document.customSections.map((section) => ({
      ...section,
      entries: enabled.has(`custom:${section.key}`) ? printedList('custom', section.entries) : [],
    }));
  }

  const header = document.header;
  if (!isHeaderFieldShown(header, 'title')) out.title = '';
  if (document.contact) {
    const contact: Record<string, unknown> = { ...document.contact };
    for (const field of ['phone', 'email', 'location', 'linkedin', 'github', 'portfolio'] as const) {
      if (!isHeaderFieldShown(header, field) && field in contact) contact[field] = '';
    }
    out.contact = contact;
  }
  return out as T;
}
