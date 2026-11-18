import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export interface PageHeaderProps {
  /** The page's title: one per page, an h1 unless `as` says otherwise. */
  title: ReactNode;
  /** One short sentence under the title (muted, up to ~70 characters a line). */
  description?: ReactNode;
  /** Buttons at the right (the page's main action last, as a primary Button). Wraps under the title on a phone. */
  actions?: ReactNode;
  /** A small spaced-capital line above the title (a group name: "Settings", "Admin"). */
  eyebrow?: ReactNode;
  /** The heading's id, for a region's aria-labelledby. */
  id?: string;
  as?: 'h1' | 'h2';
  className?: string;
}

/**
 * The top of a page: the title in Bricolage Grotesque (26/32, 22/28 on a phone), an optional description and the
 * page's actions. Pages put it first in their content column, 28 px under the top bar (`pt-7`), 24 px above the
 * content (`mb-6`, or the gap of the column). v31 FIX-WEB (REV-UX UX-7): as the page's h1 it carries `data-page-header`,
 * and the app's top bar leaves out its section name on a page that has one (the page's own title says it; never twice).
 */
export function PageHeader({ title, description, actions, eyebrow, id, as: Heading = 'h1', className }: PageHeaderProps) {
  return (
    <div data-page-header={Heading === 'h1' ? '' : undefined} className={clsx('flex flex-wrap items-end justify-between gap-x-6 gap-y-3', className)}>
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1 text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">{eyebrow}</p>
        )}
        <Heading id={id} className="page-title">
          {title}
        </Heading>
        {description && <p className="mt-1.5 max-w-2xl text-sm leading-5 text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
