'use client';

import { useState } from 'react';
// Relative, not '@/': the web tests draw these views.
import { BuyCreditDialog } from '../../components/limits/BuyCreditDialog';
import { SubscribeDialog } from '../../components/limits/SubscribeDialog';
import { UsageMeter } from '../../components/limits/UsageMeter';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { CheckIcon, LockSimpleIcon } from '../../components/ui/icons';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAccount } from '../../lib/account';
import { userMessage } from '../../lib/api';
import { ACCOUNT_COPY, accountView, type AccountView } from './account';
import { Section, SettingRow } from './parts';

// v2.0: Settings › Account, the first section of /settings (docs/design/v2.0/08-ui.md, "Settings › Account"): the
// account type and its end, today's auto-applies (UsageMeter), the resumes against the plan's limit, AI job search,
// the extra-credit balance with Buy extra credit, and Subscribe for a Free account. Subscribe and Buy credit open the
// shared dialogs ("Please contact the admin…" and the admin's email). Never the daily AI budget or anything about the
// server.

export function AccountSection({ className }: { className?: string }) {
  const account = useAccount();
  const [open, setOpen] = useState<'subscribe' | 'credit' | null>(null);
  return (
    <Section title={ACCOUNT_COPY.title} description={ACCOUNT_COPY.description} id="account" className={className}>
      {account.data ? (
        <AccountDetails
          view={accountView(account.data)}
          onSubscribe={() => setOpen('subscribe')}
          onBuyCredit={() => setOpen('credit')}
        />
      ) : account.isError ? (
        <Notice
          tone="error"
          title={ACCOUNT_COPY.loadFailed}
          action={
            <Button variant="outline" size="sm" loading={account.isFetching} onClick={() => void account.refetch()}>
              {ACCOUNT_COPY.tryAgain}
            </Button>
          }
        >
          {userMessage(account.error, 'Please try again in a moment.')}
        </Notice>
      ) : (
        <AccountSkeleton />
      )}
      <SubscribeDialog open={open === 'subscribe'} onOpenChange={(next) => setOpen(next ? 'subscribe' : null)} />
      <BuyCreditDialog open={open === 'credit'} onOpenChange={(next) => setOpen(next ? 'credit' : null)} />
    </Section>
  );
}

/** The rows (drawn statically by the tests). */
export function AccountDetails({
  view,
  onSubscribe,
  onBuyCredit,
}: {
  view: AccountView;
  onSubscribe: () => void;
  onBuyCredit: () => void;
}) {
  return (
    <dl className="flex flex-col divide-y divide-divider-soft" data-account-type={view.paid ? 'paid' : 'free'}>
      <SettingRow label={ACCOUNT_COPY.type}>
        <Badge tone={view.paid ? 'primary' : 'neutral'}>{view.typeLabel}</Badge>
        {view.paidUntil && <span className="text-muted-foreground">{view.paidUntil}</span>}
        {view.subscribe && (
          <Button size="sm" className="sm:ml-auto" onClick={onSubscribe} data-subscribe="">
            {ACCOUNT_COPY.subscribe}
          </Button>
        )}
      </SettingRow>
      <SettingRow label={ACCOUNT_COPY.autoApplies}>
        {view.autoApply.kind === 'meter' ? (
          <span className="flex flex-col gap-1">
            <UsageMeter used={view.autoApply.used} limit={view.autoApply.limit} showReset={false} />
            <span className="text-xs leading-4 text-muted-foreground">{view.autoApplyReset}</span>
          </span>
        ) : (
          <span>{ACCOUNT_COPY.unlimited}</span>
        )}
      </SettingRow>
      <SettingRow label={ACCOUNT_COPY.resumes}>
        {view.resumes.kind === 'meter' ? (
          <UsageMeter
            used={view.resumes.used}
            limit={view.resumes.limit}
            label={ACCOUNT_COPY.resumesLabel}
            text={view.resumesText ?? undefined}
            showReset={false}
          />
        ) : (
          <span>{ACCOUNT_COPY.unlimited}</span>
        )}
      </SettingRow>
      <SettingRow label={ACCOUNT_COPY.aiSearch}>
        {view.aiJobSearch === 'included' ? (
          <span className="inline-flex items-center gap-1.5">
            <CheckIcon size={14} weight="bold" className="text-success" aria-hidden="true" />
            {ACCOUNT_COPY.aiSearchIncluded}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <LockSimpleIcon size={14} aria-hidden="true" />
            {ACCOUNT_COPY.aiSearchLocked}
          </span>
        )}
      </SettingRow>
      <SettingRow label={ACCOUNT_COPY.credit}>
        <span className="font-semibold tabular-nums" data-credit="">
          {view.credit}
        </span>
        <Button size="sm" variant="outline" className="sm:ml-auto" onClick={onBuyCredit}>
          {ACCOUNT_COPY.buyCredit}
        </Button>
      </SettingRow>
    </dl>
  );
}

function AccountSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading your account">
      {[0, 1, 2, 3, 4].map((index) => (
        <div key={index} className="flex items-center gap-6">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-40" />
        </div>
      ))}
    </div>
  );
}
