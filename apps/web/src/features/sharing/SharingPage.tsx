'use client';

import { initialsOf } from '@tailorit/shared/auth';
import {
  SHARE_PRESET_LABELS,
  SHARING_SETTINGS_PATH,
  isGrantEnded,
  presetOf,
  type GrantView,
  type SharedProfile,
  type SharingInvite,
} from '@tailorit/shared/sharing';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useState, type ReactNode } from 'react';
// Relative, not '@/': the web tests draw these views.
import { PAGE_GUTTER } from '../../components/shell/layout';
import { profileName, useProfile, useSharedProfiles } from '../../components/shell/profile/useProfile';
import { Badge, type BadgeProps } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LetterAvatar } from '../../components/ui/LetterAvatar';
import { LoadError } from '../../components/ui/LoadError';
import { PageHeader } from '../../components/ui/PageHeader';
import { Skeleton } from '../../components/ui/Skeleton';
import { useToast } from '../../components/ui/Toast';
import { Tooltip } from '../../components/ui/Tooltip';
import { userMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { usePublicConstants } from '../../lib/constants';
import { formatDate } from '../../lib/format';
import { Section } from '../settings/parts';
import { ActivitySection } from './ActivitySection';
import { acceptInvite, declineInvite, fetchGrants, invalidateSharing, leaveProfile, sharingKeys, stopGrant } from './api';
import { SHARING_COPY } from './copy';
import { GrantDialog, type GrantDialogMode } from './GrantDialog';

// v33 SHARE-7 (PLAN F9 "Grants"; SP v33 PLAN-sharing.md §2, §9 "Settings › Sharing", §10): Settings › Sharing
// (/settings/sharing, in the account menu; only ever on the person's own profile: AuthGate switches a tab on a shared
// profile back first). Three cards:
// - Shared with you: invites (Accept, Decline) and the profiles shared with the person (Open, Leave);
// - People you share with: Share your profile (the dialog), and each share (Change, Stop sharing; an invite: Change,
//   Copy link, Cancel invite; an ended one: Send again);
// - Activity: hourly counts of what was done on a shared profile, both sides.
// Stop and Leave are ConfirmDialogs opening on Cancel. A list that does not load is the kit's LoadError ("Sharing didn't
// load."); with sharing off (SHARING_ENABLED) the page says so and lists nothing.

export function SharingPage() {
  const { t } = usePublicConstants();
  const shared = useSharedProfiles();
  const off = shared.settled && !shared.failed && !shared.data.enabled;
  return (
    <div className={clsx('mx-auto w-full max-w-[880px] pt-7 pb-20', PAGE_GUTTER)} data-sharing-page="">
      <PageHeader title={SHARING_COPY.title} description={SHARING_COPY.description} />
      {off ? (
        // v3.2: a state the page is in is a quiet line, never a banner.
        <p className="mt-6 text-sm text-muted-foreground" data-sharing-off="">
          {t('MSG_SHARING_OFF')}
        </p>
      ) : (
        <>
          <SharedWithYou className="mt-6" />
          <PeopleYouShareWith className="mt-6" />
          <ActivitySection className="mt-6" />
        </>
      )}
    </div>
  );
}

// Shared with you ------------------------------------------------------------------------------------------------------

function SharedWithYou({ className }: { className?: string }) {
  const { account } = useAuth();
  const { t } = usePublicConstants();
  const toast = useToast();
  const queryClient = useQueryClient();
  const shared = useSharedProfiles();
  const { switchTo } = useProfile();
  const [leaving, setLeaving] = useState<SharedProfile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const answer = useMutation({
    mutationFn: ({ invite, accept }: { invite: SharingInvite; accept: boolean }) =>
      accept ? acceptInvite(invite.key) : declineInvite(invite.key),
    onMutate: ({ invite }) => setBusy(invite.key),
    onSuccess: (_done, { invite, accept }) => {
      const name = invite.fromName.trim() || invite.fromEmail;
      if (accept) toast.success(SHARING_COPY.accepted(name));
      else toast.info(SHARING_COPY.declined);
    },
    onError: (error, { accept }) => toast.error(accept ? SHARING_COPY.acceptFailed : SHARING_COPY.declineFailed, userMessage(error)),
    onSettled: () => {
      setBusy(null);
      void invalidateSharing(queryClient);
    },
  });

  const { profiles, invites } = shared.data;
  let body: ReactNode;
  if (shared.failed) {
    body = <LoadError thing={SHARING_COPY.loadThing} onRetry={shared.refetch} />;
  } else if (!shared.settled) {
    body = <RowsSkeleton count={2} />;
  } else if (profiles.length === 0 && invites.length === 0) {
    body = (
      <p className="text-sm text-muted-foreground" data-sharing-empty="with-you">
        {SHARING_COPY.withYouEmpty}
      </p>
    );
  } else {
    body = (
      <ul className="flex flex-col divide-y divide-divider-soft" aria-label={SHARING_COPY.withYouTitle}>
        {invites.map((invite) => {
          const name = invite.fromName.trim() || invite.fromEmail;
          return (
            <PersonRow
              key={invite.key}
              data={{ 'data-invite': invite.key }}
              initials={initialsOf(invite.fromName, invite.fromEmail)}
              name={name}
              email={invite.fromEmail}
              badge={<Badge tone="tint">{SHARING_COPY.invitedYou}</Badge>}
              details={[t(SHARE_PRESET_LABELS[presetOf(invite.permissions)]), SHARING_COPY.invitedExpires(formatDate(invite.expiresAt))]}
              actions={
                <>
                  <Button
                    size="sm"
                    loading={busy === invite.key && answer.variables?.accept === true}
                    disabled={busy !== null}
                    onClick={() => answer.mutate({ invite, accept: true })}
                  >
                    {SHARING_COPY.accept}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    loading={busy === invite.key && answer.variables?.accept === false}
                    disabled={busy !== null}
                    onClick={() => answer.mutate({ invite, accept: false })}
                  >
                    {SHARING_COPY.decline}
                  </Button>
                </>
              }
            />
          );
        })}
        {profiles.map((profile) => {
          const name = profileName(profile, account);
          return (
            <PersonRow
              key={profile.key}
              data={{ 'data-shared-profile': profile.key }}
              initials={initialsOf(profile.name, profile.email)}
              name={name}
              email={profile.email}
              badge={<Badge tone="success">{SHARING_COPY.state.active}</Badge>}
              details={[
                t(SHARE_PRESET_LABELS[presetOf(profile.permissions)]),
                profile.accessEndsAt ? SHARING_COPY.until(formatDate(profile.accessEndsAt)) : SHARING_COPY.noEnd,
              ]}
              actions={
                <>
                  <Button size="sm" variant="outline" onClick={() => void switchTo(profile.key, { to: '/jobs' })}>
                    {SHARING_COPY.open}
                    <span className="sr-only">{` ${name}'s profile`}</span>
                  </Button>
                  <Button size="sm" variant="destructive-outline" onClick={() => setLeaving(profile)}>
                    {SHARING_COPY.leave}
                    <span className="sr-only">{` ${name}'s profile`}</span>
                  </Button>
                </>
              }
            />
          );
        })}
      </ul>
    );
  }

  const leavingName = leaving ? profileName(leaving, account) : '';
  return (
    <Section title={SHARING_COPY.withYouTitle} description={SHARING_COPY.withYouTip} className={className} id="shared-with-you">
      {body}
      <ConfirmDialog
        open={leaving !== null}
        onOpenChange={(open) => !open && setLeaving(null)}
        title={SHARING_COPY.leaveTitle(leavingName)}
        description={SHARING_COPY.leaveDescription}
        confirmLabel={SHARING_COPY.leaveConfirm}
        busyLabel="Leaving..."
        focusCancel
        onConfirm={async () => {
          if (!leaving) return;
          await leaveProfile(leaving.key);
          toast.success(SHARING_COPY.left(leavingName));
          void invalidateSharing(queryClient);
        }}
      />
    </Section>
  );
}

// People you share with ------------------------------------------------------------------------------------------------

const STATE_TONE: Record<GrantView['state'], NonNullable<BadgeProps['tone']>> = {
  pending: 'tint',
  active: 'success',
  declined: 'neutral',
  revoked: 'neutral',
  left: 'neutral',
  expired: 'neutral',
};

function PeopleYouShareWith({ className }: { className?: string }) {
  const { t } = usePublicConstants();
  const toast = useToast();
  const queryClient = useQueryClient();
  const grants = useQuery({ queryKey: sharingKeys.grants, queryFn: ({ signal }) => fetchGrants(signal) });
  const [dialog, setDialog] = useState<GrantDialogMode | null>(null);
  const [stopping, setStopping] = useState<GrantView | null>(null);
  const [removeQueued, setRemoveQueued] = useState(true);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${SHARING_SETTINGS_PATH}`);
      toast.success(SHARING_COPY.copied);
    } catch {
      toast.error(SHARING_COPY.copyFailed);
    }
  };

  let body: ReactNode;
  if (grants.isError) {
    body = <LoadError thing={SHARING_COPY.loadThing} error={grants.error} onRetry={() => void grants.refetch()} />;
  } else if (grants.isPending) {
    body = <RowsSkeleton count={2} />;
  } else if (grants.data.grants.length === 0) {
    body = (
      <p className="text-sm text-muted-foreground" data-sharing-empty="with-others">
        {SHARING_COPY.withOthersEmpty}
      </p>
    );
  } else {
    body = (
      <ul className="flex flex-col divide-y divide-divider-soft" aria-label={SHARING_COPY.withOthersTitle}>
        {grants.data.grants.map((grant) => {
          const name = grant.name?.trim() || grant.email;
          const ended = isGrantEnded(grant.state);
          const details = ended
            ? [t(SHARE_PRESET_LABELS[grant.preset]), grant.endedAt ? formatDate(grant.endedAt) : null]
            : [
                t(SHARE_PRESET_LABELS[grant.preset]),
                grant.state === 'pending'
                  ? SHARING_COPY.invitedExpires(formatDate(grant.inviteExpiresAt))
                  : grant.accessEndsAt
                    ? SHARING_COPY.until(formatDate(grant.accessEndsAt))
                    : SHARING_COPY.noEnd,
              ];
          return (
            <PersonRow
              key={grant.key}
              data={{ 'data-grant': grant.key, 'data-grant-state': grant.state }}
              initials={initialsOf(grant.name ?? '', grant.email)}
              name={name}
              email={grant.name ? grant.email : grant.state === 'pending' ? SHARING_COPY.invitePending(grant.email) : null}
              badge={<Badge tone={STATE_TONE[grant.state]}>{SHARING_COPY.state[grant.state]}</Badge>}
              details={details}
              muted={ended}
              actions={
                ended ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDialog({ kind: 'create', email: grant.email, permissions: grant.permissions })}
                  >
                    {SHARING_COPY.sendAgain}
                    <span className="sr-only">{` to ${grant.email}`}</span>
                  </Button>
                ) : (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'change', grant, name })}>
                      {SHARING_COPY.change}
                      <span className="sr-only">{` what ${name} can do`}</span>
                    </Button>
                    {grant.state === 'pending' && (
                      <Tooltip content={SHARING_COPY.copyTip}>
                        <Button size="sm" variant="ghost" onClick={() => void copyLink()}>
                          {SHARING_COPY.copyLink}
                        </Button>
                      </Tooltip>
                    )}
                    <Button
                      size="sm"
                      variant="destructive-outline"
                      onClick={() => {
                        setRemoveQueued(true);
                        setStopping(grant);
                      }}
                    >
                      {grant.state === 'pending' ? SHARING_COPY.cancelInvite : SHARING_COPY.stop}
                      <span className="sr-only">{grant.state === 'pending' ? ` to ${grant.email}` : ` with ${name}`}</span>
                    </Button>
                  </>
                )
              }
            />
          );
        })}
      </ul>
    );
  }

  const stoppingName = stopping ? stopping.name?.trim() || stopping.email : '';
  const cancelling = stopping?.state === 'pending';
  return (
    <Section
      title={SHARING_COPY.withOthersTitle}
      description={SHARING_COPY.withOthersTip}
      className={className}
      id="people-you-share-with"
      actions={
        <Button size="sm" onClick={() => setDialog({ kind: 'create' })} data-share-profile="">
          {SHARING_COPY.share}
        </Button>
      }
    >
      {body}
      <GrantDialog mode={dialog} onOpenChange={(open) => !open && setDialog(null)} />
      <ConfirmDialog
        open={stopping !== null}
        onOpenChange={(open) => !open && setStopping(null)}
        title={cancelling ? SHARING_COPY.cancelTitle(stopping?.email ?? '') : SHARING_COPY.stopTitle(stoppingName)}
        description={cancelling ? SHARING_COPY.cancelDescription : SHARING_COPY.stopDescription}
        confirmLabel={cancelling ? SHARING_COPY.cancelConfirm : SHARING_COPY.stopConfirm}
        cancelLabel={cancelling ? SHARING_COPY.keepInvite : 'Cancel'}
        busyLabel="Stopping..."
        focusCancel
        onConfirm={async () => {
          if (!stopping) return;
          await stopGrant(stopping.key, cancelling ? true : removeQueued);
          toast.success(cancelling ? SHARING_COPY.cancelled : SHARING_COPY.stopped(stoppingName));
          void invalidateSharing(queryClient);
        }}
      >
        {!cancelling && (
          <Checkbox
            checked={removeQueued}
            onCheckedChange={(next) => setRemoveQueued(next)}
            label={SHARING_COPY.stopRemoveQueued}
          />
        )}
      </ConfirmDialog>
    </Section>
  );
}

// Parts ------------------------------------------------------------------------------------------------------------------

/** One person of a list: their initials, name and email, a state badge, a details line, and the row's actions. */
function PersonRow({
  initials,
  name,
  email,
  badge,
  details,
  actions,
  muted = false,
  data,
}: {
  initials: string;
  name: string;
  email: string | null;
  badge: ReactNode;
  details: readonly (string | null)[];
  actions: ReactNode;
  muted?: boolean;
  data?: Record<`data-${string}`, string>;
}) {
  const line = details.filter((part): part is string => Boolean(part)).join(' · ');
  return (
    <li className="flex flex-col gap-3 py-3.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4" {...data}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <LetterAvatar letters={initials} size={36} tone={muted ? 'neutral' : 'tint'} shape="circle" />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className={clsx('truncate text-sm leading-5 font-semibold', muted ? 'text-muted-foreground' : 'text-foreground')}>{name}</span>
            {badge}
          </p>
          {email && <p className="truncate text-[13px] leading-5 text-muted-foreground">{email}</p>}
          {line && <p className="text-[13px] leading-5 text-muted-foreground">{line}</p>}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 pl-12 sm:pl-0">{actions}</div>
    </li>
  );
}

function RowsSkeleton({ count }: { count: number }) {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <span className="sr-only">Loading</span>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} aria-hidden="true" className="flex items-center gap-3">
          <Skeleton className="size-9" rounded="full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
