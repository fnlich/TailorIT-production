'use client';

import { initialsOf } from '@tailorit/shared/auth';
import {
  PROFILE_SELF,
  type ProfileChoice,
  type SharingOverview,
  type SharingOverviewItem,
  type SharingOverviewProfile,
} from '@tailorit/shared/sharing';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useRef, useState, type ReactNode } from 'react';
// Relative, not '@/': the web tests draw these views.
import { PAGE_GUTTER } from '../../components/shell/layout';
import { PROFILE_COPY } from '../../components/shell/profile/copy';
import { profileName, useProfile } from '../../components/shell/profile/useProfile';
import { useGateAlert } from '../../components/ui/AlertDialog';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { HelpTip } from '../../components/ui/HelpTip';
import { LetterAvatar } from '../../components/ui/LetterAvatar';
import { LoadError } from '../../components/ui/LoadError';
import { PageHeader } from '../../components/ui/PageHeader';
import { Skeleton } from '../../components/ui/Skeleton';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/Toast';
import { useAuth } from '../../lib/auth';
import { formatDate, relativeTime } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import { BudgetNote } from '../prepare/PrepareAllConfirmDialog';
import { fetchOverview, fetchPrepareAllPlanOf, invalidateSharing, sharingKeys, startPrepareAllOf } from './api';
import { PROFILES_COPY } from './copy';
import { canPrepare, refusalReason, summarize, type PlanRead, type PrepareAllSummary, type Refusal } from './prepareAll';

// v33 SHARE-7 (PLAN F9 "Seeing every profile at once"; SP v33 PLAN-sharing.md §8): the Profiles page (/profiles, "All
// profiles" in the account menu): a card per profile (the person's own first, then each profile shared with them that
// shows Prepare & queue) with its counts, running Prepares and "Needs you"; one merged "Needs you" list; and "Prepare all
// profiles": one confirm (the jobs over every profile the person may prepare, and their own AI use, which pays for all
// of it), then one Prepare All per profile, every refusal in one alert. GET /api/sharing/overview is `self`, so the page
// shows the same on any profile the tab works on; it asks again every 10 s while something prepares, else every 60 s
// (never in a hidden tab).

/** How often the overview is read while something prepares or applies, and otherwise. */
export const OVERVIEW_BUSY_MS = 10_000;
export const OVERVIEW_IDLE_MS = 60_000;

/** Where a card's Open, and a "Needs you" item, take the tab. */
const OPEN_PATH = '/auto-apply';

type Phase = { kind: 'idle' } | { kind: 'reading' } | { kind: 'confirm'; summary: PrepareAllSummary };

export function ProfilesPage() {
  const { account } = useAuth();
  const view = useProfile();
  const toast = useToast();
  const gate = useGateAlert();
  const queryClient = useQueryClient();
  const overview = useQuery({
    queryKey: sharingKeys.overview,
    queryFn: ({ signal }) => fetchOverview(signal),
    refetchInterval: (query) => (query.state.data?.busy ? OVERVIEW_BUSY_MS : OVERVIEW_IDLE_MS),
  });
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const prepareButton = useRef<HTMLButtonElement>(null);

  const nameOf = (profile: Pick<SharingOverviewProfile, 'profile' | 'name' | 'email'>): string =>
    profile.profile === PROFILE_SELF ? PROFILES_COPY.you : profileName(profile, account);
  const nameOfChoice = (choice: ProfileChoice, data: SharingOverview | undefined): string => {
    const profile = data?.profiles.find((one) => one.profile === choice);
    return profile ? nameOf(profile) : '';
  };
  const current: ProfileChoice = view.key ?? PROFILE_SELF;
  const runnable = overview.data?.profiles.filter(canPrepare) ?? [];

  const startReading = async () => {
    if (!overview.data || phase.kind !== 'idle') return;
    setPhase({ kind: 'reading' });
    const reads = await Promise.all(
      runnable.map(async (profile): Promise<PlanRead> => {
        try {
          return { profile: profile.profile, name: nameOf(profile), plan: await fetchPrepareAllPlanOf(profile.profile) };
        } catch (error) {
          return { profile: profile.profile, name: nameOf(profile), error };
        }
      }),
    );
    setPhase({ kind: 'confirm', summary: summarize(reads, "Its jobs couldn't be read. Try again in a moment.") });
  };

  const run = async (summary: PrepareAllSummary) => {
    const refused: Refusal[] = [...summary.refused];
    let started = 0;
    let profiles = 0;
    // One profile after another, the person's own first: each start counts against the person's own limits.
    for (const one of summary.runs) {
      try {
        const answer = await startPrepareAllOf(one.profile, one.applicationIds);
        // Started now or waiting for the runner: both are on their way.
        const count = answer.results.filter((result) => result.outcome === 'started' || result.outcome === 'queued').length;
        started += count;
        if (count > 0) profiles += 1;
      } catch (error) {
        refused.push({ profile: one.profile, name: one.name, message: refusalReason(error, 'Nothing started. Try again in a moment.') });
      }
    }
    void invalidateSharing(queryClient);
    void queryClient.invalidateQueries({ queryKey: ['auto-apply'] });
    if (started > 0) toast.success(PROFILES_COPY.started(started, profiles));
    if (refused.length > 0) {
      gate.show({
        title: PROFILES_COPY.refusedTitle(refused.length),
        tone: 'warning',
        message: <RefusalList lead={PROFILES_COPY.refusedLead} refused={refused} />,
        dataAttributes: { 'data-prepare-all-refused': String(refused.length) },
      });
    }
  };

  const busy = overview.data?.busy ?? false;
  let body: ReactNode;
  if (overview.isError && !overview.data) {
    body = <LoadError className="mt-6" thing={PROFILES_COPY.loadThing} error={overview.error} onRetry={() => void overview.refetch()} />;
  } else if (!overview.data) {
    body = <CardsSkeleton />;
  } else {
    const data = overview.data;
    body = (
      <>
        {!data.enabled && (
          <p className="mt-4 text-sm text-muted-foreground" data-profiles-off="">
            {PROFILES_COPY.off}
          </p>
        )}
        {/* v33 INT-1: one shrinkable column on a phone (grid-cols-1 is minmax(0, 1fr)) and cards that may be narrower than
            their longest line (min-w-0): a long email (truncated) once widened the implicit column past a 390 px screen. */}
        <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label={PROFILES_COPY.title} data-profile-cards="">
          {data.profiles.map((profile) => (
            <ProfileCard
              key={profile.profile}
              profile={profile}
              name={nameOf(profile)}
              // The person's own card: their initials as the top bar shows them.
              letters={profile.profile === PROFILE_SELF ? initialsOf(account?.name ?? '', account?.email ?? profile.email) : initialsOf(profile.name, profile.email)}
              current={profile.profile === current}
              onOpen={() => void view.switchTo(profile.profile, { to: OPEN_PATH })}
            />
          ))}
        </ul>
        <NeedsYou
          items={data.needsYou}
          nameOf={(choice) => nameOfChoice(choice, data)}
          onOpen={(item) => void view.switchTo(item.profile, { to: OPEN_PATH })}
        />
      </>
    );
  }

  const summary = phase.kind === 'confirm' ? phase.summary : null;
  return (
    <div className={clsx('mx-auto w-full max-w-[1280px] pt-7 pb-20', PAGE_GUTTER)} data-profiles-page="">
      <PageHeader
        title={PROFILES_COPY.title}
        description={PROFILES_COPY.description}
        // v33 SHARE-7: every profile at once, whichever one the tab works on (not the shell's "<name>'s profile").
        eyebrow={view.acting ? PROFILE_COPY.allProfiles : undefined}
        actions={
          <span className="flex items-center gap-1.5">
            {busy && <Spinner size={16} label={PROFILES_COPY.counts.preparing} />}
            <Button
              ref={prepareButton}
              onClick={() => void startReading()}
              loading={phase.kind === 'reading'}
              disabled={!overview.data || runnable.length === 0 || phase.kind !== 'idle'}
              data-prepare-all-profiles=""
            >
              {phase.kind === 'reading' ? PROFILES_COPY.reading : PROFILES_COPY.prepareAll}
            </Button>
            <HelpTip label={PROFILES_COPY.prepareAll}>{PROFILES_COPY.prepareAllTip}</HelpTip>
          </span>
        }
      />
      {body}
      <ConfirmDialog
        open={summary !== null}
        onOpenChange={(open) => !open && setPhase({ kind: 'idle' })}
        tone="primary"
        title={summary && summary.total > 0 ? PROFILES_COPY.confirmTitle(summary.total) : PROFILES_COPY.confirmNone}
        description={summary && summary.total > 0 ? PROFILES_COPY.confirmLine(summary.runs.length) : PROFILES_COPY.confirmNothing}
        confirmLabel={PROFILES_COPY.confirmLabel(summary?.total ?? 0)}
        busyLabel={PROFILES_COPY.starting}
        confirmDisabled={!summary || summary.total === 0}
        // It spends the person's AI on many jobs at once: it opens on Cancel.
        focusCancel
        finalFocus={() => prepareButton.current ?? true}
        onConfirm={async () => {
          if (summary) await run(summary);
        }}
      >
        {summary && <ConfirmBody summary={summary} />}
      </ConfirmDialog>
      {gate.alert}
    </div>
  );
}

function ConfirmBody({ summary }: { summary: PrepareAllSummary }) {
  return (
    <div className="flex flex-col gap-3" data-prepare-all-profiles-confirm="">
      {summary.runs.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Jobs per profile">
          {summary.runs.map((run) => (
            <li key={run.profile} className="flex items-baseline justify-between gap-3" data-run={run.profile}>
              <span className="truncate text-foreground">{run.name}</span>
              <span className="num shrink-0 text-muted-foreground">{`${run.taking} ${run.taking === 1 ? 'job' : 'jobs'}`}</span>
            </li>
          ))}
        </ul>
      )}
      {summary.refused.length > 0 && <RefusalList lead={PROFILES_COPY.refusedLead} refused={summary.refused} />}
      {summary.ai && <BudgetNote ai={summary.ai} />}
    </div>
  );
}

function RefusalList({ lead, refused }: { lead: string; refused: readonly Refusal[] }) {
  return (
    <div className="flex flex-col gap-1.5" data-refusals="">
      <p className="text-[13px] leading-5 text-muted-foreground">{lead}</p>
      <ul className="flex flex-col gap-1 text-[13px] leading-5">
        {refused.map((one) => (
          <li key={one.profile} data-refused={one.profile}>
            <span className="font-semibold text-foreground">{one.name}</span>
            <span className="text-muted-foreground">{`: ${one.message}`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The cards ---------------------------------------------------------------------------------------------------------------

function ProfileCard({
  profile,
  name,
  letters,
  current,
  onOpen,
}: {
  profile: SharingOverviewProfile;
  name: string;
  /** The card's initials (the person's own: as the top bar shows them). */
  letters: string;
  current: boolean;
  onOpen: () => void;
}) {
  const own = profile.profile === PROFILE_SELF;
  const headingId = `profile-card-${profile.profile}`;
  const counts = profile.counts;
  return (
    <Card as="li" padding="none" className="flex min-w-0 flex-col gap-4 p-5" aria-labelledby={headingId} data-profile-card={profile.profile}>
      <div className="flex items-start gap-3">
        <LetterAvatar letters={letters} size={40} tone={own ? 'brand' : 'tint'} shape="circle" />
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-heading leading-6 font-semibold text-foreground">{own ? PROFILES_COPY.yours : name}</span>
            {current && <Badge tone="tint">{PROFILES_COPY.current}</Badge>}
          </h2>
          <p className="truncate text-[13px] leading-5 text-muted-foreground">{profile.email}</p>
          {profile.accessEndsAt && (
            <p className="text-[13px] leading-5 text-muted-foreground">{PROFILES_COPY.until(formatDate(profile.accessEndsAt))}</p>
          )}
        </div>
      </div>
      <dl
        // As many columns as fit with a whole label each ("Waiting for OK" and its "?"): 2 on a phone, 3 on a wide card.
        className="grid grid-cols-[repeat(auto-fill,minmax(7.75rem,1fr))] gap-x-3 gap-y-3"
        data-profile-counts=""
      >
        <Count label={PROFILES_COPY.counts.saved} value={counts.saved} />
        <Count label={PROFILES_COPY.counts.applied} value={counts.applied} />
        <Count label={PROFILES_COPY.counts.preparing} value={counts.preparing} busy={counts.preparing > 0} />
        <Count label={PROFILES_COPY.counts.queued} value={counts.queued} />
        <Count
          label={PROFILES_COPY.counts.waitingForOk}
          value={counts.waitingForOk}
          tip={own ? PROFILES_COPY.waitingTip.own : PROFILES_COPY.waitingTip.shared}
          strong={own && counts.waitingForOk > 0}
        />
        <Count label={PROFILES_COPY.counts.needsYou} value={counts.needsYou} strong={counts.needsYou > 0} />
      </dl>
      <div className="mt-auto flex items-center justify-end">
        {current ? null : (
          <Button size="sm" variant="outline" onClick={onOpen} data-profile-open={profile.profile}>
            {PROFILES_COPY.open}
            <span className="sr-only">{own ? ' your profile' : ` ${name}'s profile`}</span>
          </Button>
        )}
      </div>
    </Card>
  );
}

function Count({
  label,
  value,
  tip,
  busy = false,
  strong = false,
}: {
  label: string;
  value: number | null;
  tip?: string;
  busy?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-count={label}>
      <dt className="flex min-h-5 min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground">
        <span className="truncate">{label}</span>
        {tip && <HelpTip label={label}>{tip}</HelpTip>}
      </dt>
      <dd className={clsx('num flex items-center gap-1.5 text-lg leading-6 font-semibold', strong ? 'text-primary-ink' : 'text-foreground')}>
        {value === null ? <span className="text-sm font-normal text-muted-foreground">{PROFILES_COPY.notShown}</span> : value}
        {busy && <Spinner size={12} />}
      </dd>
    </div>
  );
}

// Needs you -----------------------------------------------------------------------------------------------------------------

function NeedsYou({
  items,
  nameOf,
  onOpen,
}: {
  items: readonly SharingOverviewItem[];
  nameOf: (choice: ProfileChoice) => string;
  onOpen: (item: SharingOverviewItem) => void;
}) {
  const now = useNow();
  return (
    <section className="mt-8" aria-labelledby="profiles-needs-you" data-needs-you="">
      <div className="flex items-center gap-1.5">
        <h2 id="profiles-needs-you" className="text-heading font-semibold text-foreground">
          {PROFILES_COPY.needsYouTitle}
        </h2>
        <HelpTip label={PROFILES_COPY.needsYouTitle}>{PROFILES_COPY.needsYouTip}</HelpTip>
      </div>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground" data-needs-you-empty="">
          {PROFILES_COPY.needsYouEmpty}
        </p>
      ) : (
        <Card as="div" padding="none" className="mt-3">
          <ul className="flex flex-col divide-y divide-divider-soft">
            {items.map((item) => {
              const whose = item.profile === PROFILE_SELF ? PROFILES_COPY.yours : nameOf(item.profile);
              return (
                <li key={`${item.profile}:${item.queueId}`} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-5" data-needs-you-item={item.kind}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm leading-5 font-semibold text-foreground">{item.title}</p>
                    <p className="truncate text-[13px] leading-5 text-muted-foreground">
                      {`${item.company} · ${whose} · ${relativeTime(item.at, now)}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={item.kind === 'awaiting_ok' ? 'tint' : 'warning'}>{PROFILES_COPY.itemKind[item.kind]}</Badge>
                    <Button size="sm" variant="outline" onClick={() => onOpen(item)}>
                      {PROFILES_COPY.open}
                      <span className="sr-only">{` ${item.title} on ${whose}`}</span>
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </section>
  );
}

function CardsSkeleton() {
  return (
    <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
      <span className="sr-only">Loading</span>
      {[0, 1].map((index) => (
        <div key={index} aria-hidden="true" className="rounded-card border border-border bg-surface p-5 shadow-card">
          <div className="flex items-center gap-3">
            <Skeleton className="size-10" rounded="full" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48 max-w-full" />
            </div>
          </div>
          <Skeleton className="mt-5 h-20 w-full" rounded="control" />
        </div>
      ))}
    </div>
  );
}
