// @jsxRuntime automatic
// @jsxImportSource react
import { Box } from '../components/blocks/Box';
import { Header } from '../components/blocks/Header';
import { ENHANCV_OPTIONS, type BlockLook } from '../components/blocks/options';
import { atsPlainCss } from '../styles/ats-plain.css';
import type { TemplateDefinition } from './types';

// Enhancv's ATS Plain: one column of black text in Arimo and Roboto that an applicant tracking system reads line by
// line. A text header with the contacts between bars, plain bold section titles, the dates, place and link of an
// entry as one line of text, words as comma lists, languages as "Name - Label". No icons, tags or dots unless the
// person turns the dots on; its spec has no photo or background and locks the colours to black.

const ATS_PLAIN_LOOK: BlockLook = {
  icons: false,
  entryHead: 'stacked',
  separators: true,
  language: 'inline',
  tags: false,
  inlineGroupNames: true,
  defaults: { ...ENHANCV_OPTIONS, skillsLayout: 'list', showLevel: false },
};

export const ATS_PLAIN: TemplateDefinition = {
  id: 'ats-plain',
  css: atsPlainCss(),
  spacing: { afterHeading: 6, betweenItems: 10 },
  look: ATS_PLAIN_LOOK,
  Header,
  Box,
};
