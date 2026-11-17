import { lengthEm, ORIGINALS_COMMON_RULES, ratio } from './originals.css';
import { glyphBulletRules, glyphRules, scopedCss, type GlyphMarker } from './templates.css';

// Slate, after the owner's One-Column Slate: black 9pt text on 12pt lines. Page 1 opens with a band in the primary
// colour across the whole width of the page (the header bleeds), 80pt deep with a 4pt edge in the secondary colour:
// the name in white and the title in light grey on its left, the contacts one to a line on its right. Section titles
// in the primary colour; the summary, skills, education and the other short lists indented 16pt; each role's title,
// then "Company · dates · place" in grey, its description and its bullets indented 15pt behind a middle dot.
// Education, certifications, courses, awards, publications and references print on one line each, " | " between the
// parts, as the original's education does. Changed from the original: the band is #4f667d (#59738c one shade darker,
// so the light title and contacts read on it at 4.5:1), and the LinkedIn line is in the contacts' grey, not light
// blue (a third colour that Design & Font's two could not change).

const pt = (value: number) => lengthEm(value, 9);

/** The original's bullet: a middle dot 15pt in, the text at 26.1pt. */
const DOT: GlyphMarker = { code: 0xb7, left: 15 / 9, indent: 26.1 / 9, color: '#000000' };

export function slateCss(): string {
  return scopedCss(
    'one-column-slate',
    `
&{color:#000000}
${ORIGINALS_COMMON_RULES}
.rt-header{display:flex;flex-direction:row-reverse;align-items:flex-start;gap:${pt(20)};min-height:${pt(80)};
  padding:${pt(24)} var(--rt-margin) 0;margin-bottom:${pt(8)};background:var(--rt-primary);
  border-bottom:${pt(4)} solid var(--rt-secondary)}
.rt-header-main{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto 1fr;
  column-gap:${pt(20)};align-items:start;flex:1 1 auto;min-width:0}
.rt-name{grid-column:1;grid-row:1;font-family:var(--rt-heading-font);font-size:${pt(23)};font-weight:700;
  line-height:${ratio(26, 23)};color:#ffffff}
.rt-title{grid-column:1;grid-row:2;margin-top:${lengthEm(2, 11)};font-family:var(--rt-heading-font);font-size:${pt(11)};
  line-height:${ratio(14, 11)};color:#e6e6e6}
.rt-contacts{grid-column:2;grid-row:1 / span 3;text-align:right;font-size:${pt(8.5)};line-height:${ratio(12, 8.5)};
  color:#ebebeb}
.rt-contact-line{display:flex;flex-direction:column;align-items:flex-end}
.rt-contact .rt-text{white-space:pre}
.rt-contact[data-contact=linkedin] .rt-text,.rt-contact[data-contact=github] .rt-text,
  .rt-contact[data-contact=portfolio] .rt-text{white-space:pre-wrap;overflow-wrap:anywhere}
.rt-header-photo{width:${pt(52)};height:${pt(52)}}

.rt-heading-text{font-family:var(--rt-heading-font);font-size:${pt(12)};font-weight:700;line-height:${ratio(16, 12)};
  color:var(--rt-primary)}

.rt-summary,.rt-skills,.rt-chips,.rt-row{padding-left:${pt(16)}}
${glyphRules('.rt-strength-line', DOT)}

.rt-entry{gap:${pt(4)}}
.rt-entry-head[data-head=line]{padding-left:${pt(15)};margin-bottom:${pt(2)}}
.rt-entry-head[data-head=line] .rt-entry-title{font-family:var(--rt-heading-font);font-size:${pt(10.5)};
  font-weight:400;line-height:${ratio(14, 10.5)}}
.rt-entry-head[data-head=line] .rt-entry-sub{margin-top:${pt(1)};color:#666666}
.rt-entry-head[data-head=inline]{padding-left:${pt(16)}}
.rt-entry-desc{padding-left:${pt(15)}}
${glyphBulletRules('0', DOT)}
`,
  );
}
