import { z } from 'zod';
import {
  CUSTOM_REF_PREFIX,
  customSectionRef,
  effectiveSectionOrder,
  isCustomSectionKey,
  isSectionKind,
  parseSectionRef,
  presenceOf,
  sectionRefId,
  type SectionKind,
} from './catalogue';
import type { ResumeDocument } from './document';
import { resumeTemplateOf, type ResumeTemplateSpec } from './templates';

// The section layout of the on-page editor: one ordered list of every section the resume can hold, each with the
// column it is in, whether it prints and its own settings. A section that is switched off keeps its place in the list,
// its content and its settings, so adding it again brings everything back. The list replaces `sectionOrder` and the
// include flags (`layoutFromLegacy` reads those for a document that has no layout yet).

export const LAYOUT_COLUMNS = ['main', 'side'] as const;
export type LayoutColumn = (typeof LAYOUT_COLUMNS)[number];

export const SKILLS_LAYOUTS = ['tags', 'list', 'bullets'] as const;
export const TAG_BORDERS = ['box', 'underline'] as const;
/** The longest title a person may give a section. */
export const MAX_SECTION_HEADING_LENGTH = 60;

/** A section's own settings; a missing one means the template's default. */
export const SectionOptionsSchema = z
  .object({
    skillsLayout: z.enum(SKILLS_LAYOUTS),
    showGroupNames: z.boolean(),
    tagBorder: z.enum(TAG_BORDERS),
    showBulletMarker: z.boolean(),
    showProficiency: z.boolean(),
    showLevel: z.boolean(),
  })
  .partial();
export type SectionOptions = z.infer<typeof SectionOptionsSchema>;

export const LayoutItemSchema = z.object({
  /** A kind id, or `custom:<key>`. */
  ref: z.string(),
  column: z.enum(LAYOUT_COLUMNS),
  /** Whether the section prints. */
  enabled: z.boolean(),
  /** The title the person typed; absent means the section's own name. */
  heading: z.string().max(MAX_SECTION_HEADING_LENGTH).optional(),
  options: SectionOptionsSchema.optional(),
});
export type LayoutItem = z.infer<typeof LayoutItemSchema>;

/** The relative order of the kinds inside a column; custom sections follow them. */
export const DEFAULT_LAYOUT_ORDER: readonly SectionKind[] = [
  'summary',
  'experience',
  'education',
  'projects',
  'volunteering',
  'publications',
  'references',
  'strengths',
  'skills',
  'softSkills',
  'certifications',
  'awards',
  'courses',
  'languages',
  'interests',
];

/** The four every page shows, even with nothing in them yet. */
const ALWAYS_SHOWN: ReadonlySet<string> = new Set(['summary', 'experience', 'education', 'skills']);

/** Raw items read from a stored layout at most: far more than the 25 sections there can be. */
const MAX_ITEMS_READ = 200;

// ------------------------------------------------------------------------------------------------ reading input

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const oneOf =
  <T extends string>(allowed: readonly T[]) =>
  (value: unknown): T | undefined =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
const flag = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

/** Each option's reader: the value when it has the right type, else undefined. The table's order is the stored order. */
const OPTION_READERS: { readonly [K in keyof SectionOptions]-?: (value: unknown) => SectionOptions[K] } = {
  skillsLayout: oneOf(SKILLS_LAYOUTS),
  showGroupNames: flag,
  tagBorder: oneOf(TAG_BORDERS),
  showBulletMarker: flag,
  showProficiency: flag,
  showLevel: flag,
};
const OPTION_KEYS = Object.keys(OPTION_READERS) as Array<keyof SectionOptions>;

/** Options from untrusted input: a key of the wrong type or an unknown one is dropped; undefined when none is left. */
function cleanOptions(value: unknown): SectionOptions | undefined {
  if (!isPlainRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of OPTION_KEYS) {
    const read = OPTION_READERS[key] as (value: unknown) => unknown;
    const kept = read(value[key]);
    if (kept !== undefined) out[key] = kept;
  }
  return Object.keys(out).length > 0 ? (out as SectionOptions) : undefined;
}

/** A title on one line, trimmed. */
function tidyHeading(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

/** The title when it is 1 to 60 characters; a longer one is not a title the editor could have written. */
function keptHeading(value: unknown): string | undefined {
  const heading = tidyHeading(value);
  return heading && heading.length <= MAX_SECTION_HEADING_LENGTH ? heading : undefined;
}

/**
 * A layout from untrusted input: the valid refs once each (a `custom:` ref only for a key in `customKeys`), column
 * 'main' and enabled unless said otherwise, a heading of 1 to 60 characters, and the options that have the right type.
 * Everything else is dropped. Never throws; completion is `completeLayout`'s.
 */
export function cleanLayout(value: unknown, customKeys: readonly string[]): LayoutItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: LayoutItem[] = [];
  for (const raw of value.slice(0, MAX_ITEMS_READ)) {
    if (!isPlainRecord(raw)) continue;
    const ref = parseSectionRef(raw.ref);
    if (!ref || (ref.kind === 'custom' && !customKeys.includes(ref.key))) continue;
    const id = sectionRefId(ref);
    if (seen.has(id)) continue;
    seen.add(id);
    const heading = keptHeading(raw.heading);
    const options = cleanOptions(raw.options);
    out.push({
      ref: id,
      column: raw.column === 'side' ? 'side' : 'main',
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
      ...(heading ? { heading } : {}),
      ...(options ? { options } : {}),
    });
  }
  return out;
}

/**
 * The layout with every one of the fifteen kinds and every custom section exactly once. A missing section is added at
 * the end, switched off (so adding it again restores its content): the kinds in `DEFAULT_LAYOUT_ORDER`, then the custom
 * sections. A repeated item and an item for a custom section that no longer exists are dropped.
 */
export function completeLayout(layout: readonly LayoutItem[], customKeys: readonly string[]): LayoutItem[] {
  const refs = [...DEFAULT_LAYOUT_ORDER, ...customKeys.filter(isCustomSectionKey).map(customSectionRef)];
  const known = new Set<string>(refs);
  const seen = new Set<string>();
  const out: LayoutItem[] = [];
  for (const item of layout) {
    if (!known.has(item.ref) || seen.has(item.ref)) continue;
    seen.add(item.ref);
    out.push(item);
  }
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, column: 'main', enabled: false });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the starting layouts

/** The column a kind starts in on a template: its default placement on two columns, 'main' otherwise. */
function startColumn(ref: string, spec: ResumeTemplateSpec): LayoutColumn {
  if (spec.columns === 1 || !isSectionKind(ref)) return 'main';
  return spec.defaultPlacement[ref] ?? 'main';
}

/**
 * The layout of a document that has none yet, from what the old model said: its section order (completed the way the
 * old editor showed it), the sections with content, and the Strengths and Soft Skills switches. A section prints when
 * it has content, or is one of the four every page shows; Strengths and Soft Skills also need their switch on. The
 * columns are the template's defaults.
 */
export function layoutFromLegacy(document: ResumeDocument, spec: ResumeTemplateSpec): LayoutItem[] {
  const presence = presenceOf(document);
  const present = new Set<string>(presence.kinds);
  const settings = document.resumeSettings;
  const order = effectiveSectionOrder(document.sectionOrder ?? [], DEFAULT_LAYOUT_ORDER, presence);
  const prints = (ref: string): boolean => {
    if (ref.startsWith(CUSTOM_REF_PREFIX)) return true;
    if (ref === 'strengths') return present.has(ref) && settings?.includeStrengths === true;
    if (ref === 'softSkills') return present.has(ref) && settings?.includeSoftSkills === true;
    return present.has(ref) || ALWAYS_SHOWN.has(ref);
  };
  const items = order.map((ref): LayoutItem => ({ ref, column: startColumn(ref, spec), enabled: prints(ref) }));
  return completeLayout(items, presence.customKeys);
}

/** A blank page: Summary, Experience, Education and Skills in their default columns, every other section off. */
export function newDocumentLayout(spec: ResumeTemplateSpec): LayoutItem[] {
  const shown = DEFAULT_LAYOUT_ORDER.filter((kind) => ALWAYS_SHOWN.has(kind));
  return completeLayout(
    shown.map((ref): LayoutItem => ({ ref, column: startColumn(ref, spec), enabled: true })),
    [],
  );
}

/**
 * The layout a document prints with: its own, cleaned and completed, or the one worked out from the old model on the
 * template it opens on (`templateId`, else `preferredTemplate`). Pure; never throws.
 */
export function effectiveLayout(document: ResumeDocument): LayoutItem[] {
  const customKeys = presenceOf(document).customKeys;
  if (Array.isArray(document.layout)) return completeLayout(cleanLayout(document.layout, customKeys), customKeys);
  return layoutFromLegacy(document, resumeTemplateOf(document.templateId ?? document.preferredTemplate));
}

// ------------------------------------------------------------------------------------------------ editing

/** The column an item counts in: on a one-column template there is only 'main', whatever the item stores. */
const columnOf = (item: LayoutItem, spec?: ResumeTemplateSpec): LayoutColumn =>
  spec?.columns === 1 ? 'main' : item.column;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** `delta` as a whole number of places; anything else is no move. */
const places = (delta: number) => (Number.isFinite(delta) ? Math.trunc(delta) : 0);

/**
 * `ref` switched on. Summary goes first. Any other section goes right after `options.afterRef` (the section whose +
 * was used) in that section's column, or at the end of the shorter column by the number of sections on show (a tie is
 * the main column); on one column, at the end. A ref the layout lacks, or a section already on, changes nothing.
 */
export function enableSection(
  layout: readonly LayoutItem[],
  ref: string,
  spec: ResumeTemplateSpec,
  options: { afterRef?: string } = {},
): LayoutItem[] {
  const at = layout.findIndex((item) => item.ref === ref);
  const current = layout[at];
  if (!current || current.enabled) return [...layout];
  const rest = layout.filter((_, index) => index !== at);

  let column: LayoutColumn;
  let insertAt: number;
  const after = rest.findIndex((item) => item.enabled && item.ref === options.afterRef);
  if (ref === 'summary') {
    column = startColumn(ref, spec);
    insertAt = 0;
  } else if (after >= 0) {
    column = columnOf(rest[after]!, spec);
    insertAt = after + 1;
  } else {
    const shown = rest.filter((item) => item.enabled);
    const side = shown.filter((item) => item.column === 'side').length;
    column = spec.columns === 2 && side < shown.length - side ? 'side' : 'main';
    const lastInColumn = rest.findLastIndex((item) => item.enabled && columnOf(item, spec) === column);
    insertAt = lastInColumn >= 0 ? lastInColumn + 1 : rest.length;
  }
  return [...rest.slice(0, insertAt), { ...current, column, enabled: true }, ...rest.slice(insertAt)];
}

/** `ref` switched off. The item stays, with its heading and options, so adding it again restores them. */
export function disableSection(layout: readonly LayoutItem[], ref: string): LayoutItem[] {
  return layout.map((item) => (item.ref === ref && item.enabled ? { ...item, enabled: false } : item));
}

/**
 * `ref` moved `delta` places up (negative) or down among the sections on show in its column, held at the ends. Pass
 * the template so that a one-column template counts every section on show as one column.
 */
export function moveSectionBy(
  layout: readonly LayoutItem[],
  ref: string,
  delta: number,
  spec?: ResumeTemplateSpec,
): LayoutItem[] {
  const at = layout.findIndex((item) => item.ref === ref);
  const current = layout[at];
  if (!current || !current.enabled) return [...layout];
  const column = columnOf(current, spec);
  const slots: number[] = [];
  layout.forEach((item, index) => {
    if (item.enabled && columnOf(item, spec) === column) slots.push(index);
  });
  const rank = slots.indexOf(at);
  const target = clamp(rank + places(delta), 0, slots.length - 1);
  const next = [...layout];
  if (target === rank) return next;
  // The sections of this column swap places among the slots they already hold; every other item stays where it is.
  const order = slots.map((slot) => layout[slot]!);
  order.splice(rank, 1);
  order.splice(target, 0, current);
  slots.forEach((slot, index) => {
    next[slot] = order[index]!;
  });
  return next;
}

/**
 * `ref` dropped into `target.column` at `target.index`, counted among the sections on show there (the moved one not
 * included). On one column the stored column is left alone and the index counts every section on show. A ref that is
 * missing or switched off changes nothing.
 */
export function moveSectionTo(
  layout: readonly LayoutItem[],
  ref: string,
  target: { column: LayoutColumn; index: number },
  spec: ResumeTemplateSpec,
): LayoutItem[] {
  const at = layout.findIndex((item) => item.ref === ref);
  const current = layout[at];
  if (!current || !current.enabled) return [...layout];
  const column = spec.columns === 1 ? current.column : target.column;
  const group: LayoutColumn = spec.columns === 1 ? 'main' : column;
  const rest = layout.filter((_, index) => index !== at);
  const slots: number[] = [];
  rest.forEach((item, index) => {
    if (item.enabled && columnOf(item, spec) === group) slots.push(index);
  });
  const index = clamp(places(target.index), 0, slots.length);
  const insertAt = index < slots.length ? slots[index]! : slots.length > 0 ? slots[slots.length - 1]! + 1 : rest.length;
  return [...rest.slice(0, insertAt), { ...current, column }, ...rest.slice(insertAt)];
}

/** The title of a section, or its own name again with `undefined` (or a title that tidies to nothing). Cut at 60. */
export function setSectionHeading(layout: readonly LayoutItem[], ref: string, heading: string | undefined): LayoutItem[] {
  const title = tidyHeading(heading).slice(0, MAX_SECTION_HEADING_LENGTH).trim();
  return layout.map((item) => {
    if (item.ref !== ref) return item;
    const { heading: _old, ...rest } = item;
    return title ? { ...rest, heading: title } : rest;
  });
}

/**
 * A section's settings with `patch` laid over them. A key set to `undefined` goes back to the template's default; a
 * value of the wrong type is ignored.
 */
export function setSectionOptions(layout: readonly LayoutItem[], ref: string, patch: SectionOptions): LayoutItem[] {
  return layout.map((item) => {
    if (item.ref !== ref) return item;
    const merged: Record<string, unknown> = { ...item.options };
    for (const key of OPTION_KEYS) {
      if (!Object.hasOwn(patch, key)) continue;
      const value = patch[key];
      if (value === undefined) delete merged[key];
      else {
        const read = OPTION_READERS[key] as (value: unknown) => unknown;
        const kept = read(value);
        if (kept !== undefined) merged[key] = kept;
      }
    }
    const options = cleanOptions(merged);
    const { options: _old, ...rest } = item;
    return options ? { ...rest, options } : rest;
  });
}

/** The sections on show by column, each in layout order. A one-column template has only a main column. */
export function columnsOf(
  layout: readonly LayoutItem[],
  spec: ResumeTemplateSpec,
): { main: LayoutItem[]; side: LayoutItem[] } {
  const shown = layout.filter((item) => item.enabled);
  if (spec.columns === 1) return { main: shown, side: [] };
  return { main: shown.filter((item) => item.column === 'main'), side: shown.filter((item) => item.column === 'side') };
}
