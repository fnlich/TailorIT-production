'use client';

import { PuzzlePieceIcon } from '@phosphor-icons/react/PuzzlePiece';
import type { AutofillTokenItem, AutofillTokenList } from '@tailorit/shared/autofill';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { HelpTip } from '@/components/ui/HelpTip';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { ApiError, userMessage } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { autofillKeys, createConnectCode, disconnectExtension, fetchExtensionConnections } from '../api';
import { sendConnectCode } from '../extensionBridge';
import { Section } from '../Section';
import { ConnectCodeDialog, type CodeOffer } from './ConnectCodeDialog';
import { isOlderConnection } from './connection';
import { SiteRequestsSection } from './SiteRequestsSection';

/** How often the open code dialog looks for the new connection. */
const CONNECTION_POLL_MS = 3_000;

/**
 * Settings › Autofill › Extension: connect the TailorIT extension in this browser, and see or disconnect the browsers
 * it is connected in. The extension's options page opens it with `connect=1` (which only focuses the button) and a
 * one-time pairing `state`: the code made by "Connect the extension" then goes straight to the extension, and only
 * when that fails is it shown for the person to type.
 */
export function ExtensionTab({
  pairingState,
  focusConnect,
  includeSensitive,
  onIncludeSensitiveChange,
  allowSignIn,
  onAllowSignInChange,
  onPairingUsed,
}: {
  /** The extension's pairing state from the page's address (already checked), or null. */
  pairingState: string | null;
  focusConnect: boolean;
  /** The box for the sensitive answers: the page holds it, so a visit to the Profile tab keeps the choice. */
  includeSensitive: boolean;
  onIncludeSensitiveChange: (include: boolean) => void;
  /** The box for the saved job-site password (Sign-in mode Auto), unticked until the person ticks it. */
  allowSignIn: boolean;
  onAllowSignInChange: (allow: boolean) => void;
  /** The state has been offered once: the page drops it from its address. */
  onPairingUsed: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const connectButton = useRef<HTMLButtonElement>(null);
  const [offer, setOffer] = useState<CodeOffer | null>(null);
  const [disconnecting, setDisconnecting] = useState<AutofillTokenItem | null>(null);

  const connections = useQuery({
    queryKey: autofillKeys.tokens,
    queryFn: ({ signal }) => fetchExtensionConnections(signal),
    // While the code is on screen, the extension may use it at any moment.
    refetchInterval: (query) =>
      offer && !hasNewConnection(query.state.data, offer) ? CONNECTION_POLL_MS : false,
  });
  const connectedWithCode = offer !== null && hasNewConnection(connections.data, offer);

  useEffect(() => {
    if (focusConnect) connectButton.current?.focus();
  }, [focusConnect]);

  // The code dialog closes as the new connection appears; say so once for that code. The sign-in box goes back to
  // unticked: each connection is asked anew whether it may read the saved password.
  const announced = useRef<CodeOffer | null>(null);
  useEffect(() => {
    if (!connectedWithCode || announced.current === offer) return;
    announced.current = offer;
    onAllowSignInChange(false);
    toast.success('Extension connected');
  }, [connectedWithCode, offer, toast, onAllowSignInChange]);

  const connect = useMutation({
    mutationFn: async () => {
      // The connections as they are now: one that appears after this is the code's.
      const before = await queryClient.fetchQuery({
        queryKey: autofillKeys.tokens,
        queryFn: ({ signal }) => fetchExtensionConnections(signal),
        staleTime: 0,
      });
      const minted = await createConnectCode({ includeSensitive, allowSignIn });
      const handed = await sendConnectCode({ state: pairingState, code: minted.code, extensionIds: minted.extensionIds });
      return { minted, handed, known: new Set(before.items.map((item) => item.id)) };
    },
    onSuccess: ({ minted, handed, known }) => {
      if (pairingState) onPairingUsed();
      if (handed.ok) {
        setOffer(null);
        onAllowSignInChange(false);
        toast.success('Extension connected');
        void queryClient.invalidateQueries({ queryKey: autofillKeys.tokens });
        return;
      }
      // With a state, the extension asked for the code: nothing to try (no runtime, no ids) is a failure to explain too.
      const failure = pairingState && handed.reason === 'unavailable' ? 'failed' : handed.reason;
      setOffer({ code: minted.code, expiresAt: minted.expiresAt, known, failure });
    },
    onError: (error) => toast.error('The extension could not be connected', userMessage(error)),
  });

  const items = connections.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Connect the extension"
        description="Fills applications, adds jobs, attaches letters and auto-applies; connect each browser once."
      >
        <div className="flex flex-col items-start gap-4">
          {pairingState && (
            <span className="inline-flex items-center gap-1" data-pairing-waiting="">
              <Badge tone="sky">The extension is waiting to connect</Badge>
              <HelpTip label="The extension is waiting to connect">Press Connect the extension to finish.</HelpTip>
            </span>
          )}
          <span className="flex items-start gap-1.5">
            <Checkbox
              label="Let this browser read and change work authorization and self-identification answers"
              checked={includeSensitive}
              disabled={connect.isPending}
              onCheckedChange={onIncludeSensitiveChange}
            />
            <HelpTip label="Work authorization and self-identification">Without it, you answer those on each form.</HelpTip>
          </span>
          <span className="flex items-start gap-1.5">
            <Checkbox
              label="Let this browser sign in to job sites with my saved password"
              checked={allowSignIn}
              disabled={connect.isPending}
              onCheckedChange={onAllowSignInChange}
            />
            <HelpTip label="Job-site sign-in">
              Sign-in Auto may type your saved password or create an account with it, asked for each connection.
            </HelpTip>
          </span>
          <Button ref={connectButton} loading={connect.isPending} onClick={() => connect.mutate()}>
            Connect the extension
          </Button>
        </div>
      </Section>

      <Section
        title="Connected browsers"
        description="Each lasts until the date shown; disconnect one to stop it now."
      >
        {connections.isError ? (
          <Notice
            tone="error"
            title="Your connections didn't load."
            action={
              <Button variant="outline" size="sm" onClick={() => void connections.refetch()}>
                Try again
              </Button>
            }
          >
            {userMessage(connections.error)}
          </Notice>
        ) : connections.isPending ? (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading your connections">
            <Skeleton className="h-14 w-full" rounded="control" />
            <Skeleton className="h-14 w-full" rounded="control" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col gap-4">
            <EmptyState
              icon={<PuzzlePieceIcon size={24} />}
              title="No browser is connected"
              description="Install it, then connect it here or from its options page."
              variant="dashed"
              size="md"
            />
            <InstallSteps />
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-border" aria-label="Connected browsers">
            {items.map((item) => (
              <ConnectionRow key={item.id} item={item} now={now} onDisconnect={() => setDisconnecting(item)} />
            ))}
          </ul>
        )}
      </Section>

      <SiteRequestsSection />

      {offer && (
        <ConnectCodeDialog
          offer={offer}
          open={!connectedWithCode}
          renewing={connect.isPending}
          onRenew={() => connect.mutate()}
          onClose={() => setOffer(null)}
        />
      )}

      <ConfirmDialog
        open={disconnecting !== null}
        onOpenChange={(open) => !open && setDisconnecting(null)}
        title={`Disconnect ${disconnecting?.label ?? 'this browser'}?`}
        description="The extension stops filling until you connect it again."
        confirmLabel="Disconnect"
        busyLabel="Disconnecting..."
        onConfirm={async () => {
          if (!disconnecting) return;
          const { id, label } = disconnecting;
          try {
            await disconnectExtension(id);
          } catch (error) {
            // Already gone (disconnected from the extension, or expired and removed): the list just catches up.
            if (!(error instanceof ApiError && error.status === 404)) throw error;
          }
          queryClient.setQueryData<AutofillTokenList>(autofillKeys.tokens, (previous) =>
            previous
              ? { items: previous.items.filter((other) => other.id !== id), total: Math.max(0, previous.total - 1) }
              : previous,
          );
          toast.success(`${label} disconnected`);
        }}
      />
    </div>
  );
}

/** Whether a connection appeared that was not there when the code was made. */
function hasNewConnection(list: AutofillTokenList | undefined, offer: CodeOffer): boolean {
  return Boolean(list?.items.some((item) => !offer.known.has(item.id)));
}

function ConnectionRow({ item, now, onDisconnect }: { item: AutofillTokenItem; now: number; onDisconnect: () => void }) {
  const expired = Date.parse(item.expiresAt) <= now;
  const sensitive = item.scopes.includes('profile:sensitive');
  const older = !expired && isOlderConnection(item.scopes);
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
          {item.label}
          {expired && <Badge tone="warning">Expired</Badge>}
          {older && (
            <span className="inline-flex items-center gap-1">
              <Badge tone="warning">Connect again</Badge>
              <HelpTip label="Connect again">Connected before auto-apply and sign-in existed; connect again to use them.</HelpTip>
            </span>
          )}
        </p>
        <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
          Connected {formatDate(item.createdAt)} · Last used {item.lastUsedAt ? relativeTime(item.lastUsedAt, now) : 'never'} ·{' '}
          {expired ? 'Expired' : 'Expires'} {formatDate(item.expiresAt)}
        </p>
        <p className="text-[13px] leading-5 text-muted-foreground">
          {sensitive
            ? 'Reads and changes work authorization and self-identification answers'
            : 'Does not read work authorization or self-identification answers'}
          {item.extensionVersion ? ` · Extension ${item.extensionVersion}` : ''}
        </p>
        <p className="text-[13px] leading-5 text-muted-foreground">
          {item.signIn ? 'Can read your saved job-site password' : 'Cannot read your saved job-site password'}
        </p>
      </div>
      <Button variant="destructive-outline" size="sm" onClick={onDisconnect}>
        Disconnect
      </Button>
    </li>
  );
}

/** "Load unpacked", until the extension is published. */
function InstallSteps() {
  return (
    <div className="rounded-control bg-surface-low px-4 py-3.5 text-sm leading-5 text-foreground">
      <p className="font-semibold">Install the extension</p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
        <li>
          Build it: run <code className="font-mono text-[13px] text-foreground">npm run build</code> in the TailorIT-autofill
          folder.
        </li>
        <li>
          Open <code className="font-mono text-[13px] text-foreground">chrome://extensions</code> (or{' '}
          <code className="font-mono text-[13px] text-foreground">edge://extensions</code>) and turn on Developer mode.
        </li>
        <li>
          Choose Load unpacked and pick its <code className="font-mono text-[13px] text-foreground">.output/chrome-mv3</code>{' '}
          folder (<code className="font-mono text-[13px] text-foreground">.output/edge-mv3</code> for Edge).
        </li>
        <li>Connect it with the button above, or from the extension&apos;s options page.</li>
      </ol>
    </div>
  );
}
