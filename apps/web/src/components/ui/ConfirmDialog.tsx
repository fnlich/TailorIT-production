'use client';

import { AlertDialog } from '@base-ui/react/alert-dialog';
import { clsx } from 'clsx';
import { useRef, useState, type ReactNode } from 'react';
import { userMessage } from '@/lib/api';
import { Button, type ButtonVariant } from './Button';
import { BACKDROP } from './Dialog';
import { Notice } from './Notice';
import { ScrollBody } from './ScrollBody';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Extra content between the description and the buttons (e.g. "1 default resume will be skipped"). */
  children?: ReactNode;
  confirmLabel: string;
  /** Shown on the confirm button while `onConfirm` runs. */
  busyLabel?: string;
  cancelLabel?: string;
  tone?: 'destructive' | 'primary';
  /**
   * Runs on confirm. Resolve to close the dialog; reject to keep it open with the error's sentence shown
   * (ApiError messages are used as-is).
   */
  onConfirm: () => Promise<void> | void;
  /** First focus on the confirm button, not the dialog's first control (a checkbox a Space press would tick). */
  focusConfirm?: boolean;
  /**
   * v32 FIX-UX (UXREQ-12): first focus on Cancel, the safe answer: for a confirm that spends (AI, credit) or publishes
   * to everyone, so a quick Enter never does it. Wins over `focusConfirm`.
   */
  focusCancel?: boolean;
  /** v32 INT-2: the confirm button is off (nothing it could do yet: the question's subject is loading or refused). */
  confirmDisabled?: boolean;
  /**
   * Where focus goes when the dialog closes: the element to focus, or true for Base UI's default (the opener). Use it
   * when the opener can be gone or busy by then (a row whose action changed).
   */
  finalFocus?: () => HTMLElement | boolean | null;
}

/**
 * A yes/no question that must be answered ("Disconnect Claude?" / "Claude can no longer reach your TailorIT account.").
 * Built on Base UI AlertDialog: no outside-press dismissal. v34 FIX-WEB (final review U-M3): never taller than the
 * window; the title and the buttons stay on screen and the words between them scroll (a line per profile on a phone
 * held sideways).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  busyLabel,
  cancelLabel = 'Cancel',
  tone = 'destructive',
  onConfirm,
  focusConfirm = false,
  focusCancel = false,
  confirmDisabled = false,
  finalFocus,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (caught) {
      setError(userMessage(caught, 'That did not work. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const variant: ButtonVariant = tone === 'destructive' ? 'destructive' : 'primary';
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={BACKDROP} />
        <AlertDialog.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <AlertDialog.Popup
            initialFocus={focusCancel ? cancelRef : focusConfirm ? confirmRef : undefined}
            finalFocus={finalFocus}
            className={clsx(
              'flex max-h-full w-full max-w-md flex-col rounded-popup border border-border bg-surface p-6 text-foreground shadow-dialog outline-none',
              'transition-[opacity,scale] duration-200 ease-out-soft data-starting-style:scale-[0.97] data-starting-style:opacity-0',
              'data-ending-style:scale-[0.97] data-ending-style:opacity-0',
            )}
            data-confirm-dialog=""
            data-kit-modal="" // v34 FIX-WEB (final review U-M4): on a phone the toasts go under it (Toast.tsx).
          >
            <AlertDialog.Title className="shrink-0 text-heading font-semibold">{title}</AlertDialog.Title>
            {(description || children || error) && (
              <ScrollBody className="-mx-6 px-6" data-confirm-body="">
                {description && (
                  <AlertDialog.Description className="mt-2 text-sm leading-5 text-muted-foreground">
                    {description}
                  </AlertDialog.Description>
                )}
                {children && <div className="mt-3 text-sm">{children}</div>}
                {error && (
                  <Notice tone="error" className="mt-4">
                    {error}
                  </Notice>
                )}
              </ScrollBody>
            )}
            <div className="mt-6 flex shrink-0 flex-wrap items-center justify-end gap-2.5" data-confirm-buttons="">
              <AlertDialog.Close ref={cancelRef} render={<Button variant="outline" disabled={busy} />}>
                {cancelLabel}
              </AlertDialog.Close>
              <Button ref={confirmRef} variant={variant} loading={busy} disabled={confirmDisabled} onClick={() => void confirm()}>
                {busy && busyLabel ? busyLabel : confirmLabel}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
