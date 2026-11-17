import { z } from 'zod';
import { RESUME_FONT_PAIR_IDS, fontPairOf, isResumeFontPairId, type FontFace, type ResumeFontPairId } from './fonts';
import type { ResumeTemplateSpec } from './templates';

// The stepped controls of the editor's Design & Font panel (Enhancv's), as data. A document stores only what the
// person changed (`ResumeDesign`, step indexes and colours); `resolveDesign` lays that over a template's defaults and
// returns the concrete numbers the editor and the PDF renderer both draw with. Lengths are CSS px at 96 dpi on the
// page's CSS width (816 for Letter), so a margin or a gap measures the same in the editor and in the print.

export const DESIGN_CONTROLS = [
  'margins',
  'sectionSpacing',
  'colors',
  'fontPair',
  'fontSize',
  'lineHeight',
  'columnRatio',
  'background',
  'pageSize',
  'uppercaseHeadings',
] as const;
export type DesignControl = (typeof DESIGN_CONTROLS)[number];

/** A template's starting point. Step controls are indexes into the maps below; `columnRatio` indexes its `columnRatios`. */
export interface DesignDefaults {
  fontPair: ResumeFontPairId;
  colors: { primary: string; secondary: string };
  margins: number;
  sectionSpacing: number;
  fontSize: number;
  lineHeight: number;
  /** 0 on a one-column template (unused). */
  columnRatio: number;
  /** An id from the template's `backgrounds`; null for none. */
  background: string | null;
}

// ------------------------------------------------------------------------------------------------------ pages

export const PAGE_SIZE_IDS = ['letter', 'a4'] as const;
export type PageSizeId = (typeof PAGE_SIZE_IDS)[number];
export const DEFAULT_PAGE_SIZE: PageSizeId = 'letter';

export interface PageSize {
  widthPx: number;
  heightPx: number;
  /** The `@page { size }` value. */
  css: string;
  /** The PDF MediaBox, in points. */
  mediaBoxPt: readonly [number, number];
}

export const PAGE_SIZES: Readonly<Record<PageSizeId, PageSize>> = {
  letter: { widthPx: 816, heightPx: 1056, css: '8.5in 11in', mediaBoxPt: [612, 792] },
  a4: { widthPx: 793.7007874015749, heightPx: 1122.5196850393702, css: '210mm 297mm', mediaBoxPt: [595.28, 841.89] },
};

// ------------------------------------------------------------------------------------------------- the steps

// A template may shift every step of a map by a constant of its own (`marginShiftPx`, `sectionSpacingShiftPx`,
// `fontSizeShiftPt`, `lineHeightShift`), so a design drawn to other numbers starts on them exactly and the steps keep
// their spacing around it.

/**
 * Page margins on all four sides, narrow to wide: Enhancv's 28/36/44/50/60 px on its 940 px page scaled to 816,
 * the narrowest at the 0.25in print floor. A template may add to the top and the bottom (`marginExtraPx`).
 */
export const MARGIN_STEPS_PX: readonly number[] = [24, 32, 38, 43, 52];
/** The gap between sections, compact to more space. */
export const SECTION_SPACING_STEPS_PX: readonly number[] = [8, 12, 16, 22, 28];
/** Body text size. */
export const FONT_SIZE_STEPS_PT: readonly number[] = [9, 9.5, 10, 10.5, 11];
/** Unitless, condensed to spacious. */
export const LINE_HEIGHT_STEPS: readonly number[] = [1.2, 1.35, 1.5];
/** The side column's widths per two-column template (`ResumeTemplateSpec.columnRatios`). */
export const COLUMN_RATIO_STEP_COUNT = 4;

// ----------------------------------------------------------------------------------------------------- colours

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
export const isHexColor = (value: unknown): value is string => typeof value === 'string' && HEX_COLOR.test(value);

export interface ColorPreset {
  id: string;
  /** The swatch's accessible name. */
  label: string;
  primary: string;
  secondary: string;
}

/** The fourteen Primary and Secondary pairs the panel offers, in its order; lower-case hex. */
export const COLOR_PRESETS: readonly ColorPreset[] = [
  { id: 'ink-azure', label: 'Black and azure', primary: '#000000', secondary: '#1e90ff' },
  { id: 'forest-green', label: 'Forest and green', primary: '#124f44', secondary: '#3cb371' },
  { id: 'midnight-blue', label: 'Midnight and blue', primary: '#19273c', secondary: '#3c6df0' },
  { id: 'graphite-teal', label: 'Graphite and teal', primary: '#343334', secondary: '#00b6cb' },
  { id: 'cobalt-sky', label: 'Cobalt and sky', primary: '#002b7f', secondary: '#56acf2' },
  { id: 'ink-navy', label: 'Black and navy', primary: '#000000', secondary: '#11335e' },
  { id: 'burgundy-rose', label: 'Burgundy and rose', primary: '#5c1a2b', secondary: '#c2455f' },
  { id: 'plum-violet', label: 'Plum and violet', primary: '#3d2c5a', secondary: '#8a5cd0' },
  { id: 'slate-orange', label: 'Slate and orange', primary: '#2f3e4e', secondary: '#e0782f' },
  { id: 'charcoal-amber', label: 'Charcoal and amber', primary: '#262626', secondary: '#d98a00' },
  // The pairs of the four templates after the owner's originals.
  { id: 'slate-steel', label: 'Slate and steel', primary: '#4f667d', secondary: '#405973' },
  { id: 'ink-orange', label: 'Black and orange', primary: '#111111', secondary: '#e8631a' },
  { id: 'charcoal-teal', label: 'Charcoal and teal', primary: '#202020', secondary: '#0f766e' },
  { id: 'navy-blue', label: 'Navy and blue', primary: '#1c2333', secondary: '#2d5be3' },
];

// ------------------------------------------------------------------------------------------- the stored form

const hexColor = z.string().regex(HEX_COLOR).toLowerCase();
const stepIndex = (count: number) => z.number().int().min(0).max(count - 1);
const BACKGROUND_ID = /^[a-z0-9-]{1,40}$/;

/**
 * The overrides a person made in Design & Font; every field is optional and a missing one means "the template's
 * own". `background: 'none'` switches the template's background off; any other id must be one the template offers
 * (`resolveDesign` ignores the rest).
 */
export const ResumeDesignSchema = z.object({
  pageSize: z.enum(PAGE_SIZE_IDS).optional(),
  fontPair: z.enum(RESUME_FONT_PAIR_IDS).optional(),
  colors: z.object({ primary: hexColor, secondary: hexColor }).optional(),
  margins: stepIndex(MARGIN_STEPS_PX.length).optional(),
  sectionSpacing: stepIndex(SECTION_SPACING_STEPS_PX.length).optional(),
  fontSize: stepIndex(FONT_SIZE_STEPS_PT.length).optional(),
  lineHeight: stepIndex(LINE_HEIGHT_STEPS.length).optional(),
  columnRatio: stepIndex(COLUMN_RATIO_STEP_COUNT).optional(),
  background: z.string().regex(BACKGROUND_ID).optional(),
  uppercaseHeadings: z.boolean().optional(),
});
export type ResumeDesign = z.infer<typeof ResumeDesignSchema>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const readHex = (value: unknown): string | undefined =>
  typeof value === 'string' && HEX_COLOR.test(value.trim()) ? value.trim().toLowerCase() : undefined;

const readStep = (count: number) => (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < count ? value : undefined;

/** A field's value: the one given when it reads, else the stored one; `null` clears it back to the template's own. */
const choose = <T>(read: (value: unknown) => T | undefined, given: unknown, kept: unknown): T | undefined =>
  given === null ? undefined : (read(given) ?? read(kept));

function chooseColors(given: unknown, kept: unknown): ResumeDesign['colors'] {
  if (given === null) return undefined;
  const from = (source: unknown, key: 'primary' | 'secondary') => (isPlainRecord(source) ? readHex(source[key]) : undefined);
  const primary = from(given, 'primary') ?? from(kept, 'primary');
  const secondary = from(given, 'secondary') ?? from(kept, 'secondary');
  return primary && secondary ? { primary, secondary } : undefined;
}

/**
 * A design from any input (a request body, an editor draft), laid over `stored` the way the document's other fields
 * are: a field that reads is taken, one that is missing or reads wrong (not an integer, out of range, not a hex colour,
 * unknown font pair) keeps the stored value, and `null` clears it. Unknown keys are dropped; a colour pair needs both
 * ends. Never throws.
 */
export function normalizeDesign(input: unknown, stored?: ResumeDesign): ResumeDesign {
  const given = isPlainRecord(input) ? input : {};
  const kept = isPlainRecord(stored) ? stored : {};
  const candidate: Record<keyof ResumeDesign, unknown> = {
    pageSize: choose((v) => (v === 'letter' || v === 'a4' ? v : undefined), given.pageSize, kept.pageSize),
    fontPair: choose((v) => (isResumeFontPairId(v) ? v : undefined), given.fontPair, kept.fontPair),
    colors: chooseColors(given.colors, kept.colors),
    margins: choose(readStep(MARGIN_STEPS_PX.length), given.margins, kept.margins),
    sectionSpacing: choose(readStep(SECTION_SPACING_STEPS_PX.length), given.sectionSpacing, kept.sectionSpacing),
    fontSize: choose(readStep(FONT_SIZE_STEPS_PT.length), given.fontSize, kept.fontSize),
    lineHeight: choose(readStep(LINE_HEIGHT_STEPS.length), given.lineHeight, kept.lineHeight),
    columnRatio: choose(readStep(COLUMN_RATIO_STEP_COUNT), given.columnRatio, kept.columnRatio),
    background: choose(
      (v) => (typeof v === 'string' && BACKGROUND_ID.test(v.trim()) ? v.trim() : undefined),
      given.background,
      kept.background,
    ),
    uppercaseHeadings: choose((v) => (typeof v === 'boolean' ? v : undefined), given.uppercaseHeadings, kept.uppercaseHeadings),
  };
  return Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined)) as ResumeDesign;
}

// ----------------------------------------------------------------------------------------------- the numbers

/** A design with every choice made; what the editor's CSS and the PDF's CSS are written from. */
export interface ResolvedDesign {
  pageSize: PageSizeId;
  pageWidthPx: number;
  pageHeightPx: number;
  fontPairId: ResumeFontPairId;
  headingFont: FontFace;
  bodyFont: FontFace;
  /** Lower-case #rrggbb. */
  primary: string;
  secondary: string;
  /** The sides of every page, at the page's CSS width. */
  marginPx: number;
  /** The top of every page: the side margin and the template's extra (`marginExtraPx`). */
  marginTopPx: number;
  /** The bottom of every page: the side margin and the template's extra. */
  marginBottomPx: number;
  sectionSpacingPx: number;
  fontSizePt: number;
  /** Unitless. */
  lineHeight: number;
  /** The side column's fraction of the content width; 0 on a one-column template. */
  columnRatio: number;
  background: string | null;
  uppercaseHeadings: boolean;
}

function stepValue(steps: readonly number[], index: unknown, fallbackIndex: number): number {
  const at = typeof index === 'number' && Number.isInteger(index) ? steps[index] : undefined;
  return at ?? steps[fallbackIndex] ?? 0;
}

/** A shifted step without the float noise of the addition (px and pt to two places, line heights to four). */
const rounded = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * The step a resolved value is on in `steps`, each shifted by the template's `shift`: what the Design & Font panel
 * marks as chosen. 0 when the value is on none.
 */
export function stepIndexOf(steps: readonly number[], value: number, shift = 0): number {
  return Math.max(0, steps.findIndex((step) => Math.abs(step + shift - value) < 0.0005));
}

/**
 * The design a resume prints with: the template's defaults, then the stored overrides, except for a control the
 * template locks (its override is ignored). Anything unreadable falls back to the template's default, so a stale or
 * hand-edited document still draws.
 */
export function resolveDesign(design: ResumeDesign | undefined, template: ResumeTemplateSpec): ResolvedDesign {
  const defaults = template.designDefaults;
  const override = <K extends DesignControl>(control: K): ResumeDesign[K] | undefined =>
    template.designLocks.includes(control) ? undefined : design?.[control];

  const pageSize = override('pageSize') === 'a4' ? 'a4' : DEFAULT_PAGE_SIZE;
  const page = PAGE_SIZES[pageSize];
  const fontPair = override('fontPair');
  const pair = fontPairOf(isResumeFontPairId(fontPair) ? fontPair : defaults.fontPair);
  const colors = override('colors');
  const palette = colors && isHexColor(colors.primary) && isHexColor(colors.secondary) ? colors : defaults.colors;
  const background = override('background');
  const marginPx = rounded(stepValue(MARGIN_STEPS_PX, override('margins'), defaults.margins) + (template.marginShiftPx ?? 0), 2);

  return {
    pageSize,
    pageWidthPx: page.widthPx,
    pageHeightPx: page.heightPx,
    fontPairId: pair.id,
    headingFont: pair.heading,
    bodyFont: pair.body,
    primary: palette.primary.toLowerCase(),
    secondary: palette.secondary.toLowerCase(),
    marginPx,
    marginTopPx: rounded(marginPx + (template.marginExtraPx?.top ?? 0), 2),
    marginBottomPx: rounded(marginPx + (template.marginExtraPx?.bottom ?? 0), 2),
    sectionSpacingPx: rounded(
      stepValue(SECTION_SPACING_STEPS_PX, override('sectionSpacing'), defaults.sectionSpacing) +
        (template.sectionSpacingShiftPx ?? 0),
      2,
    ),
    fontSizePt: rounded(
      stepValue(FONT_SIZE_STEPS_PT, override('fontSize'), defaults.fontSize) + (template.fontSizeShiftPt ?? 0),
      2,
    ),
    lineHeight: rounded(
      stepValue(LINE_HEIGHT_STEPS, override('lineHeight'), defaults.lineHeight) + (template.lineHeightShift ?? 0),
      4,
    ),
    columnRatio:
      template.columns === 2 ? stepValue(template.columnRatios, override('columnRatio'), defaults.columnRatio) : 0,
    background:
      background === 'none'
        ? null
        : background !== undefined && template.backgrounds.includes(background)
          ? background
          : defaults.background,
    uppercaseHeadings: override('uppercaseHeadings') ?? template.uppercaseHeadings,
  };
}

/** Whether the panel shows the control for this template: not locked, and the template has something to choose from. */
export function isDesignControlEditable(template: ResumeTemplateSpec, control: DesignControl): boolean {
  if (template.designLocks.includes(control)) return false;
  if (control === 'columnRatio') return template.columns === 2;
  if (control === 'background') return template.backgrounds.length > 0;
  return true;
}
