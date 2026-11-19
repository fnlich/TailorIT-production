'use client';

import type { OAuthGrantItem, OAuthGrantList } from '@tailorit/shared/oauth';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, type RefObject } from 'react';
import { CountBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { HelpTip } from '@/components/ui/HelpTip';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { ApiError, userMessage } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { fetchOAuthGrants, OAUTH_GRANTS_KEY, revokeOAuthGrant } from '@/features/oauth/api';
import { ClientMark } from './ClientMark';
import { IntegrationSection } from './IntegrationSection';
import { AI_COPY, grantHost, grantLine } from './integrations';

// v3.1 INTEG: AI assistants › Connected: the assistants the person allowed on TailorIT's consent page (GET
// /api/oauth/grants, newest first, only those with a working token), each with Disconnect (DELETE
// /api/oauth/grants/:id ends every token of it at once). Read again when the person comes back to the tab, so an
// assistant connected in Claude's or ChatGPT's tab shows up here. v31 FIX-WEB: the confirm is its own component, as a
// connected assistant's card offers Disconnect too (AiAssistantsTab holds which one is asked).

/** The hook for the grants (Claude's and ChatGPT's cards read it too, for their "Connected" tag). */
export function useOAuthGrants() {
  return useQuery({ queryKey: OAUTH_GRANTS_KEY, queryFn: ({ signal }) => fetchOAuthGrants(signal), refetchOnWindowFocus: true });
}

/**
 * What a Disconnect asks to end: every connection of one assistant. A row's Disconnect names one; a card's (v31
 * FIX-WEB, REV-UX UX-6) names all of that assistant's (usually one). `kind` is the card's, for focus after it.
 */
export interface DisconnectRequest {
  name: string;
  items: readonly OAuthGrantItem[];
  from: 'row' | 'card';
  kind?: OAuthGrantItem['clientKind'];
}

export function ConnectedAssistants({
  onDisconnect,
  headingRef,
}: {
  onDisconnect: (request: DisconnectRequest) => void;
  /** The section's heading: where focus goes once the row a person disconnected is gone. */
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const now = useNow();
  const grants = useOAuthGrants();

  return (
    <IntegrationSection
      title={AI_COPY.connectedTitle}
      headingRef={headingRef}
      aside={grants.data && grants.data.items.length > 0 ? <CountBadge count={grants.data.items.length} /> : undefined}
    >
      {grants.isError ? (
        <Notice
          tone="error"
          title={AI_COPY.connectedFailed}
          action={
            <Button variant="outline" size="sm" onClick={() => void grants.refetch()}>
              Try again
            </Button>
          }
        >
          {userMessage(grants.error)}
        </Notice>
      ) : grants.isPending ? (
        <div aria-busy="true" aria-label={AI_COPY.connectedLoading}>
          <Skeleton className="h-12 w-full" rounded="control" />
        </div>
      ) : (
        <GrantList items={grants.data.items} now={now} onDisconnect={(item) => onDisconnect({ name: item.clientName, items: [item], from: 'row' })} />
      )}
    </IntegrationSection>
  );
}

/**
 * The Disconnect confirm (a row's or a card's): it names the assistant, ends each of its connections (DELETE
 * /api/oauth/grants/:id; one already gone counts as ended) and takes them off the list. Cancel puts focus back on the
 * button that opened it; once they are gone, a row's goes to the Connected heading and a card's to the card's Connect.
 */
export function DisconnectDialog({
  request,
  onClose,
  headingRef,
}: {
  request: DisconnectRequest | null;
  onClose: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const removed = useRef<DisconnectRequest | null>(null);
  const name = request?.name;

  return (
    <ConfirmDialog
      open={request !== null}
      onOpenChange={(open) => !open && onClose()}
      finalFocus={() => {
        const done = removed.current;
        removed.current = null;
        if (!done) return true;
        const connect = done.from === 'card' ? document.querySelector<HTMLElement>(`[data-ai-client="${done.kind}"] [data-ai-connect]`) : null;
        return connect ?? headingRef.current;
      }}
      title={AI_COPY.disconnectTitle(name ?? 'this assistant')}
      description={AI_COPY.disconnectBody(name ?? 'It')}
      confirmLabel={AI_COPY.disconnect}
      busyLabel={AI_COPY.disconnecting}
      onConfirm={async () => {
        if (!request) return;
        removed.current = null;
        for (const { id } of request.items) {
          try {
            await revokeOAuthGrant(id);
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) throw error;
          }
        }
        removed.current = request;
        const gone = new Set(request.items.map((item) => item.id));
        queryClient.setQueryData<OAuthGrantList>(OAUTH_GRANTS_KEY, (previous) =>
          previous ? { items: previous.items.filter((item) => !gone.has(item.id)) } : previous,
        );
        toast.success(AI_COPY.disconnected(request.name));
      }}
    />
  );
}

/** The connected assistants, each with its mark, name, use and Disconnect; a line saying what to do without any. */
export function GrantList({
  items,
  now,
  onDisconnect,
}: {
  items: readonly OAuthGrantItem[];
  now: number;
  onDisconnect: (item: OAuthGrantItem) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-1.5 rounded-control bg-surface-low px-4 py-3.5 text-sm leading-5" data-connected-empty="">
        <p className="font-semibold text-foreground">{AI_COPY.connectedEmpty}</p>
        <HelpTip label={AI_COPY.connectedEmpty}>{AI_COPY.connectedEmptyHint}</HelpTip>
      </div>
    );
  }
  return (
    <ul aria-label={AI_COPY.connectedList} className="-my-3 flex flex-col divide-y divide-divider-soft">
      {items.map((item) => {
        const host = grantHost(item);
        return (
          <li key={item.id} data-grant-kind={item.clientKind} className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-2 py-3 scroll-mt-topbar">
            <ClientMark kind={item.clientKind} name={item.clientName} />
            <div className="min-w-0 flex-1 basis-48">
              <p className="text-[15px] leading-5 font-semibold break-words text-foreground">
                {item.clientName}
                {host && <span className="ml-2 text-[13px] font-normal text-muted-foreground">{host}</span>}
              </p>
              <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
                {grantLine(item, (value) => formatDate(value), (value) => relativeTime(value, now))}
              </p>
            </div>
            <Button variant="destructive-outline" size="sm" onClick={() => onDisconnect(item)} aria-label={`${AI_COPY.disconnect} ${item.clientName}`}>
              {AI_COPY.disconnect}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
