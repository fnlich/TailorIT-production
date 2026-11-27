import { decodeHtmlEntities } from '@tailorit/shared';
import { isRecord, type Json } from './common';

// v38 ATS-B: the data a board's own page carries in its HTML (SP v38 EVIDENCE.md §12-14, 17: Zoho Recruit's
// `var jobs = JSON.parse('…')` and hidden inputs, Join.com's and Dayforce's __NEXT_DATA__, Recruiterflow's window
// objects), read as data, never run. Every reader is bounded (the page was read to its platform's maxBytes) and answers
// null for anything it cannot read whole; a page's script is never evaluated.

/** The most characters of one embedded object read (a page's own JSON runs to some hundreds of kilobytes). */
export const EMBEDDED_JSON_MAX_CHARS = 8 * 1024 * 1024;

/** The JSON a page names under `<script id="__NEXT_DATA__">` (a Next.js page's props), or null. */
export function nextDataOf(html: string): Json | null {
  const match = /<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script\s*>/i.exec(html);
  if (!match || match[1]!.length > EMBEDDED_JSON_MAX_CHARS) return null;
  try {
    const data: unknown = JSON.parse(match[1]!);
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

/** The value at `path` (dot-separated keys) of a JSON object, or undefined. */
export function pathOf(value: unknown, path: string): unknown {
  let node: unknown = value;
  for (const key of path.split('.')) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** JavaScript's one-character escapes (\n, \t...); any other escaped character is itself (\- is -, \/ is /). */
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

/**
 * The text a JavaScript string literal's body spells (its \xNN, \uNNNN, \u{N...} and one-character escapes read; a line
 * continuation dropped), as a script's engine would read it. Zoho Recruit's job page writes its record so: `JSON.parse('[{\x22id\x22:...}]')`.
 */
export function jsStringLiteralText(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|\r\n|[\s\S])/g, (_whole, escape: string) => {
    if (escape.length === 3 && escape[0] === 'x') return String.fromCharCode(parseInt(escape.slice(1), 16));
    if (escape.startsWith('u{')) {
      const code = parseInt(escape.slice(2, -1), 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    if (escape.length === 5 && escape[0] === 'u') return String.fromCharCode(parseInt(escape.slice(1), 16));
    if (escape === '\n' || escape === '\r' || escape === '\r\n' || escape === '\u2028' || escape === '\u2029') return '';
    return SIMPLE_ESCAPES[escape] ?? escape;
  });
}

/**
 * The single-quoted string a page passes to `JSON.parse('…')` right after `marker` (`var jobs = `), read as text (see
 * jsStringLiteralText), or null when the marker or a whole literal is not there.
 */
export function jsonParseArgumentAfter(html: string, marker: string): string | null {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const call = /^\s*JSON\.parse\(\s*'/.exec(html.slice(at + marker.length, at + marker.length + 64));
  if (!call) return null;
  const start = at + marker.length + call[0].length;
  const end = Math.min(html.length, start + EMBEDDED_JSON_MAX_CHARS);
  for (let i = start; i < end; i += 1) {
    const char = html[i];
    if (char === '\\') i += 1;
    else if (char === "'") return jsStringLiteralText(html.slice(start, i));
    else if (char === '\n') return null; // a single-quoted literal never spans lines
  }
  return null;
}

/**
 * The JSON object or array literal a page assigns right after `marker` (`window.jobsList = `, `var convertedToJSON = `),
 * read whole (brackets balanced, strings respected) and parsed; null when it is not there, not whole or not JSON.
 */
export function jsonLiteralAfter(html: string, marker: string): unknown {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  let start = at + marker.length;
  while (start < html.length && /\s/.test(html[start]!)) start += 1;
  const open = html[start];
  if (open !== '{' && open !== '[') return null;
  const end = Math.min(html.length, start + EMBEDDED_JSON_MAX_CHARS);
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < end; i += 1) {
    const char = html[i]!;
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"') quote = char;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1)) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** One tag's attributes, read with their quotes respected (a value may hold `>`), names in lower case. */
function attributesAt(html: string, start: number): { attributes: Map<string, string>; end: number } {
  const attributes = new Map<string, string>();
  let i = start + 1;
  while (i < html.length && !/[\s/>]/.test(html[i]!)) i += 1; // the tag's name
  const limit = Math.min(html.length, start + EMBEDDED_JSON_MAX_CHARS);
  while (i < limit) {
    while (i < limit && /\s/.test(html[i]!)) i += 1;
    if (html[i] === '>' || html.startsWith('/>', i)) break;
    const name = /^[^\s=/>]+/.exec(html.slice(i, i + 200))?.[0];
    if (!name) {
      i += 1;
      continue;
    }
    i += name.length;
    while (i < limit && /\s/.test(html[i]!)) i += 1;
    let value = '';
    if (html[i] === '=') {
      i += 1;
      while (i < limit && /\s/.test(html[i]!)) i += 1;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        if (close < 0 || close > limit) return { attributes, end: limit };
        value = html.slice(i + 1, close);
        i = close + 1;
      } else {
        const bare = /^[^\s>]*/.exec(html.slice(i, i + 2048))![0];
        value = bare;
        i += bare.length;
      }
    }
    if (!attributes.has(name.toLowerCase())) attributes.set(name.toLowerCase(), decodeHtmlEntities(value));
  }
  return { attributes, end: i };
}

/**
 * The value of the page's `<input id="{id}">` (a hidden input holding data: Zoho Recruit's #jobs and #meta), its
 * entities decoded; null when the page has none. The value may come before the id and hold `>`.
 */
export function inputValueById(html: string, id: string): string | null {
  const pattern = new RegExp(`\\bid\\s*=\\s*["']${id.replace(/[^a-z0-9_-]/gi, '')}["']`, 'gi');
  for (const match of html.matchAll(pattern)) {
    const start = html.toLowerCase().lastIndexOf('<input', match.index);
    if (start < 0) continue;
    const { attributes } = attributesAt(html, start);
    if (attributes.get('id') === id && attributes.has('value')) return attributes.get('value')!;
  }
  return null;
}

/** A `<meta property|name="{key}" content="…">` tag's content, its entities decoded and spaces tidied; null for none. */
export function metaContentOf(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = new RegExp(`<meta\\b[^>]*\\b(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*>`, 'i').exec(html)?.[0];
  if (!tag) return null;
  const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  const text = decodeHtmlEntities(content?.[1] ?? content?.[2] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

/** The page's `<title>`, its entities decoded and spaces tidied; null for none. */
export function htmlTitleOf(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]{0,2000}?)<\/title\s*>/i.exec(html);
  const text = match ? decodeHtmlEntities(match[1]!).replace(/\s+/g, ' ').trim() : '';
  return text || null;
}

/** The Accept header of a read of a page (as the iCIMS and BambooHR readers send it). */
export const PAGE_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8';
