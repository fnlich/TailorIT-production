'use client';

import type { UnverifiedLink, UnverifiedLinkDetail, UnverifiedVersion } from '@tailorit/shared/jobs';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useEffect, useId, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ArrowSquareOutIcon, CaretDownIcon, CaretRightIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { Skeleton } from '@/components/ui/Skeleton';
import { userMessage } from '@/lib/api';
import { reviewKeys } from './api';
import { POSTING_HTML } from './ReviewSheet';
import { fetchUnverifiedDetail, linkName, versionLabel } from './unverified';

// v32 FIX-API (REV-SECBEH SB-1, the coordinator's decision): Admin › Review › Couldn't verify shows the admin the job an
// approval publishes, in full, before they approve it: the row's "Show the job" (every version its adders captured)
// and the Approve confirm (the version to publish, picked when they differ). Each version is drawn as it would be
// published: its title, company, places, pay, description (the API's sanitised HTML: captured text arrives escaped)
// and the Apply link published.

/** A row's link and every version of its job (GET /api/admin/jobs/unverified/:jobId). */
export function useUnverifiedDetail(jobId: number, enabled: boolean) {
  return useQuery({
    queryKey: reviewKeys.unverifiedDetail(jobId),
    queryFn: ({ signal }) => fetchUnverifiedDetail(jobId, signal),
    enabled,
    // The confirm reads what it approves: always the server's words now, never an old copy.
    staleTime: 0,
  });
}

/** One version as an approval would publish it. */
export function VersionView({ version, heading }: { version: UnverifiedVersion; heading?: string }) {
  const facts = [version.companyName, ...version.locations, version.pay].filter((part): part is string => !!part && part.trim() !== '');
  return (
    <div className="flex flex-col gap-2" data-unverified-version={version.jobId}>
      {heading && <p className="text-xs leading-4 font-semibold tracking-[0.04em] text-muted-foreground uppercase">{heading}</p>}
      <div className="text-[13px] leading-5">
        <p className="font-semibold break-words text-foreground">{version.title}</p>
        {facts.length > 0 && <p className="break-words text-muted-foreground">{facts.join(' · ')}</p>}
      </div>
      {version.descriptionHtml ? (
        <div
          className={clsx(POSTING_HTML, 'max-h-64 overflow-y-auto rounded-control border border-border bg-surface p-3')}
          // The API's sanitised HTML, as the Jobs page would draw the published job.
          dangerouslySetInnerHTML={{ __html: version.descriptionHtml }}
          data-unverified-description=""
          tabIndex={0}
          role="region"
          aria-label={`The description of ${version.title}`}
        />
      ) : (
        <p className="text-[13px] text-muted-foreground">No description was added.</p>
      )}
      <a
        href={version.applyUrl}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="inline-flex max-w-full items-start gap-1 self-start text-[13px] leading-5 break-all text-primary-ink underline underline-offset-2"
      >
        <span>Apply link: {linkName(version.applyUrl)}</span>
        <ArrowSquareOutIcon size={12} className="mt-1 shrink-0" aria-hidden="true" />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    </div>
  );
}

/** The detail's loading and failure states, shared by the row and the confirm. */
function DetailState({ detail, retry }: { detail: ReturnType<typeof useUnverifiedDetail>; retry: () => void }) {
  if (detail.isError) {
    return (
      <Notice
        tone="error"
        title="The job didn't load."
        action={
          <Button variant="outline" size="sm" onClick={retry}>
            Try again
          </Button>
        }
      >
        {userMessage(detail.error)}
      </Notice>
    );
  }
  return (
    <div aria-busy="true" aria-label="Loading the job" className="flex flex-col gap-2">
      <Skeleton className="h-3.5 w-1/2" />
      <Skeleton className="h-3 w-1/3" />
      <Skeleton className="h-24 w-full" rounded="control" />
    </div>
  );
}

/** Every version in full, one under the other (the row's "Show the job"). */
function AllVersions({ detail }: { detail: UnverifiedLinkDetail }) {
  return (
    <div className="flex flex-col gap-4">
      {detail.versions.map((version, index) => (
        <VersionView key={version.version} version={version} heading={detail.versions.length > 1 ? versionLabel(version, index) : undefined} />
      ))}
      {detail.moreVersions > 0 && (
        <p className="text-[13px] text-muted-foreground">{detail.moreVersions} more versions are not shown.</p>
      )}
    </div>
  );
}

/** The row's "Show the job" disclosure: the job as an approval would publish it, every version. */
export function VersionsDisclosure({ row, name }: { row: UnverifiedLink; name: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const detail = useUnverifiedDetail(row.jobId, open);
  return (
    <div data-unverified-show="">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 max-sm:h-11"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Show the job: ${name}`}
        icon={open ? <CaretDownIcon size={14} aria-hidden="true" /> : <CaretRightIcon size={14} aria-hidden="true" />}
        onClick={() => setOpen((value) => !value)}
      >
        Show the job
      </Button>
      <div id={panelId} hidden={!open} className="mt-2 rounded-control border border-divider-soft bg-surface-low p-3">
        {open && (detail.data ? <AllVersions detail={detail.data} /> : <DetailState detail={detail} retry={() => void detail.refetch()} />)}
      </div>
    </div>
  );
}

/**
 * The Approve confirm's body: the version an approval publishes, in full, and when the adders' versions differ a pick
 * between them (the admin's own versions cannot be picked: another admin approves them). `onPick` hears the chosen
 * version (null while none can be approved).
 */
export function ApproveVersions({ row, onPick }: { row: UnverifiedLink; onPick: (version: UnverifiedVersion | null) => void }) {
  const detail = useUnverifiedDetail(row.jobId, true);
  const versions = detail.data?.versions ?? [];
  const pickable = versions.filter((version) => !version.yours);
  const [chosen, setChosen] = useState<string | null>(null);
  // The row's own version first, else the first the admin may approve.
  const initial = (pickable.find((version) => version.jobId === row.jobId) ?? pickable[0])?.version ?? null;
  const current = chosen ?? initial;
  const picked = versions.find((version) => version.version === current) ?? null;
  useEffect(() => onPick(picked && !picked.yours ? picked : null), [picked, onPick]);

  if (!detail.data) return <DetailState detail={detail} retry={() => void detail.refetch()} />;
  if (pickable.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <Badge tone="warning" wrap>
          You added this job, so another admin approves it.
        </Badge>
        {versions[0] && <VersionView version={versions[0]} />}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-approve-versions="">
      {versions.length > 1 && (
        <RadioGroup
          aria-label="The version to publish"
          value={current}
          onValueChange={setChosen}
          options={versions.map((version, index) => ({ value: version.version, label: versionLabel(version, index), disabled: version.yours }))}
        />
      )}
      {picked && <VersionView version={picked} heading={versions.length > 1 ? 'What is published' : undefined} />}
    </div>
  );
}
