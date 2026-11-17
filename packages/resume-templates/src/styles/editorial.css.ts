import { lengthEm, ORIGINALS_COMMON_RULES, ratio } from './originals.css';
import { glyphBulletRules, glyphRules, scopedCss, type GlyphMarker } from './templates.css';

// Editorial, after the owner's One-Column Editorial: 9pt text on 12.5pt lines in near-black. A centred header (a
// large tight name, the title in grey, the contacts between middle dots with the LinkedIn line under them); section
// titles with a 3pt rule in the secondary colour (teal) on their left; each entry's title in bold with "at Company" in
// grey after it for roles, its dates bold on the right, then the place (or the school and the place) in grey, its
// description and its bullets behind grey en dashes. Strengths print as dash lines, "Title: description". Not
// reproduced: the extra 2pt the original leaves after each role's first bullet (its page-break markup splits the list
// there), and the rule left of a title is 4px (3pt) as printed, since a border in em would round down to 3px.

const pt = (value: number) => lengthEm(value, 9);
const GREY = '#6b6b6b';
/** The original's bullet: an en dash in grey, the text 10pt in. */
const DASH: GlyphMarker = { code: 0x2013, indent: 10 / 9, color: GREY };

export function editorialCss(): string {
  return scopedCss(
    'one-column-editorial',
    `
&{color:#202020}
${ORIGINALS_COMMON_RULES}
.rt-header{display:flex;flex-direction:column-reverse;align-items:center;gap:10px}
.rt-header-main{display:flex;flex-direction:column;align-items:center;max-width:100%;text-align:center}
.rt-name{font-family:var(--rt-heading-font);font-size:${pt(30)};font-weight:700;line-height:${ratio(34, 30)};
  letter-spacing:${lengthEm(-0.6, 30)};color:var(--rt-primary)}
.rt-title{margin-top:${lengthEm(1, 11.5)};font-family:var(--rt-heading-font);font-size:${pt(11.5)};
  line-height:${ratio(15, 11.5)};color:${GREY}}
.rt-contacts{display:flex;flex-direction:column;align-items:center;margin-top:${pt(5)}}
.rt-contact-line{display:flex;flex-wrap:wrap;justify-content:center;column-gap:${pt(5)}}
.rt-contact .rt-text{white-space:pre}

.rt-heading{padding-left:${pt(8)};border-left:4px solid var(--rt-secondary)}
.rt-heading-text{font-family:var(--rt-heading-font);font-size:${pt(12)};font-weight:700;line-height:${ratio(14, 12)};
  color:var(--rt-primary)}

.rt-summary{font-size:${pt(9.5)};line-height:${ratio(13.5, 9.5)}}
${glyphRules('.rt-strength-line', DASH)}

.rt-entry-head[data-head=split] .rt-entry-line{gap:${pt(10)}}
.rt-entry-lead{font-family:var(--rt-heading-font);font-size:${pt(10)};line-height:${ratio(13.5, 10)}}
.rt-entry-title{font-weight:700;color:var(--rt-primary)}
.rt-entry-at,.rt-entry-lead .rt-entry-subtitle{font-weight:400;color:${GREY}}
.rt-entry-aside{font-size:${pt(8.5)};font-weight:700}
.rt-entry-sub{color:${GREY}}
.rt-entry-desc,.rt-bullets{margin-top:${pt(2)}}
${glyphBulletRules('0', DASH)}
`,
  );
}
