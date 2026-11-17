import { bulletRules, HEADER_PHOTO_RULES, levelRules, ROW_RULES, scopedCss, TAG_RULES } from './templates.css';

// Ivy League, after Enhancv's: a classic serif page. The name large and centred in the heading font (a photo above
// it, so the text stays on the page's centre line), the title under it in the secondary colour, the contacts on one
// line between bars; section titles in the heading font over a thin rule across the page; each entry on two lines,
// the organisation in bold and the role in italics, the place and the dates on the right. Words print as a comma list
// and languages as "Name - Label". Volkhov and PT Sans have regular and bold only, so every weight here is one of the
// two.

export function ivyLeagueCss(): string {
  return scopedCss(
    'ivy-league',
    `
.rt-header{display:flex;flex-direction:column-reverse;align-items:center;gap:10px}
.rt-header-main{display:flex;flex-direction:column;align-items:center;gap:0.2em;max-width:100%;text-align:center}
.rt-name{font-family:var(--rt-heading-font);font-size:2.4em;font-weight:700;line-height:1.15;color:var(--rt-primary)}
&[data-uppercase-name] .rt-name{text-transform:uppercase}
.rt-title{font-family:var(--rt-heading-font);font-size:1.15em;font-weight:400;line-height:1.3;
  color:var(--rt-secondary)}
.rt-contacts{display:block;margin-top:0.1em;color:var(--rt-text)}
.rt-contact{display:inline}
.rt-contact-sep{color:var(--rt-muted)}
.rt-contact-link{color:inherit;text-decoration:none}
${HEADER_PHOTO_RULES}
.rt-heading{padding-bottom:1px;border-bottom:1px solid var(--rt-primary)}
.rt-heading-text{font-family:var(--rt-heading-font);font-size:1.15em;font-weight:700;line-height:1.3;
  letter-spacing:0.03em;color:var(--rt-secondary)}
&[data-uppercase-headings] .rt-heading-text{text-transform:uppercase}

.rt-summary{color:var(--rt-text)}

.rt-entry{display:flex;flex-direction:column;gap:0.2em}
.rt-entry-head{display:flex;flex-direction:column}
.rt-entry-line{display:flex;align-items:baseline;gap:1em}
.rt-entry-lead{flex:1 1 auto;min-width:0;font-family:var(--rt-heading-font);font-size:1.05em;font-weight:700;
  color:var(--rt-primary)}
.rt-entry-sub{flex:1 1 auto;min-width:0;font-style:italic;color:var(--rt-text)}
.rt-entry-aside{flex:0 1 auto;max-width:50%;margin-left:auto;text-align:right;color:var(--rt-text)}
.rt-meta-sep{color:var(--rt-muted)}
.rt-meta-link{color:inherit;text-decoration:none}
.rt-details{color:var(--rt-text)}
.rt-detail-label{font-weight:700}
${bulletRules('0.1em')}
${ROW_RULES}
.rt-language{display:flex;align-items:flex-start;justify-content:space-between;gap:0.75em}
.rt-language-text{display:block;min-width:0;color:var(--rt-text)}
.rt-language-name{font-weight:700;color:var(--rt-primary)}
${levelRules('var(--rt-secondary)')}
.rt-strength{display:flex}
.rt-strength-text{display:flex;flex-direction:column;gap:0.05em;min-width:0}
.rt-strength-title{font-family:var(--rt-heading-font);font-weight:700;color:var(--rt-primary)}

.rt-skills{display:flex;flex-direction:column;gap:0.25em}
.rt-skill-list{color:var(--rt-text)}
.rt-group-name{font-weight:700;color:var(--rt-primary)}
.rt-tags{display:flex;flex-wrap:wrap;gap:0.4em 0.6em}
${TAG_RULES}
`,
  );
}
