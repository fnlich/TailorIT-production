import {
  dateRange,
  defaultHidden,
  effectiveLayout,
  effectiveTemplateId,
  isFieldShown,
  isHeaderFieldShown,
  isSafeInlineHref,
  parseInline,
  parseSectionRef,
  RESUME_TEMPLATES,
  resolveDesign,
  withPositionalEntryIds,
  type HeaderField,
  type InlineRun,
  type LayoutColumn,
  type ResolvedDesign,
  type ResumeDocument,
  type ResumeTemplateId,
  type ResumeTemplateSpec,
  type SectionKind,
  type SectionOptions,
  type ToggleKind,
} from '@tailorit/shared';

// What a template draws, worked out from a document once: the sections that are on, in their columns and order, each
// field with its document path (what the editor writes through) and its placeholder, after the entry's toggles. In
// edit mode a field that is on but empty is kept, so the editor can show its placeholder and the page has room to type
// in; in static mode (Preview, the PDF) it is left out, and so is a section with nothing to print.

export type ViewMode = 'edit' | 'static';

/** A plain text field. `text` is '' for an empty one (edit mode only). */
export interface TextView {
  path: string;
  text: string;
  placeholder: string;
}

/** A field that holds inline markup, as its runs. */
export interface RichView {
  path: string;
  runs: InlineRun[];
  placeholder: string;
}

export type ContactField = Exclude<HeaderField, 'title'>;

export interface ContactView extends TextView {
  field: ContactField;
  /** Only http(s) and mailto: links; null for text that is no link. */
  href: string | null;
  /** The line of the header it prints on (the template's `contactLines`); 0 when the template has one line. */
  line: number;
}

export interface HeaderView {
  name: TextView;
  title: TextView | null;
  contacts: ContactView[];
  photo: { photoId: string; shape: 'round' | 'square' } | null;
  uppercaseName: boolean;
}

/** A short fact, with the word printed before it ('GPA'), or null when it prints alone. */
export interface DetailView extends TextView {
  label: string | null;
}

/** One entry of any kind, mapped onto the parts every template draws. A part is null when it does not print. */
export interface EntryView {
  id: string;
  /** The entry's address: `experience.<id>`, `customSections.<key>.entries.<id>`. */
  path: string;
  kind: ToggleKind;
  /** The row the editor shows in a section with no entries; it is not in the document. */
  placeholder: boolean;
  /** What names it: a role, a degree, a project. */
  title: TextView | null;
  /** Where or with whom: the company, the school, the issuer. */
  subtitle: TextView | null;
  /** The period or the single date, as printed ("01/2020 - Present"). */
  date: TextView | null;
  location: TextView | null;
  link: (TextView & { href: string | null }) | null;
  /** Short facts: a GPA, a credential id, a reference's email. */
  details: DetailView[];
  description: RichView | null;
  bullets: RichView[];
  /** Languages only: the dots (null when no level is set) and the label. */
  level: { value: number | null; label: TextView | null } | null;
}

export interface SkillGroupView {
  /** Null: the skills print without a heading. */
  name: TextView | null;
  skills: TextView[];
}

export type SectionBody =
  | { type: 'summary'; text: RichView }
  | { type: 'entries'; entries: EntryView[] }
  | { type: 'skills'; groups: SkillGroupView[] }
  | { type: 'chips'; chips: TextView[] };

export interface SectionView {
  /** The layout ref: a kind id or `custom:<key>`. */
  ref: string;
  kind: SectionKind | 'custom';
  column: LayoutColumn;
  heading: TextView;
  options: SectionOptions;
  body: SectionBody;
  /** Short entries laid this many to a row in the section's column (1: one per row). */
  perRow: number;
}

export interface ResumeView {
  mode: ViewMode;
  templateId: ResumeTemplateId;
  spec: ResumeTemplateSpec;
  design: ResolvedDesign;
  header: HeaderView;
  sections: SectionView[];
}

/** The printed section titles, after Enhancv's; the person can rename any of them. */
export const DEFAULT_SECTION_HEADINGS: Readonly<Record<SectionKind, string>> = {
  summary: 'Summary',
  strengths: 'Strengths',
  skills: 'Skills',
  softSkills: 'Soft Skills',
  experience: 'Experience',
  education: 'Education',
  certifications: 'Certification',
  projects: 'Projects',
  volunteering: 'Volunteering',
  awards: 'Awards',
  publications: 'Publications',
  courses: 'Courses',
  languages: 'Languages',
  interests: 'Interests',
  references: 'References',
};
export const DEFAULT_CUSTOM_HEADING = 'Custom Section';

/** Enhancv's placeholders. */
const ph = {
  name: 'Your Name',
  title: 'The role you are applying for?',
  phone: 'Phone',
  email: 'Email',
  linkedin: 'LinkedIn',
  github: 'GitHub',
  portfolio: 'Portfolio',
  location: 'Location',
  summary:
    "Briefly explain why you're a great fit for the role. Use the AI assistant to tailor this summary for each job " +
    'posting.',
  bullet: 'Highlight your accomplishments, using numbers if possible.',
  period: 'Date period',
  date: 'Date',
  skill: 'Your Skill',
  chip: 'Skill',
  interest: 'Interest',
} as const;

const CONTACT_ORDER: readonly ContactField[] = ['phone', 'email', 'linkedin', 'github', 'portfolio', 'location'];

/** The contact fields in the order the template prints them, each with its line. */
function contactOrder(spec: ResumeTemplateSpec): Array<{ field: ContactField; line: number }> {
  const lines = spec.header.contactLines ?? [];
  const placed = lines.flatMap((fields, line) => fields.map((field) => ({ field, line })));
  const last = Math.max(0, lines.length - 1);
  const rest = CONTACT_ORDER.filter((field) => !placed.some((item) => item.field === field)).map((field) => ({ field, line: last }));
  return [...placed, ...rest];
}

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** A contact link: mailto for an email, https for a bare web address, nothing for anything else. */
function contactHref(field: ContactField, text: string): string | null {
  if (!text) return null;
  if (field === 'email') return isSafeInlineHref(`mailto:${text}`) && text.includes('@') ? `mailto:${text}` : null;
  if (field === 'phone' || field === 'location') return null;
  const url = /^https?:\/\//i.test(text) ? text : /^[^\s/]+\.[^\s]+$/.test(text) ? `https://${text}` : '';
  return url && isSafeInlineHref(url) ? url : null;
}

/** An http(s) link as typed, or null. */
function webHref(text: string): string | null {
  const url = /^https?:\/\//i.test(text) ? text : /^[^\s/]+\.[^\s]+$/.test(text) ? `https://${text}` : '';
  return url && isSafeInlineHref(url) ? url : null;
}

interface Context {
  mode: ViewMode;
  /** Whether the document's rich fields hold markup (otherwise each is one literal run). */
  markup: boolean;
  /** Between the two ends of a period, as the template prints it. */
  dateSeparator: string;
}

function runsOf(context: Context, value: string): InlineRun[] {
  if (!value) return [];
  return context.markup ? parseInline(value) : [{ text: value }];
}

const hasRuns = (runs: readonly InlineRun[]) => runs.some((run) => run.text.trim() !== '');

function headerView(document: ResumeDocument, spec: ResumeTemplateSpec, context: Context): HeaderView {
  const header = document.header;
  const keep = (text: string) => context.mode === 'edit' || text !== '';
  const title = str(document.title);
  const contact = (document.contact ?? {}) as Record<string, unknown>;
  const contacts: ContactView[] = [];
  for (const { field, line } of contactOrder(spec)) {
    const text = str(contact[field]);
    if (!isHeaderFieldShown(header, field) || !keep(text)) continue;
    contacts.push({ field, path: `contact.${field}`, text, placeholder: ph[field], href: contactHref(field, text), line });
  }
  return {
    name: { path: 'name', text: str(document.name), placeholder: ph.name },
    title:
      isHeaderFieldShown(header, 'title') && keep(title) ? { path: 'title', text: title, placeholder: ph.title } : null,
    contacts,
    photo: spec.supportsPhoto && header?.photo ? { ...header.photo } : null,
    uppercaseName: header?.uppercaseName ?? spec.header.uppercaseName,
  };
}

type Entry = Record<string, unknown> & { id?: string; hidden?: string[] };

/** How each kind's fields map onto the parts of an entry; `key` is the toggle that shows it. */
interface PartSpec {
  prop: string;
  key: string;
  placeholder: string;
}
interface KindSpec {
  title?: PartSpec;
  subtitle?: PartSpec;
  /** A range ('period', from startDate and endDate) or a single date property. */
  date?: { prop: 'period' | 'date'; key: string; placeholder: string };
  location?: PartSpec;
  link?: PartSpec;
  details?: Array<PartSpec & { label?: string }>;
  description?: PartSpec;
  bullets?: { key: string };
}

const part = (prop: string, placeholder: string, key = prop): PartSpec => ({ prop, key, placeholder });
const PERIOD = { prop: 'period', key: 'period', placeholder: ph.period } as const;
const DATE = { prop: 'date', key: 'date', placeholder: ph.date } as const;
const LOCATION = part('location', ph.location);
const BULLETS = { key: 'bullets' };

const KIND_SPECS: Readonly<Record<Exclude<ToggleKind, 'languages'>, KindSpec>> = {
  experience: {
    title: part('title', 'Title'),
    subtitle: part('company', 'Company Name'),
    date: PERIOD,
    location: LOCATION,
    description: part('description', 'Company Description'),
    bullets: BULLETS,
  },
  education: {
    title: part('degree', 'Degree and Field of Study'),
    subtitle: part('institution', 'School or University'),
    date: PERIOD,
    location: LOCATION,
    details: [{ ...part('gpa', 'GPA'), label: 'GPA' }],
    bullets: BULLETS,
  },
  projects: {
    title: part('name', 'Project Name'),
    subtitle: part('role', 'Your Role'),
    date: PERIOD,
    link: part('link', 'Link'),
    description: part('description', 'Short summary of your work'),
    bullets: BULLETS,
  },
  volunteering: {
    title: part('role', 'Role'),
    subtitle: part('organization', 'Organization'),
    date: PERIOD,
    location: LOCATION,
    description: part('description', 'Short summary of your work'),
    bullets: BULLETS,
  },
  custom: {
    title: part('heading', 'Title'),
    subtitle: part('subheading', 'Subtitle'),
    date: PERIOD,
    location: LOCATION,
    description: part('description', 'Description'),
    bullets: BULLETS,
  },
  certifications: {
    title: part('name', 'Certification Name'),
    subtitle: part('issuer', 'Issuing Organization'),
    date: DATE,
    details: [
      { ...part('expiryDate', 'Expiry date', 'expiry'), label: 'Expires' },
      { ...part('credentialId', 'Credential ID'), label: 'Credential ID' },
    ],
  },
  awards: {
    title: part('title', 'Award Name'),
    subtitle: part('issuer', 'Issued by'),
    date: DATE,
    description: part('description', 'What it was for'),
  },
  publications: {
    title: part('title', 'Publication Title'),
    subtitle: part('publisher', 'Publisher'),
    date: DATE,
    description: part('description', 'Short summary'),
  },
  courses: {
    title: part('name', 'Course Name'),
    subtitle: part('institution', 'Institution'),
    date: DATE,
  },
  references: {
    title: part('name', 'Reference Name'),
    subtitle: part('title', 'Job Title'),
    details: [part('company', 'Company'), part('email', 'Email'), part('phone', 'Phone')],
  },
  strengths: {
    title: part('title', 'Your Strength'),
    description: part('description', 'Explain how this strength helped you.'),
  },
};

function entryView(kind: ToggleKind, base: string, entry: Entry, context: Context, placeholder: boolean): EntryView {
  const id = entry.id ?? 'new';
  const path = `${base}.${id}`;
  const shown = (key: string) => isFieldShown(kind, entry, key);
  const keep = (text: string) => context.mode === 'edit' || text !== '';
  const text = (spec: PartSpec | undefined): TextView | null => {
    if (!spec || !shown(spec.key)) return null;
    const value = str(entry[spec.prop]);
    return keep(value) ? { path: `${path}.${spec.prop}`, text: value, placeholder: spec.placeholder } : null;
  };
  const view: EntryView = {
    id,
    path,
    kind,
    placeholder,
    title: null,
    subtitle: null,
    date: null,
    location: null,
    link: null,
    details: [],
    description: null,
    bullets: [],
    level: null,
  };

  if (kind === 'languages') {
    view.title = keep(str(entry.language))
      ? { path: `${path}.language`, text: str(entry.language), placeholder: 'Language' }
      : null;
    const label = str(entry.proficiency);
    const level = typeof entry.level === 'number' ? entry.level : null;
    view.level = {
      value: level,
      label: keep(label) ? { path: `${path}.proficiency`, text: label, placeholder: 'Proficiency' } : null,
    };
    return view;
  }

  const spec = KIND_SPECS[kind];
  view.title = text(spec.title);
  view.subtitle = text(spec.subtitle);
  if (spec.date && shown(spec.date.key)) {
    const value =
      spec.date.prop === 'period' ? dateRange(entry.startDate, entry.endDate, context.dateSeparator) : str(entry.date);
    if (keep(value)) view.date = { path: `${path}.${spec.date.prop}`, text: value, placeholder: spec.date.placeholder };
  }
  view.location = text(spec.location);
  const link = text(spec.link);
  view.link = link ? { ...link, href: webHref(link.text) } : null;
  for (const detail of spec.details ?? []) {
    const shownDetail = text(detail);
    if (shownDetail) view.details.push({ ...shownDetail, label: detail.label ?? null });
  }
  if (spec.description && shown(spec.description.key)) {
    const runs = runsOf(context, str(entry[spec.description.prop]));
    if (context.mode === 'edit' || hasRuns(runs)) {
      view.description = { path: `${path}.${spec.description.prop}`, runs, placeholder: spec.description.placeholder };
    }
  }
  if (spec.bullets && shown(spec.bullets.key)) {
    const lines = strings(entry.achievements);
    view.bullets = lines
      .map((line, index) => ({
        path: `${path}.achievements.${index}`,
        runs: runsOf(context, line),
        placeholder: ph.bullet,
      }))
      .filter((bullet) => context.mode === 'edit' || hasRuns(bullet.runs));
    if (context.mode === 'edit' && view.bullets.length === 0) {
      view.bullets.push({ path: `${path}.achievements.0`, runs: [], placeholder: ph.bullet });
    }
  }
  return view;
}

/** Whether a static entry prints anything at all. */
function printsSomething(entry: EntryView): boolean {
  return Boolean(
    entry.title ||
      entry.subtitle ||
      entry.date ||
      entry.location ||
      entry.link ||
      entry.details.length > 0 ||
      entry.description ||
      entry.bullets.length > 0 ||
      entry.level?.label ||
      entry.level?.value,
  );
}

function entriesBody(kind: ToggleKind, base: string, list: unknown, context: Context): SectionBody | null {
  const stored = Array.isArray(list) ? (list as Entry[]) : [];
  const entries = stored.map((entry) => entryView(kind, base, entry, context, false));
  if (context.mode === 'static') {
    const printed = entries.filter(printsSomething);
    return printed.length > 0 ? { type: 'entries', entries: printed } : null;
  }
  if (entries.length === 0) {
    // An empty section shows one row to type into; the editor adds it to the document on the first keystroke.
    entries.push(entryView(kind, base, { hidden: defaultHidden(kind) }, context, true));
  }
  return { type: 'entries', entries };
}

function skillsBody(document: ResumeDocument, options: SectionOptions, context: Context): SectionBody | null {
  const skills = strings(document.skills).map((skill) => skill.trim()).filter(Boolean);
  const categories = (document.skillCategories ?? []).filter(
    (group) => group.skills.length > 0 || context.mode === 'edit',
  );
  const named = options.showGroupNames ?? categories.length > 0;
  const groups: SkillGroupView[] = [];
  if (categories.length > 0) {
    const grouped = new Set<string>();
    categories.forEach((group, index) => {
      const chips = group.skills.map((skill, at) => ({
        path: `skillCategories.${index}.skills.${at}`,
        text: skill,
        placeholder: ph.skill,
      }));
      group.skills.forEach((skill) => grouped.add(skill.toLowerCase()));
      if (named) {
        const name = { path: `skillCategories.${index}.category`, text: group.category, placeholder: 'Group name' };
        groups.push({ name, skills: chips });
      } else if (groups[0]) groups[0].skills.push(...chips);
      else groups.push({ name: null, skills: chips });
    });
    // Skills the groups do not hold still print, after them.
    const rest = skills
      .map((skill, index) => ({ path: `skills.${index}`, text: skill, placeholder: ph.skill }))
      .filter((chip) => !grouped.has(chip.text.toLowerCase()));
    if (rest.length > 0) {
      if (!named && groups[0]) groups[0].skills.push(...rest);
      else groups.push({ name: null, skills: rest });
    }
  } else if (skills.length > 0) {
    const chips = skills.map((skill, index) => ({ path: `skills.${index}`, text: skill, placeholder: ph.skill }));
    groups.push({ name: null, skills: chips });
  }
  const printed = groups.filter((group) => group.skills.length > 0 || context.mode === 'edit');
  if (printed.length > 0) return { type: 'skills', groups: printed };
  if (context.mode === 'static') return null;
  return { type: 'skills', groups: [{ name: null, skills: [{ path: 'skills.0', text: '', placeholder: ph.skill }] }] };
}

function chipsBody(prop: 'softSkills' | 'interests', list: unknown, context: Context): SectionBody | null {
  const placeholder = prop === 'interests' ? ph.interest : ph.chip;
  const chips = strings(list)
    .map((chip, index) => ({ path: `${prop}.${index}`, text: chip.trim(), placeholder }))
    .filter((chip) => chip.text !== '');
  if (chips.length > 0) return { type: 'chips', chips };
  return context.mode === 'edit' ? { type: 'chips', chips: [{ path: `${prop}.0`, text: '', placeholder }] } : null;
}

/** The view of a document: everything a template draws, in `mode`. Pure; never throws on a normalized document. */
export function resumeView(input: ResumeDocument, mode: ViewMode): ResumeView {
  // Every entry has an id from here on (a legacy document's are positional), so every field has an address.
  const document = withPositionalEntryIds(input);
  const templateId = effectiveTemplateId(document);
  const spec = RESUME_TEMPLATES[templateId];
  const context: Context = { mode, markup: document.markupVersion === 1, dateSeparator: spec.dateSeparator ?? ' - ' };
  const sections: SectionView[] = [];

  for (const item of effectiveLayout(document)) {
    if (!item.enabled) continue;
    const ref = parseSectionRef(item.ref);
    if (!ref) continue;
    const column: LayoutColumn = spec.columns === 2 ? item.column : 'main';
    const options = item.options ?? {};
    let body: SectionBody | null = null;
    let heading: TextView;
    if (ref.kind === 'custom') {
      const index = (document.customSections ?? []).findIndex((section) => section.key === ref.key);
      const section = document.customSections?.[index];
      if (!section) continue;
      heading = { path: `customSections.${ref.key}.title`, text: section.title, placeholder: DEFAULT_CUSTOM_HEADING };
      body = entriesBody('custom', `customSections.${ref.key}.entries`, section.entries, context);
    } else {
      const kind = ref.kind;
      const fallback = DEFAULT_SECTION_HEADINGS[kind];
      heading = { path: `layout.${kind}.heading`, text: item.heading ?? fallback, placeholder: fallback };
      if (kind === 'summary') {
        const runs = runsOf(context, str(document.summary));
        const text = { path: 'summary', runs, placeholder: ph.summary };
        body = mode === 'edit' || hasRuns(runs) ? { type: 'summary', text } : null;
      } else if (kind === 'skills') {
        body = skillsBody(document, options, context);
      } else if (kind === 'softSkills' || kind === 'interests') {
        body = chipsBody(kind, document[kind], context);
      } else {
        body = entriesBody(kind, kind, document[kind], context);
      }
    }
    if (!body) continue;
    const perRow = ref.kind === 'custom' ? 1 : (spec.itemsPerRow[ref.kind]?.[column] ?? 1);
    sections.push({ ref: item.ref, kind: ref.kind, column, heading, options, body, perRow });
  }

  return {
    mode,
    templateId,
    spec,
    design: resolveDesign(document.design, spec),
    header: headerView(document, spec, context),
    sections,
  };
}
