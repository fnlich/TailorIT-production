'use client';

import { COMPANY_ENRICHMENT_STEPS, type AdminCompany, type AdminCompanyRow, type CompanyEnrichmentStep } from '@tailorit/shared/companies';
import { ADMIN_BULK_MAX } from '@tailorit/shared/reviews';
import { JOB_SOURCE_KIND_LABEL } from '@tailorit/shared/sourcing';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Field } from '@/components/ui/Field';
import { ArrowsClockwiseIcon } from '@/components/ui/icons';
import { Input, Textarea } from '@/components/ui/Input';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { Switch } from '@/components/ui/Switch';
import { ApiError } from '@/lib/api';
import type { TooLongText } from '@/lib/constants';
import { ArrowsMergeIcon, ArrowsSplitIcon } from '@/features/companies/icons';
import { CompanyLogo } from '@/features/jobs/CompanyLogo';
import { companiesAdminKeys, fetchAdminCompanies, fetchAdminCompany } from './api';
import { sourceKindLabel } from './fields';

// v30 E0-WEB: the company editor's actions (13-company-enrichment.md §5.5, §6.4, §4 rule 6): Refresh now, merge another
// company into this one, split chosen boards off to a new company, and the opt-out switch. Each that moves jobs or
// purges asks first.

/** The opt-out reason's cap: AdminCompanyOptOutBodySchema's, which crawl_opt_outs.reason checks too (a schema cap). */
export const OPT_OUT_REASON_MAX = 500;
/** A split's new name's cap: AdminCompanySplitBodySchema's (a schema cap). */
export const SPLIT_NAME_MAX = 300;

export function EditorSection({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-t border-border pt-6">
      <h3 className="text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">{title}</h3>
      {description && <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** The raster images an uploaded logo may be (the server re-encodes it and refuses an SVG: 13 §4 rule 7). */
export const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

/** The stored logo: upload one (TailorIT serves its own copy, never a remote address) or remove it. */
export function LogoSection({
  company,
  busy,
  onUpload,
  onRemove,
}: {
  company: AdminCompany;
  busy: boolean;
  onUpload: (file: File) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const logo = company.profile.logoUrl;
  return (
    <EditorSection title="Logo" description="An uploaded logo is stored and served by TailorIT, and locked: no source replaces it.">
      <div className="flex flex-wrap items-center gap-4">
        <CompanyLogo name={company.name} url={logo} size={48} />
        <input
          ref={input}
          type="file"
          accept={LOGO_ACCEPT}
          className="hidden"
          aria-label={`Logo file for ${company.name}`}
          data-company-logo-input=""
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void onUpload(file);
          }}
        />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>
          {logo ? 'Replace logo' : 'Upload logo'}
        </Button>
        {logo && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onRemove()}>
            Remove logo
          </Button>
        )}
      </div>
    </EditorSection>
  );
}

/** Refresh now: the chosen enrichment steps (every step due, when none is ticked). */
export function RefreshSection({ busy, onRefresh }: { busy: boolean; onRefresh: (steps: CompanyEnrichmentStep[]) => Promise<void> }) {
  const [steps, setSteps] = useState<CompanyEnrichmentStep[]>([]);
  return (
    <EditorSection
      title="Refresh now"
      description="Reads the company's sources again at once. Leave every box empty to read each source that is due. Sources that are switched off stay off."
    >
      <div className="flex flex-wrap gap-x-5 gap-y-2" role="group" aria-label="Sources to read again">
        {COMPANY_ENRICHMENT_STEPS.map((step) => (
          <Checkbox
            key={step}
            label={sourceKindLabel(step)}
            checked={steps.includes(step)}
            onCheckedChange={(checked) => setSteps((current) => (checked ? [...current, step] : current.filter((item) => item !== step)))}
          />
        ))}
      </div>
      <Button
        className="mt-3"
        size="sm"
        variant="outline"
        icon={<ArrowsClockwiseIcon size={14} />}
        disabled={busy}
        onClick={() => void onRefresh(steps).then(() => setSteps([]))}
      >
        {steps.length > 0 ? `Refresh ${steps.length} ${steps.length === 1 ? 'source' : 'sources'}` : 'Refresh every source due'}
      </Button>
    </EditorSection>
  );
}

/** v30 FIX-WEB (REV-UX UX-6): the other company of a merge, as the search shows it and the confirm names it. */
export interface MergePick {
  id: number;
  name: string;
  domain: string | null;
  openJobs: number;
}

/** The confirm's title: both companies by name ("Merge Proseware Systems (company 23) into Northwind Robotics?"). */
export function mergeTitle(other: Pick<MergePick, 'id' | 'name'>, into: { name: string }): string {
  return `Merge ${other.name} (company ${other.id}) into ${into.name}?`;
}

/** What a merge moves, and what a split cannot move back. */
export function mergeDescription(other: Pick<MergePick, 'name' | 'openJobs'>): string {
  const jobs = `${other.openJobs.toLocaleString('en-US')} open ${other.openJobs === 1 ? 'job' : 'jobs'}`;
  return `${other.name}'s ${jobs}, its applications, sources and keys move to this company. A split can move boards back later, but not jobs that came without a board (imports, page jobs).`;
}

/** A search's answer as picks: neither this company nor one merged into another already. */
export function mergePicks(rows: readonly AdminCompanyRow[], selfId: number): MergePick[] {
  return rows
    .filter((row) => row.id !== selfId && row.mergedIntoId === null)
    .map((row) => ({ id: row.id, name: row.name, domain: row.domain, openJobs: row.openJobs }));
}

/** "company 23 · proseware.com · 4 open jobs": a pick's second line. */
export function mergePickLine(pick: MergePick): string {
  return [`company ${pick.id}`, pick.domain, `${pick.openJobs.toLocaleString('en-US')} open ${pick.openJobs === 1 ? 'job' : 'jobs'}`]
    .filter(Boolean)
    .join(' · ');
}

const MERGE_SEARCH_DELAY_MS = 300;
const MERGE_PICKS = 8;

/**
 * Merge another company into this one. v30 FIX-WEB (REV-UX UX-6): the other company is picked by name (or its id) from
 * the admin's own company search, never typed as a bare number; the confirm names both companies, and an id that names
 * no company is refused before it.
 */
export function MergeSection({ company, busy, onMerge }: { company: AdminCompany; busy: boolean; onMerge: (otherId: number) => Promise<void> }) {
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<MergePick | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(draft.trim()), MERGE_SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft]);
  const byId = /^\d{1,15}$/.test(q) ? Number(q) : null;
  const one = useQuery({
    queryKey: [...companiesAdminKeys.company(byId ?? 0), 'merge-pick'],
    queryFn: ({ signal }) => fetchAdminCompany(byId!, signal),
    enabled: byId !== null && byId !== company.id,
    retry: false,
  });
  const found = useQuery({
    queryKey: [...companiesAdminKeys.list(q, 'all'), 'merge-picks'],
    queryFn: ({ signal }) => fetchAdminCompanies({ q, filter: 'all', limit: MERGE_PICKS }, signal),
    enabled: byId === null && q.length >= 2,
  });
  const picks: MergePick[] =
    byId !== null
      ? one.data && one.data.mergedIntoId === null && one.data.id !== company.id
        ? [{ id: one.data.id, name: one.data.name, domain: one.data.profile.domain ?? null, openJobs: one.data.counts.openJobs }]
        : []
      : mergePicks(found.data?.items ?? [], company.id);
  const settled = byId !== null ? one.isFetched && !one.isFetching : found.isFetched && !found.isFetching;
  const problem =
    byId === company.id
      ? 'That is this company. Enter another company.'
      : byId !== null && one.isError
        ? `There is no company ${byId}.`
        : byId !== null && one.data && one.data.mergedIntoId !== null
          ? `Company ${byId} is merged into company ${one.data.mergedIntoId} already.`
          : q.length >= 2 && settled && picks.length === 0
            ? 'No other company matches.'
            : undefined;
  const pick = chosen && picks.some((item) => item.id === chosen.id) ? chosen : null;

  return (
    <EditorSection
      title="Merge another company into this one"
      description="Its jobs, applications, sources and keys move here; the other company keeps a pointer, so its old links still open this one."
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (pick) setConfirming(true);
        }}
      >
        <Field label="Find the other company" hint="Its name, domain or company id." error={problem} className="max-w-md">
          <Input
            type="search"
            value={draft}
            autoComplete="off"
            onChange={(event) => {
              setDraft(event.target.value);
              setChosen(null);
            }}
            data-merge-search=""
          />
        </Field>
        {picks.length > 0 && (
          <RadioGroup<string>
            aria-label="The company to merge into this one"
            options={picks.map((item) => ({ value: String(item.id), label: item.name, description: mergePickLine(item) }))}
            value={pick ? String(pick.id) : null}
            onValueChange={(value) => setChosen(picks.find((item) => String(item.id) === value) ?? null)}
          />
        )}
        <div>
          <Button type="submit" size="sm" variant="outline" icon={<ArrowsMergeIcon size={14} />} disabled={busy || pick === null}>
            {pick ? `Merge ${pick.name} into ${company.name}` : `Merge into ${company.name}`}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirming && pick !== null}
        onOpenChange={setConfirming}
        title={pick ? mergeTitle(pick, company) : ''}
        description={pick ? mergeDescription(pick) : undefined}
        confirmLabel="Merge"
        busyLabel="Merging…"
        onConfirm={async () => {
          if (!pick) return;
          await onMerge(pick.id);
          setDraft('');
          setChosen(null);
        }}
      />
    </EditorSection>
  );
}

/** Split: move the chosen boards and their jobs to a new company. */
export function SplitSection({
  company,
  busy,
  tooLong,
  onSplit,
}: {
  company: AdminCompany;
  busy: boolean;
  tooLong: TooLongText;
  onSplit: (sourceIds: number[], name: string) => Promise<void>;
}) {
  const [chosen, setChosen] = useState<number[]>([]);
  const [name, setName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const nameError = name.trim().length > SPLIT_NAME_MAX ? tooLong(SPLIT_NAME_MAX) : undefined;
  const ready = chosen.length > 0 && chosen.length <= ADMIN_BULK_MAX && name.trim() !== '' && !nameError;

  if (company.boards.length === 0) {
    return (
      <EditorSection title="Boards" description="The job sources that list this company's jobs.">
        <p className="text-sm text-muted-foreground">{"No board lists this company's jobs."}</p>
      </EditorSection>
    );
  }
  return (
    <EditorSection
      title="Boards"
      description="The job sources that list this company's jobs. To split a board that belongs to another employer off to a new company, tick it and name the new company."
    >
      <ul className="flex flex-col divide-y divide-divider-soft rounded-card border border-border" aria-label="Boards">
        {company.boards.map((board) => (
          <li key={board.sourceId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5" data-company-board={board.sourceId}>
            <Checkbox
              label={
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">{board.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {JOB_SOURCE_KIND_LABEL[board.kind]} · {board.openJobs.toLocaleString('en-US')} open {board.openJobs === 1 ? 'job' : 'jobs'}
                  </span>
                </span>
              }
              checked={chosen.includes(board.sourceId)}
              onCheckedChange={(checked) =>
                setChosen((current) => (checked ? [...current, board.sourceId] : current.filter((id) => id !== board.sourceId)))
              }
            />
            {!board.enabled && <Badge tone="neutral">Off</Badge>}
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) setConfirming(true);
        }}
      >
        <Field label="New company's name" error={nameError} className="min-w-0 flex-1 basis-60">
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Button type="submit" size="sm" variant="outline" icon={<ArrowsSplitIcon size={14} />} disabled={busy || !ready}>
          {chosen.length > 0 ? `Move ${chosen.length} ${chosen.length === 1 ? 'board' : 'boards'} to a new company` : 'Move to a new company'}
        </Button>
      </form>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Move ${chosen.length} ${chosen.length === 1 ? 'board' : 'boards'} to ${name.trim()}?`}
        description="The boards and their jobs leave this company for a new one of that name."
        confirmLabel="Move"
        busyLabel="Moving…"
        onConfirm={async () => {
          await onSplit(chosen, name.trim());
          setChosen([]);
          setName('');
        }}
      />
    </EditorSection>
  );
}

/** The opt-out switch, with its reason (kept beside the domains on the opt-out list). */
export function OptOutSection({
  company,
  busy,
  tooLong,
  onChange,
}: {
  company: AdminCompany;
  busy: boolean;
  tooLong: TooLongText;
  onChange: (doNotFetch: boolean, reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState<boolean | null>(null);
  const reasonError = reason.trim().length > OPT_OUT_REASON_MAX ? tooLong(OPT_OUT_REASON_MAX) : undefined;
  const next = !company.doNotFetch;
  return (
    <EditorSection
      title="Opt-out"
      description="An opted-out company is never looked up anywhere: its domains go on the opt-out list, its job sources are switched off and their jobs purged, and discovery refuses its boards."
    >
      <Switch
        checked={company.doNotFetch}
        disabled={busy}
        label={company.doNotFetch ? 'Opted out' : 'Not opted out'}
        onCheckedChange={() => setConfirming(next)}
      />
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={confirming ? `Opt ${company.name} out?` : `Take ${company.name} off the opt-out?`}
        description={
          confirming
            ? "Its domains go on the opt-out list; its job sources are switched off and their jobs purged (applied jobs keep their text). Switching back later does not bring the purged jobs back."
            : 'Its domains leave the opt-out list and its company data may be read again. Its sources stay off until an admin switches them on.'
        }
        confirmLabel={confirming ? 'Opt out' : 'Take off'}
        busyLabel="Saving…"
        tone={confirming ? 'destructive' : 'primary'}
        onConfirm={async () => {
          // The dialog shows an ApiError's own words: a missing or long reason keeps it open with them.
          if (!reason.trim()) throw new ApiError({ status: 400, code: 'validation_failed', message: 'Give a reason first.' });
          if (reasonError) throw new ApiError({ status: 400, code: 'validation_failed', message: reasonError });
          await onChange(confirming === true, reason.trim());
          setReason('');
        }}
      >
        <Field label="Reason" error={reasonError} className="mt-4">
          <Textarea value={reason} rows={3} maxLength={OPT_OUT_REASON_MAX} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </ConfirmDialog>
    </EditorSection>
  );
}
