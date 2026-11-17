import type { SectionKind } from './catalogue';
import type { DesignControl, DesignDefaults } from './design';
import type { HeaderField } from './toggles';

// The resume templates as data: six after Enhancv's own, and four after the owner's original designs (2026-11-08),
// listed first as the newest (the Templates panel, the new-resume chooser and the copy picker list them in this
// order). The editor and the PDF renderer build every template from the same blocks and read the differences here: how
// many columns, where each kind of section starts, how many short entries share a row, the header, and the design the
// template starts from. Which column a section is in lives in the document's `layout`; `defaultPlacement` only seeds
// it.

export const RESUME_TEMPLATE_IDS = [
  'one-column-slate',
  'one-column-accent-orange',
  'one-column-editorial',
  'one-column-timeline',
  'double-column',
  'single-column',
  'ivy-league',
  'modern',
  'compact',
  'ats-plain',
] as const;
export type ResumeTemplateId = (typeof RESUME_TEMPLATE_IDS)[number];
export const DEFAULT_TEMPLATE_ID: ResumeTemplateId = 'double-column';

export type TemplateColumn = 'main' | 'side';
/** A contact detail of the header: every header field but the title. */
export type HeaderContactField = Exclude<HeaderField, 'title'>;

export interface ResumeTemplateSpec {
  id: ResumeTemplateId;
  /** What the Templates panel calls it. */
  name: string;
  description: string;
  category: 'simple' | 'modern' | 'ats';
  columns: 1 | 2;
  /** Where the side column sits; null on one column. The main column is the other one. */
  side: { position: 'left' | 'right' } | null;
  /** The four widths of the side column as fractions of the content width, narrow to wide; [] on one column. */
  columnRatios: readonly number[];
  header: {
    align: 'left' | 'center';
    /** Full width above the columns, on page 1 only. */
    placement: 'top';
    /**
     * How the contact details print: `icons` an icon before each item, `text` plain items, `separators` one line
     * with " | " between the items.
     */
    contact: 'icons' | 'text' | 'separators';
    /** Whether the name prints in capitals until the person changes it (the document's `header.uppercaseName`). */
    uppercaseName: boolean;
    /**
     * The header runs to the edges of page 1 at its top: no page margin above it or beside it, so the band the
     * template's CSS draws behind it is full bleed. Its text keeps the side margin inside (`--rt-margin`).
     */
    bleed?: boolean;
    /**
     * The contact details in lines, each line in its order; a field no line lists goes at the end of the last line.
     * Not set: one line, phone, email, LinkedIn, GitHub, portfolio, location.
     */
    contactLines?: readonly (readonly HeaderContactField[])[];
    /** What `separators` prints between two contact details of a line; " | " when not set. */
    separator?: string;
  };
  /** The column a kind of section starts in when it is added; a kind not listed starts in 'main'. */
  defaultPlacement: Readonly<Partial<Record<SectionKind, TemplateColumn>>>;
  /** Short entries laid out N to a row, by the column the section is in; a kind not listed prints one per row. */
  itemsPerRow: Readonly<Partial<Record<SectionKind, { main: number; side: number }>>>;
  designDefaults: DesignDefaults;
  /** Controls the template does not let the person change; the panel disables them and `resolveDesign` ignores them. */
  designLocks: readonly DesignControl[];
  /** Ids of the page backgrounds the template offers, besides 'none'. */
  backgrounds: readonly string[];
  /** Section headings in capitals until the person changes it. */
  uppercaseHeadings: boolean;
  supportsPhoto: boolean;
  /** Added to every step of the font size map, in pt. */
  fontSizeShiftPt?: number;
  /** Added to every step of the margin map, in px: the side margin of a design drawn to page margins of its own. */
  marginShiftPx?: number;
  /** Added to the side margin at the top and at the bottom of every page, in px (a deeper top margin). */
  marginExtraPx?: { top?: number; bottom?: number };
  /** Added to every step of the section spacing map, in px. */
  sectionSpacingShiftPx?: number;
  /** Added to every step of the line height map (unitless). */
  lineHeightShift?: number;
  /** Between the two ends of a period ("02/2021 - Present"); " - " when not set. */
  dateSeparator?: string;
  /** A heading never ends a column, and a section that continues on the next page prints its heading again there. */
  splitRules: { headingKeepWithNext: true; repeatHeadingOnContinuation: true };
}

const SPLIT_RULES = { headingKeepWithNext: true, repeatHeadingOnContinuation: true } as const;

/** The sections a two-column template starts in the side column: the short, list-like ones. */
const SIDE_KINDS: Readonly<Partial<Record<SectionKind, TemplateColumn>>> = {
  strengths: 'side',
  skills: 'side',
  softSkills: 'side',
  languages: 'side',
  certifications: 'side',
  awards: 'side',
  courses: 'side',
  interests: 'side',
};

/** Two to a row in the wide main column, one in the narrow side column. */
const TWO_COLUMN_ROWS: ResumeTemplateSpec['itemsPerRow'] = {
  languages: { main: 2, side: 1 },
  interests: { main: 2, side: 1 },
  strengths: { main: 2, side: 1 },
};

/** Three to a row in the one wide column. */
const ONE_COLUMN_ROWS: ResumeTemplateSpec['itemsPerRow'] = {
  languages: { main: 3, side: 1 },
  interests: { main: 3, side: 1 },
  strengths: { main: 3, side: 1 },
};

// Step indexes: margins 2 is 38 px (about 0.4in), section spacing 2 is 16 px, font size 2 is 10 pt, line height 1 is 1.35.
const STANDARD_STEPS = { margins: 2, sectionSpacing: 2, fontSize: 2, lineHeight: 1 } as const;

// The owner's four originals were drawn in pt (Accent Orange in CSS px) for Helvetica and Arial. Each starts on its own
// numbers through the shifts below (1pt is 4/3 px), in Arimo, which has Arial's widths. Their defaults sit on the
// middle steps, so the person can go either way, except Accent Orange's small type, which can only grow.

/** 9pt body type: the 10pt step shifted down a point, so the five steps run from 8 to 10pt. */
const NINE_POINT = { fontSize: 2, fontSizeShiftPt: -1 } as const;
/** 36pt at the sides and the bottom, 40pt at the top (Editorial's and Timeline's page): 48 and 53.33 px. */
const PAGE_40_36 = { marginShiftPx: 5, marginExtraPx: { top: 5.33 } } as const;
/** 12.5pt lines for 9pt type (1.3889). */
const LINES_12_5_ON_9 = 0.0389;
/** One line of contacts in the originals' order: where you are, then how to reach you. */
const PLACE_FIRST: ResumeTemplateSpec['header']['contactLines'] = [
  ['location', 'phone', 'email', 'linkedin', 'github', 'portfolio'],
];
const EN_DASH = ' – ';
/** Three languages to a row in the one column; strengths one to a line, as the originals print them. */
const LANGUAGE_ROWS: ResumeTemplateSpec['itemsPerRow'] = { languages: { main: 3, side: 1 } };

export const RESUME_TEMPLATES: Readonly<Record<ResumeTemplateId, ResumeTemplateSpec>> = {
  'one-column-slate': {
    id: 'one-column-slate',
    name: 'Slate',
    description:
      'One column under a slate band across the top of the page, the contacts on its right; slate section titles, ' +
      'dot bullets and grey company and date lines. Reads well in applicant tracking systems.',
    category: 'modern',
    columns: 1,
    side: null,
    columnRatios: [],
    header: { align: 'left', placement: 'top', contact: 'text', uppercaseName: false, bleed: true, contactLines: PLACE_FIRST },
    defaultPlacement: {},
    itemsPerRow: LANGUAGE_ROWS,
    designDefaults: {
      fontPair: 'arimo',
      // The original's band #59738c one shade darker, so its light title and contact lines read at 4.5:1 or more.
      colors: { primary: '#4f667d', secondary: '#405973' },
      margins: 3,
      sectionSpacing: 2,
      fontSize: NINE_POINT.fontSize,
      lineHeight: 1,
      columnRatio: 0,
      background: null,
    },
    designLocks: [],
    backgrounds: [],
    uppercaseHeadings: false,
    supportsPhoto: true,
    fontSizeShiftPt: NINE_POINT.fontSizeShiftPt,
    // 34pt at the sides, 40pt at the top of a page (page 1 starts with the band), 36pt at the bottom; 14pt between
    // sections; 12pt lines.
    marginShiftPx: 2.33,
    marginExtraPx: { top: 8, bottom: 2.67 },
    sectionSpacingShiftPx: 2.67,
    lineHeightShift: -0.0167,
    splitRules: SPLIT_RULES,
  },
  'one-column-accent-orange': {
    id: 'one-column-accent-orange',
    name: 'Accent Orange',
    description:
      'One column with a centred header, an orange dot and a trailing rule on every section title, indented ' +
      'sections and grey dates on the right. Reads well in applicant tracking systems.',
    category: 'modern',
    columns: 1,
    side: null,
    columnRatios: [],
    header: {
      align: 'center',
      placement: 'top',
      contact: 'separators',
      uppercaseName: false,
      contactLines: PLACE_FIRST,
      separator: ' · ',
    },
    defaultPlacement: {},
    itemsPerRow: LANGUAGE_ROWS,
    designDefaults: {
      fontPair: 'arimo',
      colors: { primary: '#111111', secondary: '#e8631a' },
      margins: 3,
      sectionSpacing: 1,
      fontSize: 0,
      lineHeight: 1,
      columnRatio: 0,
      background: null,
    },
    designLocks: [],
    backgrounds: [],
    uppercaseHeadings: false,
    supportsPhoto: true,
    // 10px (7.5pt) type on 1.6 lines, 14mm margins and 9px between sections, as the original.
    fontSizeShiftPt: -1.5,
    marginShiftPx: 9.91,
    sectionSpacingShiftPx: -3,
    lineHeightShift: 0.25,
    dateSeparator: EN_DASH,
    splitRules: SPLIT_RULES,
  },
  'one-column-editorial': {
    id: 'one-column-editorial',
    name: 'Editorial',
    description:
      'One column with a centred header, teal-edged section titles, "Role at Company" lines with the dates on the ' +
      'right, and dash bullets. Reads well in applicant tracking systems.',
    category: 'simple',
    columns: 1,
    side: null,
    columnRatios: [],
    header: {
      align: 'center',
      placement: 'top',
      contact: 'separators',
      uppercaseName: false,
      contactLines: [
        ['email', 'phone', 'location'],
        ['linkedin', 'github', 'portfolio'],
      ],
      separator: '·',
    },
    defaultPlacement: {},
    itemsPerRow: LANGUAGE_ROWS,
    designDefaults: {
      fontPair: 'arimo',
      colors: { primary: '#202020', secondary: '#0f766e' },
      margins: 3,
      sectionSpacing: 2,
      fontSize: NINE_POINT.fontSize,
      lineHeight: 1,
      columnRatio: 0,
      background: null,
    },
    designLocks: [],
    backgrounds: [],
    uppercaseHeadings: false,
    supportsPhoto: true,
    fontSizeShiftPt: NINE_POINT.fontSizeShiftPt,
    ...PAGE_40_36,
    // 15pt between sections.
    sectionSpacingShiftPx: 4,
    lineHeightShift: LINES_12_5_ON_9,
    dateSeparator: EN_DASH,
    splitRules: SPLIT_RULES,
  },
  'one-column-timeline': {
    id: 'one-column-timeline',
    name: 'Timeline',
    description:
      'One column with a compact header and a blue accent, ruled section titles, and experience and education on a ' +
      'vertical timeline with dot markers. Reads well in applicant tracking systems.',
    category: 'simple',
    columns: 1,
    side: null,
    columnRatios: [],
    header: {
      align: 'left',
      placement: 'top',
      contact: 'separators',
      uppercaseName: false,
      contactLines: [['email', 'phone', 'location', 'linkedin', 'github', 'portfolio']],
      separator: '  | ',
    },
    defaultPlacement: {},
    itemsPerRow: LANGUAGE_ROWS,
    designDefaults: {
      fontPair: 'arimo',
      colors: { primary: '#1c2333', secondary: '#2d5be3' },
      margins: 3,
      sectionSpacing: 2,
      fontSize: NINE_POINT.fontSize,
      lineHeight: 1,
      columnRatio: 0,
      background: null,
    },
    designLocks: [],
    backgrounds: [],
    uppercaseHeadings: false,
    supportsPhoto: true,
    fontSizeShiftPt: NINE_POINT.fontSizeShiftPt,
    ...PAGE_40_36,
    // 14pt between sections.
    sectionSpacingShiftPx: 2.67,
    lineHeightShift: LINES_12_5_ON_9,
    dateSeparator: EN_DASH,
    splitRules: SPLIT_RULES,
  },
  'double-column': {
    id: 'double-column',
    name: 'Double Column',
    description: 'A wide main column for your experience and a narrow side column for skills, languages and more.',
    category: 'simple',
    columns: 2,
    side: { position: 'right' },
    columnRatios: [0.3, 0.35, 0.41, 0.45],
    header: { align: 'left', placement: 'top', contact: 'icons', uppercaseName: false },
    defaultPlacement: SIDE_KINDS,
    itemsPerRow: TWO_COLUMN_ROWS,
    designDefaults: {
      fontPair: 'rubik-inter',
      colors: { primary: '#000000', secondary: '#1e90ff' },
      ...STANDARD_STEPS,
      columnRatio: 2,
      background: null,
    },
    designLocks: [],
    backgrounds: [],
    uppercaseHeadings: true,
    supportsPhoto: true,
    splitRules: SPLIT_RULES,
  },
  'single-column': {
    id: 'single-column',
    name: 'Single Column',
    description: 'Everything in one column, top to bottom; the most familiar resume layout.',
    category: 'simple',
    columns: 1,
    side: null,
    columnRatios: [],
    header: { align: 'left', placement: 'top', contact: 'icons', uppercaseName: false },
    defaultPlacement: {},
    itemsPerRow: ONE_COLUMN_ROWS,
    designDefaults: {
      fontPair: 'rubik-inter',
      colors: { primary: '#000000', secondary: '#1e90ff' },
      ...STANDARD_STEPS,
      columnRatio: 0,
      background: null,
    },
    designLocks: [],
    backgrounds: [],
    uppercaseHeadings: true,
    supportsPhoto: true,
    splitRules: SPLIT_RULES,
  },
  'ivy-league': {
    id: 'ivy-league',
    name: 'Ivy League',
    description: 'A classic serif look: a centred header, one column and a rule under every heading.',
    category: 'simple',
    columns: 1,
    side: null,
    columnRatios: [],
    header: { align: 'center', placement: 'top', contact: 'separators', uppercaseName: false },
    defaultPlacement: {},
    itemsPerRow: ONE_COLUMN_ROWS,
    designDefaults: {
      fontPair: 'volkhov-ptsans',
      colors: { primary: '#000000', secondary: '#11335e' },
      ...STANDARD_STEPS,
      columnRatio: 0,
      background: null,
    },
    designLocks: [],
    backgrounds: [],
    uppercaseHeadings: true,
    supportsPhoto: true,
    splitRules: SPLIT_RULES,
  },
  modern: {
    id: 'modern',
    name: 'Modern',
    description: 'A bold header over two columns, with the main column on the left and no sidebar band.',
    category: 'modern',
    columns: 2,
    side: { position: 'right' },
    columnRatios: [0.3, 0.35, 0.4, 0.45],
    header: { align: 'left', placement: 'top', contact: 'icons', uppercaseName: true },
    defaultPlacement: SIDE_KINDS,
    itemsPerRow: TWO_COLUMN_ROWS,
    designDefaults: {
      fontPair: 'rubik-inter',
      colors: { primary: '#343334', secondary: '#00b6cb' },
      ...STANDARD_STEPS,
      columnRatio: 2,
      background: null,
    },
    designLocks: [],
    backgrounds: [],
    uppercaseHeadings: true,
    supportsPhoto: true,
    splitRules: SPLIT_RULES,
  },
  compact: {
    id: 'compact',
    name: 'Compact',
    description: 'Tight margins, spacing and type to fit more on a page, with a light-blue corner background.',
    category: 'modern',
    columns: 2,
    side: { position: 'right' },
    columnRatios: [0.28, 0.32, 0.36, 0.4],
    header: { align: 'left', placement: 'top', contact: 'icons', uppercaseName: false },
    defaultPlacement: SIDE_KINDS,
    itemsPerRow: TWO_COLUMN_ROWS,
    designDefaults: {
      fontPair: 'rubik-inter',
      colors: { primary: '#002b7f', secondary: '#56acf2' },
      margins: 1,
      sectionSpacing: 1,
      fontSize: 2,
      lineHeight: 0,
      columnRatio: 2,
      background: 'corners',
    },
    designLocks: [],
    backgrounds: ['corners'],
    uppercaseHeadings: true,
    supportsPhoto: true,
    fontSizeShiftPt: -0.5,
    splitRules: SPLIT_RULES,
  },
  'ats-plain': {
    id: 'ats-plain',
    name: 'ATS Plain',
    description: 'Plain black text in one column, with no icons, colours or backgrounds, for applicant tracking systems.',
    category: 'ats',
    columns: 1,
    side: null,
    columnRatios: [],
    header: { align: 'left', placement: 'top', contact: 'separators', uppercaseName: false },
    defaultPlacement: {},
    itemsPerRow: {},
    designDefaults: {
      fontPair: 'arimo-roboto',
      colors: { primary: '#000000', secondary: '#000000' },
      ...STANDARD_STEPS,
      columnRatio: 0,
      background: null,
    },
    designLocks: ['colors', 'background'],
    backgrounds: [],
    uppercaseHeadings: false,
    supportsPhoto: false,
    splitRules: SPLIT_RULES,
  },
};

export function isResumeTemplateId(value: unknown): value is ResumeTemplateId {
  return typeof value === 'string' && (RESUME_TEMPLATE_IDS as readonly string[]).includes(value);
}

/**
 * The ids of the 26 retired Handlebars templates and the template each opens on. Resumes keep their stored id; it is
 * mapped wherever it is read (`resolveTemplateId`).
 */
export const LEGACY_TEMPLATE_IDS: Readonly<Record<string, ResumeTemplateId>> = {
  default: 'double-column',
  'azure-stack': 'double-column',
  'amber-gradient': 'double-column',
  'contrast-cards': 'double-column',
  'forest-chips': 'double-column',
  'indigo-band': 'double-column',
  'structured-slate': 'double-column',
  'timeline-bars': 'double-column',
  'ink-ledger': 'double-column',
  'charcoal-sidebar': 'modern',
  'sidebar-executive': 'modern',
  'dossier-panel': 'modern',
  'classic-serif': 'ivy-league',
  'framed-serif': 'ivy-league',
  'navy-gold': 'ivy-league',
  'editorial-italic': 'ivy-league',
  'ats-executive': 'ivy-league',
  'navy-rule': 'single-column',
  'burgundy-rule': 'single-column',
  'slate-italic': 'single-column',
  'developer-mono': 'compact',
  'ats-tech-compact': 'compact',
  'ats-classic-serif': 'ats-plain',
  'ats-modern-sans': 'ats-plain',
  'ats-education-first': 'ats-plain',
  '9145ec7c-211d-4cce-a6ef-4ac44793c66a': 'ats-plain',
};

/** A stored template id as a current one: a current id stays, a legacy id maps; '' and anything else is the default. */
export function resolveTemplateId(id: unknown): ResumeTemplateId {
  if (typeof id !== 'string') return DEFAULT_TEMPLATE_ID;
  const wanted = id.trim();
  if (isResumeTemplateId(wanted)) return wanted;
  return (Object.hasOwn(LEGACY_TEMPLATE_IDS, wanted) ? LEGACY_TEMPLATE_IDS[wanted] : undefined) ?? DEFAULT_TEMPLATE_ID;
}

/** The spec of a stored template id (legacy ids included); the default template's for an unknown one. */
export function resumeTemplateOf(id: unknown): ResumeTemplateSpec {
  return RESUME_TEMPLATES[resolveTemplateId(id)];
}
