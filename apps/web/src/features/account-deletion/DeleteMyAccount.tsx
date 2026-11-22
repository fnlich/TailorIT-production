'use client';

import { accountDeletedLoginPath } from '@tailorit/shared/account-deletion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
// Relative, not '@/': the web tests draw this row.
import { Button } from '../../components/ui/Button';
import { HelpTip } from '../../components/ui/HelpTip';
import { TrashIcon } from '../../components/ui/icons';
import { fetchMe, ME_QUERY_KEY } from '../../lib/auth';
import { leaveForSignIn } from '../../lib/navigation';
import { forgetProfile } from '../../lib/profile';
import { DELETE_CHECK_QUERY_KEY, deleteMyAccount, fetchDeleteCheck } from './api';
import { DELETE_COPY } from './copy';
import { DeleteAccountDialog } from './DeleteAccountDialog';

// v34 ACCTDEL (PLAN G10): Settings › Account › Delete my account. The row sits at the end of the Account section (which
// is never shown on a profile shared with the person; the route refuses one anyway: acting `never`), drawn once the
// signed-in account is known, whether or not the plan summary above it loaded. The last administrator who can sign in
// sees the button off with why (GET /api/account/delete), before typing anything. Deleted, the tab forgets everything
// it held and goes to the sign-in page, which says the account was deleted (or, when the rest finishes on its own, that
// it is off and being deleted).

/** The row, once the signed-in account is known (its address is what the dialog asks for). */
export function DeleteMyAccount() {
  // The session's account, as AuthProvider reads it (the same query: no second request).
  const me = useQuery({ queryKey: ME_QUERY_KEY, queryFn: ({ signal }) => fetchMe(signal), staleTime: 5 * 60_000 });
  const email = me.data?.account?.email;
  return email ? <DeleteMyAccountRow email={email} /> : null;
}

/** The row (its button opens the dialog); `email` is the signed-in account's. */
export function DeleteMyAccountRow({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const reasonId = useId();
  // Why the person cannot delete their account now (the last administrator), or null. Unread or failed: the button is
  // on, and the server refuses with the same sentence in the dialog.
  const check = useQuery({ queryKey: DELETE_CHECK_QUERY_KEY, queryFn: ({ signal }) => fetchDeleteCheck(signal), staleTime: 60_000 });
  const refusal = check.data?.refusal ?? null;
  return (
    <div className="mt-4 border-t border-divider-soft pt-4" data-delete-my-account="">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
        <span className="inline-flex items-center gap-1 text-sm leading-5 text-muted-foreground sm:w-44 sm:shrink-0">
          {DELETE_COPY.rowLabel}
          <HelpTip label={DELETE_COPY.rowLabel}>{DELETE_COPY.rowTip}</HelpTip>
        </span>
        <Button
          size="sm"
          variant="destructive-outline"
          className="self-start sm:ml-auto sm:self-auto"
          icon={<TrashIcon size={16} aria-hidden="true" />}
          disabled={refusal !== null}
          aria-describedby={refusal ? reasonId : undefined}
          onClick={() => setOpen(true)}
        >
          {DELETE_COPY.openSelf}
        </Button>
      </div>
      {refusal && (
        <p id={reasonId} className="mt-2 text-[13px] leading-5 text-muted-foreground sm:text-right" data-delete-refusal="">
          {refusal}
        </p>
      )}
      <DeleteAccountDialog
        open={open}
        onOpenChange={setOpen}
        email={email}
        mode="self"
        onConfirm={async (typed) => {
          const done = await deleteMyAccount(typed);
          // Signed out (the server cleared the session): nothing of the account stays in this tab.
          queryClient.clear();
          forgetProfile();
          leaveForSignIn(accountDeletedLoginPath(done.state));
        }}
      />
    </div>
  );
}
