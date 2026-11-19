'use client';

import { useState, type ReactNode } from 'react';
import { useAccount } from '../../lib/account';
// Relative, not '@/': the web tests draw these views.
import { Badge } from '../ui/Badge';
import { Button, type ButtonSize } from '../ui/Button';
import { HelpTip } from '../ui/HelpTip';
import { LockSimpleIcon, WarningCircleIcon } from '../ui/icons';
import { BuyCreditDialog } from './BuyCreditDialog';
import { LIMIT_COPY, LIMIT_TITLES } from './copy';
import { limitButtons, limitTone, toLimit, type LimitInfo } from './limits';
import { SubscribeDialog } from './SubscribeDialog';

// v2.0: the limit message's buttons (Subscribe, never for a Paid account; Get extra credit).
// v32 COPY (E4): a limit is never a full-width banner. When the person acts it is an alert (LimitDialog,
// useLimitDialog); a state the page shows while nothing is pressed (at the resume limit, the auto-apply queue waiting
// for the reset) is this small chip: the limit's short title, its sentence in a "?" tooltip, and the button it asks for.

/**
 * The buttons of a limit message, each opening its dialog (Subscribe, Buy credit). Nothing when the message asks for
 * none (ai_unavailable: its words point to the person's own AI; there is no MCP button).
 */
export function LimitActions({
  limit,
  size = 'sm',
  variant,
}: {
  limit: Pick<LimitInfo, 'subscribe' | 'buyCredit'>;
  size?: ButtonSize;
  /** `link` for the passive chip's quiet buttons; by default Subscribe is primary and Get extra credit outline. */
  variant?: 'link';
}) {
  const { data: account } = useAccount();
  const [open, setOpen] = useState<'subscribe' | 'credit' | null>(null);
  const buttons = limitButtons(limit, account);
  if (!buttons.subscribe && !buttons.buyCredit) return null;
  return (
    <>
      <span className="flex flex-wrap items-center gap-2" data-limit-actions="">
        {buttons.subscribe && (
          // 44 px on a phone (08-ui.md: touch targets).
          <Button size={size} variant={variant ?? 'primary'} className="max-sm:h-11" onClick={() => setOpen('subscribe')}>
            {LIMIT_COPY.subscribe}
          </Button>
        )}
        {buttons.buyCredit && (
          <Button
            size={size}
            className="max-sm:h-11"
            variant={variant ?? (buttons.subscribe ? 'outline' : 'primary')}
            onClick={() => setOpen('credit')}
          >
            {LIMIT_COPY.buyCredit}
          </Button>
        )}
      </span>
      {buttons.subscribe && <SubscribeDialog open={open === 'subscribe'} onOpenChange={(next) => setOpen(next ? 'subscribe' : null)} />}
      {buttons.buyCredit && <BuyCreditDialog open={open === 'credit'} onOpenChange={(next) => setOpen(next ? 'credit' : null)} />}
    </>
  );
}

export interface LimitNoticeProps {
  /**
   * A limit message, or an error as a query or request gave it: only an ApiError of a limit code shows; anything else
   * renders nothing.
   */
  limit: LimitInfo | Error | null | undefined;
  /** A second sentence for the tooltip, after the message ("Jobs you apply to by hand don't count."). */
  children?: ReactNode;
  className?: string;
}

/**
 * A limit the page is at, as a small chip: "Resume limit reached" (?) Subscribe. The message is the "?" tooltip (and
 * the chip's description for screen readers); the buttons are the ones it asks for.
 */
export function LimitChip({ limit: value, children, className }: LimitNoticeProps) {
  const { data: account } = useAccount();
  const limit = toLimit(value);
  if (!limit) return null;
  const buttons = limitButtons(limit, account);
  const title = LIMIT_TITLES[limit.kind];
  const tone = limitTone(limit.kind);
  return (
    <div data-limit={limit.kind} data-limit-chip="" className={className}>
      <span className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="inline-flex min-w-0 items-center gap-1">
          <Badge
            tone={tone === 'error' ? 'destructive' : 'warning'}
            icon={
              limit.kind === 'paid_feature' ? (
                <LockSimpleIcon size={13} weight="fill" aria-hidden="true" />
              ) : (
                <WarningCircleIcon size={13} weight="fill" aria-hidden="true" />
              )
            }
          >
            {title}
          </Badge>
          <HelpTip label={title}>
            {limit.message}
            {children ? <> {children}</> : null}
          </HelpTip>
        </span>
        {buttons.subscribe || buttons.buyCredit ? <LimitActions limit={limit} variant="link" /> : null}
      </span>
    </div>
  );
}

/** v32 COPY: the v2.0 name of the passive limit; it is the chip now (never a banner). */
export const LimitNotice = LimitChip;
