// @jsxRuntime automatic
// @jsxImportSource react
import type { ResumeView } from '../model/view';

// Compact's background, 'corners': soft round shapes in the top-right and bottom-left corners of every page, in the
// secondary colour made light (the template's CSS fills them). Drawn in the page sheet behind the text and sized in px
// from the page, so it never moves or measures anything in the flow, and it prints as drawn.

/** Two decimals, as the geometry rounds. */
const px = (value: number) => Math.round(value * 100) / 100;

/** The fills of the shapes; the template adds them to its CSS. */
export const CORNER_RULES = `
.rt-corners{display:block}
.rt-corner{fill:var(--rt-secondary)}
.rt-corner-wide{fill-opacity:0.1}
.rt-corner-near{fill-opacity:0.16}
`;

export function CornersBackground({ view }: { view: ResumeView; page: number }) {
  if (view.design.background !== 'corners') return null;
  const width = px(view.design.pageWidthPx);
  // The sheet is a px shorter than the page, so print never starts an empty one.
  const height = px(view.design.pageHeightPx - 1);
  const wide = px(width * 0.22);
  const near = px(width * 0.11);
  return (
    <svg
      className="rt-corners"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
    >
      <circle className="rt-corner rt-corner-wide" cx={px(width * 1.03)} cy={px(width * -0.05)} r={wide} />
      <circle className="rt-corner rt-corner-near" cx={px(width * 0.99)} cy={px(width * 0.01)} r={near} />
      <circle className="rt-corner rt-corner-wide" cx={px(width * -0.03)} cy={px(height + width * 0.05)} r={wide} />
      <circle className="rt-corner rt-corner-near" cx={px(width * 0.01)} cy={px(height - width * 0.01)} r={near} />
    </svg>
  );
}
