'use client';

import { Button as BaseButton } from '@base-ui/react/button';
import { clsx } from 'clsx';
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { Spinner } from './Spinner';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'destructive'
  | 'destructive-soft'
  | 'destructive-outline'
  | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BASE =
  'inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-control font-medium ' +
  'transition-[background-color,border-color,color,box-shadow] duration-150 ease-out-soft ' +
  'disabled:pointer-events-none disabled:opacity-50 data-disabled:pointer-events-none data-disabled:opacity-50 ' +
  '[&_svg]:shrink-0';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-on-primary shadow-control hover:bg-primary-hover active:bg-primary-active',
  secondary: 'bg-surface-muted text-foreground hover:bg-muted active:bg-border',
  outline:
    'border border-border-strong bg-surface text-foreground shadow-control hover:border-control-hover hover:bg-surface-low active:bg-surface-muted',
  ghost: 'text-foreground hover:bg-hover active:bg-pressed',
  destructive: 'bg-danger text-on-primary shadow-control hover:bg-danger-hover active:bg-danger-ink',
  'destructive-soft': 'bg-danger-soft text-danger-ink hover:bg-danger/15 active:bg-danger/20',
  'destructive-outline':
    'border border-danger/45 bg-surface text-danger-ink shadow-control hover:bg-danger-soft active:bg-danger/15',
  link: 'h-auto px-0 text-primary underline-offset-4 hover:underline',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-9 px-3.5 text-sm',
  lg: 'h-10 px-5 text-sm',
};

export interface ButtonStyleOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
}

/** The kit's button classes, for a Link or a Base UI trigger that must look like a Button. */
export function buttonClasses({ variant = 'primary', size = 'md', fullWidth, className }: ButtonStyleOptions = {}) {
  return clsx(BASE, variant === 'link' ? 'text-sm' : SIZES[size], VARIANTS[variant], fullWidth && 'w-full', className);
}

export interface ButtonProps
  extends Omit<ComponentPropsWithoutRef<typeof BaseButton>, 'className'>,
    Omit<ButtonStyleOptions, 'className'> {
  className?: string;
  /** Shows a spinner, disables the button and keeps its width. */
  loading?: boolean;
  /** An icon before the label (16 px). */
  icon?: ReactNode;
  /** An icon after the label (e.g. a caret). */
  trailingIcon?: ReactNode;
}

/**
 * The kit's button: 36 px (`md`), radius 6, IBM Plex Sans 500. Variants primary (denim), secondary (a quiet grey
 * fill), outline (white with the strong border), ghost, destructive(-soft/-outline) and link; sizes sm 32 / md 36 /
 * lg 40.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, fullWidth, className, loading = false, icon, trailingIcon, disabled, children, type, ...rest },
  ref,
) {
  return (
    <BaseButton
      ref={ref}
      type={type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, fullWidth, className })}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 14 : 16} /> : icon}
      {children}
      {trailingIcon}
    </BaseButton>
  );
});
