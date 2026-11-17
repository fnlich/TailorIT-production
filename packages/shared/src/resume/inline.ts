// Inline formatting for resume text. A rich field stores a small markup string: <b>, <i>, <u> and <a href> (http, https
// and mailto links), with `&`, `<` and `>` written as entities. Everything else is literal text, so no stored string
// can carry a script, a style or a foreign tag to a page or a PDF. The parser reads once, left to right, without
// backtracking; its flat runs are all a renderer reads, and `serializeInline` is the only writer of markup.

/** The revision of this markup a document says it was written in (`markupVersion`). */
export const INLINE_MARKUP_VERSION = 1;

/** A stretch of text with one formatting. A flag is present only when on. */
export type InlineRun = { text: string; bold?: true; italic?: true; underline?: true; href?: string };

/** The longest link a run may carry. */
export const MAX_INLINE_HREF_LENGTH = 2000;

// http(s) or mailto with something after it, and no whitespace, control or invisible format character (a zero-width
// space or a bidi override can make an address read as another one).
const SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s\p{Cc}\p{Cf}]+$/iu;

/** Whether `href` may be linked to: `https?://` or `mailto:`, no whitespace or control characters, 2000 at most. */
export function isSafeInlineHref(href: string): boolean {
  return href.length <= MAX_INLINE_HREF_LENGTH && SAFE_HREF.test(href);
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** `&`, `<` and `>` as entities: what a text may hold between tags. */
function escapeText(text: string): string {
  return text.replace(/[&<>]/g, (char) => ESCAPES[char]!);
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ESCAPES[char]!);
}

/** The five entities decoded in one pass; any other `&...;` stays as typed. */
function decodeEntities(text: string): string {
  return text.includes('&') ? text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]!) : text;
}

// ------------------------------------------------------------------------------------------------------ parsing

type TagName = 'b' | 'i' | 'u' | 'a';

interface Tag {
  name: TagName;
  closing: boolean;
  /** An opening `<a>`: the decoded, validated link. */
  href?: string;
  /** Index just past the `>`. */
  end: number;
}

const LINK_OPEN = '<a href="';
/** A link's address as written: every character could be `&quot;`. */
const MAX_HREF_SOURCE = MAX_INLINE_HREF_LENGTH * 6;

/**
 * The opening `<a href="...">` at `at`, or null. The one attribute is a double-quoted href that passes
 * `isSafeInlineHref`; any other attribute, quote or address is not a link. A start carries its own quote, so the
 * search for the closing one never runs past the next start: the whole scan stays linear.
 */
function readLink(markup: string, at: number): Tag | null {
  if (!markup.startsWith(LINK_OPEN, at)) return null;
  const start = at + LINK_OPEN.length;
  const quote = markup.indexOf('"', start);
  if (quote < 0 || quote - start > MAX_HREF_SOURCE || markup[quote + 1] !== '>') return null;
  const href = decodeEntities(markup.slice(start, quote));
  return isSafeInlineHref(href) ? { name: 'a', closing: false, href, end: quote + 2 } : null;
}

/** The allowed tag at `at` (a `<`), exactly as `serializeInline` writes it, or null: anything else is text. */
function readTag(markup: string, at: number): Tag | null {
  const closing = markup[at + 1] === '/';
  const nameAt = at + (closing ? 2 : 1);
  const name = markup[nameAt];
  if (name !== 'b' && name !== 'i' && name !== 'u' && name !== 'a') return null;
  if (name === 'a' && !closing) return readLink(markup, at);
  return markup[nameAt + 1] === '>' ? { name, closing, end: nameAt + 2 } : null;
}

function sameFormat(a: InlineRun, b: InlineRun): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.href === b.href;
}

/**
 * The markup as flat runs. Only the tags above are markup: an unknown, malformed or unsafe tag, a closing tag with
 * nothing to close and a link with an unsafe address are kept as the characters typed. A tag left open formats to
 * the end of the string. Tags of one kind count (`<b>a<b>b</b>c</b>` is bold throughout) and may cross
 * (`<b><i>x</b>y</i>`: x is bold italic, y italic); a link ends at `</a>` or at the next link. Adjacent runs with the
 * same formatting are merged.
 */
export function parseInline(markup: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const depth = { b: 0, i: 0, u: 0 };
  let href: string | undefined;

  const emit = (span: string) => {
    const text = decodeEntities(span);
    if (!text) return;
    const run: InlineRun = { text };
    if (depth.b > 0) run.bold = true;
    if (depth.i > 0) run.italic = true;
    if (depth.u > 0) run.underline = true;
    if (href !== undefined) run.href = href;
    const last = runs.at(-1);
    if (last && sameFormat(last, run)) last.text += text;
    else runs.push(run);
  };

  let from = 0;
  let at = markup.indexOf('<');
  while (at >= 0) {
    const tag = readTag(markup, at);
    const applies =
      tag !== null && (!tag.closing || (tag.name === 'a' ? href !== undefined : depth[tag.name] > 0));
    if (tag && applies) {
      emit(markup.slice(from, at));
      if (tag.name === 'a') href = tag.closing ? undefined : tag.href;
      else depth[tag.name] += tag.closing ? -1 : 1;
      from = tag.end;
      at = markup.indexOf('<', from);
    } else {
      at = markup.indexOf('<', at + 1);
    }
  }
  emit(markup.slice(from));
  return runs;
}

// -------------------------------------------------------------------------------------------------- serializing

type Flat = { text: string; bold: boolean; italic: boolean; underline: boolean; href: string | undefined };

interface Layer {
  of: (run: Flat) => string | boolean | undefined;
  open: (run: Flat) => string;
  close: string;
}

/** Outermost first: a run is wrapped by each layer whose value it has. */
const NESTING: readonly Layer[] = [
  { of: (run) => run.href, open: (run) => `<a href="${escapeAttribute(run.href!)}">`, close: '</a>' },
  { of: (run) => run.bold, open: () => '<b>', close: '</b>' },
  { of: (run) => run.italic, open: () => '<i>', close: '</i>' },
  { of: (run) => run.underline, open: () => '<u>', close: '</u>' },
];

/** `runs` under the layers from `level` in, one tag pair around each stretch of runs that share the layer's value. */
function wrap(runs: readonly Flat[], level: number): string {
  const layer = NESTING[level];
  if (!layer) return runs.map((run) => escapeText(run.text)).join('');
  let out = '';
  for (let start = 0; start < runs.length; ) {
    const value = layer.of(runs[start]!);
    let end = start + 1;
    while (end < runs.length && layer.of(runs[end]!) === value) end++;
    const inner = wrap(runs.slice(start, end), level + 1);
    out += value ? layer.open(runs[start]!) + inner + layer.close : inner;
    start = end;
  }
  return out;
}

/**
 * The canonical markup of `runs`: `<a>` outside `<b>` outside `<i>` outside `<u>`, adjacent runs with the same
 * formatting under one tag, text escaped, empty runs dropped. A run whose link is not safe keeps its text and
 * formatting without the link.
 */
export function serializeInline(runs: readonly InlineRun[]): string {
  const flat: Flat[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    flat.push({
      text: run.text,
      bold: run.bold === true,
      italic: run.italic === true,
      underline: run.underline === true,
      href: run.href !== undefined && isSafeInlineHref(run.href) ? run.href : undefined,
    });
  }
  return wrap(flat, 0);
}

/** The markup rewritten canonically: what the normaliser stores. Idempotent. */
export function sanitizeInline(markup: string): string {
  return serializeInline(parseInline(markup));
}

// -------------------------------------------------------------------------------------------------- plain text

/** The words only: no tags, entities decoded, a link's text without its address. */
export function toPlainText(markup: string): string {
  if (!/[<&]/.test(markup)) return markup;
  return parseInline(markup)
    .map((run) => run.text)
    .join('');
}

/** Any plain string as markup that reads back as that string: `AT&T`, `a < b` and `<b>not bold</b>` stay text. */
export function escapeInline(plain: string): string {
  return escapeText(plain);
}

/** Whether the printed text is only whitespace. */
export function isInlineBlank(markup: string): boolean {
  return toPlainText(markup).trim() === '';
}

/** The length of the printed text: what the caps count, not the tags. */
export function inlineLength(markup: string): number {
  return toPlainText(markup).length;
}

// ---------------------------------------------------------------------------------------------- rich fields

/** One field that holds markup: `list` is the document key of its entries (null: a top-level field). */
export interface RichTextFieldDescriptor {
  /** `customSections.entries` is the entries of every custom section. */
  list: string | null;
  field: string;
  /** A `string[]` (bullets) rather than a string. */
  many: boolean;
}

/** Every field of the document that holds markup; all other text is plain. */
export const RICH_TEXT_FIELDS: readonly RichTextFieldDescriptor[] = [
  { list: null, field: 'summary', many: false },
  { list: 'experience', field: 'description', many: false },
  { list: 'experience', field: 'achievements', many: true },
  { list: 'projects', field: 'description', many: false },
  { list: 'projects', field: 'achievements', many: true },
  { list: 'volunteering', field: 'description', many: false },
  { list: 'volunteering', field: 'achievements', many: true },
  { list: 'education', field: 'achievements', many: true },
  { list: 'awards', field: 'description', many: false },
  { list: 'publications', field: 'description', many: false },
  { list: 'strengths', field: 'description', many: false },
  { list: 'customSections.entries', field: 'description', many: false },
  { list: 'customSections.entries', field: 'achievements', many: true },
];

export function isRichTextField(list: string | null, field: string): boolean {
  return RICH_TEXT_FIELDS.some((rich) => rich.list === list && rich.field === field);
}

type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The registry by list, each list's dotted key split into the path to its entries. */
const FIELDS_BY_LIST = (() => {
  const groups = new Map<string | null, RichTextFieldDescriptor[]>();
  for (const rich of RICH_TEXT_FIELDS) groups.set(rich.list, [...(groups.get(rich.list) ?? []), rich]);
  return [...groups].map(([list, fields]) => ({ path: list === null ? null : list.split('.'), fields }));
})();

/** `items` with each string mapped; the same array when none changed. */
function mapStrings(items: unknown, map: (markup: string) => string): unknown {
  if (!Array.isArray(items)) return items;
  let out: unknown[] | undefined;
  items.forEach((item, index) => {
    if (typeof item !== 'string') return;
    const next = map(item);
    if (next === item) return;
    out ??= items.slice();
    out[index] = next;
  });
  return out ?? items;
}

/** `owner` with the named fields mapped; the same object when none changed. */
function mapOwn(owner: Fields, fields: readonly RichTextFieldDescriptor[], map: (markup: string) => string): Fields {
  let out = owner;
  for (const { field, many } of fields) {
    const value = owner[field];
    const next = many ? mapStrings(value, map) : typeof value === 'string' ? map(value) : value;
    if (next === value) continue;
    if (out === owner) out = { ...owner };
    out[field] = next;
  }
  return out;
}

/** `owner` with `change` applied to every entry at `path` (a list of entries, or lists inside lists). */
function mapEntries(owner: Fields, path: readonly string[], change: (entry: Fields) => Fields): Fields {
  const [key, ...rest] = path;
  const items = key === undefined ? undefined : owner[key];
  if (key === undefined || !Array.isArray(items)) return owner;
  let out: unknown[] | undefined;
  items.forEach((item, index) => {
    if (!isFields(item)) return;
    const next = rest.length === 0 ? change(item) : mapEntries(item, rest, change);
    if (next === item) return;
    out ??= items.slice();
    out[index] = next;
  });
  return out ? { ...owner, [key]: out } : owner;
}

/**
 * A copy of a resume-shaped object with `map` applied to every string of every rich field (each bullet of the
 * `many` ones, the entries of every custom section). Other fields are untouched, nothing is changed in place, and
 * the very same object comes back when `map` changed nothing.
 */
export function mapRichFields<T extends Record<string, unknown>>(document: T, map: (markup: string) => string): T {
  if (!isFields(document)) return document;
  let out: Fields = document;
  for (const { path, fields } of FIELDS_BY_LIST) {
    out = path === null ? mapOwn(out, fields, map) : mapEntries(out, path, (entry) => mapOwn(entry, fields, map));
  }
  return out as T;
}

/** Every plain string that enters the rich fields from outside the editor goes through this. */
export function escapeRichFields<T extends Record<string, unknown>>(document: T): T {
  return mapRichFields(document, escapeInline);
}

/** The rich fields as the words that print, for matching, AI prompts and the plain-text exports. */
export function plainRichFields<T extends Record<string, unknown>>(document: T): T {
  return mapRichFields(document, toPlainText);
}
