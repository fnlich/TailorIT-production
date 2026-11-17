// @jsxRuntime automatic
// @jsxImportSource react
import { Box } from '../components/blocks/Box';
import { Header } from '../components/blocks/Header';
import type { BlockLook } from '../components/blocks/options';
import { editorialCss } from '../styles/editorial.css';
import { ORIGINALS_DEFAULTS, pt } from './originals';
import type { TemplateDefinition } from './types';

// The owner's One-Column Editorial: a centred header, teal-edged section titles, and every entry with the split head:
// a role as "Title at Company" with its dates on the right and its place under it, a degree with the school and the
// place under it; en-dash bullets. The original's spacing: 7pt under a title, 10pt between entries, 2pt between
// strengths and skill lines.

const EDITORIAL_LOOK: BlockLook = {
  icons: false,
  entryHead: 'split',
  subtitleAt: ['experience', 'volunteering'],
  metaSeparator: ', ',
  separators: false,
  language: 'inline',
  tags: true,
  inlineGroupNames: true,
  strength: 'inline',
  defaults: ORIGINALS_DEFAULTS,
};

export const ONE_COLUMN_EDITORIAL: TemplateDefinition = {
  id: 'one-column-editorial',
  css: editorialCss(),
  spacing: {
    afterHeading: pt(7),
    betweenItems: pt(10),
    byKind: { skills: { betweenItems: pt(2) }, strengths: { betweenItems: pt(2) }, languages: { betweenItems: pt(2) } },
  },
  look: EDITORIAL_LOOK,
  Header,
  Box,
};
