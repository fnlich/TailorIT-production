import type { ActingSpec } from '../../core/feature';

// v33 SHARE-6 (PLAN F9 "Per-person, self"; SP v33 PLAN-sharing.md §3): the resume editor's fonts are the same files for
// everyone (no profile's data), so a tab acting on a shared profile loads them as the signed-in person, as the letter
// editor's fonts (cover-letters/acting.ts).

/** /api/fonts: the stylesheet and the font files. */
export const FONTS_ACTING: ActingSpec = 'self';
