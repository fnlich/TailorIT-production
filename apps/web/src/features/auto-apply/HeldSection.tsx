'use client';

import { initialsOf } from '@tailorit/shared/auth';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useRef, useState } from 'react';
// Relative, not '@/': the web tests draw these views.
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { HelpTip } from '../../components/ui/HelpTip';
import { LetterAvatar } from '../../components/ui/LetterAvatar';
import { LoadError } from '../../components/ui/LoadError';
import { useToast } from '../../components/ui/Toast';
import { ApiError, userMessage } from '../../lib/api';
import { relativeTime } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import { useTabProfile } from '../sharing/access';
import { autoApplyKeys } from './api';
import { HELD_COPY, approveHeld, fetchHeld, heldKeys, rejectHeld, type HeldGroup } from './held';

// v33 SHARE-7 (PLAN F9 "Prepare and the queue"; SP v33 PLAN-sharing.md §6 "Jobs wait for A's OK"): Auto-apply's "Waiting
// for your OK" card, on the person's own profile only: one line per person they share their profile with who prepared
// jobs on it, "From Bob · 12 wait for your OK", with Approve all and Remove (each a ConfirmDialog opening on Cancel).
// Nothing shows when nothing waits (or before the API has the route: a 404 is "none").
// The confirm reads the list again as it opens and shows that count; its Approve all or Remove sends `through` = that
// read's newest held time, so a job B prepares after the read (or while the confirm stays open) waits for another OK.

/** How often the card asks again (the Queue pane's slow pace). */
export const HELD_POLL_MS = 30_000;

/** The confirm: which share and what to do; `group` is the share's jobs as the confirm read them (null while reading). */
type Pending = { kind: 'approve' | 'remove'; grantKey: string; name: string; group: HeldGroup | null } | null;

const nameOf = (group: HeldGroup) => group.name.trim() || group.email;

export function HeldSection({ className }: { className?: string }) {
  const { key } = useTabProfile();
  const queryClient = useQueryClient();
  const toast = useToast();
  const held = useQuery({
    queryKey: heldKeys.held,
    queryFn: ({ signal }) => fetchHeld(signal),
    // Approving is the owner's alone: never asked for on a shared profile.
    enabled: key === null,
    refetchInterval: HELD_POLL_MS,
    retry: false,
  });
  const [pending, setPending] = useState<Pending>(null);
  // Each opening's read; a read that ends after the confirm closed (or another opened) changes nothing.
  const reading = useRef(0);

  /** Opens the confirm on `group`'s share and reads how many of its jobs wait now. */
  const ask = async (kind: 'approve' | 'remove', group: HeldGroup) => {
    const name = nameOf(group);
    const read = ++reading.current;
    setPending({ kind, grantKey: group.grantKey, name, group: null });
    try {
      const fresh = await queryClient.fetchQuery({ queryKey: heldKeys.held, queryFn: ({ signal }) => fetchHeld(signal), staleTime: 0 });
      if (reading.current !== read) return;
      const now = fresh.groups.find((one) => one.grantKey === group.grantKey && one.count > 0) ?? null;
      if (!now) {
        setPending(null);
        toast.info(HELD_COPY.noneLeft(name));
        return;
      }
      setPending({ kind, grantKey: group.grantKey, name, group: now });
    } catch (error) {
      if (reading.current !== read) return;
      setPending(null);
      toast.error(HELD_COPY.readFailed, userMessage(error));
    }
  };

  if (key !== null) return null;
  if (held.isError) {
    if (held.error instanceof ApiError && held.error.status === 404) return null;
    return (
      <div className={className} data-held-load-failed="">
        <LoadError thing="Jobs waiting for your OK" error={held.error} onRetry={() => void held.refetch()} />
      </div>
    );
  }
  const groups = held.data?.groups.filter((group) => group.count > 0) ?? [];
  if (groups.length === 0) return null;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: heldKeys.held });
    void queryClient.invalidateQueries({ queryKey: autoApplyKeys.all });
    void queryClient.invalidateQueries({ queryKey: ['sharing', 'overview'] });
  };

  return (
    <>
      <HeldGroupsView
        className={className}
        groups={groups}
        onApprove={(group) => void ask('approve', group)}
        onRemove={(group) => void ask('remove', group)}
      />
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (open) return;
          reading.current += 1;
          setPending(null);
        }}
        tone={pending?.kind === 'remove' ? 'destructive' : 'primary'}
        title={
          !pending
            ? ''
            : !pending.group
              ? HELD_COPY.checkingTitle(pending.name)
              : pending.kind === 'approve'
                ? HELD_COPY.approveTitle(pending.group.count, pending.name)
                : HELD_COPY.removeTitle(pending.group.count, pending.name)
        }
        description={
          pending && !pending.group
            ? HELD_COPY.checkingDescription
            : pending?.kind === 'remove'
              ? HELD_COPY.removeDescription
              : HELD_COPY.approveDescription
        }
        confirmLabel={pending?.kind === 'remove' ? HELD_COPY.removeConfirm : HELD_COPY.approveConfirm}
        busyLabel={pending?.kind === 'remove' ? HELD_COPY.removing : HELD_COPY.approving}
        // Nothing to decide until the confirm has read what waits now.
        confirmDisabled={!pending?.group}
        // Both change what the extension applies to: they open on Cancel.
        focusCancel
        onConfirm={async () => {
          const group = pending?.group;
          if (!pending || !group) return;
          // Only the jobs the confirm showed: held at or before its read's newest.
          const scope = { through: group.newestAt };
          try {
            if (pending.kind === 'approve') {
              const { approved } = await approveHeld(pending.grantKey, scope);
              toast.success(HELD_COPY.approved(approved));
            } else {
              const { removed } = await rejectHeld(pending.grantKey, scope);
              toast.success(HELD_COPY.removed(removed));
            }
          } finally {
            refresh();
          }
        }}
      />
    </>
  );
}

/** The card itself (drawn statically by the tests). */
export function HeldGroupsView({
  groups,
  onApprove,
  onRemove,
  className,
  now,
}: {
  groups: readonly HeldGroup[];
  onApprove: (group: HeldGroup) => void;
  onRemove: (group: HeldGroup) => void;
  className?: string;
  /** The clock the times are counted from (the tests fix it; else the page-wide clock). */
  now?: number;
}) {
  const clock = useNow();
  const at = now ?? clock;
  return (
    <Card as="section" padding="none" className={clsx('p-4 sm:p-5', className)} aria-labelledby="held-title" data-held="">
      <div className="flex items-center gap-1.5">
        <h2 id="held-title" className="text-heading font-semibold text-foreground">
          {HELD_COPY.title}
        </h2>
        <HelpTip label={HELD_COPY.title}>{HELD_COPY.tip}</HelpTip>
      </div>
      <ul className="mt-3 flex flex-col divide-y divide-divider-soft">
        {groups.map((group) => {
          const name = nameOf(group);
          return (
            <li
              key={group.grantKey}
              className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4"
              data-held-group={group.grantKey}
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <LetterAvatar letters={initialsOf(group.name, group.email)} size={36} tone="tint" shape="circle" />
                <div className="min-w-0">
                  <p className="text-sm leading-5 font-semibold text-foreground" data-held-line="">
                    {HELD_COPY.group(name, group.count)}
                  </p>
                  <p className="truncate text-[13px] leading-5 text-muted-foreground">
                    {`${group.email} · ${relativeTime(group.oldestAt, at)}`}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2 pl-12 sm:pl-0">
                <Button size="sm" onClick={() => onApprove(group)} data-held-approve="">
                  {HELD_COPY.approveAll}
                  <span className="sr-only">{` from ${name}`}</span>
                </Button>
                <Button size="sm" variant="destructive-outline" onClick={() => onRemove(group)} data-held-remove="">
                  {HELD_COPY.remove}
                  <span className="sr-only">{` the jobs from ${name}`}</span>
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
