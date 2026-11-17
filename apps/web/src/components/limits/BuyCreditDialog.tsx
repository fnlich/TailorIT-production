'use client';

import { useAccount } from '../../lib/account';
import { usePublicConstants } from '../../lib/constants';
import { LIMIT_COPY } from './copy';
import { buyCreditActionOf, type PurchaseAction } from './limits';
import { PurchaseActionDialog } from './PurchaseActionDialog';

// v2.0: the Buy credit dialog (docs/design/v2.0/08-ui.md, "Shared pieces"): `account.buyCredit` by its mode, as the
// Subscribe dialog: "Please contact the admin to purchase extra credit." and the admin's email in v2.0. Opened from
// Settings › Account's "Buy extra credit" and from the ai_usage_exhausted message's "Get extra credit"; offered to
// every account.

export interface BuyCreditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The action to show; by default the account's (GET /api/account), else the constants' contact message. */
  action?: PurchaseAction;
}

export function BuyCreditDialog({ open, onOpenChange, action }: BuyCreditDialogProps) {
  const { data: account } = useAccount();
  const { t, values } = usePublicConstants();
  return (
    <PurchaseActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title={LIMIT_COPY.buyCreditTitle}
      action={action ?? buyCreditActionOf(account, t, values)}
      emailMissing={t('MSG_CONTACT_EMAIL_MISSING')}
    />
  );
}
