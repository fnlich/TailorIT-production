'use client';

import {
  COMPANY_STRONG_ALIAS_KINDS,
  type AdminCompany,
  type CompanyEnrichmentStep,
  type CompanyProfileField,
} from '@tailorit/shared/companies';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { ArrowSquareOutIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Sheet, SheetContent } from '@/components/ui/Sheet';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { usePublicConstants, type TooLongText } from '@/lib/constants';
import { formatDate } from '@/lib/format';
import { companyKeys } from '@/features/companies/api';
import { companyHref } from '@/features/companies/routes';
import {
  companiesAdminKeys,
  editAdminCompany,
  fetchAdminCompany,
  mergeAdminCompany,
  refreshAdminCompany,
  removeAdminCompanyLogo,
  setAdminCompanyOptOut,
  splitAdminCompany,
  uploadAdminCompanyLogo,
} from './api';
import { EditorSection, LogoSection, MergeSection, OptOutSection, RefreshSection, SplitSection } from './CompanyActions';
import { FIELD_GROUPS, FIELD_SPECS, fieldsOf, setBody, sourceKindLabel } from './fields';
import { FieldRow } from './FieldRow';

// v30 E0-WEB: Admin › Companies › a company (13-company-enrichment.md §6.4): each field with its value, source,
// confidence and the other candidates, with lock and unlock; the keys and sources behind it; parents and children;
// Refresh now; merge and split; the opt-out switch. Every change shows the company as the server answered it.

const STRONG = new Set<string>(COMPANY_STRONG_ALIAS_KINDS);

export function CompanyEditor({
  companyId,
  open,
  onOpenChange,
  onOpenCompany,
}: {
  companyId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens another company in the editor (a merge's survivor, a split's new company, a parent). */
  onOpenCompany: (companyId: number) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = usePublicConstants();
  const tooLong = useCallback<TooLongText>((max) => t('MSG_TEXT_TOO_LONG', { max }), [t]);
  const company = useQuery({
    queryKey: companiesAdminKeys.company(companyId),
    queryFn: ({ signal }) => fetchAdminCompany(companyId, signal),
    enabled: open,
  });
  const [busy, setBusy] = useState(false);

  /** The server's answer goes into the editor, the lists and the company page at once. */
  const apply = (answer: AdminCompany) => {
    queryClient.setQueryData(companiesAdminKeys.company(answer.id), answer);
    void queryClient.invalidateQueries({ queryKey: companiesAdminKeys.lists });
    void queryClient.invalidateQueries({ queryKey: companyKeys.page(answer.id) });
  };

  /** Runs one change: the busy state, the toast, and the error's toast (rethrown for a dialog that shows it). */
  const run = async <T,>(call: () => Promise<T>, done: (answer: T) => string, rethrow = false): Promise<T | undefined> => {
    setBusy(true);
    try {
      const answer = await call();
      toast.success(done(answer));
      return answer;
    } catch (error) {
      if (rethrow) throw error;
      toast.error('The company was not changed', userMessage(error));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const data = company.data;
  const title = data?.name ?? 'Company';

  const saveField = async (field: CompanyProfileField, value: unknown) => {
    const answer = await run(() => editAdminCompany(companyId, setBody(field, value)), () => `${FIELD_SPECS[field].label} saved and locked`, true);
    if (answer) apply(answer);
  };
  const lockField = (field: CompanyProfileField, locked: boolean) =>
    void run(
      () => editAdminCompany(companyId, locked ? { lock: [field] } : { unlock: [field] }),
      () => (locked ? `${FIELD_SPECS[field].label} locked` : `${FIELD_SPECS[field].label} handed back to its sources`),
    ).then((answer) => answer && apply(answer));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={title}
        description={data ? `Company ${data.id}${data.profile.domain ? ` · ${data.profile.domain}` : ''}` : undefined}
        wrapTitle
        headerActions={
          data && (
            <Link href={companyHref(data.id)} target="_blank" rel="noopener noreferrer" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
              Company page
              <ArrowSquareOutIcon size={12} aria-hidden />
              <span className="sr-only"> (opens in a new tab)</span>
            </Link>
          )
        }
      >
        {company.error && !data ? (
          <Notice
            tone="error"
            title="The company could not be loaded"
            action={
              <Button variant="outline" size="sm" onClick={() => void company.refetch()}>
                Try again
              </Button>
            }
          >
            {userMessage(company.error)}
          </Notice>
        ) : !data ? (
          <div className="flex flex-col gap-4" aria-busy="true">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-6" data-company-editor={data.id}>
            {data.mergedIntoId !== null && (
              <Notice
                tone="warning"
                title={`Merged into company ${data.mergedIntoId}`}
                action={
                  <Button variant="outline" size="sm" onClick={() => onOpenCompany(data.mergedIntoId!)}>
                    Open it
                  </Button>
                }
              >
                Its jobs and links follow that company.
              </Notice>
            )}
            {data.doNotFetch && (
              <Notice tone="warning" title="Opted out">
                No outside lookup reads this company; its domains are on the opt-out list.
              </Notice>
            )}
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4" aria-label="At a glance">
              <Glance label="Open jobs" value={data.counts.openJobs.toLocaleString('en-US')} />
              <Glance label="Closed jobs" value={data.counts.closedJobs.toLocaleString('en-US')} />
              <Glance label="Open reviews" value={data.openReviews.toLocaleString('en-US')} />
              <Glance label="Next refresh" value={data.nextRefreshAt ? formatDate(data.nextRefreshAt) : 'Not planned'} />
            </dl>

            <LogoSection
              company={data}
              busy={busy}
              onUpload={async (file) => {
                const answer = await run(() => uploadAdminCompanyLogo(companyId, file), () => 'Logo stored');
                if (answer) apply(answer);
              }}
              onRemove={async () => {
                const answer = await run(() => removeAdminCompanyLogo(companyId), () => 'Logo removed');
                if (answer) apply(answer);
              }}
            />

            {FIELD_GROUPS.map((group) => {
              const entries = fieldsOf(group.id)
                .map((field) => data.fields.find((entry) => entry.field === field))
                .filter((entry) => entry !== undefined);
              if (entries.length === 0) return null;
              return (
                <EditorSection key={group.id} title={group.title}>
                  <ul className="divide-y divide-border" aria-label={group.title}>
                    {entries.map((entry) => (
                      <FieldRow
                        key={entry.field}
                        entry={entry}
                        busy={busy}
                        tooLong={tooLong}
                        onSave={(value) => saveField(entry.field, value)}
                        onLock={(locked) => lockField(entry.field, locked)}
                      />
                    ))}
                  </ul>
                </EditorSection>
              );
            })}

            <RelationsSection company={data} onOpenCompany={onOpenCompany} />
            <AliasesSection company={data} />
            <SourcesSection company={data} />
            <SplitSection
              company={data}
              busy={busy}
              tooLong={tooLong}
              onSplit={async (sourceIds, name) => {
                const made = await run(() => splitAdminCompany(companyId, { sourceIds, name }), () => `Moved to ${name}`, true);
                void company.refetch();
                void queryClient.invalidateQueries({ queryKey: companiesAdminKeys.lists });
                if (made) {
                  toast.toast({ title: `${name} is company ${made.id}`, type: 'info', action: { label: 'Open it', onClick: () => onOpenCompany(made.id) } });
                }
              }}
            />
            <MergeSection
              company={data}
              busy={busy}
              onMerge={async (otherId) => {
                const answer = await run(() => mergeAdminCompany(companyId, { otherId }), () => `Company ${otherId} merged into ${data.name}`, true);
                if (answer) apply(answer);
              }}
            />
            <RefreshSection
              busy={busy}
              onRefresh={async (steps: CompanyEnrichmentStep[]) => {
                await run(
                  () => refreshAdminCompany(companyId, steps.length > 0 ? { steps } : {}),
                  () => 'Refresh queued',
                );
                void company.refetch();
              }}
            />
            <OptOutSection
              company={data}
              busy={busy}
              tooLong={tooLong}
              onChange={async (doNotFetch, reason) => {
                const answer = await run(
                  () => setAdminCompanyOptOut(companyId, { doNotFetch, reason }),
                  () => (doNotFetch ? `${data.name} opted out` : `${data.name} taken off the opt-out`),
                  true,
                );
                if (answer) apply(answer);
                void queryClient.invalidateQueries({ queryKey: companiesAdminKeys.optOuts });
              }}
            />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Glance({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[13px] leading-5 text-muted-foreground">{label}</dt>
      <dd className="text-sm leading-5 font-semibold text-foreground tabular-nums">{value}</dd>
    </div>
  );
}

/** Parents and children (company_relations): kept apart, never merged; each opens in the editor. */
function RelationsSection({ company, onOpenCompany }: { company: AdminCompany; onOpenCompany: (companyId: number) => void }) {
  const rows = [
    ...company.parents.map((relation) => ({ ...relation, side: 'Part of' })),
    ...company.children.map((relation) => ({ ...relation, side: 'Owns' })),
  ];
  if (rows.length === 0) return null;
  return (
    <EditorSection title="Parents and subsidiaries" description="Kept apart, never merged: a subsidiary keeps its own jobs and profile.">
      <ul className="flex flex-col gap-2" aria-label="Parents and subsidiaries">
        {rows.map((relation) => (
          <li key={`${relation.side}-${relation.company.id}`} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{relation.side}</span>
            <button type="button" onClick={() => onOpenCompany(relation.company.id)} className="font-medium text-primary-ink hover:underline">
              {relation.company.name}
            </button>
            <Badge tone="neutral">{relation.kind}</Badge>
            <span className="text-xs text-muted-foreground">{relation.confidence}% sure</span>
          </li>
        ))}
      </ul>
    </EditorSection>
  );
}

/** The keys that point at the company (company_aliases); a strong key points at this company only. */
function AliasesSection({ company }: { company: AdminCompany }) {
  return (
    <EditorSection title="Keys" description="What points at this company: boards, domains and registry ids are strong (one company each); names are weak (several companies may share one).">
      {company.aliases.length === 0 ? (
        <p className="text-sm text-muted-foreground">No keys yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-control border border-border" aria-label="Keys">
          {company.aliases.map((alias) => (
            <li key={`${alias.kind}:${alias.value}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm" data-company-alias={alias.kind}>
              <span className="min-w-0 break-all">
                <span className="font-medium text-foreground">{alias.value}</span>
                <span className="ml-2 text-xs text-muted-foreground">{alias.kind.replace(/_/g, ' ')}</span>
              </span>
              <span className="flex items-center gap-2">
                {STRONG.has(alias.kind) && <Badge tone="tint">Strong</Badge>}
                {alias.isPrimary && <Badge tone="neutral">Primary</Badge>}
                <span className="text-xs text-muted-foreground tabular-nums">{alias.confidence}%</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </EditorSection>
  );
}

const SOURCE_STATUS_TONE = { ok: 'success', not_found: 'neutral', blocked: 'warning', robots_disallowed: 'warning', error: 'destructive' } as const;
const SOURCE_STATUS_LABEL = { ok: 'Read', not_found: 'Not found', blocked: 'Blocked', robots_disallowed: 'Robots disallow', error: 'Failed' } as const;

/** Every source's answer (company_sources): its kind, reference, licence, how it went and when. */
function SourcesSection({ company }: { company: AdminCompany }) {
  return (
    <EditorSection title="Sources" description="Each source's last answer for this company, with its licence. A field above names the source it came from.">
      {company.sources.length === 0 ? (
        <p className="text-sm text-muted-foreground">No source has been read yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-control border border-border" aria-label="Sources">
          {company.sources.map((source) => (
            <li key={source.id} className="flex flex-col gap-1 px-3 py-2.5 text-sm" data-company-source={source.id}>
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-foreground">{sourceKindLabel(source.kind)}</span>
                <Badge tone={SOURCE_STATUS_TONE[source.status]}>{SOURCE_STATUS_LABEL[source.status]}</Badge>
              </span>
              {source.ref && <span className="text-xs break-all text-muted-foreground">{source.ref}</span>}
              <span className="text-xs text-muted-foreground">
                Licence {source.licence.replace(/_/g, ' ')} · match {source.matchConfidence}% · read {formatDate(source.retrievedAt)}
                {source.expiresAt ? ` · expires ${formatDate(source.expiresAt)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </EditorSection>
  );
}
