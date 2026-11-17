// @jsxRuntime automatic
// @jsxImportSource react
import { memo, type CSSProperties, type ReactNode } from 'react';
import { breakSpacer, type PagePlan } from '../paginate/paginate';
import { boxSignature, type FlowBox, type FlowName, type ResumeFlows } from '../model/flows';
import { rootHeight, sheetTop, type ResumeGeometry } from '../model/geometry';
import type { ResumeView } from '../model/view';
import { STATIC_SLOTS, SlotsContext } from '../slots';
import { designVariables } from '../styles/base.css';
import type { TemplateDefinition } from '../templates/types';

// The pages of a resume, drawn the same way in the editor and in print: one sheet per page behind the text, the header
// across the top of page 1, and each column as one continuous flow of boxes. A page break is a spacer before the box
// that starts the page, tall enough to carry it to the next page's top margin (plus the gap the editor shows between
// pages), and a section that continues there draws a static copy of its heading first. Nothing remounts when a box
// moves to another page, so a field being typed in keeps its caret.

export interface ResumeLayoutProps {
  view: ResumeView;
  template: TemplateDefinition;
  flows: ResumeFlows;
  geometry: ResumeGeometry;
  /** The page breaks; null while measuring (one page, no spacers). */
  plan: PagePlan | null;
  /** Between pages: the editor's gap, 0 in print. */
  gap: number;
}

interface BoxProps {
  box: FlowBox;
  view: ResumeView;
  template: TemplateDefinition;
  /** boxSignature(box): a box whose signature and template did not change is not drawn again (typing redraws one). */
  signature: string;
}

const Box = memo(function Box({ box, view, template }: BoxProps) {
  const entry = box.content.type === 'entry' ? box.content.entry : null;
  return (
    <div
      className={`rt-box rt-box-${box.role}`}
      data-rt-box={box.id}
      data-rt-entry={entry?.path}
      data-placeholder-entry={entry?.placeholder ? '' : undefined}
      style={{ marginTop: box.marginTop }}
    >
      <template.Box content={box.content} view={view} look={template.look} />
    </div>
  );
}, sameBox);

function sameBox(before: BoxProps, after: BoxProps): boolean {
  return before.signature === after.signature && before.template === after.template && before.view.mode === after.view.mode;
}

/** The header, drawn again only when what it shows (or the template) changed. */
const Header = memo(
  function Header({ view, template }: { view: ResumeView; template: TemplateDefinition; signature: string }) {
    return <template.Header view={view} />;
  },
  (before, after) => before.signature === after.signature && before.template === after.template,
);

function Flow(props: ResumeLayoutProps & { name: FlowName }) {
  const { name, flows, plan, view, template, geometry, gap } = props;
  const boxes = flows[name];
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const breaks = new Map((plan?.breaks[name] ?? []).map((pageBreak) => [pageBreak.before, pageBreak]));

  // Consecutive boxes of one section share its wrapper.
  const sections: FlowBox[][] = [];
  for (const box of boxes) {
    const last = sections.at(-1);
    if (last && last[0]!.group === box.group) last.push(box);
    else sections.push([box]);
  }

  return (
    <div className="rt-flow" data-flow={name}>
      {sections.map((section) => (
        <section key={section[0]!.group} data-rt-section={section[0]!.group}>
          {section.map((box) => {
            const pageBreak = breaks.get(box.id);
            if (!pageBreak) return <Box key={box.id} box={box} view={view} template={template} signature={boxSignature(box)} />;
            const repeat = pageBreak.repeatHeading ? byId.get(pageBreak.repeatHeading) : undefined;
            const height = breakSpacer(
              pageBreak,
              { marginTop: geometry.marginTop, marginBottom: geometry.marginBottom },
              (repeat ?? box).marginTop,
              gap,
            );
            const nodes: ReactNode[] = [
              <div key={`break:${box.id}`} className="rt-break" aria-hidden="true" data-rt-break={pageBreak.page} style={{ height }} />,
            ];
            if (repeat) {
              // A copy for the reader of the page; the heading itself stays where it is, editable.
              nodes.push(
                <div
                  key={`repeat:${box.id}`}
                  className="rt-box rt-box-heading rt-repeat"
                  aria-hidden="true"
                  style={{ marginTop: repeat.marginTop }}
                >
                  <SlotsContext.Provider value={STATIC_SLOTS}>
                    <template.Box content={repeat.content} view={view} look={template.look} />
                  </SlotsContext.Provider>
                </div>,
              );
            }
            nodes.push(<Box key={box.id} box={box} view={view} template={template} signature={boxSignature(box)} />);
            return nodes;
          })}
        </section>
      ))}
    </div>
  );
}

export function ResumeLayout(props: ResumeLayoutProps) {
  const { view, template, geometry, plan, gap } = props;
  const pageCount = plan?.pageCount ?? 1;
  const style = {
    ...designVariables(view.design, geometry),
    height: rootHeight(geometry, pageCount, gap),
  } as CSSProperties;
  return (
    // The definition that draws the page names it, so its CSS applies (a template without its own draws with another).
    <div
      className="rt-root"
      data-template={template.id}
      data-mode={view.mode}
      data-columns={geometry.side ? 2 : 1}
      data-uppercase-headings={view.design.uppercaseHeadings ? '' : undefined}
      data-uppercase-name={view.header.uppercaseName ? '' : undefined}
      data-background={view.design.background ?? undefined}
      data-header-bleed={geometry.headerBleed ? '' : undefined}
      style={style}
    >
      {Array.from({ length: pageCount }, (_, page) => (
        <div key={page} className="rt-sheet" data-page={page + 1} style={{ top: sheetTop(geometry, page, gap) }}>
          {template.Background ? <template.Background view={view} page={page} /> : null}
        </div>
      ))}
      <div className="rt-body">
        <div className="rt-box rt-header-box" data-rt-box="header">
          <Header view={view} template={template} signature={JSON.stringify([view.mode, view.header, view.design])} />
        </div>
        <div className="rt-columns" data-side={geometry.side ? view.spec.side?.position : undefined}>
          <Flow {...props} name="main" />
          {geometry.side ? <Flow {...props} name="side" /> : null}
        </div>
      </div>
    </div>
  );
}
