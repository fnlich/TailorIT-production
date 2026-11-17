// @jsxRuntime automatic
// @jsxImportSource react
import { Box } from '../components/blocks/Box';
import { Header } from '../components/blocks/Header';
import type { BlockLook } from '../components/blocks/options';
import { slateCss } from '../styles/slate.css';
import { ORIGINALS_DEFAULTS, ORIGINALS_SHORT_KINDS, pt } from './originals';
import type { TemplateDefinition } from './types';

// The owner's One-Column Slate: a slate band across the top of page 1 (the spec's header bleeds), the contacts on its
// right, and one column under it. A role prints its title over "Company · dates · place"; education and the other
// short entries print on one line, " | " between the parts; strengths as dot lines, "Title: description"; skills as
// "Group: a, b" lines. The original's spacing: 7pt under a title (11pt above the first role), 12pt between roles,
// nothing between education lines, 2pt between skill lines.

const SLATE_LOOK: BlockLook = {
  icons: false,
  entryHead: 'line',
  entryHeadByKind: Object.fromEntries(ORIGINALS_SHORT_KINDS.map((kind) => [kind, 'inline' as const])),
  metaSeparator: ' · ',
  separators: false,
  language: 'inline',
  tags: true,
  inlineGroupNames: true,
  strength: 'inline',
  defaults: ORIGINALS_DEFAULTS,
};

export const ONE_COLUMN_SLATE: TemplateDefinition = {
  id: 'one-column-slate',
  css: slateCss(),
  spacing: {
    afterHeading: pt(7),
    betweenItems: pt(12),
    byKind: {
      experience: { afterHeading: pt(11) },
      education: { betweenItems: 0 },
      certifications: { betweenItems: 0 },
      courses: { betweenItems: 0 },
      awards: { betweenItems: pt(2) },
      publications: { betweenItems: pt(2) },
      references: { betweenItems: pt(2) },
      skills: { betweenItems: pt(2) },
      strengths: { betweenItems: 0 },
      languages: { betweenItems: pt(2) },
    },
  },
  look: SLATE_LOOK,
  Header,
  Box,
};
