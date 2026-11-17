import type { ResumeTemplateId } from '@tailorit/shared';

// The look of the blocks, after Enhancv's Double Column: the name large in the heading font, the title and the
// company in the secondary colour, a heavy rule under every section title, grey meta rows with icons, underlined
// skill tags and proficiency dots. Modern and Compact are the same blocks with a short accent bar under the titles or
// less space inside the blocks; Ivy League and ATS Plain have CSS of their own, from the shared rule groups below.
// Every size is in em of the body size, so the Font size control scales the page, and every colour is a design
// variable or a fixed grey.
//
// What keeps the editor and the PDF measuring alike: every rule is scoped to the template's root; a box's height
// depends only on its own content and the root's data attributes (no rule looks at a neighbouring box, and nothing
// here styles the boxes, sections or breaks of the layout); line heights are unitless; and the space inside a box
// comes from gaps, so a part that does not print leaves none.

/** The selector every rule of a template starts with. */
export const templateScope = (id: ResumeTemplateId) => `.rt-root[data-template="${id}"]`;

/**
 * `rules` with the scope in front of every selector: `.a .b` becomes `<scope> .a .b`, and `&[x] .b` (a state of the
 * root itself) becomes `<scope>[x] .b`. Plain rules only, no nesting or at-rules; one output line per rule.
 */
export function scopeRules(scope: string, rules: string): string {
  return rules
    .split('}')
    .map((rule) => rule.trim())
    .filter(Boolean)
    .map((rule) => {
      const open = rule.indexOf('{');
      const selectors = rule
        .slice(0, open)
        .split(',')
        .map((selector) => selector.trim())
        .map((selector) => (selector.startsWith('&') ? `${scope}${selector.slice(1)}` : `${scope} ${selector}`));
      const body = rule
        .slice(open + 1)
        .split('\n')
        .map((line) => line.trim())
        .join('');
      return `${selectors.join(',')}{${body}}`;
    })
    .join('\n');
}

/** A template's rules, scoped, as one block of CSS. */
export const scopedCss = (id: ResumeTemplateId, rules: string) => `\n${scopeRules(templateScope(id), rules)}\n`;

/** Centres a 1em-high mark (an icon) on the first line of the text beside it. */
export const FIRST_LINE = 'calc((var(--rt-line-height) - 1) * 0.5em)';

/** The header photo at the side of the text, square or round. */
export const HEADER_PHOTO_RULES = `
.rt-header-photo{flex:none;width:72px;height:72px;object-fit:cover}
.rt-header-photo[data-shape=round]{border-radius:50%}
`;

/** Bullets with a round marker and a hanging indent, flush when the section turns the marker off. */
export const bulletRules = (gap: string) => `
.rt-bullets{display:flex;flex-direction:column;gap:${gap}}
.rt-bullet{position:relative;padding-left:1.1em}
.rt-bullet::before{content:'';position:absolute;left:0.3em;top:calc((var(--rt-line-height) - 0.36) * 0.5em);
  width:0.36em;height:0.36em;border-radius:50%;background:var(--rt-text)}
.rt-bullets-plain .rt-bullet{padding-left:0}
.rt-bullets-plain .rt-bullet::before{display:none}
`;

/** Short entries side by side: the grid a row keys to its `data-per-row`. */
export const ROW_RULES = `
.rt-row{display:grid;column-gap:1.25em;align-items:start}
.rt-row[data-per-row="1"]{grid-template-columns:minmax(0,1fr)}
.rt-row[data-per-row="2"]{grid-template-columns:repeat(2,minmax(0,1fr))}
.rt-row[data-per-row="3"]{grid-template-columns:repeat(3,minmax(0,1fr))}
.rt-row[data-per-row="4"]{grid-template-columns:repeat(4,minmax(0,1fr))}
`;

/** The five proficiency dots, the ones reached in `on`. */
export const levelRules = (on: string) => `
.rt-level{display:flex;flex:none;gap:0.25em}
.rt-language-level{margin-top:calc((var(--rt-line-height) - 0.7) * 0.5em)}
.rt-dot{display:block;width:0.7em;height:0.7em;border-radius:50%;background:#d9d9d9}
.rt-dot-on{background:${on}}
`;

/** Tags with a grey line under them, or a grey box around them. */
export const TAG_RULES = `
.rt-tag{padding:0.05em 0.1em 0.15em;border-bottom:1px solid #c4c4c4}
.rt-tags-box .rt-tag{padding:0.15em 0.5em;border:1px solid #c4c4c4;border-radius:4px}
`;

/**
 * A character that marks a line (a bullet): which one, where it sits and how it looks. Lengths are in em of the line's
 * text, so the marker scales with the Font size control.
 */
export interface GlyphMarker {
  /** The character's code point: 0xb7 a middle dot, 0x2013 an en dash, 0x2022 a bullet. */
  code: number;
  /** Where the line's text starts, from the line's left edge. */
  indent: number;
  /** Where the character sits, from the line's left edge (0 when not set). */
  left?: number;
  color: string;
  /** The character's size against the text's (1 when not set). */
  size?: number;
  /** The character's own line height (unitless), when its size is not the text's. */
  lineHeight?: number;
}

const em = (value: number) => `${Math.round(value * 10_000) / 10_000}em`;

/** The marker of `selector`: the character before its first line, with the line's text indented past it. */
export function glyphRules(selector: string, marker: GlyphMarker): string {
  const size = marker.size ?? 1;
  // The character's own lengths are in its own em: its place is divided by its size.
  const own = [
    size !== 1 ? `font-size:${em(size)}` : '',
    marker.lineHeight !== undefined ? `line-height:${marker.lineHeight}` : '',
  ]
    .filter(Boolean)
    .map((declaration) => `;${declaration}`)
    .join('');
  return `
${selector}{position:relative;padding-left:${em(marker.indent)}}
${selector}::before{content:'\\${marker.code.toString(16)}';position:absolute;left:${em((marker.left ?? 0) / size)};
  top:0;color:${marker.color}${own}}
`;
}

/** Bullets marked with a character (a middle dot, an en dash) and a hanging indent, flush when the section turns it off. */
export const glyphBulletRules = (gap: string, marker: GlyphMarker) => `
.rt-bullets{display:flex;flex-direction:column;gap:${gap}}
${glyphRules('.rt-bullet', marker)}
.rt-bullets-plain .rt-bullet{padding-left:0}
.rt-bullets-plain .rt-bullet::before{display:none}
`;

/** A timeline down the left of every full entry: its rail, and the dot on the rail at the entry's first line. */
export interface TimelineRail {
  /** From the column's edge to the rail, and from the rail to the text, in em of the body text. */
  offset: number;
  gap: number;
  /** The rail's width (em) and colour. */
  width: number;
  color: string;
  /** The dot's diameter and its top from the entry's top (em), and its colour. */
  dot: number;
  top: number;
  dotColor: string;
}

/**
 * The rail is each entry's left border, so it breaks between entries and between pages with them; the dot is centred
 * on it. An entry is one box, so the rail never leaves the box that measures it.
 */
export function railRules(rail: TimelineRail): string {
  return `
.rt-entry{position:relative;margin-left:${em(rail.offset)};padding-left:${em(rail.gap)};
  border-left:${em(rail.width)} solid ${rail.color}}
.rt-entry::before{content:'';position:absolute;left:${em(-(rail.width + rail.dot) / 2)};top:${em(rail.top)};width:${em(rail.dot)};
  height:${em(rail.dot)};border-radius:50%;background:${rail.dotColor}}
`;
}

export interface StandardLook {
  /** The rule under a section title, in px (Modern draws a bar instead). */
  headingRule: number;
  /** A short bar in the secondary colour under each section title, instead of the rule (Modern). */
  headingBar?: boolean;
  /** Less space inside the blocks (Compact); its smaller type, margins and spacing come from its design. */
  dense?: boolean;
  /** Rules of the template's own, after the standard ones (scoped the same way). */
  extra?: string;
}

/** The blocks as Double Column draws them; Single Column is the same look in one column. */
export function standardCss(id: ResumeTemplateId, look: StandardLook): string {
  /** A value, or its tighter form in a dense template. */
  const d = (normal: string, dense: string) => (look.dense ? dense : normal);
  const heading = look.headingBar
    ? `
.rt-heading{display:flex;flex-direction:column;align-items:flex-start;gap:3px}
.rt-heading::after{content:'';display:block;width:2.5em;height:3px;background:var(--rt-secondary)}
`
    : `
.rt-heading{padding-bottom:${d('2px', '1px')};border-bottom:${look.headingRule}px solid var(--rt-primary)}
`;
  const css = `
.rt-icon{display:block;flex:none;width:1em;height:1em;overflow:visible}

.rt-header{display:flex;align-items:flex-start;gap:${d('16px', '14px')}}
.rt-header-main{display:flex;flex-direction:column;gap:${d('0.3em', '0.2em')};flex:1 1 auto;min-width:0}
.rt-header[data-align=center] .rt-header-main{align-items:center;text-align:center}
.rt-name{font-family:var(--rt-heading-font);font-size:${d('2.3em', '2.1em')};font-weight:700;line-height:1.1;
  color:var(--rt-primary)}
&[data-uppercase-name] .rt-name{text-transform:uppercase}
.rt-title{font-family:var(--rt-heading-font);font-size:${d('1.2em', '1.12em')};font-weight:500;line-height:1.25;
  color:var(--rt-secondary)}
.rt-contacts{display:flex;flex-wrap:wrap;gap:${d('0.3em 1em', '0.2em 0.9em')};margin-top:0.15em;font-size:0.92em;
  color:var(--rt-text)}
.rt-header[data-align=center] .rt-contacts{justify-content:center}
.rt-contacts[data-style=separators]{display:block}
.rt-contact{display:flex;align-items:flex-start;gap:0.35em;min-width:0}
.rt-contacts[data-style=separators] .rt-contact{display:inline}
.rt-contact .rt-icon{margin-top:${FIRST_LINE};color:var(--rt-secondary)}
.rt-contact-link{color:inherit;text-decoration:none}
${HEADER_PHOTO_RULES}
${heading}
.rt-heading-text{font-family:var(--rt-heading-font);font-size:${d('1.2em', '1.12em')};font-weight:700;line-height:1.25;
  color:var(--rt-primary)}
&[data-uppercase-headings] .rt-heading-text{text-transform:uppercase}

.rt-summary{color:var(--rt-text)}

.rt-entry{display:flex;flex-direction:column;gap:${d('0.3em', '0.2em')}}
.rt-entry-head{display:flex;flex-direction:column;gap:${d('0.1em', '0.05em')}}
.rt-entry-title{font-family:var(--rt-heading-font);font-size:1.08em;font-weight:500;color:var(--rt-primary)}
.rt-entry-subtitle{font-family:var(--rt-heading-font);font-size:1.02em;font-weight:500;color:var(--rt-secondary)}
.rt-meta,.rt-details{display:flex;flex-wrap:wrap;gap:${d('0.1em 1.25em', '0.05em 1em')};font-size:0.88em;
  color:var(--rt-muted)}
.rt-meta-item{display:flex;align-items:flex-start;gap:0.4em;min-width:0}
.rt-meta-item .rt-icon{margin-top:${FIRST_LINE}}
.rt-meta-link{color:inherit;text-decoration:none}
.rt-detail{min-width:0}
.rt-detail-label{font-weight:500}
${bulletRules(d('0.15em', '0.08em'))}
${ROW_RULES}
.rt-language{display:flex;align-items:flex-start;justify-content:space-between;gap:0.75em}
.rt-language-text{display:flex;flex-direction:column;min-width:0}
.rt-language-name{font-family:var(--rt-heading-font);font-weight:500;color:var(--rt-primary)}
.rt-language-label{font-size:0.92em;color:var(--rt-muted)}
${levelRules('var(--rt-secondary)')}
.rt-strength{display:flex;align-items:flex-start;gap:0.6em}
.rt-strength-marker{margin-top:${FIRST_LINE};color:var(--rt-secondary)}
.rt-strength-text{display:flex;flex-direction:column;gap:0.1em;min-width:0}
.rt-strength-title{font-family:var(--rt-heading-font);font-weight:700;color:var(--rt-primary)}

.rt-skills{display:flex;flex-direction:column;gap:${d('0.35em', '0.25em')}}
.rt-group-name{font-family:var(--rt-heading-font);font-weight:700;color:var(--rt-primary)}
.rt-tags{display:flex;flex-wrap:wrap;gap:${d('0.45em 0.6em', '0.35em 0.5em')}}
${TAG_RULES}
${look.extra ?? ''}
`;
  return scopedCss(id, css);
}
