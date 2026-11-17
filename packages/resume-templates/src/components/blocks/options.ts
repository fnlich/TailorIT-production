import type { SectionOptions, ToggleKind } from '@tailorit/shared';

// What the blocks share: class names joined, the way a template draws them (its look), and a section's settings with
// the template's defaults filled in.

export const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(' ');

export interface BlockOptions {
  skillsLayout: 'tags' | 'list' | 'bullets';
  tagBorder: 'box' | 'underline';
  showBulletMarker: boolean;
  showProficiency: boolean;
  showLevel: boolean;
}

/**
 * An entry's head:
 * - `stacked`, Enhancv's: the title, the subtitle, then a row of date, place and link;
 * - `classic`: two lines, the organisation and the place, then the role and the dates, the place and dates on the right;
 * - `split`: the title with the dates on the right, then one line of the subtitle, the place, the link and the facts;
 * - `line`: the title, then one line of the subtitle, the dates, the place, the link and the facts;
 * - `inline`: everything on one line, " | " between the parts ("B.S. | University | City | 2011 - 2015").
 */
export type EntryHead = 'stacked' | 'classic' | 'split' | 'line' | 'inline';

/** Where the templates draw the same blocks differently. Everything else is the template's CSS. */
export interface BlockLook {
  /** Icons before an entry's date, place and link, and before a strength. */
  icons: boolean;
  entryHead: EntryHead;
  /** Kinds of entry whose head is drawn otherwise than `entryHead` (a template's one-line education). */
  entryHeadByKind?: Readonly<Partial<Record<ToggleKind, EntryHead>>>;
  /** Kinds whose subtitle follows the title on its line in a `split` head: "Engineer at Acme". */
  subtitleAt?: readonly ToggleKind[];
  /** Between the parts of the second line of a `split` or `line` head ("Acme · Remote"); " | " when not set. */
  metaSeparator?: string;
  /** A strength: its title over its description (`stacked`), or one line, "Title: description" (`inline`). */
  strength?: 'stacked' | 'inline';
  /** " | " as text between the date, place and link of a stacked head, and between short facts: one line each. */
  separators: boolean;
  /** A language's label under its name (`stacked`) or after it on the same line, "English - Native" (`inline`). */
  language: 'stacked' | 'inline';
  /** Whether lists of words may print as tags; when not, the tag layout prints as the comma list. */
  tags: boolean;
  /** In the comma list, a skill group's name starts the line ("Data: PostgreSQL, Redis") instead of heading it. */
  inlineGroupNames: boolean;
  /** The section settings before the person changes them. */
  defaults: BlockOptions;
}

/** Enhancv's section settings: tags with a line under them, bullet markers, the proficiency label and dots. */
export const ENHANCV_OPTIONS: BlockOptions = {
  skillsLayout: 'tags',
  tagBorder: 'underline',
  showBulletMarker: true,
  showProficiency: true,
  showLevel: true,
};

/** The head an entry of `kind` is drawn with in `look`. */
export function entryHeadOf(look: BlockLook, kind: ToggleKind): EntryHead {
  return look.entryHeadByKind?.[kind] ?? look.entryHead;
}

/** Double Column's look, which most templates share. */
export const STANDARD_LOOK: BlockLook = {
  icons: true,
  entryHead: 'stacked',
  separators: false,
  language: 'stacked',
  tags: true,
  inlineGroupNames: false,
  defaults: ENHANCV_OPTIONS,
};

/**
 * A section's settings as a template draws them: each one the template's default until the person changes it. Takes a
 * section of the view or an item of the document's layout, so the editor's section settings show the same.
 */
export function blockOptions(section: { options?: SectionOptions }, look: BlockLook = STANDARD_LOOK): BlockOptions {
  const options = section.options ?? {};
  const defaults = look.defaults;
  const skillsLayout = options.skillsLayout ?? defaults.skillsLayout;
  return {
    skillsLayout: skillsLayout === 'tags' && !look.tags ? 'list' : skillsLayout,
    tagBorder: options.tagBorder ?? defaults.tagBorder,
    showBulletMarker: options.showBulletMarker ?? defaults.showBulletMarker,
    showProficiency: options.showProficiency ?? defaults.showProficiency,
    showLevel: options.showLevel ?? defaults.showLevel,
  };
}
