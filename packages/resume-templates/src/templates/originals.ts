import type { ToggleKind } from '@tailorit/shared';
import { ENHANCV_OPTIONS, type BlockOptions } from '../components/blocks/options';

// What the four templates after the owner's original designs share: their section settings, and the kinds of entry
// they print as short entries (the original's education, and the credential-like kinds TailorIT adds).

/** Skills and other words as comma lists, no proficiency dots (the person can turn tags or dots on). */
export const ORIGINALS_DEFAULTS: BlockOptions = { ...ENHANCV_OPTIONS, skillsLayout: 'list', showLevel: false };

/** The kinds printed like the original's education: a degree, a certificate, a course, an award, a reference. */
export const ORIGINALS_SHORT_KINDS: readonly ToggleKind[] = [
  'education',
  'certifications',
  'courses',
  'awards',
  'publications',
  'references',
];

/** A length of the originals in pt as CSS px, to two places (1pt is 4/3 px). */
export const pt = (value: number) => Math.round((value * 400) / 3) / 100;
