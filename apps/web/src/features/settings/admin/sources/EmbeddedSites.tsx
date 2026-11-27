'use client';

import type { AdminEmbeddedSite, AdminSourceRow } from '@tailorit/shared/sourcing';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { HelpTip } from '@/components/ui/HelpTip';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import {
  embeddedSiteHow,
  embeddedSiteLine,
  embeddedSitesKey,
  fetchEmbeddedSites,
  forgetEmbeddedSite,
  isForgotten,
  rememberEmbeddedSite,
  siteChangeToast,
} from './embedded';

// v381 EMBED (SP v381 PLAN E2, E5): a Greenhouse or Ashby source's sheet lists the company sites whose job pages show its
// board ("Job pages on acme.com use this board."), how TailorIT learned each, the link that found it first, and Forget.
// v381 FIX (SP v381 FIXES-381 G6; REVIEW381-ux L4-L7): a forgotten site stays listed with Remember again; the toast says
// what the server did (already forgotten too); keyboard focus stays on the row's button after either; the loading state
// is a status; the section and list are named by the heading's words alone (not the "?" tip's).

const HEADING = 'text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase';

/** The id of the words that name the section and its list (the heading's text, never its tip). */
export const embeddedSitesHeadingId = (sourceId: number) => `source-${sourceId}-sites`;

/** The list itself (drawn without a server in the web tests). */
export function EmbeddedSitesList({
  sourceId,
  sites,
  now,
  busy,
  onForget,
  onRemember,
}: {
  sourceId: number;
  sites: readonly AdminEmbeddedSite[];
  now: number;
  /** The site whose Forget or Remember again is on its way, or null. */
  busy: string | null;
  onForget: (site: string) => void;
  onRemember: (site: string) => void;
}) {
  if (sites.length === 0) {
    return (
      <p className="mt-1 text-sm text-muted-foreground" data-embedded-sites-none="">
        No company site is known to show this board yet.
      </p>
    );
  }
  return (
    <ul className="mt-1 divide-y divide-divider-soft" aria-labelledby={embeddedSitesHeadingId(sourceId)}>
      {sites.map((site) => {
        const forgotten = isForgotten(site);
        return (
          <li
            key={site.site}
            className="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2"
            data-embedded-site={site.site}
            {...(forgotten ? { 'data-embedded-site-forgotten': '' } : {})}
          >
            <div className="min-w-0 flex-1 basis-56">
              <p className="text-sm break-words text-foreground">{embeddedSiteLine(site)}</p>
              <p className="text-[13px] text-muted-foreground">
                {forgotten && site.forgottenAt
                  ? `Forgotten by an admin, ${relativeTime(site.forgottenAt, now)}`
                  : `${embeddedSiteHow(site)}, ${relativeTime(site.firstSeenAt, now)}`}
              </p>
              {site.firstLink && (
                <p className="text-[13px] break-all text-muted-foreground" data-embedded-site-link="">
                  First link: <span className="text-foreground">{site.firstLink}</span>
                </p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="max-sm:h-11"
              loading={busy === site.site}
              disabled={busy !== null}
              // The clicked button keeps keyboard focus while it works (a disabled button would drop it to the sheet).
              focusableWhenDisabled
              aria-label={forgotten ? `Remember ${site.site} again` : `Forget ${site.site}`}
              data-embedded-site-action={forgotten ? 'remember' : 'forget'}
              onClick={() => (forgotten ? onRemember(site.site) : onForget(site.site))}
            >
              {forgotten ? 'Remember again' : 'Forget'}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** The sheet's "Company sites" section: the list, read from the source's own route. */
export function EmbeddedSites({ source, now }: { source: AdminSourceRow; now: number }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  /** The site whose row's button takes keyboard focus once the list is read again (REVIEW381-ux L5), and its turn. */
  const focusSite = useRef<string | null>(null);
  const [focusTurn, setFocusTurn] = useState(0);
  const sites = useQuery({ queryKey: embeddedSitesKey(source.id), queryFn: ({ signal }) => fetchEmbeddedSites(source.id, signal) });
  const settled = (action: 'forget' | 'remember', site: string, changed: boolean) => {
    const words = siteChangeToast(action, site, changed);
    if (words.tone === 'success') toast.success(words.title, words.description);
    else toast.info(words.title, words.description);
    // Once the list is read again (its row may have moved), the focus goes back to it.
    void queryClient.invalidateQueries({ queryKey: embeddedSitesKey(source.id) }).finally(() => {
      focusSite.current = site;
      setFocusTurn((turn) => turn + 1);
    });
  };
  const forget = useMutation({
    mutationFn: (site: string) => forgetEmbeddedSite(source.id, site),
    onSuccess: (result, site) => settled('forget', site, result.forgotten),
    onError: (error) => toast.error('The site was not forgotten', userMessage(error)),
  });
  const remember = useMutation({
    mutationFn: (site: string) => rememberEmbeddedSite(source.id, site),
    onSuccess: (result, site) => settled('remember', site, result.remembered),
    onError: (error) => toast.error('The site was not remembered again', userMessage(error)),
  });

  // The changed site's button (now Remember again, or Forget) takes the focus; a site no longer listed hands it to the
  // section's heading.
  useEffect(() => {
    const site = focusSite.current;
    if (site === null) return;
    focusSite.current = null;
    const rows = section.current?.querySelectorAll<HTMLElement>('[data-embedded-site]') ?? [];
    const row = [...rows].find((each) => each.dataset.embeddedSite === site);
    const target = row?.querySelector<HTMLElement>('[data-embedded-site-action]') ?? heading.current;
    target?.focus();
  }, [focusTurn]);

  const busy = forget.isPending ? (forget.variables ?? null) : remember.isPending ? (remember.variables ?? null) : null;
  let body;
  if (sites.isError) {
    body = (
      <Notice
        tone="error"
        title="Company sites didn't load."
        className="mt-1"
        action={
          <Button variant="outline" size="sm" className="max-sm:h-11" onClick={() => void sites.refetch()}>
            Try again
          </Button>
        }
      >
        {userMessage(sites.error)}
      </Notice>
    );
  } else if (!sites.data) {
    body = (
      // A status (REVIEW381-ux L4): its label is read while the sites load.
      <div role="status" aria-busy="true" aria-label="Loading the company sites" className="mt-2 flex flex-col gap-2">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    );
  } else {
    body = (
      <EmbeddedSitesList
        sourceId={source.id}
        sites={sites.data.items}
        now={now}
        busy={busy}
        onForget={(site) => forget.mutate(site)}
        onRemember={(site) => remember.mutate(site)}
      />
    );
  }
  return (
    <section ref={section} aria-labelledby={embeddedSitesHeadingId(source.id)} data-embedded-sites={source.id}>
      <h3 ref={heading} tabIndex={-1} className={`flex items-center gap-1 outline-none ${HEADING}`}>
        <span id={embeddedSitesHeadingId(source.id)}>Company sites</span>
        <HelpTip label="Company sites">Company career pages that show this board; TailorIT reads their job links from it.</HelpTip>
      </h3>
      {body}
    </section>
  );
}
