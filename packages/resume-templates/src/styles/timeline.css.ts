import { lengthEm, ORIGINALS_COMMON_RULES, ratio } from './originals.css';
import { glyphBulletRules, glyphRules, railRules, scopedCss, type GlyphMarker } from './templates.css';

// Timeline, after the owner's One-Column Timeline: 9pt text on 12.5pt lines in the primary colour (navy black). A
// compact header on the left (the name, the title, the contacts in a cool grey between bars) over a short bar in the
// secondary colour (blue); section titles over a thin rule; every full entry on a timeline: a rail down its left with
// a blue dot at its title, the dates in grey on the right, "Company, place" in grey under the title, the description
// and blue bullets. The greys are the primary colour mixed with white, so they follow the person's colour; the bars
// between the contacts (#b7bdc8 in the original, 1.9:1 on white) are drawn at 4.8:1, the lightest that reads as text.

const pt = (value: number) => lengthEm(value, 9);
/** #5b6475 in the original. */
const MUTED = 'color-mix(in srgb, var(--rt-primary) 72%, #ffffff)';
/** The rails and the rule under the section titles (#d9dde5 in the original). */
const RULE = 'color-mix(in srgb, var(--rt-primary) 17%, #ffffff)';
/** The bars between the contacts. */
const BAR = 'color-mix(in srgb, var(--rt-primary) 64%, #ffffff)';
/** The original's bullet: a blue bullet, the text 10pt in. */
const BULLET: GlyphMarker = { code: 0x2022, indent: 10 / 9, color: 'var(--rt-secondary)' };

export function timelineCss(): string {
  return scopedCss(
    'one-column-timeline',
    `
&{color:var(--rt-primary)}
${ORIGINALS_COMMON_RULES}
.rt-header{display:flex;align-items:flex-start;gap:16px}
.rt-header-main{display:flex;flex-direction:column;flex:1 1 auto;min-width:0}
.rt-header-main::after{content:'';display:block;width:${pt(40)};height:${pt(3)};margin-top:${pt(9)};
  background:var(--rt-secondary)}
.rt-name{font-family:var(--rt-heading-font);font-size:${pt(26)};font-weight:700;line-height:${ratio(30, 26)};
  letter-spacing:${lengthEm(-0.3, 26)};color:var(--rt-primary)}
.rt-title{margin-top:${lengthEm(1, 11)};font-family:var(--rt-heading-font);font-size:${pt(11)};line-height:${ratio(14, 11)}}
.rt-contacts{margin-top:${lengthEm(4, 8.5)};font-size:${pt(8.5)};line-height:${ratio(12, 8.5)};color:${MUTED}}
.rt-contact{display:inline-block}
.rt-contact .rt-text{white-space:pre}
.rt-contact-sep{white-space:pre;color:${BAR}}

.rt-heading{padding-bottom:${pt(3)};border-bottom:${pt(1)} solid ${RULE}}
.rt-heading-text{font-family:var(--rt-heading-font);font-size:${pt(11)};font-weight:700;line-height:${ratio(14, 11)};
  color:var(--rt-primary)}

${glyphRules('.rt-strength-line', BULLET)}

${railRules({ offset: 3.5 / 9, gap: 12 / 9, width: 1 / 9, color: RULE, dot: 7 / 9, top: 3.5 / 9, dotColor: 'var(--rt-secondary)' })}
.rt-entry-head[data-head=split] .rt-entry-line{gap:${pt(10)}}
.rt-entry-lead{font-family:var(--rt-heading-font);font-size:${pt(10)};line-height:${ratio(13.5, 10)}}
.rt-entry-title{font-weight:700}
.rt-entry-aside{font-size:${pt(8.5)};color:${MUTED}}
.rt-entry-sub{color:${MUTED}}
.rt-entry-desc,.rt-bullets{margin-top:${pt(2)}}
${glyphBulletRules('0', BULLET)}
`,
  );
}
