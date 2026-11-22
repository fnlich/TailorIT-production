'use client';

import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { clsx } from 'clsx';
import { useRef, type ComponentProps, type ReactNode } from 'react';
import { firstFocusSkippingTips, HelpTip } from './HelpTip';
import { IconButton } from './IconButton';
import { XIcon } from './icons';

/*
 *   <Dialog open={open} onOpenChange={setOpen}>
 *     <DialogContent title="Rename resume" help="…">
 *       …
 *       <DialogFooter><Button variant="outline" onClick={…}>Cancel</Button><Button>Rename</Button></DialogFooter>
 *     </DialogContent>
 *   </Dialog>
 * Escape and an outside press close the top-most dialog only; focus is trapped and returns to the opener, unless an
 * alert opened as the dialog closed (a result, a confirm): that alert keeps it (v34 FIX-WEB, final review U-M5).
 *
 * A body that scrolls (`min-h-0 flex-1 overflow-y-auto` under the title) must also be `relative` (v34 FIX-WEB, final
 * review U-M1): an absolutely placed piece inside it (an sr-only name, a field's "$") otherwise takes the popup as its
 * containing block, escapes the body's clipping, hangs below the popup and makes the whole dialog scroll, title and ✕
 * off the screen.
 */

export function Dialog(props: ComponentProps<typeof BaseDialog.Root>) {
  return <BaseDialog.Root {...props} />;
}

export function DialogTrigger(props: ComponentProps<typeof BaseDialog.Trigger>) {
  return <BaseDialog.Trigger {...props} />;
}

export const DialogClose = BaseDialog.Close;

/** `full` (v1.4 E): the whole window less a small margin (none on a phone), for a document's full-page preview. */
export type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

const SIZES: Record<DialogSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
  full: 'h-full max-w-none rounded-none sm:rounded-popup',
};

/** v34 FIX-WEB (final review U-M5): an alert open outside `popup` (raised by the dialog's action as it closes). */
export function alertOpenOutside(popup: HTMLElement | null): boolean {
  if (typeof document === 'undefined') return false;
  return [...document.querySelectorAll('[role="alertdialog"]')].some((alert) => !popup?.contains(alert));
}

/**
 * Where focus goes as a dialog closes: nowhere when an alert opened meanwhile (it took the focus and keeps it), else as
 * `finalFocus` says (the opener by default).
 */
export function closingFocus(
  popup: HTMLElement | null,
  finalFocus: DialogContentProps['finalFocus'],
  closeType: Parameters<Extract<NonNullable<DialogContentProps['finalFocus']>, (...args: never[]) => unknown>>[0],
): boolean | HTMLElement | null | void {
  if (alertOpenOutside(popup)) return false;
  if (finalFocus === undefined) return true;
  if (typeof finalFocus === 'function') return finalFocus(closeType);
  if (typeof finalFocus === 'boolean') return finalFocus;
  return finalFocus.current ?? true;
}

export const BACKDROP =
  'fixed inset-0 z-50 min-h-dvh bg-overlay backdrop-blur-[2px] transition-opacity duration-200 ease-out-soft ' +
  'data-starting-style:opacity-0 data-ending-style:opacity-0 supports-[-webkit-touch-callout:none]:absolute';

export interface DialogContentProps {
  children: ReactNode;
  title?: ReactNode;
  /**
   * A visible line under the title for what the dialog is about when it is a value or a question ("Senior Designer at
   * Acme", "What is wrong with this job?"). Helper text goes in `help`.
   */
  description?: ReactNode;
  /** v32 COPY (E5): one short sentence of help in a "?" beside the title (never a visible line). */
  help?: ReactNode;
  size?: DialogSize;
  /** The ✕ in the corner (default on). */
  showClose?: boolean;
  className?: string;
  initialFocus?: ComponentProps<typeof BaseDialog.Popup>['initialFocus'];
  finalFocus?: ComponentProps<typeof BaseDialog.Popup>['finalFocus'];
}

/**
 * A centred white dialog (radius 10, 1 px border, the dialog shadow) over the denim overlay. `full` fills the window
 * (its content lays out its own header and padding).
 */
export function DialogContent({
  children,
  title,
  description,
  help,
  size = 'md',
  showClose = true,
  className,
  initialFocus,
  finalFocus,
}: DialogContentProps) {
  // v32 COPY: by default the dialog opens on its first control that is not a "?" (its title's or a field's tip).
  const popup = useRef<HTMLDivElement>(null);
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className={BACKDROP} />
      <BaseDialog.Viewport
        className={clsx(
          'fixed inset-0 z-50 flex items-center justify-center',
          size === 'full' ? 'overflow-hidden p-0 sm:p-3' : 'overflow-y-auto p-4 sm:p-6',
        )}
      >
        <BaseDialog.Popup
          ref={popup}
          initialFocus={initialFocus ?? (() => firstFocusSkippingTips(popup.current))}
          finalFocus={(closeType) => closingFocus(popup.current, finalFocus, closeType)}
          // v34 FIX-WEB (final review U-M4): a kit dialog is open: on a phone the toasts go under it (Toast.tsx).
          data-kit-modal=""
          className={clsx(
            'relative flex max-h-full w-full flex-col bg-surface text-foreground shadow-dialog outline-none',
            size !== 'full' && 'rounded-popup border border-border p-6',
            'transition-[opacity,scale] duration-200 ease-out-soft data-starting-style:scale-[0.97] data-starting-style:opacity-0',
            'data-ending-style:scale-[0.97] data-ending-style:opacity-0',
            SIZES[size],
            className,
          )}
        >
          {(title || description) && (
            <div className={clsx('flex flex-col gap-1.5', showClose && 'pr-8')}>
              {title &&
                (help ? (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <DialogTitle>{title}</DialogTitle>
                    <HelpTip label={title} side="bottom">
                      {help}
                    </HelpTip>
                  </span>
                ) : (
                  <DialogTitle>{title}</DialogTitle>
                ))}
              {description && <DialogDescription>{description}</DialogDescription>}
            </div>
          )}
          {children}
          {showClose && (
            <BaseDialog.Close
              render={<IconButton label="Close" icon={<XIcon size={18} />} size="sm" tooltip={false} className="absolute top-4 right-4" />}
            />
          )}
        </BaseDialog.Popup>
      </BaseDialog.Viewport>
    </BaseDialog.Portal>
  );
}

export function DialogTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <BaseDialog.Title className={clsx('text-heading font-semibold text-foreground', className)}>
      {children}
    </BaseDialog.Title>
  );
}

export function DialogDescription({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <BaseDialog.Description className={clsx('text-sm leading-5 text-muted-foreground', className)}>
      {children}
    </BaseDialog.Description>
  );
}

/**
 * Right-aligned buttons at the bottom of a dialog, 24 px under the content. `flush` drops that margin (inside a
 * form that already spaces its children).
 */
export function DialogFooter({ children, className, flush }: { children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <div className={clsx('flex flex-wrap items-center justify-end gap-2.5', !flush && 'mt-6', className)}>{children}</div>
  );
}
