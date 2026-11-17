// @jsxRuntime automatic
// @jsxImportSource react
import { Box } from '../components/blocks/Box';
import { Header } from '../components/blocks/Header';
import { STANDARD_LOOK } from '../components/blocks/options';
import { standardCss } from '../styles/templates.css';
import type { TemplateDefinition } from './types';

// Enhancv's Double Column, the default: the header across the top, a wide main column for experience and a narrow
// side column for skills, languages and the like, a 3px rule under every section title.

export const DOUBLE_COLUMN: TemplateDefinition = {
  id: 'double-column',
  css: standardCss('double-column', { headingRule: 3 }),
  spacing: { afterHeading: 6, betweenItems: 12 },
  look: STANDARD_LOOK,
  Header,
  Box,
};
