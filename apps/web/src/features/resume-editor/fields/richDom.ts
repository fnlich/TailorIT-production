import { isSafeInlineHref, serializeInline, type InlineRun } from '@tailorit/shared';

// Between a rich field's DOM and its markup. Reading walks the field's nodes and keeps only what the markup can hold:
// text, bold, italic, underline and a safe link (whatever produced them: our own runs, the browser's B/I/U commands,
// or <strong>/<em>/<span style> left by an edit); every other element is read for its text alone. Writing builds the
// nodes from runs with createElement and textContent, never from HTML, so no string can become an element.

/** The part of a DOM node the reader needs (so it can be tested with plain objects). */
export interface ReadableNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<ReadableNode>;
  getAttribute?(name: string): string | null;
  /** Elements only: the inline style the browser may write (`font-weight: bold`). */
  style?: { fontWeight?: string; fontStyle?: string; textDecorationLine?: string; textDecoration?: string };
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

type Format = { bold: boolean; italic: boolean; underline: boolean; href: string | undefined };

function formatOf(node: ReadableNode, outer: Format): Format {
  const name = node.nodeName.toLowerCase();
  const style = node.style;
  const weight = style?.fontWeight ?? '';
  const decoration = `${style?.textDecorationLine ?? ''} ${style?.textDecoration ?? ''}`;
  const href = name === 'a' ? (node.getAttribute?.('href') ?? '') : '';
  return {
    bold: outer.bold || name === 'b' || name === 'strong' || weight === 'bold' || Number(weight) >= 600,
    italic: outer.italic || name === 'i' || name === 'em' || style?.fontStyle === 'italic',
    underline: outer.underline || name === 'u' || /\bunderline\b/.test(decoration),
    href: href && isSafeInlineHref(href) ? href : outer.href,
  };
}

/** The runs a rich field's nodes hold. A line break (<br>, or a block after text) reads as "\n". */
export function runsFromNodes(root: ReadableNode): InlineRun[] {
  const runs: InlineRun[] = [];
  const push = (text: string, format: Format) => {
    if (!text) return;
    const run: InlineRun = { text };
    if (format.bold) run.bold = true;
    if (format.italic) run.italic = true;
    if (format.underline) run.underline = true;
    if (format.href) run.href = format.href;
    runs.push(run);
  };
  const walk = (node: ReadableNode, format: Format) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === TEXT_NODE) push(child.textContent ?? '', format);
      else if (child.nodeType === ELEMENT_NODE) {
        const name = child.nodeName.toLowerCase();
        if (name === 'br') {
          push('\n', format);
          continue;
        }
        const block = name === 'div' || name === 'p';
        // A block the browser wrapped a new line in starts on a line of its own.
        if (block && runs.length > 0 && !runs[runs.length - 1]!.text.endsWith('\n')) push('\n', format);
        walk(child, formatOf(child, format));
      }
    }
  };
  walk(root, { bold: false, italic: false, underline: false, href: undefined });
  // The browser keeps a lone <br> in an emptied field; it is no text of the person's.
  if (runs.length > 0) {
    const last = runs[runs.length - 1]!;
    if (last.text.endsWith('\n')) last.text = last.text.replace(/\n$/, '');
    if (!last.text) runs.pop();
  }
  return runs;
}

/** The canonical markup of a rich field's nodes. */
export function markupFromNodes(root: ReadableNode): string {
  return serializeInline(runsFromNodes(root));
}

/** Nodes drawing `runs` (link outside bold outside italic outside underline, as the markup nests them). */
export function nodesFromRuns(document: Document, runs: readonly InlineRun[]): Node[] {
  const nodes: Node[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    let node: Node = document.createTextNode(run.text);
    const wrap = (tag: string, attribute?: [string, string]) => {
      const element = document.createElement(tag);
      if (attribute) element.setAttribute(attribute[0], attribute[1]);
      element.append(node);
      node = element;
    };
    if (run.underline) wrap('u');
    if (run.italic) wrap('i');
    if (run.bold) wrap('b');
    if (run.href && isSafeInlineHref(run.href)) wrap('a', ['href', run.href]);
    nodes.push(node);
  }
  return nodes;
}
