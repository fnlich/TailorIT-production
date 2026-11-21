'use client';

import type { SharingActivity, SharingActivityGrant, SharingActivityRow } from '@tailorit/shared/sharing';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo, type ReactNode } from 'react';
// Relative, not '@/': the web tests draw these views.
import { Button } from '../../components/ui/Button';
import { LoadError } from '../../components/ui/LoadError';
import { Skeleton } from '../../components/ui/Skeleton';
import { Section } from '../settings/parts';
import { fetchActivity, sharingKeys } from './api';
import { ACTIVITY_AREA, ACTIVITY_VIA, SHARING_COPY, activityAction } from './copy';

// v33 SHARE-7 (PLAN F9 "Notifications and activity"; SP v33 PLAN-sharing.md §10): Settings › Sharing › Activity. What
// was done on a shared profile, hour by hour, newest first: on the person's own profile by the people they share with
// (and their own changes to a share), and on the profiles shared with them by the person (until the share ended). Ids
// and codes only come from the API; the names are the shares' (the other side). "Load more" reads the next page.

/** One activity line as drawn: who did what, where and how, in which hour, how many times. */
export interface ActivityLine {
  id: string;
  /** "You", or the other person's name (their email when they set none). */
  who: string;
  /** "Changed · Job Tracker", "Accepted". */
  what: string;
  /** "Your profile", "Ana Lopez's profile". */
  where: string;
  how: string;
  hour: string;
  events: number;
}

const nameOf = (grant: SharingActivityGrant | undefined) => (grant ? grant.name.trim() || grant.email : '');

/** The rows of an activity page as lines (a row whose share the page does not name is left out). */
export function activityLines(page: Pick<SharingActivity, 'grants' | 'rows'>): ActivityLine[] {
  const grants = new Map(page.grants.map((grant) => [grant.key, grant]));
  return page.rows.flatMap((row: SharingActivityRow, index) => {
    const grant = grants.get(row.key);
    if (!grant) return [];
    const mine = (grant.side === 'owner' && row.by === 'owner') || (grant.side === 'grantee' && row.by === 'grantee');
    const action = activityAction(row.action);
    return [
      {
        id: `${row.key}:${row.hour}:${row.area}:${row.action}:${row.via}:${index}`,
        who: mine ? SHARING_COPY.you : nameOf(grant),
        what: row.area === 'sharing' ? action : `${action} · ${ACTIVITY_AREA[row.area]}`,
        where: grant.side === 'owner' ? 'Your profile' : `${nameOf(grant)}'s profile`,
        how: ACTIVITY_VIA[row.via],
        hour: row.hour,
        events: row.events,
      },
    ];
  });
}

/** "Nov 19, 2 PM" for the hour a line counts. */
export function activityHour(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' });
}

export function ActivitySection({ className }: { className?: string }) {
  const activity = useInfiniteQuery({
    queryKey: sharingKeys.activity,
    queryFn: ({ pageParam, signal }) => fetchActivity(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
  const lines = useMemo(() => (activity.data ? activity.data.pages.flatMap((page) => activityLines(page)) : null), [activity.data]);

  let body: ReactNode;
  if (activity.isError && !lines) {
    body = <LoadError thing={SHARING_COPY.activityThing} error={activity.error} onRetry={() => void activity.refetch()} />;
  } else if (!lines) {
    body = (
      <div className="flex flex-col gap-3" aria-busy="true">
        <span className="sr-only">Loading</span>
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-10 w-full" rounded="control" />
        ))}
      </div>
    );
  } else if (lines.length === 0) {
    body = (
      <p className="text-sm text-muted-foreground" data-sharing-empty="activity">
        {SHARING_COPY.activityEmpty}
      </p>
    );
  } else {
    body = (
      <>
        <ul className="flex flex-col divide-y divide-divider-soft" aria-label={SHARING_COPY.activityTitle} data-activity-list="">
          {lines.map((line) => (
            <li key={line.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0" data-activity-line="">
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-5 text-foreground">
                  <span className="font-semibold">{line.who}</span>
                  <span className="text-muted-foreground"> · </span>
                  {line.what}
                </p>
                <p className="text-[13px] leading-5 text-muted-foreground">
                  <time dateTime={line.hour} className="num">
                    {activityHour(line.hour)}
                  </time>
                  {` · ${line.where} · ${line.how}`}
                </p>
              </div>
              <span className="num shrink-0 pt-0.5 text-[13px] leading-5 text-muted-foreground">{SHARING_COPY.times(line.events)}</span>
            </li>
          ))}
        </ul>
        {activity.hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Button variant="outline" size="sm" loading={activity.isFetchingNextPage} onClick={() => void activity.fetchNextPage()}>
              {SHARING_COPY.loadMore}
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <Section title={SHARING_COPY.activityTitle} description={SHARING_COPY.activityTip} className={className} id="activity">
      {body}
    </Section>
  );
}
