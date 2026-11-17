import { bulletRules, levelRules, ROW_RULES, scopedCss } from './templates.css';

// ATS Plain, after Enhancv's: black text on white for applicant tracking systems. The name, the title and the contacts
// between bars as plain lines; bold section titles over a thin rule; each entry's title, its organisation, then its
// dates, place and link as one line of text. No icons, tags, photo or background, and no colour but black and greys:
// every colour here is fixed (black, or the base's text greys), never the primary or secondary colour.

export function atsPlainCss(): string {
  return scopedCss(
    'ats-plain',
    `
.rt-header{display:flex;align-items:flex-start}
.rt-header-main{display:flex;flex-direction:column;gap:0.15em;flex:1 1 auto;min-width:0}
.rt-header[data-align=center] .rt-header-main{align-items:center;text-align:center}
.rt-name{font-family:var(--rt-heading-font);font-size:2em;font-weight:700;line-height:1.15;color:#000000}
&[data-uppercase-name] .rt-name{text-transform:uppercase}
.rt-title{font-family:var(--rt-heading-font);font-size:1.15em;font-weight:400;line-height:1.3;color:#000000}
.rt-contacts{display:block;color:var(--rt-text)}
.rt-contact{display:inline}
.rt-contact-link{color:inherit;text-decoration:none}

.rt-heading{padding-bottom:1px;border-bottom:1px solid #000000}
.rt-heading-text{font-family:var(--rt-heading-font);font-size:1.15em;font-weight:700;line-height:1.3;color:#000000}
&[data-uppercase-headings] .rt-heading-text{text-transform:uppercase}

.rt-summary{color:var(--rt-text)}

.rt-entry{display:flex;flex-direction:column;gap:0.2em}
.rt-entry-head{display:flex;flex-direction:column}
.rt-entry-title{font-family:var(--rt-heading-font);font-size:1.05em;font-weight:700;color:#000000}
.rt-entry-subtitle{color:#000000}
.rt-meta,.rt-details{color:var(--rt-text)}
.rt-meta-link{color:inherit;text-decoration:none}
.rt-detail-label{font-weight:700}
${bulletRules('0.1em')}
${ROW_RULES}
.rt-language{display:flex;align-items:flex-start;justify-content:space-between;gap:0.75em}
.rt-language-text{display:block;min-width:0;color:var(--rt-text)}
.rt-language-name{font-weight:700;color:#000000}
${levelRules('#000000')}
.rt-strength-text{display:flex;flex-direction:column;min-width:0}
.rt-strength-title{font-weight:700;color:#000000}

.rt-skills{display:flex;flex-direction:column;gap:0.2em}
.rt-skill-list{color:var(--rt-text)}
.rt-group-name{font-weight:700;color:#000000}
`,
  );
}
