import { SHARING_SETTINGS_PATH } from '@tailorit/shared/sharing';
import type { NotificationKind } from '@tailorit/shared/notifications';
import type { AppDeps } from '../../core/context';
import { notify, type NotifyOutcome } from '../notifications/index';
import { nameOrEmail } from './rows';

// v33 SHARE-2 (PLAN F9; SP v33 PLAN-sharing.md §10): the sharing notifications this feature writes. Each names the other
// person ({name}: their name, else their address) and links to Settings › Sharing (no `as`: the recipient's own
// profile). One per grant and event (the dedupe key), so a retry or a second process never writes it twice.
//   sharing_invited  → B (lazily, when B's header first counts the invite: invites.ts noticeInvites)
//   sharing_changed  → B (A changed the boxes or the end date of an accepted share; one per change)
//   sharing_accepted → A, sharing_declined → A
//   sharing_ended    → the other side (A stopped: B; B left: A; the end date passed: both)
// (sharing_prepared, to A, is Prepare's: SHARE-5.)

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

type SharingKind = Extract<NotificationKind, `sharing_${string}`>;

/** Writes `kind` for `recipientId` about `other`; never throws (notify's rule). */
export function notifySharing(
  deps: Deps,
  recipientId: string,
  kind: SharingKind,
  other: { name: string | null | undefined; email: string },
  dedupeKey: string,
): Promise<NotifyOutcome> {
  return notify(deps, recipientId, {
    kind,
    params: { name: nameOrEmail(other) },
    link: SHARING_SETTINGS_PATH,
    dedupeKey,
  });
}

/** The dedupe key of a grant's notification of `kind` (`sharing_changed` adds the change's time). */
export function sharingDedupeKey(kind: SharingKind, grantId: string, at?: string): string {
  return at ? `${kind}:${grantId}:${at}` : `${kind}:${grantId}`;
}
