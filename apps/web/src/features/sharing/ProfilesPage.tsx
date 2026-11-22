'use client';

import { initialsOf } from '@tailorit/shared/auth';
import {
  PROFILE_SELF,
  type FanoutSettingsSummary,
  type ProfileChoice,
  type SharingOverviewItem,
  type SharingOverviewProfile,
} from '@tailorit/shared/sharing';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useRef, useState, type ReactNode } from 'react';
// Relative, not '@/': the web tests draw these views.
import { PAGE_GUTTER } from '../../components/shell/layout';
import { PROFILE_COPY } from '../../components/shell/profile/copy';
import { useProfile } from '../../components/shell/profile/useProfile';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { HelpTip } from '../../components/ui/HelpTip';
import { LetterAvatar } from '../../components/ui/LetterAvatar';
import { LoadError } from '../../components/ui/LoadError';
import { PageHeader } from '../../components/ui/PageHeader';
import { Skeleton } from '../../components/ui/Skeleton';
import { Spinner } from '../../components/ui/Spinner';
import { useAuth } from '../../lib/auth';
import { usePublicConstants, type PublicMessageKey } from '../../lib/constants';
import { formatDate, relativeTime } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import { AllProfilesFiltersDialog } from '../settings/prepare/AllProfilesFilters';
import { filtersLineWords } from '../settings/prepare/filters';
import { PROFILES_COPY } from './copy';
import { fanoutKeys, fetchSettingsSummary } from './fanout/api'; // v34 FANWEB
import { FANOUT_COPY } from './fanout/copy';
import { boxName } from './fanout/targets';
import { useFanoutReport } from './fanout/useFanout';
import { usePrepareAllProfiles } from './usePrepareAllProfiles';

// v33 SHARE-7 (PLAN F9 "Seeing every profile at once"; SP v33 PLAN-sharing.md §8): the Profiles page (/profiles, "All
// profiles" in the account menu): a card per profile (the person's own first, then each profile shared with them that
// shows Prepare & queue) with its counts, running Prepares and "Needs you"; one merged "Needs you" list; and "Prepare all
// profiles": one confirm (the jobs over every profile the person may prepare, and their own AI use, which pays for all
// of it), then one Prepare All per profile, every refusal in one alert. GET /api/sharing/overview is `self`, so the page
// shows the same on any profile the tab works on; it asks again every 10 s while something prepares, else every 60 s
// (never in a hidden tab).
// v34 FANWEB (PLAN G3, G4): each card also says which Prepare filters are on there (GET /api/profiles/settings, one read
// for every profile), with Edit (the tab opens that profile's Settings > Prepare & Queue) and, over the cards, "Change
// filters for all profiles" (the filters form over every profile, starting from the person's own filters). Prepare all
// profiles is usePrepareAllProfiles (the Tracker's All profiles view starts the same).

/** Where a card's Edit of the filters opens (the Settings section's anchor). */
const FILTERS_PATH = '/settings#prepare';

export { OVERVIEW_BUSY_MS, OVERVIEW_IDLE_MS } from './usePrepareAllProfiles';

/** Where a card's Open, and a "Needs you" item, take the tab. */
const OPEN_PATH = '/auto-apply';

export function ProfilesPage() {
  const { account } = useAuth();
  const view = useProfile();
  const { t } = usePublicConstants();
  const prepareButton = useRef<HTMLButtonElement>(null);
  const all = usePrepareAllProfiles(prepareButton);
  const { overview, nameOf } = all;
  // v34 FANWEB: the filters of every profile in one read (each as its boxes let the person see it).
  const shared = (overview.data?.profiles.length ?? 0) > 1;
  const filters = useQuery({
    queryKey: fanoutKeys.settings(['filters']),
    queryFn: ({ signal }) => fetchSettingsSummary(['filters'], signal),
    // Only with a shared profile: the line compares profiles (nothing of v3.4 shows on your own alone).
    enabled: overview.isSuccess && shared,
    retry: false,
  });
  const [filtersAllOpen, setFiltersAllOpen] = useState(false);
  const filtersAllButton = useRef<HTMLButtonElement>(null);
  const report = useFanoutReport();
  const settingsBox = boxName('settings:edit', (key) => t(key as PublicMessageKey));

  const nameOfChoice = (choice: ProfileChoice): string => {
    const profile = overview.data?.profiles.find((one) => one.profile === choice);
    return profile ? nameOf(profile) : '';
  };
  const current: ProfileChoice = view.key ?? PROFILE_SELF;

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
        {/* v34 FANWEB: the Prepare filters of every profile at once (only with a shared profile), over the cards. */}
        {shared && (
          <div className="mt-6 flex justify-end">
            <Button ref={filtersAllButton} variant="outline" onClick={() => setFiltersAllOpen(true)} data-filters-all-profiles="">
              {FANOUT_COPY.filtersAll}
            </Button>
          </div>
        )}
        {/* v33 INT-1: one shrinkable column on a phone (grid-cols-1 is minmax(0, 1fr)) and cards that may be narrower than
            their longest line (min-w-0): a long email (truncated) once widened the implicit column past a 390 px screen. */}
        <ul
          className={clsx('grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3', shared ? 'mt-3' : 'mt-6')}
          aria-label={PROFILES_COPY.title}
          data-profile-cards=""
        >
          {data.profiles.map((profile) => (
            <ProfileCard
              key={profile.profile}
              profile={profile}
              name={nameOf(profile)}
              filters={shared ? filtersOf(filters.data, filters.isError, profile.profile) : undefined}
              settingsBox={settingsBox}
              onEditFilters={() => void view.switchTo(profile.profile, { to: FILTERS_PATH })}
              // The person's own card: their initials as the top bar shows them.
              letters={profile.profile === PROFILE_SELF ? initialsOf(account?.name ?? '', account?.email ?? profile.email) : initialsOf(profile.name, profile.email)}
              current={profile.profile === current}
              onOpen={() => void view.switchTo(profile.profile, { to: OPEN_PATH })}
            />
          ))}
        </ul>
        <NeedsYou
          items={data.needsYou}
          nameOf={nameOfChoice}
          onOpen={(item) => void view.switchTo(item.profile, { to: OPEN_PATH })}
        />
      </>
    );
  }

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
            <Button ref={prepareButton} onClick={all.start} loading={all.reading} disabled={!all.ready} data-prepare-all-profiles="">
              {all.reading ? PROFILES_COPY.reading : PROFILES_COPY.prepareAll}
            </Button>
            <HelpTip label={PROFILES_COPY.prepareAll}>{PROFILES_COPY.prepareAllTip}</HelpTip>
          </span>
        }
      />
      {body}
      {all.elements}
      {shared && (
        <AllProfilesFiltersDialog
          open={filtersAllOpen}
          onOpenChange={setFiltersAllOpen}
          report={report}
          finalFocus={() => filtersAllButton.current ?? true}
        />
      )}
      {report.element}
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
  filters,
  settingsBox,
  onEditFilters,
}: {
  profile: SharingOverviewProfile;
  name: string;
  /** The card's initials (the person's own: as the top bar shows them). */
  letters: string;
  current: boolean;
  onOpen: () => void;
  /** v34 FANWEB: the profile's filters line (null: not read yet; undefined: none, without a shared profile). */
  filters?: FiltersLine | null;
  /** v34 FANWEB: the box a change of the filters needs, by name ("Job settings > Change"). */
  settingsBox: string;
  onEditFilters: () => void;
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
      {filters !== undefined && <FiltersRow filters={filters} whose={own ? 'your' : `${name}'s`} settingsBox={settingsBox} onEdit={onEditFilters} />}
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

// The filters line (v34 FANWEB) ----------------------------------------------------------------------------------------

/** One profile's filters as its card shows them. */
export type FiltersLine = { kind: 'hidden' } | { kind: 'shown'; words: string[]; canChange: boolean } | { kind: 'failed' };

/** A profile's line from the summary (null while it is read). */
export function filtersOf(summary: FanoutSettingsSummary | undefined, failed: boolean, choice: ProfileChoice): FiltersLine | null {
  if (failed) return { kind: 'failed' };
  if (!summary) return null;
  const entry = summary.profiles.find((one) => one.profile === choice);
  if (!entry || !entry.ok || !entry.can.seeFilters || !entry.filters || !entry.filtersOn) return { kind: 'hidden' };
  return { kind: 'shown', words: filtersLineWords(entry.filters.filters, entry.filtersOn), canChange: entry.can.changeSettings };
}

function FiltersRow({
  filters,
  whose,
  settingsBox,
  onEdit,
}: {
  filters: FiltersLine | null;
  whose: string;
  settingsBox: string;
  onEdit: () => void;
}) {
  if (filters === null) return <Skeleton className="h-5 w-full" />;
  if (filters.kind === 'failed') return null;
  const words =
    filters.kind === 'hidden' ? FANOUT_COPY.filtersNotShared : filters.words.length > 0 ? filters.words.join(', ') : FANOUT_COPY.filtersNone;
  const locked = filters.kind === 'shown' && !filters.canChange;
  return (
    <div className="flex min-w-0 items-start gap-3 border-t border-divider-soft pt-3" data-profile-filters={filters.kind}>
      <div className="min-w-0 flex-1 text-[13px] leading-5">
        <p>
          <span className="font-medium text-foreground">{`${FANOUT_COPY.filtersLine}: `}</span>
          <span className="text-muted-foreground" data-profile-filters-words="">
            {words}
          </span>
        </p>
        {/* v34 FANWEB fix (spec M5): the reason a change is off is text, for every way of reading the card. */}
        {locked && (
          <p className="text-muted-foreground" data-profile-filters-locked-reason="">
            {FANOUT_COPY.filtersLocked(settingsBox)}
          </p>
        )}
      </div>
      {filters.kind === 'shown' &&
        (filters.canChange ? (
          <Button size="sm" variant="ghost" className="-my-1 shrink-0" onClick={onEdit} aria-label={FANOUT_COPY.filtersEditLabel(whose)} data-profile-filters-edit="">
            {FANOUT_COPY.filtersEdit}
          </Button>
        ) : (
          <span className="-my-1 shrink-0" data-profile-filters-locked="">
            <Button size="sm" variant="ghost" disabled aria-label={`${FANOUT_COPY.filtersEditLabel(whose)}: ${FANOUT_COPY.needs(settingsBox)}`}>
              {FANOUT_COPY.filtersEdit}
            </Button>
          </span>
        ))}
    </div>
  );
}
