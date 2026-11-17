// @jsxRuntime automatic
// @jsxImportSource react
import { Fragment, type ReactNode } from 'react';
import { isSafeInlineHref, type InlineRun } from '@tailorit/shared';
import { useSlots } from '../slots';

// Formatted text as React elements, never as HTML: the runs a rich field parses to, nested the way `serializeInline`
// writes them (a link outside bold outside italic outside underline). A stretch of runs that share a link is one <a>,
// so a link whose words change formatting is still one link in the PDF. An unsafe address loses its link, not its text.

type Layer = (run: InlineRun) => string | boolean | undefined;

const LAYERS: readonly Layer[] = [
  (run) => (run.href !== undefined && isSafeInlineHref(run.href) ? run.href : undefined),
  (run) => run.bold === true,
  (run) => run.italic === true,
  (run) => run.underline === true,
];

function wrap(value: string | true, level: number, key: string, children: ReactNode, links: boolean): ReactNode {
  if (level === 0) {
    // Text where links may not be (a thumbnail inside a link or a button).
    if (!links) return <span key={key}>{children}</span>;
    return (
      <a key={key} href={value as string}>
        {children}
      </a>
    );
  }
  if (level === 1) return <b key={key}>{children}</b>;
  if (level === 2) return <i key={key}>{children}</i>;
  return <u key={key}>{children}</u>;
}

function nest(runs: readonly InlineRun[], level: number, prefix: string, links: boolean): ReactNode[] {
  const layer = LAYERS[level];
  if (!layer) return runs.map((run) => run.text);
  const out: ReactNode[] = [];
  for (let start = 0; start < runs.length; ) {
    const value = layer(runs[start]!);
    let end = start + 1;
    while (end < runs.length && layer(runs[end]!) === value) end++;
    const key = `${prefix}${level}.${start}`;
    const inner = nest(runs.slice(start, end), level + 1, `${key}-`, links);
    out.push(value ? wrap(value, level, key, inner, links) : <Fragment key={key}>{inner}</Fragment>);
    start = end;
  }
  return out;
}

/** The runs of one field, empty runs skipped. */
export function InlineRuns({ runs }: { runs: readonly InlineRun[] }): ReactNode {
  const { links } = useSlots();
  return <>{nest(runs.filter((run) => run.text !== ''), 0, '', links)}</>;
}
