import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { HelpTip } from './HelpTip';

export interface EmptyStateProps {
  title: ReactNode;
  /** v32 COPY (E5): one short sentence in a "?" beside the title (never a visible line). */
  description?: ReactNode;
  /** A 48 px denim-soft tile with an icon above the title. */
  icon?: ReactNode;
  /**
   * v32 FIX-UX (UXREQ-8, the coordinator: "next steps stay visible"): what to do next, one short sentence in view under
   * the title (a description says what the place is, in its "?"; the next step is never hidden there).
   */
  nextStep?: ReactNode;
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
 * The empty wording block: "No saved jobs yet" (?) and its action. The `md` title is set in Bricolage Grotesque; v32
 * COPY (E5): the description is the "?" beside the title, so the block reads as a title and an action.
 */
export function EmptyState({ title, description, nextStep, icon, action, variant = 'plain', size = 'md', className }: EmptyStateProps) {
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
      <div className="inline-flex max-w-md items-center justify-center gap-1.5">
        <p
          className={clsx(
            size === 'sm' ? 'text-sm font-semibold text-muted-foreground' : 'font-display text-lg leading-6 font-semibold text-foreground',
          )}
        >
          {title}
        </p>
        {description ? <HelpTip label={title}>{description}</HelpTip> : null}
      </div>
      {nextStep ? (
        <p className="max-w-sm text-[13px] leading-5 text-muted-foreground" data-empty-next-step="">
          {nextStep}
        </p>
      ) : null}
      {action && <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">{action}</div>}
    </div>
  );
}
