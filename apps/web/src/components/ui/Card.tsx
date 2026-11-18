import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';

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

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'article' | 'li' | 'aside';
  tone?: CardTone;
  padding?: CardPadding;
  children?: ReactNode;
}

/** A white surface: radius 10, 1 px border, the short card shadow. The block every list, panel and form sits on. */
export function Card({ as: Tag = 'div', tone = 'default', padding = 'md', className, children, ...rest }: CardProps) {
  return (
    <Tag className={clsx('rounded-card border', TONES[tone], PADDING[padding], className)} {...rest}>
      {children}
    </Tag>
  );
}
