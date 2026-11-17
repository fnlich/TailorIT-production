import { resolveTemplateId, type ResumeTemplateId } from '@tailorit/shared';
import { ATS_PLAIN } from './ats-plain';
import { COMPACT } from './compact';
import { DOUBLE_COLUMN } from './double-column';
import { IVY_LEAGUE } from './ivy-league';
import { MODERN } from './modern';
import { ONE_COLUMN_ACCENT_ORANGE } from './one-column-accent-orange';
import { ONE_COLUMN_EDITORIAL } from './one-column-editorial';
import { ONE_COLUMN_SLATE } from './one-column-slate';
import { ONE_COLUMN_TIMELINE } from './one-column-timeline';
import { SINGLE_COLUMN } from './single-column';
import type { TemplateDefinition } from './types';

// The template that draws each template id: one definition per template, the four newest after the owner's original
// designs, the six others each after its Enhancv namesake. A template's fonts, colours and steps come from its spec
// through the view; its definition adds the CSS, the space inside its sections, the look of the shared blocks and its
// background. The page's root names the definition that drew it (`data-template`), so that definition's CSS applies.

export const TEMPLATE_DEFINITIONS: Readonly<Record<ResumeTemplateId, TemplateDefinition>> = {
  'one-column-slate': ONE_COLUMN_SLATE,
  'one-column-accent-orange': ONE_COLUMN_ACCENT_ORANGE,
  'one-column-editorial': ONE_COLUMN_EDITORIAL,
  'one-column-timeline': ONE_COLUMN_TIMELINE,
  'double-column': DOUBLE_COLUMN,
  'single-column': SINGLE_COLUMN,
  'ivy-league': IVY_LEAGUE,
  modern: MODERN,
  compact: COMPACT,
  'ats-plain': ATS_PLAIN,
};

/** The definition that draws a stored template id (legacy ids and unknown ones included, as `resolveTemplateId`). */
export function templateDefinitionOf(id: unknown): TemplateDefinition {
  return TEMPLATE_DEFINITIONS[resolveTemplateId(id)];
}
