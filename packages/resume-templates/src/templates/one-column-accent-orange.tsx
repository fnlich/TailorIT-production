// @jsxRuntime automatic
// @jsxImportSource react
import { Box } from '../components/blocks/Box';
import { Header } from '../components/blocks/Header';
import type { BlockLook } from '../components/blocks/options';
import { accentOrangeCss } from '../styles/accent-orange.css';
import { ORIGINALS_DEFAULTS, ORIGINALS_SHORT_KINDS } from './originals';
import type { TemplateDefinition } from './types';

// The owner's One-Column Accent: a centred header with an orange disc at its top right, section titles after an
// orange dot with a rule running on, the section bodies indented. Every entry has the split head (its title, the
// dates in grey on the right, then "Organisation · place"); a role starts flush with the section title, education
// and the other short entries are indented. The original's spacing, in px: 5 under a title, 8 between roles, 3
// between short entries, strengths and skill lines.

const ACCENT_LOOK: BlockLook = {
  icons: false,
  entryHead: 'split',
  metaSeparator: ' · ',
  separators: false,
  language: 'inline',
  tags: true,
  inlineGroupNames: true,
  strength: 'inline',
  defaults: ORIGINALS_DEFAULTS,
};

export const ONE_COLUMN_ACCENT_ORANGE: TemplateDefinition = {
  id: 'one-column-accent-orange',
  css: accentOrangeCss(),
  spacing: {
    afterHeading: 5,
    betweenItems: 8,
    byKind: {
      ...Object.fromEntries(ORIGINALS_SHORT_KINDS.map((kind) => [kind, { betweenItems: 3 }])),
      skills: { betweenItems: 3 },
      strengths: { betweenItems: 3 },
      languages: { betweenItems: 3 },
    },
  },
  look: ACCENT_LOOK,
  Header,
  Box,
};
