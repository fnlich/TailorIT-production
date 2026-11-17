// @jsxRuntime automatic
// @jsxImportSource react
import { CORNER_RULES, CornersBackground } from '../backgrounds/corners';
import { Box } from '../components/blocks/Box';
import { Header } from '../components/blocks/Header';
import { STANDARD_LOOK } from '../components/blocks/options';
import { standardCss } from '../styles/templates.css';
import type { TemplateDefinition } from './types';

// Enhancv's Compact: Double Column's blocks with less space inside them and a 2px rule under the section titles; its
// design adds the narrower margins, the tighter section spacing and the smaller type. Its background, 'corners', puts
// light-blue shapes in two corners of every page.

export const COMPACT: TemplateDefinition = {
  id: 'compact',
  css: standardCss('compact', { headingRule: 2, dense: true, extra: CORNER_RULES }),
  spacing: { afterHeading: 4, betweenItems: 8 },
  look: STANDARD_LOOK,
  Header,
  Box,
  Background: CornersBackground,
};
