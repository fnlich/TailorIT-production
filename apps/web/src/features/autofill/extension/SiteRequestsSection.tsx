'use client';

import { GlobeIcon } from '@phosphor-icons/react/Globe';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { userMessage } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { autofillKeys, fetchSiteRequests } from '../api';
import { Section } from '../Section';

/**
 * "Sites you asked to support": each site where the extension's side panel said it cannot fill the page and the person
 * chose "Ask TailorIT to support this site", with how many times and when last. Only the site's host name is kept.
 */
export function SiteRequestsSection() {
  const now = useNow();
  const requests = useQuery({ queryKey: autofillKeys.siteRequests, queryFn: ({ signal }) => fetchSiteRequests(signal) });
  const items = requests.data?.items ?? [];

  return (
    <Section
      title="Sites you asked to support"
      description="On a page the extension cannot fill yet, its side panel offers “Ask TailorIT to support this site”. Each site you asked about is listed here by its host name alone, never the page’s address."
    >
      {requests.isError ? (
        <Notice
          tone="error"
          title="The sites you asked about could not be loaded"
          action={
            <Button variant="outline" size="sm" onClick={() => void requests.refetch()}>
              Try again
            </Button>
          }
        >
          {userMessage(requests.error)}
        </Notice>
      ) : requests.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading the sites you asked about">
          <Skeleton className="h-9 w-full" rounded="control" />
          <Skeleton className="h-9 w-full" rounded="control" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<GlobeIcon size={24} />}
          title="No sites asked about yet"
          description="When the extension cannot fill a job site, ask TailorIT to support it from the extension’s side panel."
          variant="dashed"
          size="sm"
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-sm leading-5">
            <caption className="sr-only">Sites you asked TailorIT to support, the latest first</caption>
            <thead>
              <tr className="border-b border-border text-[13px] text-muted-foreground">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Site
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Times asked
                </th>
                <th scope="col" className="py-2 font-medium">
                  Last asked
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((item) => (
                <tr key={item.host}>
                  <th scope="row" className="py-2.5 pr-4 font-medium break-all text-foreground">
                    {item.host}
                  </th>
                  <td className="py-2.5 pr-4 text-right text-foreground tabular-nums">{item.count}</td>
                  <td className="py-2.5 whitespace-nowrap text-muted-foreground">
                    <time dateTime={item.lastRequestedAt} title={formatDate(item.lastRequestedAt)}>
                      {relativeTime(item.lastRequestedAt, now)}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
