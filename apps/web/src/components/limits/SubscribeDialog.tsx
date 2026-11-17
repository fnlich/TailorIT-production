'use client';

import { useAccount } from '../../lib/account';
import { usePublicConstants } from '../../lib/constants';
import { LIMIT_COPY } from './copy';
import { subscribeActionOf, type PurchaseAction } from './limits';
import { PurchaseActionDialog } from './PurchaseActionDialog';

// v2.0: the Subscribe dialog (docs/design/v2.0/08-ui.md, "Shared pieces"; 04-accounts-limits.md, "Subscribe and Buy
// credit"). It renders `account.subscribe` by its mode: `contact` in v2.0 ("Please contact the admin to subscribe."
// and the admin's email), `checkout` once a payment provider exists. Opened from Settings › Account and from every
// plan-limit message (LimitNotice, LimitDialog); never offered to a Paid account.

export interface SubscribeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The action to show; by default the account's (GET /api/account), else the constants' contact message. */
  action?: PurchaseAction;
}

export function SubscribeDialog({ open, onOpenChange, action }: SubscribeDialogProps) {
  const { data: account } = useAccount();
  const { t, values } = usePublicConstants();
  return (
    <PurchaseActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title={LIMIT_COPY.subscribeTitle}
      action={action ?? subscribeActionOf(account, t, values)}
      emailMissing={t('MSG_CONTACT_EMAIL_MISSING')}
    />
  );
}
