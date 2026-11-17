import { LETTER_FONTS, letterFontCss } from '@tailorit/shared';
import { bundledFamilyNames } from '../../core/fonts';

// The letter side of the bundled web fonts (core/fonts.ts): which families a letter uses, and the names DOCX and CSS
// know them by. The editor loads the files from GET /api/cover-letters/fonts/:file (an alias of /api/fonts/:file).
// Times New Roman, Helvetica and Courier are system fonts (Helvetica prints as Arial where it is missing).

export { bundledFamilyNames, fontFaceCss, isBundledFontFile, readFontFile } from '../../core/fonts';

/** The bundled families a letter needs: its own font, plus any named in font-family spans of its HTML. */
export function familiesUsed(html: string, fontFamily: string): string[] {
  const bundled = new Map(bundledFamilyNames().map((name) => [name.toLowerCase(), name]));
  const used = new Set<string>();
  const add = (name: string) => {
    const hit = bundled.get(name.trim().replace(/^["']+|["']+$/g, '').trim().toLowerCase());
    if (hit) used.add(hit);
  };
  add(fontFamily);
  // Style attributes are double-quoted (sanitize-html writes them so); quotes inside are entities.
  for (const attribute of html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)) {
    const style = (attribute[1] ?? '').replace(/&quot;|&#34;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
    for (const declaration of style.matchAll(/font-family\s*:\s*([^;]+)/gi)) {
      for (const part of (declaration[1] ?? '').split(',')) add(part);
    }
  }
  return [...used];
}

/** The CSS stack for a letter's font name (an unknown name falls back to Times New Roman). */
export function fontStack(name: string): string {
  return letterFontCss(name);
}

/** What DOCX names the font as (Word has no Helvetica or Courier on Windows). */
export function docxFontName(name: string): string {
  if (name === 'Helvetica') return 'Arial';
  if (name === 'Courier') return 'Courier New';
  return LETTER_FONTS.some((font) => font.name === name) ? name : 'Times New Roman';
}
