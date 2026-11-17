import type { ResumeDocument } from '@tailorit/shared';
import { buildFlows, flowSpecs, type ResumeFlows } from './model/flows';
import { pageGeometry, resumeGeometry, type ResumeGeometry } from './model/geometry';
import { resumeView, type ResumeView, type ViewMode } from './model/view';
import { paginate, type FlowInput, type PageGeometry, type PagePlan } from './paginate/paginate';
import { RESUME_BASE_CSS } from './styles/base.css';
import { templateDefinitionOf } from './templates/registry';
import type { TemplateDefinition } from './templates/types';

// The static pipeline, as the API prints a resume and the editor's Preview shows one: the document's view, the
// template that draws it, the boxes of each column and the page geometry, then the markup for a page plan. Measuring
// is the caller's (headless Chrome, or the editor's page): it draws with no plan, reads the height of every
// `[data-rt-box]`, and `paginateResume` turns those heights into the plan the final drawing uses.

export interface LaidOutResume {
  view: ResumeView;
  template: TemplateDefinition;
  flows: ResumeFlows;
  geometry: ResumeGeometry;
}

/** The document laid out in `mode`; `view` is its view when the caller already has it (the editor keeps one). */
export function layoutResume(document: ResumeDocument, mode: ViewMode, view = resumeView(document, mode)): LaidOutResume {
  const template = templateDefinitionOf(view.templateId);
  return {
    view,
    template,
    flows: buildFlows(view, template.spacing),
    geometry: resumeGeometry(view.design, view.spec),
  };
}

/** Everything a page of this template needs besides its fonts: the base rules, then the template's. */
export function resumeCss(template: TemplateDefinition): string {
  return RESUME_BASE_CSS + template.css;
}

/** The flows the page draws, as the paginator reads them (the side flow only when the page has a side column). */
export function resumeFlowSpecs(layout: LaidOutResume): FlowInput {
  return flowSpecs(layout.flows, layout.geometry.side ? 2 : 1);
}

/** The page the paginator fills, with what the header (its measured height) takes from page 1. */
export function resumePageGeometry(layout: LaidOutResume, headerHeight: number): PageGeometry {
  return pageGeometry(layout.geometry, headerHeight);
}

/**
 * The plan from measured heights: the border-box height of every `[data-rt-box]`, by its id (`header` included). Each
 * box's top margin is the flow's own, never a computed style. Throws when a box of the flows was not measured.
 */
export function paginateResume(layout: LaidOutResume, heights: Readonly<Record<string, number>>): PagePlan {
  const flows = resumeFlowSpecs(layout);
  const metrics = new Map(
    [...layout.flows.main, ...layout.flows.side].map((box) => [
      box.id,
      { height: heights[box.id] ?? Number.NaN, marginTop: box.marginTop },
    ]),
  );
  return paginate(flows, metrics, resumePageGeometry(layout, heights.header ?? 0));
}
