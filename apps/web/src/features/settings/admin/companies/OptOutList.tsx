'use client';

import { RegistrableDomainSchema, type AdminOptOut } from '@tailorit/shared/companies';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { AdminResourceTab, ShowMoreButton, type AdminColumn } from '@/components/admin';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { PlusIcon } from '@/components/ui/icons';
import { Input, Textarea } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { useToast } from '@/components/ui/Toast';
import { Tooltip } from '@/components/ui/Tooltip';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { formatDate } from '@/lib/format';
import { ProhibitIcon } from '@/features/companies/icons';
import { addOptOut, companiesAdminKeys, fetchOptOuts, removeOptOut } from './api';
import { OPT_OUT_REASON_MAX } from './CompanyActions';

// v30 E0-WEB: the opt-out list (13-company-enrichment.md §4 rule 6; 11-database.md §5.3a crawl_opt_outs): registrable
// domains that neither reader (company websites, career pages) ever reads. An opted-out company's domains land here;
// an admin adds a domain when a site asks to be left alone, and can take one off again.

/** What the add form checks before it asks: a registrable domain in lower case, and a reason. */
export function checkOptOutForm(domain: string, reason: string, tooLong: (max: number) => string): { domain?: string; reason?: string } {
  const errors: { domain?: string; reason?: string } = {};
  if (!RegistrableDomainSchema.safeParse(domain).success) errors.domain = 'Enter a domain such as acme.com, without https:// or a path.';
  if (!reason.trim()) errors.reason = 'Say why the domain is never read.';
  else if (reason.trim().length > OPT_OUT_REASON_MAX) errors.reason = tooLong(OPT_OUT_REASON_MAX);
  return errors;
}

export function OptOutList({ viewSwitch, onOpenCompany }: { viewSwitch: ReactNode; onOpenCompany: (companyId: number) => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AdminOptOut | null>(null);

  const optOuts = useInfiniteQuery({
    queryKey: companiesAdminKeys.optOuts,
    queryFn: ({ pageParam, signal }) => fetchOptOuts(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = optOuts.data?.pages.flatMap((page) => page.items);

  const columns: AdminColumn<AdminOptOut>[] = [
    { key: 'domain', header: 'Domain', className: 'w-56', cell: (row) => <span className="font-semibold break-all">{row.domain}</span> },
    {
      key: 'company',
      header: 'Company',
      className: 'w-48',
      cell: (row) =>
        row.companyId !== null ? (
          <button type="button" onClick={() => onOpenCompany(row.companyId!)} className="text-left font-medium hover:underline">
            {row.companyName ?? `Company ${row.companyId}`}
          </button>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
    { key: 'reason', header: 'Reason', cell: (row) => <span className="line-clamp-3 break-words">{row.reason}</span> },
    {
      key: 'added',
      header: 'Added',
      className: 'w-48',
      cell: (row) => (
        <div className="min-w-0 text-[13px]">
          <Tooltip content={new Date(row.createdAt).toLocaleString('en-US')}>
            <p>{formatDate(row.createdAt)}</p>
          </Tooltip>
          {row.createdBy && <p className="truncate text-muted-foreground">{`by ${row.createdBy}`}</p>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      className: 'w-32 text-right',
      cell: (row) => (
        // v30 FIX-WEB (REV-UX UX-9): the name starts with the visible words (WCAG 2.5.3, Label in Name).
        <Button size="sm" variant="ghost" onClick={() => setRemoving(row)} aria-label={`Take off: ${row.domain}`}>
          Take off
        </Button>
      ),
    },
  ];

  return (
    <AdminResourceTab
      title="Opt-out list"
      description="Domains neither reader ever reads: company websites and career pages. An opted-out company's domains land here; add a domain when a site asks to be left alone."
      actions={
        <>
          {viewSwitch}
          <Button size="sm" icon={<PlusIcon size={14} />} onClick={() => setAdding(true)}>
            Add domain
          </Button>
        </>
      }
      items={items}
      error={optOuts.error}
      errorTitle="The opt-out list could not be loaded"
      errorAction={
        <Button variant="outline" size="sm" onClick={() => void optOuts.refetch()}>
          Try again
        </Button>
      }
      empty={{ icon: <ProhibitIcon size={22} />, title: 'No domain is opted out', description: "Domains added here, or by a company's opt-out, are never read." }}
      tableLabel="Opted-out domains"
      columns={columns}
      getKey={(row) => row.domain}
      footer={
        // v30 FIX-WEB (UX-4): focus stays on the button while the next page loads.
        <ShowMoreButton hasMore={optOuts.hasNextPage} loading={optOuts.isFetchingNextPage} onMore={() => void optOuts.fetchNextPage()} afterLast={['table[aria-label="Opted-out domains"] tbody tr:last-of-type button', 'table[aria-label="Opted-out domains"] tbody tr:last-of-type [role="checkbox"]']}>
          Show more domains
        </ShowMoreButton>
      }
    >
      <AddOptOutDialog
        open={adding}
        onOpenChange={setAdding}
        onAdded={(row) => {
          toast.success(`${row.domain} is never read`);
          void queryClient.invalidateQueries({ queryKey: companiesAdminKeys.optOuts });
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Take ${removing?.domain ?? ''} off the opt-out list?`}
        description="The readers may read the domain again where their own switches allow it. A company's opt-out switch stays as it is."
        confirmLabel="Take off"
        busyLabel="Taking off…"
        onConfirm={async () => {
          if (!removing) return;
          await removeOptOut(removing.domain);
          toast.success(`${removing.domain} is off the opt-out list`);
          void queryClient.invalidateQueries({ queryKey: companiesAdminKeys.optOuts });
        }}
      />
    </AdminResourceTab>
  );
}

function AddOptOutDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: (row: AdminOptOut) => void }) {
  const { t } = usePublicConstants();
  const [domain, setDomain] = useState('');
  const [reason, setReason] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [errors, setErrors] = useState<{ domain?: string; reason?: string; companyId?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setDomain('');
      setReason('');
      setCompanyId('');
      setErrors({});
      setFailure(null);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found: { domain?: string; reason?: string; companyId?: string } = checkOptOutForm(domain.trim().toLowerCase(), reason, (max) =>
      t('MSG_TEXT_TOO_LONG', { max }),
    );
    if (companyId.trim() && !/^\d{1,15}$/.test(companyId.trim())) found.companyId = 'Enter a company id, or leave it empty.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setFailure(null);
    try {
      const row = await addOptOut({
        domain: domain.trim().toLowerCase(),
        reason: reason.trim(),
        ...(companyId.trim() ? { companyId: Number(companyId.trim()) } : {}),
      });
      onAdded(row);
      close(false);
    } catch (error) {
      setFailure(userMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title="Add a domain to the opt-out list" description="Neither reader will ever read it." size="md">
        <form onSubmit={(event) => void submit(event)} className="mt-5 flex flex-col gap-4" noValidate>
          <Field label="Domain" error={errors.domain} hint="The registrable domain: acme.com covers careers.acme.com too.">
            <Input value={domain} autoComplete="off" spellCheck={false} onChange={(event) => setDomain(event.target.value)} />
          </Field>
          <Field label="Reason" error={errors.reason}>
            <Textarea value={reason} rows={3} maxLength={OPT_OUT_REASON_MAX} onChange={(event) => setReason(event.target.value)} />
          </Field>
          <Field label="Company id" optional error={errors.companyId}>
            <Input value={companyId} inputMode="numeric" onChange={(event) => setCompanyId(event.target.value)} wrapperClassName="w-40" />
          </Field>
          {failure && <Notice tone="error">{failure}</Notice>}
          <DialogFooter flush>
            <Button variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              Add domain
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
