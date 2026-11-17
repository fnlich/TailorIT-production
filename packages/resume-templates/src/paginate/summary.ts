import type { BoxMetrics, BoxSpec, MetricsInput, PagePlan } from './paginate';

// What the plan puts on each page, by section: the Rearrange dialog draws one block per page from this, and the editor
// labels the pages. A section that runs over a page break appears on both pages, `continued` on the second.

export interface SectionPart {
  /** The section ref. */
  group: string;
  /** The section started on an earlier page: this is its continuation, under its heading drawn again. */
  continued: boolean;
  /** The height this part takes in its column, a repeated heading included (CSS px). */
  height: number;
}

export interface PageSummary {
  /** The sections in each flow of the page, top to bottom. */
  columns: Readonly<Record<string, readonly SectionPart[]>>;
}

export function planSummary(
  plan: PagePlan,
  flows: Readonly<Record<string, readonly BoxSpec[]>>,
  metrics: MetricsInput,
): PageSummary[] {
  const measure = (id: string): BoxMetrics | undefined =>
    metrics instanceof Map ? metrics.get(id) : (metrics as Readonly<Record<string, BoxMetrics | undefined>>)[id];
  const summaries: PageSummary[] = [];
  for (let page = 0; page < plan.pageCount; page += 1) {
    const columns: Record<string, SectionPart[]> = {};
    for (const [flow, boxes] of Object.entries(flows)) {
      const byId = new Map(boxes.map((box) => [box.id, box]));
      const parts: SectionPart[] = [];
      const ids = plan.pages[flow]?.[page] ?? [];
      const repeated = plan.breaks[flow]?.find((pageBreak) => pageBreak.page === page)?.repeatHeading ?? null;
      ids.forEach((id, position) => {
        const box = byId.get(id);
        const measured = measure(id);
        if (!box || !measured) return;
        const last = parts[parts.length - 1];
        // The page's first box has no top margin; every other box brings its own.
        const takes = (position === 0 ? 0 : measured.marginTop) + measured.height;
        if (last && last.group === box.group) {
          last.height += takes;
          return;
        }
        const continued = box.role !== 'heading';
        const heading = continued && position === 0 && repeated ? measure(repeated) : undefined;
        // With a repeated heading on top, the box keeps its own margin under it.
        parts.push({
          group: box.group,
          continued,
          height: heading ? heading.height + measured.marginTop + measured.height : takes,
        });
      });
      columns[flow] = parts;
    }
    summaries.push({ columns });
  }
  return summaries;
}
