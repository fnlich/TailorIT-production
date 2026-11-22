'use client';

import { AdminCreditBodySchema, UsdTextSchema, type AccountType, type AdminUser } from '@tailorit/shared/accounts';
import { formatUsd, microsToUsdText } from '@tailorit/shared/constants';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DatePickerPopover } from '@/components/ui/DatePickerPopover';
import { Field } from '@/components/ui/Field';
import { HelpTip } from '@/components/ui/HelpTip';
import { CalendarBlankIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Sheet, SheetContent } from '@/components/ui/Sheet';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import {
  addCredit,
  adminKeys,
  changeEntitlement,
  clearAiBudget,
  fetchAdminConstants,
  fetchUserHistory,
  setAiBudget,
  updateUser,
} from './api';
import { endOfDayIso, historyLines } from './users';
import { AdminDeleteAccount } from '@/features/account-deletion/AdminDeleteAccount'; // v34 ACCTDEL
import type { AccountDeletionState } from '@tailorit/shared/account-deletion'; // v34 ACCTDEL

// v2.0: Admin › Users › an account (docs/design/v2.0/08-ui.md, "Users"): 1. type and term, 2. the daily AI budget,
// 3. extra credit, 4. history, 5. role and sign-in. Every change goes through the entitlement and credit services
// (audited, source admin), shows a toast, and the sheet shows the account as the server answered it.

type BudgetMode = 'default' | 'custom' | 'unlimited';

function budgetModeOf(user: AdminUser): BudgetMode {
  if (!user.aiBudget) return 'default';
  return user.aiBudget.override === null ? 'unlimited' : 'custom';
}

export function UserSheet({
  user,
  isSelf,
  open,
  onOpenChange,
  onChanged,
  onDeleted,
}: {
  user: AdminUser;
  isSelf: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: (user: AdminUser) => void;
  /** v34 ACCTDEL: the account was deleted, or is being deleted (Delete account, the last section). */
  onDeleted?: (id: string, state: AccountDeletionState) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  // The plan's own numbers, for "Default ($0.10)" and "Extend 1 month" (admins read every constant).
  const constants = useQuery({ queryKey: adminKeys.constants, queryFn: ({ signal }) => fetchAdminConstants(signal), staleTime: 60_000 });
  const constant = (key: string) => constants.data?.items.find((row) => row.key === key)?.display ?? null;
  const term = constant('PAID_TERM');
  const defaultBudget = constant(user.effectiveType === 'paid' ? 'PAID_AI_DAILY_BUDGET_USD' : 'FREE_AI_DAILY_BUDGET_USD');

  const change = useMutation({
    mutationFn: async ({ run }: { run: () => Promise<AdminUser & { note?: string }>; done: string }) => run(),
    onSuccess: (answer, { done }) => {
      onChanged(answer);
      void queryClient.invalidateQueries({ queryKey: adminKeys.userHistory(user.id) });
      if (answer.note) toast.info(`${done}, with a note`, answer.note);
      else toast.success(done);
    },
    onError: (error) => toast.error('The account was not changed', userMessage(error)),
  });
  const run = (done: string, call: () => Promise<AdminUser & { note?: string }>) => change.mutate({ run: call, done });
  const busy = change.isPending;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent title={user.name || user.email} description={user.name ? user.email : undefined}>
        <div className="flex flex-col gap-8" data-user-sheet={user.id}>
          <SheetSection title="Type and term">
            <div className="flex flex-wrap items-center gap-3">
              <SegmentedControl<AccountType>
                aria-label="Account type"
                value={user.effectiveType}
                onValueChange={(accountType) =>
                  accountType !== user.effectiveType &&
                  run(accountType === 'paid' ? 'Changed to Paid' : 'Changed to Free', () => changeEntitlement(user.id, { accountType }))
                }
                items={[
                  { value: 'free', label: 'Free' },
                  { value: 'paid', label: 'Paid' },
                ]}
              />
              <span className="text-sm text-muted-foreground" data-paid-until="">
                {user.effectiveType === 'paid' && user.paidUntil ? `Paid until ${formatDate(user.paidUntil)}` : 'No Paid term'}
              </span>
            </div>
            <p className="mt-2 flex items-center gap-1.5 text-[13px] leading-5 text-muted-foreground">
              Term
              <HelpTip label="Term">
                Free → Paid with no end date gets one term{term ? ` (${term})` : ''}; Free ends the term now.
              </HelpTip>
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => run('Term extended', () => changeEntitlement(user.id, { extendTerms: 1 }))}
              >
                {term ? `Extend ${term}` : 'Extend 1 term'}
              </Button>
              <DatePickerPopover
                value={user.paidUntil ? new Date(user.paidUntil) : null}
                minDate={new Date()}
                aria-label="Paid until"
                onValueChange={(date) =>
                  date && run(`Paid until ${formatDate(date)}`, () => changeEntitlement(user.id, { paidUntil: endOfDayIso(date) }))
                }
              >
                <Button variant="outline" size="sm" disabled={busy} icon={<CalendarBlankIcon size={16} />}>
                  Set end date
                </Button>
              </DatePickerPopover>
            </div>
          </SheetSection>

          <BudgetSection
            key={JSON.stringify(user.aiBudget ?? null)}
            user={user}
            defaultBudget={defaultBudget}
            busy={busy}
            onDefault={() => run('Budget back to the default', () => clearAiBudget(user.id))}
            onUnlimited={() => run('Budget set to Unlimited', () => setAiBudget(user.id, { unlimited: true }))}
            onCustom={(usd) => run(`Budget set to $${usd.replace(/^\$/, '')} a day`, () => setAiBudget(user.id, { usd }))}
          />

          <CreditSection
            user={user}
            busy={busy}
            onSubmit={(body, done) => run(done, () => addCredit(user.id, body))}
          />

          <HistorySection userId={user.id} />

          <SheetSection title="Role and sign-in">
            <div className="flex flex-wrap items-center gap-6">
              <Field label="Role" className="w-40">
                <Select
                  options={[
                    { value: 'user', label: 'User' },
                    { value: 'admin', label: 'Admin' },
                  ]}
                  value={user.role}
                  disabled={busy}
                  onValueChange={(role) => role !== user.role && run('Role changed', () => updateUser(user.id, { role }))}
                />
              </Field>
              <Switch
                checked={!user.disabled}
                disabled={busy || user.beingDeleted === true} // v34 ACCTDEL: it stays off while being deleted
                label={user.disabled ? 'Cannot sign in' : 'Can sign in'}
                onCheckedChange={(enabled) =>
                  run(enabled ? 'Account enabled' : 'Account disabled', () => updateUser(user.id, { disabled: !enabled }))
                }
              />
            </div>
            {isSelf && <p className="mt-2 text-[13px] leading-5 text-muted-foreground">This is your own account.</p>}
          </SheetSection>

          {/* v34 ACCTDEL (PLAN G10): Delete account (never your own from here). */}
          {onDeleted && <AdminDeleteAccount user={user} isSelf={isSelf} onDeleted={onDeleted} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SheetSection({ title, help, children }: { title: string; help?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <div className="mb-3 flex items-center gap-1.5">
        <h3 className="text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">{title}</h3>
        {help ? <HelpTip label={title}>{help}</HelpTip> : null}
      </div>
      {children}
    </section>
  );
}

function BudgetSection({
  user,
  defaultBudget,
  busy,
  onDefault,
  onUnlimited,
  onCustom,
}: {
  user: AdminUser;
  defaultBudget: string | null;
  busy: boolean;
  onDefault: () => void;
  onUnlimited: () => void;
  onCustom: (usd: string) => void;
}) {
  const saved = budgetModeOf(user);
  const [mode, setMode] = useState<BudgetMode>(saved);
  const [usd, setUsd] = useState(user.aiBudget?.override != null ? microsToUsdText(user.aiBudget.override) : '');
  const [error, setError] = useState<string | null>(null);
  const saveCustom = (event: FormEvent) => {
    event.preventDefault();
    const parsed = UsdTextSchema.safeParse(usd);
    if (!parsed.success) {
      setError('Enter a daily amount in dollars, such as 0.25 (at most 6 decimal places)');
      return;
    }
    setError(null);
    onCustom(parsed.data);
  };
  return (
    <SheetSection title="Daily AI budget" help="What AI may spend for this account each day before extra credit; the person sees only a percent.">
      <RadioGroup<BudgetMode>
        aria-label="Daily AI budget"
        value={mode}
        disabled={busy}
        onValueChange={(next) => {
          setMode(next);
          if (next === 'default' && saved !== 'default') onDefault();
          if (next === 'unlimited' && saved !== 'unlimited') onUnlimited();
        }}
        options={[
          { value: 'default', label: `Default${defaultBudget ? ` (${defaultBudget}, ${user.effectiveType === 'paid' ? 'Paid' : 'Free'})` : ''}` },
          { value: 'custom', label: 'Custom' },
          { value: 'unlimited', label: 'Unlimited' },
        ]}
      />
      {mode === 'custom' && (
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={saveCustom} noValidate>
          <Field label="Dollars a day" error={error} className="w-44">
            <Input
              inputMode="decimal"
              value={usd}
              leading={<span aria-hidden="true">$</span>}
              className="pl-7"
              placeholder="0.25"
              onChange={(event) => {
                setUsd(event.target.value);
                setError(null);
              }}
            />
          </Field>
          <Button type="submit" size="md" variant="outline" loading={busy}>
            Save budget
          </Button>
        </form>
      )}
    </SheetSection>
  );
}

function CreditSection({
  user,
  busy,
  onSubmit,
}: {
  user: AdminUser;
  busy: boolean;
  onSubmit: (body: { usd: string; kind: 'grant' | 'adjustment'; note?: string }, done: string) => void;
}) {
  const [kind, setKind] = useState<'grant' | 'adjustment'>('grant');
  const [usd, setUsd] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = AdminCreditBodySchema.safeParse({ usd, kind, note: note.trim() || undefined });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter an amount in dollars');
      return;
    }
    setError(null);
    onSubmit(parsed.data, kind === 'grant' ? `Added $${parsed.data.usd.replace(/^\$/, '')} of credit` : 'Credit adjusted');
    setUsd('');
    setNote('');
  };
  return (
    <SheetSection title="Extra credit">
      <p className="text-sm text-foreground">
        Balance <strong className="tabular-nums" data-credit-balance="">{formatUsd(user.extraCreditMicros)}</strong>
      </p>
      <form className="mt-3 flex flex-col gap-3" onSubmit={submit} noValidate>
        <SegmentedControl
          size="sm"
          aria-label="Credit change"
          value={kind}
          onValueChange={(next) => {
            setKind(next);
            setError(null);
          }}
          items={[
            { value: 'grant', label: 'Add credit' },
            { value: 'adjustment', label: 'Adjust' },
          ]}
        />
        <div className="flex flex-wrap items-end gap-2">
          <Field
            label={kind === 'grant' ? 'Amount' : 'Amount (+ or -)'}
            error={error}
            hint={kind === 'adjustment' ? 'The balance never goes below $0.' : undefined}
            className="w-44"
          >
            <Input
              inputMode="decimal"
              value={usd}
              placeholder={kind === 'grant' ? '5.00' : '-1.25'}
              onChange={(event) => {
                setUsd(event.target.value);
                setError(null);
              }}
            />
          </Field>
          <Field label="Note" optional className="min-w-0 flex-1 basis-48">
            <Input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
          </Field>
          <Button type="submit" variant="outline" loading={busy}>
            {kind === 'grant' ? 'Add credit' : 'Adjust credit'}
          </Button>
        </div>
      </form>
    </SheetSection>
  );
}

function HistorySection({ userId }: { userId: string }) {
  const now = useNow();
  const history = useInfiniteQuery({
    queryKey: adminKeys.userHistory(userId),
    queryFn: ({ pageParam, signal }) => fetchUserHistory(userId, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
  const lines = historyLines({
    events: history.data?.pages.flatMap((page) => page.events) ?? [],
    credit: history.data?.pages.flatMap((page) => page.credit) ?? [],
  });
  return (
    <SheetSection title="History">
      {history.isError ? (
        <Notice tone="error">{userMessage(history.error)}</Notice>
      ) : history.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </div>
      ) : lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">No changes yet.</p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-divider-soft rounded-card border border-border">
            {lines.map((line) => (
              <li key={line.id} className="flex flex-col gap-0.5 px-3 py-2.5 text-sm leading-5">
                <span className="text-foreground">{line.text}</span>
                <span className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground">
                  <Badge tone="outline">{line.source}</Badge>
                  {line.by !== line.source && <span>{line.by}</span>}
                  <span title={formatDate(line.at)}>{relativeTime(line.at, now)}</span>
                </span>
                {line.note && <span className="text-[13px] text-muted-foreground">“{line.note}”</span>}
              </li>
            ))}
          </ul>
          {history.hasNextPage && (
            <Button variant="ghost" size="sm" className="mt-2" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
              Show older changes
            </Button>
          )}
        </>
      )}
    </SheetSection>
  );
}
