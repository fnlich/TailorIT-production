'use client';

import { KeyIcon } from '@phosphor-icons/react/Key';
import { AUTOFILL_ANY_HOST, type AutofillSignInItem, type AutofillSignInList } from '@tailorit/shared/autofill';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { LockSimpleIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/IconButton';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { neighbourOf } from '@/features/documents/core/focusAfterRemoval';
import { ApiError, userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { focusLater } from '@/lib/focusLater';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { autofillKeys, deleteSignIn, fetchExtensionConnections, fetchSignIns } from '../api';
import { Section } from '../Section';
import { SignInDialog } from './SignInDialog';
import { EVERY_SITE_COVERS, hostLabel, lastReadLine } from './signIn';

const DESCRIPTION =
  'For job sites that make you sign in or create an account before you can apply (Workday and others): the email ' +
  'and password you use there, one for every site and, where a site needs its own, one for that site.';

/** "Adding" (null) or the sign-in being edited; undefined while the dialog is closed. */
type Editing = AutofillSignInItem | null | undefined;

/** The list as the API orders it: every site's first, then by host. */
function ordered(items: AutofillSignInItem[]): AutofillSignInItem[] {
  return [...items].sort((a, b) => {
    if (a.host === AUTOFILL_ANY_HOST) return -1;
    if (b.host === AUTOFILL_ANY_HOST) return 1;
    return a.host.localeCompare(b.host);
  });
}

/**
 * Settings › Autofill › Job-site sign-in: the sign-ins the extension's Sign-in mode Auto uses, listed by site and email
 * (a password is never shown, and never comes back from TailorIT to this page), added or edited in a dialog, deleted
 * after a confirmation.
 */
export function SignInTab() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = usePublicConstants();
  const now = useNow();
  const [editing, setEditing] = useState<Editing>(undefined);
  const [deleting, setDeleting] = useState<AutofillSignInItem | null>(null);

  const signIns = useQuery({ queryKey: autofillKeys.signIns, queryFn: ({ signal }) => fetchSignIns(signal) });
  const items = signIns.data?.items ?? [];
  const full = signIns.data ? items.length >= signIns.data.limit : false;
  // A sign-in is read only by a connection made with its box ticked: say so when none was.
  const connections = useQuery({
    queryKey: autofillKeys.tokens,
    queryFn: ({ signal }) => fetchExtensionConnections(signal),
    enabled: items.length > 0,
  });
  const noReader =
    items.length > 0 && connections.data !== undefined && !connections.data.items.some((connection) => connection.signIn);

  /** The list with one sign-in put in (a save, replacing the one for its site) or taken out (a delete). */
  const update = (removeId: string | null, next: AutofillSignInItem | null) =>
    queryClient.setQueryData<AutofillSignInList>(autofillKeys.signIns, (previous) => {
      if (!previous) return previous;
      const kept = previous.items.filter((item) => item.id !== removeId && item.host !== next?.host);
      const list = ordered(next ? [...kept, next] : kept);
      return { ...previous, items: list, total: list.length };
    });

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Job-site sign-in"
        description={DESCRIPTION}
        action={
          signIns.data && items.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              icon={<PlusIcon size={14} />}
              disabled={full}
              onClick={() => setEditing(null)}
              className="shrink-0"
              data-sign-in-add=""
            >
              Add sign-in
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-5">
          <Notice tone="info" title="Kept encrypted in TailorIT on this computer">
            Your passwords are stored encrypted and never shown again, here or anywhere else. The TailorIT extension reads
            one only when its Sign-in mode is Auto, to sign you in on that site, and never stores it. Where you have no
            account yet, Sign-in Auto may create one with this email and password, so use a password you use only for
            job sites. Email codes and CAPTCHAs always need you.
          </Notice>
          <p className="-mt-1 text-[13px] leading-5 text-muted-foreground">
            The sign-in for all job sites is used only on {EVERY_SITE_COVERS}, where job applications need an account.
            Any other site needs a sign-in of its own, and a site with one uses that one.
          </p>

          {noReader && (
            <Notice tone="warning" title="No connected browser may use it yet">
              Connect the extension again from the{' '}
              <Link href="/settings/autofill?tab=extension" className="font-semibold underline underline-offset-2">
                Extension tab
              </Link>{' '}
              with “Let this browser sign in to job sites with my saved password” ticked.
            </Notice>
          )}

          {signIns.isError ? (
            <Notice
              tone="error"
              title="Your job-site sign-ins could not be loaded"
              action={
                <Button variant="outline" size="sm" onClick={() => void signIns.refetch()}>
                  Try again
                </Button>
              }
            >
              {userMessage(signIns.error)}
            </Notice>
          ) : signIns.isPending ? (
            <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading your job-site sign-ins">
              <Skeleton className="h-14 w-full" rounded="control" />
              <Skeleton className="h-14 w-full" rounded="control" />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<KeyIcon size={24} />}
              title="No job-site sign-in yet"
              description="Add the email and password you use on job sites, so the extension can sign in for you when its Sign-in mode is Auto."
              action={
                <Button icon={<PlusIcon size={16} />} onClick={() => setEditing(null)} data-sign-in-add="">
                  Add sign-in
                </Button>
              }
              variant="dashed"
              size="md"
            />
          ) : (
            <>
              <ul className="flex flex-col divide-y divide-border" aria-label="Job-site sign-ins">
                {items.map((item) => (
                  <SignInRow
                    key={item.id}
                    item={item}
                    now={now}
                    onEdit={() => setEditing(item)}
                    onDelete={() => setDeleting(item)}
                  />
                ))}
              </ul>
              {full && (
                <p className="text-[13px] leading-5 text-muted-foreground">
                  {t('MSG_SIGN_INS_MAX', { max: signIns.data?.limit ?? items.length })}
                </p>
              )}
            </>
          )}
        </div>
      </Section>

      {editing !== undefined && (
        <SignInDialog
          item={editing}
          items={items}
          onClose={() => setEditing(undefined)}
          onSaved={(saved, replaced) => {
            update(replaced?.id ?? null, saved);
            setEditing(undefined);
            toast.success('Sign-in saved', hostLabel(saved.host));
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete the sign-in for ${deleting ? hostLabel(deleting.host) : 'this site'}?`}
        description={
          deleting?.host === AUTOFILL_ANY_HOST
            ? 'The extension stops signing in with it on sites that have no sign-in of their own. Sites already signed in to in your browser stay signed in.'
            : 'The extension stops signing in with it there. A site already signed in to in your browser stays signed in.'
        }
        confirmLabel="Delete"
        busyLabel="Deleting..."
        onConfirm={async () => {
          if (!deleting) return;
          const { id, host } = deleting;
          try {
            await deleteSignIn(id);
          } catch (error) {
            // Already gone (deleted in another tab): the list just catches up.
            if (!(error instanceof ApiError && error.status === 404)) throw error;
          }
          // Focus goes to the next sign-in (else the one before, else Add sign-in), as this one leaves.
          const next = neighbourOf(
            items.map((item) => item.id),
            [id],
          );
          update(id, null);
          focusLater(...(next ? [`[data-sign-in="${CSS.escape(next)}"] button`] : []), '[data-sign-in-add]');
          toast.success('Sign-in deleted', hostLabel(host));
        }}
      />
    </div>
  );
}

function SignInRow({
  item,
  now,
  onEdit,
  onDelete,
}: {
  item: AutofillSignInItem;
  now: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const label = hostLabel(item.host);
  return (
    <li data-sign-in={item.id} className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-5 font-semibold break-words text-foreground">{label}</p>
        <p className="mt-0.5 text-sm leading-5 break-words text-foreground">{item.email}</p>
        <p className="mt-0.5 flex items-center gap-1 text-[13px] leading-5 text-muted-foreground">
          <LockSimpleIcon size={14} />
          <span>
            Password saved · Updated {relativeTime(item.updatedAt, now)} ·{' '}
            {lastReadLine(item, (iso) => relativeTime(iso, now))}
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          label={`Edit the sign-in for ${label}`}
          tooltip="Edit"
          icon={<PencilSimpleIcon size={16} />}
          onClick={onEdit}
        />
        <IconButton
          label={`Delete the sign-in for ${label}`}
          tooltip="Delete"
          icon={<TrashIcon size={16} />}
          onClick={onDelete}
        />
      </div>
    </li>
  );
}
