// @jsxRuntime automatic
// @jsxImportSource react
import { Box } from '../components/blocks/Box';
import { Header } from '../components/blocks/Header';
import { STANDARD_LOOK } from '../components/blocks/options';
import { standardCss } from '../styles/templates.css';
import type { TemplateDefinition } from './types';

// Enhancv's Single Column: Double Column's look in one column, top to bottom, with a lighter 2px rule under the
// section titles. Short entries (languages, strengths) sit three to a row across the full width.

export const SINGLE_COLUMN: TemplateDefinition = {
  id: 'single-column',
  css: standardCss('single-column', { headingRule: 2 }),
  spacing: { afterHeading: 6, betweenItems: 12 },
  look: STANDARD_LOOK,
  Header,
  Box,
};
