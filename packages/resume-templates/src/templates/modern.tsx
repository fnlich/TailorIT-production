// @jsxRuntime automatic
// @jsxImportSource react
import { Box } from '../components/blocks/Box';
import { Header } from '../components/blocks/Header';
import { STANDARD_LOOK } from '../components/blocks/options';
import { standardCss } from '../styles/templates.css';
import type { TemplateDefinition } from './types';

// Enhancv's Modern: two columns, the main one on the left, under a full-width header with the name in capitals and the
// title in the secondary colour. Each section title has a short bar in the secondary colour under it instead of a
// rule across the column, and the side column has no band of colour behind it.

export const MODERN: TemplateDefinition = {
  id: 'modern',
  css: standardCss('modern', { headingRule: 0, headingBar: true }),
  spacing: { afterHeading: 8, betweenItems: 12 },
  look: STANDARD_LOOK,
  Header,
  Box,
};
