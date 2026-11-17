'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { invalidateAccount } from '../../lib/account';
import { isApiError } from '../../lib/api';
import { usePublicConstants } from '../../lib/constants';
// Relative, not '@/': the web tests draw these views.
import { Button } from '../ui/Button';
import { Dialog, DialogClose, DialogContent, DialogFooter } from '../ui/Dialog';
import { LIMIT_COPY, LIMIT_TITLES } from './copy';
import { paidFeatureLimit, toLimit, type LimitInfo, type PaidFeature } from './limits';
import { LimitActions } from './LimitNotice';

// v2.0: a limit message in a dialog (docs/design/v2.0/08-ui.md, "Shared pieces" and "Prepare & Queue: ... the
// errors"): a refused request (ai_unavailable, ai_usage_exhausted, resume_limit_reached, paid_feature) or a locked
// Paid-only feature (DECISIONS A28). Its title names the limit, its body is the message, and its buttons are the ones
// the message asks for, beside Close: Subscribe for a plan limit (Free only), Get extra credit for the AI usage, only
// Close for ai_unavailable (its words point to the person's own AI; no MCP button).

export interface LimitDialogProps {
  /** The message to show, or an error (only an ApiError of a limit code shows). */
  limit: LimitInfo | Error | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A second line under the message. */
  children?: ReactNode;
}

export function LimitDialog({ limit: value, open, onOpenChange, children }: LimitDialogProps) {
  const limit = toLimit(value);
  return (
    <Dialog open={open && limit !== null} onOpenChange={onOpenChange}>
      {limit && (
        <DialogContent title={LIMIT_TITLES[limit.kind]} description={limit.message} size="md">
          <div data-limit={limit.kind}>
            {children && <p className="mt-3 text-sm leading-5 text-muted-foreground">{children}</p>}
            <DialogFooter>
              <DialogClose render={<Button variant="outline">{LIMIT_COPY.close}</Button>} />
              {/* The Subscribe and Buy credit dialogs open nested in this one: Escape closes the top one only. */}
              <LimitActions limit={limit} size="md" />
            </DialogFooter>
          </div>
        </DialogContent>
      )}
    </Dialog>
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
 * One LimitDialog for a screen: `if (!limits.show(error)) toast.error(...)`, and `{limits.dialog}` in the tree. Focus
 * returns to the button that made the request.
 */
export function useLimitDialog(): LimitDialogHandle {
  const queryClient = useQueryClient();
  const [limit, setLimit] = useState<LimitInfo | null>(null);
  const [open, setOpen] = useState(false);
  const show = useCallback(
    (value: unknown) => {
      const next = toLimit(value);
      if (!next) return false;
      setLimit(next);
      setOpen(true);
      if (isApiError(value)) void invalidateAccount(queryClient);
      return true;
    },
    [queryClient],
  );
  const dialog = useMemo(() => <LimitDialog limit={limit} open={open} onOpenChange={setOpen} />, [limit, open]);
  return { show, dialog };
}

export interface LockedFeatureDialogProps {
  /** The Paid-only feature a Free account asked for: AI job search, or the batch resume download. */
  feature: PaidFeature;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The locked-feature dialog: a Free account pressed a Paid-only feature (the lock icon's button). The feature's
 * message (MSG_PAID_AI_SEARCH, MSG_BATCH_DOWNLOAD_PAID) with Subscribe. No request is made; the server refuses anyway.
 */
export function LockedFeatureDialog({ feature, open, onOpenChange }: LockedFeatureDialogProps) {
  const { t } = usePublicConstants();
  return <LimitDialog limit={paidFeatureLimit(t, feature)} open={open} onOpenChange={onOpenChange} />;
}
