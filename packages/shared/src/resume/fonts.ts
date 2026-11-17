// The resume editor's font pairs (Enhancv's "Font style"): a heading face and a body face, as data both the editor
// and the PDF renderer read. Every face is an OFL or Apache family bundled as woff2 under apps/api/static/fonts, so the
// print browser needs no network and no system font. The generic family at the end of a stack is only the fallback
// for text outside a face's subsets.

export const RESUME_FONT_PAIR_IDS = [
  'rubik-inter',
  'lato-opensans',
  'raleway-opensans',
  'arimo-roboto',
  'arimo',
  'bitter-roboto',
  'tinos-ptsans',
  'volkhov-ptsans',
  'gelasio-ptsans',
] as const;
export type ResumeFontPairId = (typeof RESUME_FONT_PAIR_IDS)[number];
export const DEFAULT_FONT_PAIR_ID: ResumeFontPairId = 'rubik-inter';

export type FontWeight = 400 | 500 | 600 | 700;
export type FontSubset = 'latin' | 'latin-ext' | 'cyrillic' | 'greek';

export interface FontFace {
  /** The @font-face family name. */
  family: string;
  /** The CSS font-family value: the bundled family first, a metric-compatible system family where one exists, then a generic. */
  stack: string;
  /** Weights the files carry (a variable file carries all four). */
  weights: readonly FontWeight[];
  /** Whether an italic file is bundled, so B/I/U never synthesises one. */
  italic: boolean;
  serif: boolean;
  /** Scripts the bundled files cover; text outside them falls back to the stack's generic family. */
  subsets: readonly FontSubset[];
  /** The file name stem under apps/api/static/fonts ("pt-sans" for pt-sans-latin-normal-400.woff2); informational. */
  file: string;
}

export interface FontPair {
  id: ResumeFontPairId;
  label: string;
  /** What the pair looks like to someone who knows the system font ("Arial-like font"). */
  hint?: string;
  heading: FontFace;
  body: FontFace;
}

const ALL_WEIGHTS: readonly FontWeight[] = [400, 500, 600, 700];
const REGULAR_BOLD: readonly FontWeight[] = [400, 700];
const WESTERN: readonly FontSubset[] = ['latin', 'latin-ext'];
const WITH_CYRILLIC: readonly FontSubset[] = ['latin', 'latin-ext', 'cyrillic'];
const WITH_GREEK: readonly FontSubset[] = ['latin', 'latin-ext', 'cyrillic', 'greek'];

const rubik: FontFace = {
  family: 'Rubik',
  stack: '"Rubik", sans-serif',
  weights: ALL_WEIGHTS,
  italic: true,
  serif: false,
  subsets: WITH_CYRILLIC,
  file: 'rubik',
};
const inter: FontFace = {
  family: 'Inter',
  stack: '"Inter", sans-serif',
  weights: ALL_WEIGHTS,
  italic: true,
  serif: false,
  subsets: WITH_GREEK,
  file: 'inter',
};
const lato: FontFace = {
  family: 'Lato',
  stack: '"Lato", sans-serif',
  weights: REGULAR_BOLD,
  italic: true,
  serif: false,
  subsets: WESTERN,
  file: 'lato',
};
const openSans: FontFace = {
  family: 'Open Sans',
  stack: '"Open Sans", sans-serif',
  weights: ALL_WEIGHTS,
  italic: true,
  serif: false,
  subsets: WITH_GREEK,
  file: 'open-sans',
};
const raleway: FontFace = {
  family: 'Raleway',
  stack: '"Raleway", sans-serif',
  weights: ALL_WEIGHTS,
  italic: true,
  serif: false,
  subsets: WITH_CYRILLIC,
  file: 'raleway',
};
const arimo: FontFace = {
  family: 'Arimo',
  stack: '"Arimo", Arial, sans-serif',
  weights: ALL_WEIGHTS,
  italic: true,
  serif: false,
  subsets: WITH_GREEK,
  file: 'arimo',
};
const roboto: FontFace = {
  family: 'Roboto',
  stack: '"Roboto", sans-serif',
  weights: ALL_WEIGHTS,
  italic: true,
  serif: false,
  subsets: WITH_GREEK,
  file: 'roboto',
};
const bitter: FontFace = {
  family: 'Bitter',
  stack: '"Bitter", serif',
  weights: ALL_WEIGHTS,
  italic: true,
  serif: true,
  subsets: WITH_CYRILLIC,
  file: 'bitter',
};
const tinos: FontFace = {
  family: 'Tinos',
  stack: '"Tinos", "Times New Roman", Times, serif',
  weights: REGULAR_BOLD,
  italic: true,
  serif: true,
  subsets: WITH_GREEK,
  file: 'tinos',
};
const ptSans: FontFace = {
  family: 'PT Sans',
  stack: '"PT Sans", sans-serif',
  weights: REGULAR_BOLD,
  italic: true,
  serif: false,
  subsets: WITH_CYRILLIC,
  file: 'pt-sans',
};
// Volkhov ships Basic Latin only: Polish or Cyrillic text in a heading falls back to the serif.
const volkhov: FontFace = {
  family: 'Volkhov',
  stack: '"Volkhov", serif',
  weights: REGULAR_BOLD,
  italic: true,
  serif: true,
  subsets: ['latin'],
  file: 'volkhov',
};
const gelasio: FontFace = {
  family: 'Gelasio',
  stack: '"Gelasio", Georgia, serif',
  weights: ALL_WEIGHTS,
  italic: true,
  serif: true,
  subsets: WESTERN,
  file: 'gelasio',
};

/** In the order the Design & Font panel lists them, the default first. */
export const RESUME_FONT_PAIRS: readonly FontPair[] = [
  { id: 'rubik-inter', label: 'Rubik + Inter', heading: rubik, body: inter },
  { id: 'lato-opensans', label: 'Lato + Open Sans', heading: lato, body: openSans },
  { id: 'raleway-opensans', label: 'Raleway + Open Sans', heading: raleway, body: openSans },
  { id: 'arimo-roboto', label: 'Arimo + Roboto', hint: 'Arial-like font', heading: arimo, body: roboto },
  // One family for both: the Helvetica and Arial stack of the owner's original templates, in Arimo, which has Arial's
  // (and so Helvetica's) widths, bundled so the editor and the PDF wrap lines alike on every machine.
  { id: 'arimo', label: 'Arimo', hint: 'Helvetica and Arial-like font', heading: arimo, body: arimo },
  { id: 'bitter-roboto', label: 'Bitter + Roboto', heading: bitter, body: roboto },
  { id: 'tinos-ptsans', label: 'Tinos + PT Sans', hint: 'Times New Roman-like font', heading: tinos, body: ptSans },
  { id: 'volkhov-ptsans', label: 'Volkhov + PT Sans', heading: volkhov, body: ptSans },
  { id: 'gelasio-ptsans', label: 'Gelasio + PT Sans', hint: 'Georgia-like font', heading: gelasio, body: ptSans },
];

const FONT_PAIR_BY_ID = Object.fromEntries(RESUME_FONT_PAIRS.map((pair) => [pair.id, pair])) as Readonly<
  Record<ResumeFontPairId, FontPair>
>;

export function isResumeFontPairId(value: unknown): value is ResumeFontPairId {
  return typeof value === 'string' && (RESUME_FONT_PAIR_IDS as readonly string[]).includes(value);
}

/** The pair of an id; the default pair for an unknown or non-string id. */
export function fontPairOf(id: unknown): FontPair {
  return FONT_PAIR_BY_ID[isResumeFontPairId(id) ? id : DEFAULT_FONT_PAIR_ID];
}

/** The distinct faces of a pair, heading first: the faces a PDF has to embed. */
export function fontFacesUsed(pairId: unknown): FontFace[] {
  const { heading, body } = fontPairOf(pairId);
  return heading.family === body.family ? [heading] : [heading, body];
}
