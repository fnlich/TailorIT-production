import type { SectionKind } from '@tailorit/shared';
import type { BoxSpec } from '../paginate/paginate';
import type { EntryView, ResumeView, SectionView, SkillGroupView } from './view';

// The view as the boxes each column flows through: a heading per section, then one box per entry, per row of short
// entries, per skill group or per paragraph. A box never splits, so this is where the page-break points are decided.
// Every box carries the space above it, from the template's spacing and the design, never from a computed style: the
// layout draws that margin and the paginator counts it, so the two cannot disagree.

/** The space a template puts inside a section, in CSS px. Between sections it is the design's section spacing. */
export interface TemplateSpacing {
  /** Under a section heading, above the section's first box. */
  afterHeading: number;
  /** Between two entries, rows or skill groups of one section. */
  betweenItems: number;
  /**
   * The kinds of section a template spaces otherwise: a list printed a line an entry (education on one line, skills
   * as "Group: a, b"), or a section whose first entry sits further from its title.
   */
  byKind?: Readonly<Partial<Record<SectionKind | 'custom', Partial<Pick<TemplateSpacing, 'afterHeading' | 'betweenItems'>>>>>;
}

/** The spacing of one kind of section: the template's, where the kind has none of its own. */
export function spacingOf(spacing: TemplateSpacing, kind: SectionKind | 'custom'): { afterHeading: number; betweenItems: number } {
  const own = spacing.byKind?.[kind];
  return {
    afterHeading: own?.afterHeading ?? spacing.afterHeading,
    betweenItems: own?.betweenItems ?? spacing.betweenItems,
  };
}

export type BoxContent =
  | { type: 'heading'; section: SectionView }
  | { type: 'entry'; section: SectionView; entry: EntryView }
  /** Short entries side by side (languages, strengths), `perRow` of them at most. */
  | { type: 'row'; section: SectionView; entries: EntryView[] }
  | { type: 'summary'; section: SectionView }
  | { type: 'skills'; section: SectionView; group: SkillGroupView; index: number }
  | { type: 'chips'; section: SectionView };

export interface FlowBox extends BoxSpec {
  /** The space above it, dropped when it starts a page (the paginator shortens the spacer instead). */
  marginTop: number;
  content: BoxContent;
}

export type FlowName = 'main' | 'side';
export type ResumeFlows = Record<FlowName, FlowBox[]>;

/**
 * What a box draws, as one string: a box's inside reads its own content and its section's settings and title (never
 * the rest of the view: the design reaches it as CSS variables), so two boxes with one signature draw the same. The
 * editor redraws only the boxes whose signature changed.
 */
export function boxSignature(box: FlowBox): string {
  const { content } = box;
  const { body, ...section } = content.section;
  const own =
    content.type === 'entry'
      ? content.entry
      : content.type === 'row'
        ? content.entries
        : content.type === 'skills'
          ? [content.group, content.index]
          : content.type === 'heading'
            ? null
            : body;
  return JSON.stringify([box.id, box.role, box.marginTop, content.type, section, own]);
}

/** The id of a section heading's box; the repeated copy on a continuation page refers to it. */
export const headingBoxId = (ref: string) => `h:${ref}`;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += Math.max(1, size)) rows.push(items.slice(index, index + size));
  return rows;
}

/** The content boxes of one section, without their margins. */
function sectionBoxes(section: SectionView): Array<Omit<FlowBox, 'marginTop' | 'flow'>> {
  const group = section.ref;
  const body = section.body;
  if (body.type === 'summary') return [{ id: `p:${group}:0`, role: 'block', group, content: { type: 'summary', section } }];
  if (body.type === 'chips') return [{ id: `p:${group}:0`, role: 'block', group, content: { type: 'chips', section } }];
  if (body.type === 'skills') {
    return body.groups.map((skills, index) => ({
      id: `p:${group}:${index}`,
      role: 'block' as const,
      group,
      content: { type: 'skills' as const, section, group: skills, index },
    }));
  }
  if (section.perRow > 1) {
    return chunk(body.entries, section.perRow).map((entries, index) => ({
      id: `r:${group}:${index}`,
      role: 'row' as const,
      group,
      content: { type: 'row' as const, section, entries },
    }));
  }
  return body.entries.map((entry) => ({
    id: `e:${group}:${entry.id}`,
    role: 'entry' as const,
    group,
    content: { type: 'entry' as const, section, entry },
  }));
}

/** The boxes of every column, in order. A one-column template has an empty side flow. */
export function buildFlows(view: ResumeView, spacing: TemplateSpacing): ResumeFlows {
  const flows: ResumeFlows = { main: [], side: [] };
  for (const section of view.sections) {
    const flow = flows[section.column];
    flow.push({
      id: headingBoxId(section.ref),
      flow: section.column,
      role: 'heading',
      group: section.ref,
      keepWithNext: true,
      marginTop: flow.length === 0 ? 0 : view.design.sectionSpacingPx,
      content: { type: 'heading', section },
    });
    const space = spacingOf(spacing, section.kind);
    sectionBoxes(section).forEach((box, index) => {
      flow.push({ ...box, flow: section.column, marginTop: index === 0 ? space.afterHeading : space.betweenItems });
    });
  }
  return flows;
}

/** The flows as the paginator reads them (only the flows the template has). */
export function flowSpecs(flows: ResumeFlows, columns: 1 | 2): Record<string, readonly BoxSpec[]> {
  return columns === 2 ? { main: flows.main, side: flows.side } : { main: flows.main };
}
