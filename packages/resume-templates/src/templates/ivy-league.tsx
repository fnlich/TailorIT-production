// @jsxRuntime automatic
// @jsxImportSource react
import { Box } from '../components/blocks/Box';
import { Header } from '../components/blocks/Header';
import { ENHANCV_OPTIONS, type BlockLook } from '../components/blocks/options';
import { ivyLeagueCss } from '../styles/ivy-league.css';
import type { TemplateDefinition } from './types';

// Enhancv's Ivy League: one column in Volkhov and PT Sans, black and navy. A centred header with the contacts on one
// line between bars, capital section titles over a thin rule, and each entry in the classic two-line form (the
// organisation and the place, then the role and the dates). No icons; skills and other words as a comma list until the
// person picks tags or bullets.

const IVY_LEAGUE_LOOK: BlockLook = {
  icons: false,
  entryHead: 'classic',
  separators: true,
  language: 'inline',
  tags: true,
  inlineGroupNames: true,
  defaults: { ...ENHANCV_OPTIONS, skillsLayout: 'list' },
};

export const IVY_LEAGUE: TemplateDefinition = {
  id: 'ivy-league',
  css: ivyLeagueCss(),
  spacing: { afterHeading: 6, betweenItems: 10 },
  look: IVY_LEAGUE_LOOK,
  Header,
  Box,
};
