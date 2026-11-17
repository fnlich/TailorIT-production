import type { ComponentType } from 'react';
import type { ResumeTemplateId } from '@tailorit/shared';
import type { BlockLook } from '../components/blocks/options';
import type { BoxContent, TemplateSpacing } from '../model/flows';
import type { ResumeView } from '../model/view';

// What a template is in this package: its CSS, the space inside its sections, the look the shared blocks take in it,
// and the components that draw the header and each kind of box. Everything else (the page, the columns, the breaks) is
// the shared layout's.

export interface TemplateDefinition {
  id: ResumeTemplateId;
  /** Scoped under `.rt-root[data-template=<id>]`; no @media, no viewport units. */
  css: string;
  spacing: TemplateSpacing;
  /** How the shared blocks draw here and the section settings it starts from; the layout hands it to Box. */
  look: BlockLook;
  Header: ComponentType<{ view: ResumeView }>;
  /** Draws the inside of one box (its wrapper, margin and data attributes are the layout's). */
  Box: ComponentType<{ content: BoxContent; view: ResumeView; look: BlockLook }>;
  /** Drawn on each page sheet, behind the text; it never changes the size of anything in the flow. */
  Background?: ComponentType<{ view: ResumeView; page: number }>;
}
