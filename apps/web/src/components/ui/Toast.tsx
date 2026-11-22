'use client';

import { Toast as BaseToast } from '@base-ui/react/toast';
import { clsx } from 'clsx';
import { useMemo, type ReactNode } from 'react';
import { CheckCircleIcon, InfoIcon, WarningCircleIcon, XIcon } from './icons';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  type?: ToastType;
  /** ms before it dismisses itself; 0 keeps it until closed. Default 5000 (errors 8000). */
  timeout?: number;
  /** One button inside the toast, e.g. { label: 'Undo', onClick }. */
  action?: { label: string; onClick: () => void };
}

export interface ToastApi {
  toast: (options: ToastOptions) => string;
  success: (title: ReactNode, description?: ReactNode) => string;
  error: (title: ReactNode, description?: ReactNode) => string;
  info: (title: ReactNode, description?: ReactNode) => string;
  dismiss: (id?: string) => void;
}

/** Shows toasts from anywhere under ToastProvider (mounted in AppProviders). */
export function useToast(): ToastApi {
  const manager = BaseToast.useToastManager();
  return useMemo<ToastApi>(() => {
    const toast = ({ title, description, type = 'info', timeout, action }: ToastOptions) =>
      manager.add({
        title,
        description,
        type,
        timeout: timeout ?? (type === 'error' ? 8000 : 5000),
        priority: type === 'error' ? 'high' : 'low',
        actionProps: action ? { children: action.label, onClick: action.onClick } : undefined,
      });
    return {
      toast,
      success: (title, description) => toast({ title, description, type: 'success' }),
      error: (title, description) => toast({ title, description, type: 'error' }),
      info: (title, description) => toast({ title, description, type: 'info' }),
      dismiss: (id) => manager.close(id),
    };
  }, [manager]);
}

const ICONS: Record<ToastType, ReactNode> = {
  success: <CheckCircleIcon size={20} weight="fill" className="text-success" />,
  error: <WarningCircleIcon size={20} weight="fill" className="text-danger" />,
  info: <InfoIcon size={20} weight="fill" className="text-primary" />,
};

/** The 3 px bar on a toast's leading edge, in its type's colour. */
const BARS: Record<ToastType, string> = { success: 'bg-success', error: 'bg-danger', info: 'bg-primary' };

function ToastList() {
  const { toasts } = BaseToast.useToastManager();
  return toasts.map((toast) => (
    <BaseToast.Root
      key={toast.id}
      toast={toast}
      className={clsx(
        'pointer-events-auto relative w-full overflow-hidden rounded-popup border border-border bg-surface shadow-popover outline-none',
        'translate-x-(--toast-swipe-movement-x) transition-[opacity,translate] duration-300 ease-out-soft',
        'data-starting-style:translate-y-3 data-starting-style:opacity-0 data-ending-style:opacity-0 data-limited:hidden',
      )}
    >
      <span aria-hidden="true" className={clsx('absolute inset-y-0 left-0 w-[3px]', BARS[(toast.type as ToastType | undefined) ?? 'info'])} />
      <BaseToast.Content className="flex items-start gap-3 p-3.5 pr-10 pl-4">
        <span className="mt-px flex shrink-0">{ICONS[(toast.type as ToastType | undefined) ?? 'info']}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <BaseToast.Title className="text-sm leading-5 font-semibold text-foreground" />
          <BaseToast.Description className="text-[13px] leading-5 text-muted-foreground empty:hidden" />
          {toast.actionProps && (
            <BaseToast.Action className="mt-1.5 self-start rounded-tag text-[13px] font-semibold text-primary underline-offset-4 hover:underline" />
          )}
        </div>
        <BaseToast.Close
          aria-label="Dismiss"
          className="absolute top-2.5 right-2.5 inline-flex size-6 items-center justify-center rounded-tag text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          <XIcon size={14} />
        </BaseToast.Close>
      </BaseToast.Content>
    </BaseToast.Root>
  ));
}

/**
 * Holds the toast queue and draws it bottom-right. v34 FIX-WEB (final review U-M4): on a phone a toast spans the width,
 * so while one of the kit's dialogs is open (a centred popup marked `data-kit-modal`: a dialog, a confirm, an alert)
 * the toasts sit under the dialogs' layer (z 40 < 50) and never cover its buttons (their words were announced already;
 * they show again once it closes). With no such dialog open, they are on top as before, over a full-window sheet too
 * (the job details on a phone), so a save's Undo is always within reach.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <BaseToast.Provider limit={3}>
      {children}
      <BaseToast.Portal>
        <BaseToast.Viewport className="pointer-events-none fixed right-4 bottom-4 z-[80] flex max-sm:[body:has([data-kit-modal])_&]:z-40 w-[calc(100vw-2rem)] flex-col-reverse gap-2.5 outline-none sm:right-6 sm:bottom-6 sm:w-[360px]">
          <ToastList />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  );
}
