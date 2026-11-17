import { lengthEm, ORIGINALS_COMMON_RULES, ratio } from './originals.css';
import { glyphBulletRules, scopedCss } from './templates.css';

// Accent Orange, after the owner's One-Column Accent, drawn in CSS px on 10px type with 1.6 lines (7.5pt, as it
// printed): a centred header over a thin grey rule, with a disc in the secondary colour (orange) at its top right;
// section titles after an orange dot, a grey rule running on to the right; every section body indented 20px. A role's
// title and its dates (grey, on the right) start flush with the section, "Company · place" under them, then its
// description and its bullets (grey middle dots) indented. Education and the other short entries are indented with
// the section, their title smaller. Skills and soft skills are comma lists with a hanging indent, strengths
// "Title: description" lines. The greys of the dates and the company line (#777777 and #888888 in the original) are
// #767676, the lightest grey that reads at 4.5:1 on white.

const px = (value: number) => lengthEm(value, 10);
const GREY = '#767676';
/** The kinds whose head starts flush with the section title, as the original's experience does. */
const FLUSH = ['experience', 'projects', 'volunteering', 'custom'];
const flush = (inner: string) => FLUSH.map((kind) => `.rt-entry[data-kind=${kind}] ${inner}`).join(',');

export function accentOrangeCss(): string {
  return scopedCss(
    'one-column-accent-orange',
    `
&{color:#222222}
${ORIGINALS_COMMON_RULES}
.rt-header{position:relative;display:flex;flex-direction:column-reverse;align-items:center;gap:${px(10)};
  padding-bottom:${px(15)};border-bottom:1px solid #cccccc}
.rt-header::after{content:'';position:absolute;top:0;right:0;width:${px(46)};height:${px(46)};border-radius:50%;
  background:var(--rt-secondary)}
.rt-header-main{display:flex;flex-direction:column;align-items:center;max-width:100%;text-align:center}
.rt-name{font-family:var(--rt-heading-font);font-size:${px(28)};font-weight:700;line-height:var(--rt-line-height);
  color:var(--rt-primary)}
.rt-title{margin-top:${lengthEm(-3, 12)};margin-bottom:${lengthEm(1, 12)};font-family:var(--rt-heading-font);
  font-size:${px(12)};line-height:var(--rt-line-height);color:#444444}
.rt-contacts{font-size:${px(11)};line-height:var(--rt-line-height);color:#111111}
.rt-contact{display:inline}

.rt-heading{display:flex;align-items:center;gap:${px(7)}}
.rt-heading::before{content:'';flex:none;width:${px(12)};height:${px(12)};border-radius:50%;
  background:var(--rt-secondary)}
.rt-heading::after{content:'';flex:1 1 0;min-width:0;border-top:1px solid #cccccc}
.rt-heading-text{font-family:var(--rt-heading-font);font-size:${px(13.5)};font-weight:700;
  line-height:var(--rt-line-height);color:var(--rt-primary)}

.rt-summary,.rt-skills,.rt-chips,.rt-row,.rt-strength{padding-left:${px(20)}}
.rt-skill-list{padding-left:${px(12)};text-indent:${px(-12)};line-height:1.5}
.rt-strength-line{line-height:1.5}

.rt-entry{padding-left:${px(20)}}
${flush('.rt-entry-head')}{margin-left:${px(-20)}}
.rt-entry-head[data-head=split] .rt-entry-line{gap:${px(12)}}
.rt-entry-lead{font-family:var(--rt-heading-font);font-size:${px(10.5)};line-height:var(--rt-line-height)}
.rt-entry-title{font-weight:700}
${flush('.rt-entry-lead')}{font-size:${px(12)};color:var(--rt-primary)}
.rt-entry-aside,.rt-entry-sub{font-size:${px(9.5)};color:${GREY}}
${flush('.rt-entry-sub')}{margin-bottom:${lengthEm(3, 9.5)}}
.rt-entry-desc{margin-bottom:${px(2)}}
${glyphBulletRules('0', { code: 0xb7, left: 1.2, indent: 2.2, color: '#666666', size: 1.3, lineHeight: Number(ratio(16, 13)) })}
`,
  );
}
