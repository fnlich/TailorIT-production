'use client';

import type { AccountDeletionState } from '@tailorit/shared/account-deletion';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { TrashIcon } from '@/components/ui/icons';
import { useToast } from '@/components/ui/Toast';
import { deleteAccountAsAdmin } from './api';
import { DELETE_COPY } from './copy';
import { DeleteAccountDialog } from './DeleteAccountDialog';

// v34 ACCTDEL (PLAN G10): Admin › Users › an account › Delete account, the last section of the account's sheet. Never
// the administrator's own account (that is Settings › Account › Delete my account); the server refuses it too, and the
// last administrator who can sign in. Deleted, the sheet closes and the list drops the account (onDeleted); when the
// rest finishes on its own (`pending`), the toast says so and the list shows the account as "Being deleted". An account
// already being deleted says so here, and Delete account finishes it now.

export function AdminDeleteAccount({
  user,
  isSelf,
  onDeleted,
}: {
  user: { id: string; email: string; name: string | null; beingDeleted?: boolean };
  isSelf: boolean;
  onDeleted: (id: string, state: AccountDeletionState) => void;
}) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const deleted = useRef(false);
  return (
    <section aria-label={DELETE_COPY.sectionAdmin} data-admin-delete-account={user.id}>
      <h3 className="mb-3 text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">{DELETE_COPY.sectionAdmin}</h3>
      {user.beingDeleted && !isSelf && (
        <p className="mb-3 text-[13px] leading-5 text-muted-foreground" data-admin-being-deleted="">
          {DELETE_COPY.beingDeletedNote}
        </p>
      )}
      <Button
        size="sm"
        variant="destructive-outline"
        icon={<TrashIcon size={16} aria-hidden="true" />}
        disabled={isSelf}
        onClick={() => setOpen(true)}
      >
        {DELETE_COPY.openAdmin}
      </Button>
      {isSelf && <p className="mt-2 text-[13px] leading-5 text-muted-foreground">{DELETE_COPY.ownInAdmin}</p>}
      {!isSelf && (
        <DeleteAccountDialog
          open={open}
          onOpenChange={setOpen}
          email={user.email}
          mode="admin"
          who={user.name || user.email}
          // Deleted, the sheet and its row go: UsersTab moves the focus (the next row, or the list's heading). Cancelled,
          // it goes back to the button.
          finalFocus={() => !deleted.current}
          onConfirm={async (typed) => {
            const done = await deleteAccountAsAdmin(user.id, typed);
            deleted.current = true;
            if (done.state === 'pending') toast.info(DELETE_COPY.adminPending, done.message);
            else toast.success(DELETE_COPY.adminDone);
            onDeleted(user.id, done.state);
          }}
        />
      )}
    </section>
  );
}
