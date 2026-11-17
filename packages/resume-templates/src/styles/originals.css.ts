import { HEADER_PHOTO_RULES, levelRules, ROW_RULES, TAG_RULES } from './templates.css';

// What the four templates after the owner's original designs (Slate, Accent Orange, Editorial, Timeline) share. The
// originals were drawn in pt (Accent Orange in CSS px) on a fixed body size; here every length is in em of the body
// text, so the Font size control scales the page and the default size prints the original's numbers. Line heights
// are the original's, as unitless ratios.

/** A length of the original, in em of its body size: `lengthEm(15, 9)` is 15pt on 9pt type. */
export function lengthEm(value: number, body: number): string {
  return `${Math.round((value / body) * 10_000) / 10_000}em`;
}

/** A line height of the original (`line` on `size`), unitless. */
export function ratio(line: number, size: number): string {
  return String(Math.round((line / size) * 10_000) / 10_000);
}

/**
 * The rules every one of the four has: the capitals switches, links that look like text, field text that keeps to
 * one line where the original's did, the photo, languages and short facts, tags and the proficiency dots (when the
 * person turns them on), and skills as "Group: a, b" lines with the group's name and colon in bold.
 */
export const ORIGINALS_COMMON_RULES = `
&[data-uppercase-name] .rt-name{text-transform:uppercase}
&[data-uppercase-headings] .rt-heading-text{text-transform:uppercase}
.rt-contact-link,.rt-meta-link{color:inherit;text-decoration:none}
.rt-entry-aside .rt-text{white-space:pre}
${HEADER_PHOTO_RULES}
${ROW_RULES}
.rt-language{display:flex;align-items:flex-start;justify-content:space-between;gap:0.75em}
.rt-language-text{display:block;min-width:0}
.rt-language-name{font-weight:700}
${levelRules('var(--rt-secondary)')}
.rt-skills{display:flex;flex-direction:column;gap:0.25em}
.rt-group-name,.rt-group-sep,.rt-strength-title,.rt-strength-sep{font-weight:700}
.rt-strength-title{display:inline}
.rt-tags{display:flex;flex-wrap:wrap;gap:0.4em 0.6em}
${TAG_RULES}
.rt-entry{display:flex;flex-direction:column}
.rt-entry-head[data-head=split] .rt-entry-line{display:flex;justify-content:space-between;align-items:baseline}
.rt-entry-lead{flex:1 1 auto;min-width:0}
.rt-entry-lead .rt-entry-title,.rt-entry-head[data-head=inline] .rt-entry-title{display:inline}
.rt-entry-aside{flex:none}
`;
