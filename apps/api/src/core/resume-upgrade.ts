import {
  disableSection,
  escapeRichFields,
  isEditorDocument,
  languageLevelOf,
  layoutFromLegacy,
  legacyPrintedSections,
  normalizeResumeDocument,
  parsePeriod,
  RESUME_TEMPLATES,
  resolveTemplateId,
  setSectionOptions,
  withPositionalEntryIds,
  type ResumeDocument,
  type ResumeTemplateId,
} from '@tailorit/shared';
import { skillGroupsFor } from './skills/groups';
import type { SkillIndex } from './skills/library';

// A resume saved before the on-page editor, as that editor opens it: the same content in the new model. The old
// renderer worked several things out as it printed (the skill groups from the library, which sections its template
// had room for, a headline when there was none); the editor shows what prints, so those are written into the document
// here. Only the server can do it, since the grouping needs the person's skill library. v33 LEGACY: the retired
// templates and their engine are gone; what each printed is baked into shared (`legacyPrintedSections`). Every write
// stores the result (insertResume, updateResumeDocument); a read of an older row upgrades again and gets the same
// document, ids included. Callers go through core/skills' `editorDocumentOf`.

export interface UpgradeContext {
  /** The skill library with the person's own skills (core/skills' `skillsFor`). */
  skills: SkillIndex;
  /**
   * A new resume of the editor made from another's content (an upload read into one): on this template, at its own
   * page size, every section it has shown. Without it, an older resume keeps what its old template printed, on A4.
   */
  into?: ResumeTemplateId;
}

type Ranged = { startDate: string; endDate: string };

/** A date range as the editor's period; text that does not read as a date stays as typed. */
function withPeriod<T extends Ranged>(entry: T): T {
  if (!entry.startDate.trim() && !entry.endDate.trim()) return entry;
  return { ...entry, period: parsePeriod(entry.startDate, entry.endDate) };
}

/** The document as the on-page editor opens it; a document the editor already owns comes back as it is. */
export function upgradeLegacyDocument(document: ResumeDocument, context: UpgradeContext): ResumeDocument {
  if (isEditorDocument(document)) return document;
  const spec = RESUME_TEMPLATES[context.into ?? resolveTemplateId(document.preferredTemplate)];

  // The sections the old template printed; one it had no room for stays in the layout, switched off.
  const printed = new Set<string>(context.into ? [] : legacyPrintedSections(document.preferredTemplate));
  let layout = layoutFromLegacy(document, spec);
  if (printed.size > 0) {
    for (const item of layout) {
      const kind = item.ref.startsWith('custom:') ? 'custom' : item.ref;
      if (item.enabled && !printed.has(kind)) layout = disableSection(layout, item.ref);
    }
  }

  // Grouped skills print under the headings the old renderer gave them; Plain prints one list with no headings.
  const grouped = document.resumeSettings?.technicalSkillsLayout !== 'flat';
  layout = setSectionOptions(layout, 'skills', { showGroupNames: grouped });
  const groups = grouped ? skillGroupsFor(document, 'categorized', context.skills) : [];

  // Its text was literal: escaped, it reads back as the same words once the document holds markup.
  const source = escapeRichFields(document);
  const upgraded = {
    ...source,
    // The old renderer printed the latest role when there was no headline (and "Professional" when there was none).
    title: document.title.trim() || document.experience[0]?.title.trim() || '',
    experience: source.experience.map(withPeriod),
    education: source.education.map(withPeriod),
    projects: source.projects?.map(withPeriod),
    volunteering: source.volunteering?.map(withPeriod),
    customSections: source.customSections?.map((section) => ({ ...section, entries: section.entries.map(withPeriod) })),
    languages: source.languages?.map((entry) => {
      const level = entry.level ?? languageLevelOf(entry.proficiency);
      return level ? { ...entry, level } : entry;
    }),
    skillCategories: groups.length > 0 ? groups.map((group) => ({ category: group.category, skills: [...group.skills] })) : undefined,
    templateId: spec.id,
    layout,
    // v33 LEGACY: a header the document already has (its photo, say) is kept; every write upgrades now, and the editor's
    // fields may come without a template (a posted draft).
    header: document.header ?? { hidden: [] },
    // The old templates printed on A4; a new resume takes its template's own size.
    design: context.into ? {} : { pageSize: 'a4' as const },
    markupVersion: 1 as const,
  };
  return normalizeResumeDocument(withPositionalEntryIds(upgraded));
}
