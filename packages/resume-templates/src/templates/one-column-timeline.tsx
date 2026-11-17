// @jsxRuntime automatic
// @jsxImportSource react
import { Box } from '../components/blocks/Box';
import { Header } from '../components/blocks/Header';
import type { BlockLook } from '../components/blocks/options';
import { timelineCss } from '../styles/timeline.css';
import { ORIGINALS_DEFAULTS, pt } from './originals';
import type { TemplateDefinition } from './types';

// The owner's One-Column Timeline: a compact header over a short blue bar, ruled section titles, and every full entry
// on a timeline (a rail down its left, a blue dot at its title; the template's CSS), with the split head: the title
// and the dates on the right, then "Company, place". The original's spacing: 7pt under a title, 10pt between
// entries, 2pt between strengths and skill lines.

const TIMELINE_LOOK: BlockLook = {
  icons: false,
  entryHead: 'split',
  metaSeparator: ', ',
  separators: false,
  language: 'inline',
  tags: true,
  inlineGroupNames: true,
  strength: 'inline',
  defaults: ORIGINALS_DEFAULTS,
};

export const ONE_COLUMN_TIMELINE: TemplateDefinition = {
  id: 'one-column-timeline',
  css: timelineCss(),
  spacing: {
    afterHeading: pt(7),
    betweenItems: pt(10),
    byKind: { skills: { betweenItems: pt(2) }, strengths: { betweenItems: pt(2) }, languages: { betweenItems: pt(2) } },
  },
  look: TIMELINE_LOOK,
  Header,
  Box,
};
