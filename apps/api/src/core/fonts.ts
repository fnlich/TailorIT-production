import { readFileSync } from 'node:fs';
import { fontFacesUsed, RESUME_FONT_PAIRS } from '@tailorit/shared';
import { staticDir } from './paths';

// The bundled web fonts: OFL woff2 files under static/fonts, listed face by face in fonts.json (with their licences in
// licenses/). The print browser has no network, so a PDF carries the faces it uses inline as data: URLs; the editors in
// the browser load the same files by URL. Cover letters and resumes both print from here.

interface BundledFace {
  style: string;
  weight: string;
  subset: string;
  file: string;
  unicodeRange: string;
}

interface BundledFamily {
  family: string;
  licence: string;
  licenceFile: string;
  faces: BundledFace[];
}

let manifest: BundledFamily[] | null = null;
const dataUrls = new Map<string, string>();

function families(): BundledFamily[] {
  manifest ??= (JSON.parse(readFileSync(staticDir('fonts', 'fonts.json'), 'utf8')) as { families: BundledFamily[] })
    .families;
  return manifest;
}

export function bundledFamilyNames(): string[] {
  return families().map((entry) => entry.family);
}

/** The bundled file names (what a font route may serve). */
export function isBundledFontFile(file: string): boolean {
  return /^[a-z0-9-]+\.woff2$/.test(file) && families().some((entry) => entry.faces.some((face) => face.file === file));
}

export function readFontFile(file: string): Buffer | null {
  if (!isBundledFontFile(file)) return null;
  try {
    return readFileSync(staticDir('fonts', file));
  } catch {
    return null;
  }
}

function dataUrl(file: string): string {
  let url = dataUrls.get(file);
  if (!url) {
    url = `data:font/woff2;base64,${readFileSync(staticDir('fonts', file)).toString('base64')}`;
    dataUrls.set(file, url);
  }
  return url;
}

/** Inline data: URLs (print, previews in sandboxed frames) or a URL per file (the editors). */
export type FontSource = 'data' | ((file: string) => string);

export interface FontFaceCssOptions {
  /**
   * Declare a variable file once, for the whole 400-700 range it carries, so 500 and 600 render as such. Without it a
   * variable file is declared at each weight the manifest lists it under (400 and 700), as cover letters always have.
   */
  variableRanges?: boolean;
  /**
   * Only the faces this text has a character for (by their unicode-range), and every latin face: a PDF inlines the
   * scripts its words are in, not all of them. Latin always, for what a template's own styles draw (bullets, bars).
   */
  forText?: string;
}

/** A face's unicode-range ("U+0301, U+0400-045F") as code point pairs. */
function rangesOf(unicodeRange: string): Array<[number, number]> {
  return unicodeRange
    .split(',')
    .map((part) => part.trim().replace(/^U\+/i, ''))
    .filter(Boolean)
    .map((part) => {
      const [from = '', to = from] = part.split('-');
      const low = Number.parseInt(from.replaceAll('?', '0'), 16);
      const high = Number.parseInt(to.replaceAll('?', 'F'), 16);
      return [low, high] as [number, number];
    })
    .filter(([low, high]) => Number.isFinite(low) && Number.isFinite(high));
}

/** Whether a face is wanted for `codePoints`: a latin one always, another when it holds one of them. */
function faceWanted(face: { subset?: string; unicodeRange: string }, codePoints: ReadonlySet<number> | null): boolean {
  if (!codePoints || face.subset === 'latin') return true;
  const ranges = rangesOf(face.unicodeRange);
  for (const point of codePoints) if (ranges.some(([low, high]) => point >= low && point <= high)) return true;
  return false;
}

const isVariableFile = (file: string) => file.endsWith('-var.woff2');

/** @font-face rules for the given families (unknown or system ones are skipped). */
export function fontFaceCss(familyNames: Iterable<string>, source: FontSource, options: FontFaceCssOptions = {}): string {
  const wanted = new Set(familyNames);
  const codePoints = options.forText === undefined ? null : new Set(Array.from(options.forText, (char) => char.codePointAt(0)!));
  const rules: string[] = [];
  for (const entry of families()) {
    if (!wanted.has(entry.family)) continue;
    const declared = new Set<string>();
    for (const face of entry.faces) {
      if (!faceWanted(face, codePoints)) continue;
      let weight = face.weight;
      if (options.variableRanges && isVariableFile(face.file)) {
        if (declared.has(face.file)) continue;
        declared.add(face.file);
        weight = '400 700';
      }
      const src = source === 'data' ? dataUrl(face.file) : source(face.file);
      rules.push(
        `@font-face{font-family:'${entry.family}';font-style:${face.style};font-weight:${weight};` +
          `font-display:block;src:url(${src}) format('woff2');unicode-range:${face.unicodeRange};}`,
      );
    }
  }
  return rules.join('\n');
}

/** Every family a resume font pair uses, once each, in the order the pairs list them. */
export function resumeFontFamilies(): string[] {
  return [...new Set(RESUME_FONT_PAIRS.flatMap((pair) => [pair.heading.family, pair.body.family]))];
}

/**
 * The @font-face rules a resume needs: the faces of one font pair (a PDF), or of every pair (the editor, which switches
 * pairs live). A family that is not bundled throws: a resume never prints in a fallback font without anyone knowing.
 */
export function resumeFontFaceCss(pair: { pairId: unknown } | 'all', source: FontSource, forText?: string): string {
  const names = pair === 'all' ? resumeFontFamilies() : fontFacesUsed(pair.pairId).map((face) => face.family);
  const bundled = new Set(bundledFamilyNames());
  const missing = names.filter((name) => !bundled.has(name));
  if (missing.length > 0) throw new Error(`Resume fonts not bundled under static/fonts: ${missing.join(', ')}`);
  return fontFaceCss(names, source, { variableRanges: true, ...(forText === undefined ? {} : { forText }) });
}
