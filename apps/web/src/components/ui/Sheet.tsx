'use client';

import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { clsx } from 'clsx';
import { useRef, type ComponentProps, type ReactNode } from 'react';
import { BACKDROP } from './Dialog';
import { firstFocusSkippingTips, HelpTip } from './HelpTip';
import { IconButton } from './IconButton';
import { XIcon } from './icons';

/*
 * A panel that slides in from the right edge ("Add Application" at max-w-3xl and the application detail at
 * max-w-7xl). It is a positioned Base UI Dialog: modal, focus-trapped, Escape closes it.
 *   <Sheet open={open} onOpenChange={setOpen}>
 *     <SheetContent title="Add Application" icon={…} footer={…}>…</SheetContent>
 *   </Sheet>
 */

export function Sheet(props: ComponentProps<typeof BaseDialog.Root>) {
  return <BaseDialog.Root {...props} />;
}

export const SheetTrigger = BaseDialog.Trigger;
export const SheetClose = BaseDialog.Close;

export type SheetSize = '3xl' | '7xl';

export interface SheetContentProps {
  children: ReactNode;
  title: ReactNode;
  /** A visible line under the title when it is a value (an email, a company's id). Helper text goes in `help`. */
  description?: ReactNode;
  /** v32 COPY (E5): one short sentence of help in a "?" beside the title (never a visible line). */
  help?: ReactNode;
  /** A 40 px denim-soft tile before the title (Add Application: a briefcase). */
  icon?: ReactNode;
  /** Buttons beside the close ✕ (detail view: Apply, Favorite, Archive, Delete). */
  headerActions?: ReactNode;
  /** Sticky bottom bar (Cancel / Add). */
  footer?: ReactNode;
  size?: SheetSize;
  className?: string;
  bodyClassName?: string;
  initialFocus?: ComponentProps<typeof BaseDialog.Popup>['initialFocus'];
  /** A long title wraps (up to three lines) instead of being cut: a job and its company on a phone. */
  wrapTitle?: boolean;
}

export function SheetContent({
  children,
  title,
  description,
  help,
  icon,
  headerActions,
  footer,
  size = '3xl',
  className,
  bodyClassName,
  initialFocus,
  wrapTitle = false,
}: SheetContentProps) {
  // v32 COPY: by default the sheet opens on its first control that is not a "?".
  const popup = useRef<HTMLDivElement>(null);
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className={BACKDROP} />
      <BaseDialog.Popup
        ref={popup}
        initialFocus={initialFocus ?? (() => firstFocusSkippingTips(popup.current))}
        className={clsx(
          'fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-surface text-foreground shadow-dialog outline-none',
          'transition-transform duration-300 ease-out-soft data-starting-style:translate-x-full data-ending-style:translate-x-full',
          size === '7xl' ? 'sm:max-w-7xl' : 'sm:max-w-3xl',
          className,
        )}
      >
        <div className="flex items-start gap-3 border-b border-border px-6 py-4">
          {icon && (
            <span className="flex size-10 shrink-0 items-center justify-center rounded-card bg-primary-soft text-primary">
              {icon}
            </span>
          )}
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 self-center">
            <span className="flex min-w-0 items-center gap-1.5">
              <BaseDialog.Title
                className={clsx('min-w-0 text-heading font-semibold text-foreground', wrapTitle ? 'line-clamp-3 break-words' : 'truncate')}
                data-sheet-title=""
              >
                {title}
              </BaseDialog.Title>
              {help ? (
                <HelpTip label={title} side="bottom">
                  {help}
                </HelpTip>
              ) : null}
            </span>
            {description && (
              <BaseDialog.Description className="text-sm text-muted-foreground">{description}</BaseDialog.Description>
            )}
          </div>
          {headerActions && <div className="flex shrink-0 items-center gap-2">{headerActions}</div>}
          <BaseDialog.Close render={<IconButton label="Close" icon={<XIcon size={18} />} tooltip={false} />} />
        </div>
        <div className={clsx('min-h-0 flex-1 overflow-y-auto px-6 py-5', bodyClassName)}>{children}</div>
        {footer && <div className="flex items-center justify-end gap-2.5 border-t border-border bg-surface-low px-6 py-3.5">{footer}</div>}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}
