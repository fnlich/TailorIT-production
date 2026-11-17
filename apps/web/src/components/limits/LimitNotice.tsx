'use client';

import { useState, type ReactNode } from 'react';
import { useAccount } from '../../lib/account';
// Relative, not '@/': the web tests draw these views.
import { Button, type ButtonSize } from '../ui/Button';
import { Notice } from '../ui/Notice';
import { BuyCreditDialog } from './BuyCreditDialog';
import { LIMIT_COPY } from './copy';
import { limitButtons, limitTone, toLimit, type LimitInfo } from './limits';
import { SubscribeDialog } from './SubscribeDialog';

// v2.0: a limit message inline (docs/design/v2.0/08-ui.md, "Shared pieces"): the server's message (or a constant the
// web rendered), then the buttons it asks for: Subscribe (never for a Paid account) and Get extra credit. A `Notice`,
// tone `warning`, or `error` for ai_unavailable. LimitDialog shows the same in a dialog.

/**
 * The buttons of a limit message, each opening its dialog (Subscribe, Buy credit). Nothing when the message asks for
 * none (ai_unavailable: its words point to the person's own AI; there is no MCP button).
 */
export function LimitActions({ limit, size = 'sm' }: { limit: Pick<LimitInfo, 'subscribe' | 'buyCredit'>; size?: ButtonSize }) {
  const { data: account } = useAccount();
  const [open, setOpen] = useState<'subscribe' | 'credit' | null>(null);
  const buttons = limitButtons(limit, account);
  if (!buttons.subscribe && !buttons.buyCredit) return null;
  return (
    <>
      <span className="flex flex-wrap items-center gap-2" data-limit-actions="">
        {buttons.subscribe && (
          // 44 px on a phone (08-ui.md: touch targets).
          <Button size={size} className="max-sm:h-11" onClick={() => setOpen('subscribe')}>
            {LIMIT_COPY.subscribe}
          </Button>
        )}
        {buttons.buyCredit && (
          <Button size={size} className="max-sm:h-11" variant={buttons.subscribe ? 'outline' : 'primary'} onClick={() => setOpen('credit')}>
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
  /** A second line under the message ("Jobs you apply to by hand don't count."). */
  children?: ReactNode;
  className?: string;
}

export function LimitNotice({ limit: value, children, className }: LimitNoticeProps) {
  const { data: account } = useAccount();
  const limit = toLimit(value);
  if (!limit) return null;
  const buttons = limitButtons(limit, account);
  return (
    <div data-limit={limit.kind} className={className}>
      <Notice
        tone={limitTone(limit.kind)}
        action={buttons.subscribe || buttons.buyCredit ? <LimitActions limit={limit} /> : undefined}
      >
        <p>{limit.message}</p>
        {children && <p className="mt-1">{children}</p>}
      </Notice>
    </div>
  );
}
