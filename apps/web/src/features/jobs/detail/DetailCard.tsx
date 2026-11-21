'use client';

import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { HelpTip } from '@/components/ui/HelpTip';

/** A detail card's box: white on the pane's canvas, or (`tape`) the Tailor card's tape-soft with the tape on top. */
export function detailCardClasses(tone: 'default' | 'tape' = 'default'): string {
  return clsx(
    'relative min-w-0 rounded-card border p-4 sm:p-5',
    tone === 'tape' ? 'overflow-hidden border-tape-strong/50 bg-tape-soft pt-5 sm:pt-6' : 'border-border bg-surface shadow-card',
  );
}

/** A detail card's title: small capitals (an h3 under the job's h2), then its "?" tip. */
export function DetailCardTitle({ id, title, tip, children }: { id: string; title: string; tip?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <h3 id={id} className="text-xs leading-4 font-semibold tracking-[0.08em] text-muted-foreground uppercase" data-detail-card-title="">
        {title}
      </h3>
      {tip && <HelpTip label={title}>{tip}</HelpTip>}
      {children}
    </div>
  );
}

/**
 * v33 JOBDETAIL (F2): one section of the job's details, a card on the pane's canvas: a small uppercase title (an h3
 * under the job's h2) with its "?" tip and an optional control at its right, then the section. `tape` is the Tailor
 * card's look (the tailor's tape along its top edge, on tape-soft).
 */
export function DetailCard({
  id,
  title,
  tip,
  aside,
  tone = 'default',
  className,
  bodyClassName,
  children,
  ...data
}: {
  /** The title's id (the section's accessible name). */
  id: string;
  title: string;
  /** One short sentence behind the "?" after the title. */
  tip?: ReactNode;
  /** Something at the title's right. */
  aside?: ReactNode;
  tone?: 'default' | 'tape';
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <section aria-labelledby={id} className={clsx(detailCardClasses(tone), className)} {...data}>
      {tone === 'tape' && <span aria-hidden="true" className="tape-ticks absolute inset-x-0 top-0 h-1.5 bg-tape" />}
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <DetailCardTitle id={id} title={title} tip={tip} />
        {aside}
      </div>
      {children !== undefined && children !== null && <div className={clsx('mt-3', bodyClassName)}>{children}</div>}
    </section>
  );
}
