'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
// Relative, not '@/': the web tests draw these views.
import { BuyCreditDialog } from '../../components/limits/BuyCreditDialog';
import type { AiUseInput } from '../../components/limits/aiUse';
import { SubscribeDialog } from '../../components/limits/SubscribeDialog';
import { AiUseMeter, UsageMeter } from '../../components/limits/UsageMeter';
import { fetchHeaderSummary, HEADER_QUERY_KEY } from '../../components/shell/header/api';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { CheckIcon, LockSimpleIcon } from '../../components/ui/icons';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { HelpTip } from '../../components/ui/HelpTip';
import { useAccount } from '../../lib/account';
import { userMessage } from '../../lib/api';
import { usePublicConstants } from '../../lib/constants';
import { roleFamilyLabel } from '@tailorit/shared/roles';
import { useMyField } from '../roles/hooks'; // v33 ROLES
import { DeleteMyAccount } from '../account-deletion/DeleteMyAccount'; // v34 ACCTDEL
import { ACCOUNT_COPY, accountView, type AccountView } from './account';
import { Section, SettingRow } from './parts';

// v2.0: Settings › Account, the first section of /settings (docs/design/v2.0/08-ui.md, "Settings › Account"): the
// account type and its end, today's auto-applies (UsageMeter), the resumes against the plan's limit, AI job search,
// the extra-credit balance with Buy extra credit, and Subscribe for a Free account. Subscribe and Buy credit open the
// shared dialogs ("Please contact the admin…" and the admin's email). Never the daily AI budget's amounts or anything
// about the server. v32 COPY (E7): today's AI use is a row as its share only ("40%"), read from the top bar's summary
// (GET /api/me/header, already loaded for the header's chip).

export function AccountSection({ className }: { className?: string }) {
  const account = useAccount();
  // The top bar's own query (same key: no second request while it is fresh; the bar keeps it current).
  const header = useQuery({ queryKey: HEADER_QUERY_KEY, queryFn: ({ signal }) => fetchHeaderSummary(signal), staleTime: 60_000 });
  const [open, setOpen] = useState<'subscribe' | 'credit' | null>(null);
  // v33 ROLES (F4): "Your field", the default resume's.
  const { t } = usePublicConstants();
  const myField = useMyField().data;
  const field = myField
    ? {
        familyId: myField.familyId as string,
        label: t('LABEL_ACCOUNT_YOUR_FIELD'),
        tip: t('MSG_ACCOUNT_FIELD_TIP'),
        text: myField.source === 'none' ? t('MSG_ACCOUNT_FIELD_NONE') : t('MSG_ACCOUNT_YOUR_FIELD', { field: roleFamilyLabel(myField.familyId) }),
      }
    : null;
  return (
    <Section title={ACCOUNT_COPY.title} description={ACCOUNT_COPY.description} id="account" className={className}>
      {account.data ? (
        <AccountDetails
          view={accountView(account.data)}
          aiUse={header.data?.ai}
          field={field}
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
          {userMessage(account.error, 'Try again in a moment.')}
        </Notice>
      ) : (
        <AccountSkeleton />
      )}
      {/* v34 ACCTDEL (PLAN G10): Delete my account, last in the section, whether or not the plan summary loaded. */}
      <DeleteMyAccount />
      <SubscribeDialog open={open === 'subscribe'} onOpenChange={(next) => setOpen(next ? 'subscribe' : null)} />
      <BuyCreditDialog open={open === 'credit'} onOpenChange={(next) => setOpen(next ? 'credit' : null)} />
    </Section>
  );
}

/** The rows (drawn statically by the tests). */
export function AccountDetails({
  view,
  aiUse,
  field,
  onSubscribe,
  onBuyCredit,
}: {
  view: AccountView;
  /** Today's AI use as the top bar's summary gives it (the share, or the amounts): only the share is drawn. */
  aiUse?: AiUseInput;
  /** v33 ROLES: "Your field" in words (the default resume's), with its "?"; no row while unknown. */
  field?: { familyId: string; label: string; tip: string; text: string } | null;
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
      {aiUse && (
        <SettingRow label={ACCOUNT_COPY.aiUse}>
          <AiUseMeter ai={aiUse} showLabel={false} layout="inline" label={ACCOUNT_COPY.aiUse} className="w-64 max-w-full" />
        </SettingRow>
      )}
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
      {field ? (
        <SettingRow
          label={
            <span className="inline-flex items-center gap-1">
              {field.label}
              <HelpTip label={field.label}>{field.tip}</HelpTip>
            </span>
          }
        >
          <span data-your-field={field.familyId}>{field.text}</span>
        </SettingRow>
      ) : null}
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
        <span className="num text-foreground" data-credit="">
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
