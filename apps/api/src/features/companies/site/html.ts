import { decodeHtmlEntities } from '@tailorit/shared';

// v30 E2: a small HTML tokenizer for reading a company's homepage (docs/design/part2/13-company-enrichment.md §3.3):
// its tags with their attributes, its text, and the raw content of its scripts (the JSON-LD blocks). Nothing is run
// and nothing is loaded; a page is only ever read as text. It reads at most MAX_TOKENS tokens (a homepage's head and
// footer are well within), and any markup it cannot read is passed over as text.

/** The most tokens one page is read into. */
const MAX_TOKENS = 100_000;
/** Elements whose content is not markup: kept raw (scripts, for their JSON-LD) or dropped. */
const RAW_ELEMENTS = new Set(['script', 'style', 'textarea', 'noscript', 'template', 'svg']);
/** Elements that never close. */
export const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

export interface HtmlTag {
  name: string;
  /** Attribute names in lower case; values with their character references decoded. */
  attrs: Record<string, string>;
  selfClosing: boolean;
}

export type HtmlToken =
  | { type: 'open'; tag: HtmlTag }
  | { type: 'close'; name: string }
  | { type: 'text'; text: string }
  | { type: 'raw'; tag: HtmlTag; content: string };

const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function attributesOf(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of text.matchAll(ATTRIBUTE)) {
    const name = match[1]!.toLowerCase();
    if (Object.hasOwn(attrs, name)) continue;
    attrs[name] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/** The end of a tag that starts at `from` (its `>`), quotes respected; -1 when it never ends. */
function tagEnd(html: string, from: number): number {
  let quote = '';
  for (let at = from; at < html.length; at += 1) {
    const char = html[at]!;
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return at;
    }
  }
  return -1;
}

/** A page's tokens (see the module's note). */
export function tokenize(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  let at = 0;
  const text = (value: string) => {
    if (value) tokens.push({ type: 'text', text: decodeHtmlEntities(value) });
  };
  while (at < html.length && tokens.length < MAX_TOKENS) {
    const open = html.indexOf('<', at);
    if (open < 0) {
      text(html.slice(at));
      break;
    }
    text(html.slice(at, open));
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      at = end < 0 ? html.length : end + 3;
      continue;
    }
    const next = html[open + 1] ?? '';
    if (next === '!' || next === '?') {
      const end = html.indexOf('>', open);
      at = end < 0 ? html.length : end + 1;
      continue;
    }
    if (next === '/') {
      const end = html.indexOf('>', open);
      const name = /^\/\s*([a-zA-Z][\w:-]*)/.exec(html.slice(open + 1, end < 0 ? undefined : end))?.[1]?.toLowerCase();
      if (name) tokens.push({ type: 'close', name });
      at = end < 0 ? html.length : end + 1;
      continue;
    }
    const name = /^[a-zA-Z][\w:-]*/.exec(html.slice(open + 1, open + 64))?.[0]?.toLowerCase();
    if (!name) {
      text('<');
      at = open + 1;
      continue;
    }
    const end = tagEnd(html, open + 1 + name.length);
    if (end < 0) break;
    const inside = html.slice(open + 1 + name.length, end);
    const tag: HtmlTag = { name, attrs: attributesOf(inside), selfClosing: /\/\s*$/.test(inside) || VOID_ELEMENTS.has(name) };
    at = end + 1;
    if (RAW_ELEMENTS.has(name) && !tag.selfClosing) {
      const closing = new RegExp(`</${name}`, 'gi');
      closing.lastIndex = at;
      const close = closing.exec(html)?.index ?? -1;
      const content = html.slice(at, close < 0 ? html.length : close);
      tokens.push({ type: 'raw', tag, content });
      const closeEnd = close < 0 ? -1 : html.indexOf('>', close);
      at = closeEnd < 0 ? html.length : closeEnd + 1;
      continue;
    }
    tokens.push({ type: 'open', tag });
  }
  return tokens;
}
