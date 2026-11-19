import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import { HelpTip } from './HelpTip';

export type CardTone = 'default' | 'muted' | 'interactive';
export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

const TONES: Record<CardTone, string> = {
  default: 'border-border bg-surface shadow-card',
  // a quieter block inside a page section (a settings group, a summary)
  muted: 'border-border bg-surface-low',
  // a card that is one big link or button target: the border darkens and the shadow lifts on hover
  interactive:
    'border-border bg-surface shadow-card transition-[border-color,box-shadow] duration-150 hover:border-control-hover hover:shadow-popover',
};

const PADDING: Record<CardPadding, string> = { none: '', sm: 'p-4', md: 'p-5', lg: 'p-6' };

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  as?: 'div' | 'section' | 'article' | 'li' | 'aside';
  tone?: CardTone;
  padding?: CardPadding;
  /** v32 COPY: the card's title (the section-heading style), drawn first with `description` in a "?" beside it. */
  heading?: ReactNode;
  /** The heading's element (default h2) and id (a region's aria-labelledby). */
  headingAs?: 'h2' | 'h3';
  headingId?: string;
  /** v32 COPY (E5): one short sentence in the "?" tooltip beside the heading (never a visible line). */
  description?: ReactNode;
  /** Buttons at the heading's right. */
  actions?: ReactNode;
  children?: ReactNode;
}

/**
 * A white surface: radius 10, 1 px border, the short card shadow. The block every list, panel and form sits on. With a
 * `heading`, the card draws its title row first: the heading, its "?" description and its actions.
 */
export function Card({
  as: Tag = 'div',
  tone = 'default',
  padding = 'md',
  heading,
  headingAs,
  headingId,
  description,
  actions,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <Tag className={clsx('rounded-card border', TONES[tone], PADDING[padding], className)} {...rest}>
      {heading ? (
        <>
          <CardHeader heading={heading} as={headingAs} id={headingId} description={description} actions={actions} />
          {children !== undefined && children !== null && <div className="mt-4">{children}</div>}
        </>
      ) : (
        children
      )}
    </Tag>
  );
}

/** A card's title row: the heading (18/24 semibold), its description as a "?" beside it, actions at the right. */
export function CardHeader({
  heading,
  description,
  actions,
  as: Heading = 'h2',
  id,
  className,
}: {
  heading: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  as?: 'h2' | 'h3';
  id?: string;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-wrap items-center justify-between gap-x-4 gap-y-2', className)}>
      <div className="flex min-w-0 items-center gap-1.5">
        <Heading id={id} className={clsx('font-semibold text-foreground', Heading === 'h2' ? 'text-heading' : 'text-[15px] leading-5')}>
          {heading}
        </Heading>
        {description ? <HelpTip label={heading}>{description}</HelpTip> : null}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
