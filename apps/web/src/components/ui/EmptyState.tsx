import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  /** A 48 px denim-soft tile with an icon above the title. */
  icon?: ReactNode;
  /** A button (or two) under the text. */
  action?: ReactNode;
  /**
   * "plain" sits inside a card; "dashed" draws its own outline: a stitch (1.5 px dashed) border over pattern paper
   * (an empty board column, a drop zone, an empty page section).
   */
  variant?: 'plain' | 'dashed';
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * The empty wording block: "No saved jobs yet" / "Save jobs from Jobs, or with the extension's Add job.", "No source
 * matches" / "Try other filters or another search." The `md` title is set in Bricolage Grotesque.
 */
export function EmptyState({ title, description, icon, action, variant = 'plain', size = 'md', className }: EmptyStateProps) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center text-center',
        size === 'sm' ? 'gap-1 px-4 py-8' : 'gap-1.5 px-6 py-14',
        variant === 'dashed' && 'paper-grid rounded-card border-[1.5px] border-dashed border-border-strong bg-surface',
        className,
      )}
    >
      {icon && (
        <span className="mb-2 flex size-12 items-center justify-center rounded-card bg-primary-soft text-primary">{icon}</span>
      )}
      <p
        className={clsx(
          size === 'sm' ? 'text-sm font-semibold text-muted-foreground' : 'font-display text-lg leading-6 font-semibold text-foreground',
        )}
      >
        {title}
      </p>
      {description && (
        <p className={clsx('max-w-md text-muted-foreground', size === 'sm' ? 'text-xs' : 'text-sm leading-5')}>{description}</p>
      )}
      {action && <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">{action}</div>}
    </div>
  );
}
