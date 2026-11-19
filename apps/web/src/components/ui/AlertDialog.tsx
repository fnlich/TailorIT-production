'use client';

import { AlertDialog as BaseAlertDialog } from '@base-ui/react/alert-dialog';
import { clsx } from 'clsx';
import { useCallback, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Button } from './Button';
import { BACKDROP } from './Dialog';
import { InfoIcon, LockSimpleIcon, WarningCircleIcon } from './icons';

// v32 COPY (E4): a plan or limit gate, or any notice the person must see, is an alert when they act, never a
// full-width banner on the page. A short title, one sentence of reason, the main action (Subscribe) and Not now.

export type AlertTone = 'warning' | 'error' | 'info' | 'locked';

export interface AlertAction {
  label: string;
  /** Runs on press; the alert closes first (an action that opens another dialog opens it on a closed alert). */
  onAction: () => void;
}

/** What one alert says: `useGateAlert().show(alert)`. */
export interface GateAlert {
  /** Short: "Paid feature", "Resume limit reached". */
  title: string;
  /** One sentence: why, and what the action does. */
  message: ReactNode;
  tone?: AlertTone;
  /** The main action (a primary button, last): "Subscribe". */
  action?: AlertAction;
  /** A second action (an outline button, before the main one): "Get extra credit". */
  secondaryAction?: AlertAction;
  /** The dismiss button: "Not now" beside an action, "OK" alone. */
  dismissLabel?: string;
  /** Extra content under the message (a second line, a hook for tests). */
  children?: ReactNode;
  /** A `data-*` mark for the alert's box (`data-limit="resume_limit_reached"`). */
  dataAttributes?: Record<`data-${string}`, string>;
}

const TILES: Record<AlertTone, { className: string; icon: ReactNode }> = {
  warning: { className: 'bg-warning-soft text-warning', icon: <WarningCircleIcon size={22} weight="fill" /> },
  error: { className: 'bg-danger-soft text-danger', icon: <WarningCircleIcon size={22} weight="fill" /> },
  info: { className: 'bg-info-soft text-info', icon: <InfoIcon size={22} weight="fill" /> },
  locked: { className: 'bg-primary-soft text-primary', icon: <LockSimpleIcon size={22} weight="fill" /> },
};

export const ALERT_COPY = { notNow: 'Not now', ok: 'OK' } as const;

export interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What to say; nothing renders without it. */
  alert: GateAlert | null;
  finalFocus?: () => HTMLElement | boolean | null;
}

/**
 * An alert dialog (role="alertdialog", Base UI AlertDialog: no outside-press dismissal; Escape and the dismiss button
 * close it, focus returns to the button that asked). A tone tile, the title, one sentence, then Not now and the action.
 */
export function AlertDialog({ open, onOpenChange, alert, finalFocus }: AlertDialogProps) {
  const tone = alert?.tone ?? 'warning';
  const tile = TILES[tone];
  const hasAction = Boolean(alert?.action || alert?.secondaryAction);
  const popup = useRef<HTMLDivElement>(null);
  const actionRan = useRef(false);
  const run = (action: AlertAction) => {
    actionRan.current = true;
    onOpenChange(false);
    action.onAction();
  };
  // v32 FIX-UX (UXREQ-2): an action that opened its own dialog (Subscribe, Get extra credit) keeps focus there; only a
  // dismissal (Not now, Escape) sends it back (to `finalFocus`, else the button that asked).
  const focusOnClose = () => {
    const ran = actionRan.current;
    actionRan.current = false;
    const active = document.activeElement;
    if (ran && active instanceof HTMLElement && !popup.current?.contains(active) && active.closest('[role="dialog"], [role="alertdialog"]')) {
      return false;
    }
    return finalFocus ? (finalFocus() ?? true) : true;
  };
  return (
    <BaseAlertDialog.Root open={open && alert !== null} onOpenChange={onOpenChange}>
      <BaseAlertDialog.Portal>
        <BaseAlertDialog.Backdrop className={BACKDROP} />
        <BaseAlertDialog.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <BaseAlertDialog.Popup
            ref={popup}
            finalFocus={focusOnClose}
            data-gate-alert={tone}
            {...alert?.dataAttributes}
            className={clsx(
              'w-full max-w-sm rounded-popup border border-border bg-surface p-6 text-foreground shadow-dialog outline-none',
              'transition-[opacity,scale] duration-200 ease-out-soft data-starting-style:scale-[0.97] data-starting-style:opacity-0',
              'data-ending-style:scale-[0.97] data-ending-style:opacity-0',
            )}
          >
            {alert && (
              <>
                <div className="flex items-start gap-3.5">
                  <span className={clsx('flex size-10 shrink-0 items-center justify-center rounded-card', tile.className)} aria-hidden="true">
                    {tile.icon}
                  </span>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <BaseAlertDialog.Title className="text-heading font-semibold">{alert.title}</BaseAlertDialog.Title>
                    <BaseAlertDialog.Description className="mt-1.5 text-sm leading-5 text-muted-foreground">
                      {alert.message}
                    </BaseAlertDialog.Description>
                    {alert.children && <div className="mt-2 text-sm leading-5 text-muted-foreground">{alert.children}</div>}
                  </div>
                </div>
                <div className="mt-6 flex flex-wrap items-center justify-end gap-2.5">
                  <BaseAlertDialog.Close render={<Button variant={!hasAction ? 'primary' : alert.secondaryAction && alert.action ? 'ghost' : 'outline'} className="max-sm:h-11" />}>
                    {alert.dismissLabel ?? (hasAction ? ALERT_COPY.notNow : ALERT_COPY.ok)}
                  </BaseAlertDialog.Close>
                  {alert.secondaryAction && (
                    <Button
                      variant={alert.action ? 'outline' : 'primary'}
                      className="max-sm:h-11"
                      onClick={() => run(alert.secondaryAction!)}
                    >
                      {alert.secondaryAction.label}
                    </Button>
                  )}
                  {alert.action && (
                    <Button className="max-sm:h-11" onClick={() => run(alert.action!)}>
                      {alert.action.label}
                    </Button>
                  )}
                </div>
              </>
            )}
          </BaseAlertDialog.Popup>
        </BaseAlertDialog.Viewport>
      </BaseAlertDialog.Portal>
    </BaseAlertDialog.Root>
  );
}

export interface GateAlertHandle {
  /** Opens the alert with these words. */
  show: (alert: GateAlert) => void;
  close: () => void;
  /** Whether it is open now. */
  open: boolean;
  /** Render it once, anywhere in the component. */
  alert: ReactElement;
}

/**
 * One alert for a screen: `gate.show({ title: 'Paid feature', message: '…', action: { label: 'Subscribe', onAction } })`
 * when the person presses something the plan does not include, and `{gate.alert}` in the tree.
 */
export function useGateAlert(): GateAlertHandle {
  const [current, setCurrent] = useState<GateAlert | null>(null);
  const [open, setOpen] = useState(false);
  const show = useCallback((next: GateAlert) => {
    setCurrent(next);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const alert = useMemo(() => <AlertDialog open={open} onOpenChange={setOpen} alert={current} />, [open, current]);
  return { show, close, open, alert };
}
