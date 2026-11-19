'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { invalidateAccount, useAccount } from '../../lib/account';
import { isApiError } from '../../lib/api';
import { usePublicConstants } from '../../lib/constants';
// Relative, not '@/': the web tests draw these views.
import { AlertDialog, type AlertTone, type GateAlert } from '../ui/AlertDialog';
import { BuyCreditDialog } from './BuyCreditDialog';
import { LIMIT_COPY, LIMIT_TITLES } from './copy';
import { limitButtons, paidFeatureLimit, toLimit, type LimitInfo, type LimitKind, type PaidFeature } from './limits';
import { SubscribeDialog } from './SubscribeDialog';

// v2.0: a limit message in a dialog: a refused request (ai_unavailable, ai_usage_exhausted, resume_limit_reached,
// paid_feature) or a locked Paid-only feature (DECISIONS A28).
// v32 COPY (E4): it is an alert (role="alertdialog"): a short title, the message, Not now and the action the message
// asks for: Subscribe for a plan limit (Free only), Get extra credit for the AI usage, only OK for ai_unavailable (its
// words point to the person's own AI; no MCP button). The action closes the alert and opens its own dialog.

/** The alert's tone tile for a kind of limit. */
export function limitAlertTone(kind: LimitKind): AlertTone {
  if (kind === 'ai_unavailable') return 'error';
  if (kind === 'paid_feature') return 'locked';
  return 'warning';
}

/**
 * The alert's words and buttons for a limit (pure, for the tests): Subscribe is the action when the account may
 * subscribe, Get extra credit the action (or the second one beside Subscribe) when the message asks for it.
 */
export function limitAlert(
  limit: LimitInfo,
  buttons: { subscribe: boolean; buyCredit: boolean },
  open: (dialog: 'subscribe' | 'credit') => void,
  children?: ReactNode,
): GateAlert {
  const subscribe = buttons.subscribe ? { label: LIMIT_COPY.subscribe, onAction: () => open('subscribe') } : undefined;
  const credit = buttons.buyCredit ? { label: LIMIT_COPY.buyCredit, onAction: () => open('credit') } : undefined;
  return {
    title: LIMIT_TITLES[limit.kind],
    message: limit.message,
    tone: limitAlertTone(limit.kind),
    action: subscribe ?? credit,
    secondaryAction: subscribe ? credit : undefined,
    children,
    dataAttributes: { 'data-limit': limit.kind },
  };
}

export interface LimitDialogProps {
  /** The message to show, or an error (only an ApiError of a limit code shows). */
  limit: LimitInfo | Error | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A second line under the message. */
  children?: ReactNode;
  /** Where focus goes when it closes (the button that asked, by default). v32 INT-1: Jobs' Ask AI tab must not get it. */
  finalFocus?: () => HTMLElement | boolean | null;
}

export function LimitDialog({ limit: value, open, onOpenChange, children, finalFocus }: LimitDialogProps) {
  const { data: account } = useAccount();
  const { values } = usePublicConstants();
  const [purchase, setPurchase] = useState<'subscribe' | 'credit' | null>(null);
  const limit = toLimit(value);
  const alert = limit ? limitAlert(limit, limitButtons(limit, account, values.ADMIN_CONTACT_EMAIL), setPurchase, children) : null;
  // v32 FIX-UX (UXREQ-2): the element that asked, kept while the alert is up: when Subscribe or Get extra credit closes
  // the alert, its own dialog has focus (AlertDialog leaves it there); closing that dialog brings focus back here
  // (or to `finalFocus`), never to the page's start.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);
  const backToOpener = () => {
    const chosen = finalFocus?.();
    if (chosen !== undefined && chosen !== null && chosen !== true) return chosen;
    return opener.current?.isConnected ? opener.current : true;
  };
  return (
    <>
      <AlertDialog open={open && alert !== null} onOpenChange={onOpenChange} alert={alert} finalFocus={finalFocus} />
      <SubscribeDialog
        open={purchase === 'subscribe'}
        onOpenChange={(next) => setPurchase(next ? 'subscribe' : null)}
        finalFocus={backToOpener}
      />
      <BuyCreditDialog open={purchase === 'credit'} onOpenChange={(next) => setPurchase(next ? 'credit' : null)} finalFocus={backToOpener} />
    </>
  );
}

export interface LimitDialogHandle {
  /**
   * Shows `value` when it is a limit message or a limit error, and answers true; answers false for anything else (the
   * caller shows its own error then). A limit error also marks the account stale (useAccount reads it again).
   */
  show: (value: unknown) => boolean;
  /** Render it once, anywhere in the component. */
  dialog: ReactElement;
}

/**
 * One limit alert for a screen: `if (!limits.show(error)) toast.error(...)`, and `{limits.dialog}` in the tree. Focus
 * returns to the button that made the request.
 */
export function useLimitDialog(): LimitDialogHandle {
  const queryClient = useQueryClient();
  const [limit, setLimit] = useState<LimitInfo | null>(null);
  const [open, setOpen] = useState(false);
  // v32 FIX-UX (UXREQ-2): the control that asked, as it is when the limit is shown: the alert and the purchase dialog
  // it may open give focus back to it.
  const opener = useRef<HTMLElement | null>(null);
  const show = useCallback(
    (value: unknown) => {
      const next = toLimit(value);
      if (!next) return false;
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
      setLimit(next);
      setOpen(true);
      if (isApiError(value)) void invalidateAccount(queryClient);
      return true;
    },
    [queryClient],
  );
  const dialog = useMemo(
    () => (
      <LimitDialog
        limit={limit}
        open={open}
        onOpenChange={setOpen}
        finalFocus={() => (opener.current?.isConnected ? opener.current : true)}
      />
    ),
    [limit, open],
  );
  return { show, dialog };
}

export interface LockedFeatureDialogProps {
  /** The Paid-only feature a Free account asked for: AI job search, or the batch resume download. */
  feature: PaidFeature;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus?: LimitDialogProps['finalFocus'];
}

/**
 * The locked-feature alert: a Free account pressed a Paid-only feature (the lock icon's button). The feature's message
 * (MSG_PAID_AI_SEARCH, MSG_BATCH_DOWNLOAD_PAID) with Subscribe and Not now. No request is made; the server refuses
 * anyway.
 */
export function LockedFeatureDialog({ feature, open, onOpenChange, finalFocus }: LockedFeatureDialogProps) {
  const { t } = usePublicConstants();
  return <LimitDialog limit={paidFeatureLimit(t, feature)} open={open} onOpenChange={onOpenChange} finalFocus={finalFocus} />;
}
