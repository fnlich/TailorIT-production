import { z } from 'zod';

// v34 ACCTDEL (PLAN G10): deleting an account, by its person or by an administrator. Everything the account holds goes
// at once (the API's features/account-deletion/service.ts says what, in order); the person is signed out.
//   GET  /api/account/delete            (session; never on a shared profile)  → AccountDeleteCheck: whether the
//                                        signed-in person may delete their account now (the last administrator who
//                                        can sign in may not), so the page says why before anything is typed
//   POST /api/account/delete            (session; never on a shared profile)  AccountDeleteBody → 204, the session
//                                        cookie cleared; or 202 AccountDeletionResult (`pending`: the account is off
//                                        and its deletion finishes on its own, within a day)
//   POST /api/admin/users/:id/delete    (admin; never one's own account)      AccountDeleteBody → 200
//                                        AccountDeletionResult (`deleted`), or 202 (`pending`, as above)
// The body names the account's email address, typed by hand in the confirm dialog: a deletion is never one click.
// Refusals: 400 validation_failed (the address does not match: MSG_ACCOUNT_DELETE_EMAIL), 409 conflict (the last
// administrator who can sign in: MSG_ACCOUNT_DELETE_LAST_ADMIN; one's own account from Admin › Users:
// MSG_ACCOUNT_DELETE_OWN), 403 own_profile_only (while working on a shared profile), 404 (no such account).
// Signing in to an account whose deletion has not finished: 403 account_being_deleted (MSG_ACCOUNT_BEING_DELETED).

export const ACCOUNT_DELETE_PATH = '/api/account/delete';

/** POST /api/admin/users/:id/delete. */
export const adminAccountDeletePath = (id: string) => `/api/admin/users/${encodeURIComponent(id)}/delete`;

/** An email address as typed (trimmed; compared without case). */
const TYPED_EMAIL_MAX = 254;

export const AccountDeleteBodySchema = z.object({
  email: z.string().trim().min(1).max(TYPED_EMAIL_MAX),
});
export type AccountDeleteBody = z.infer<typeof AccountDeleteBodySchema>;

/** `deleted`: everything went; `pending`: the account is off and the rest finishes on its own (the daily pass). */
export const ACCOUNT_DELETION_STATES = ['deleted', 'pending'] as const;
export type AccountDeletionState = (typeof ACCOUNT_DELETION_STATES)[number];

/** What a deletion did; `message` (a pending one's words) says what happens next. */
export const AccountDeletionResultSchema = z.object({
  state: z.enum(ACCOUNT_DELETION_STATES),
  message: z.string().optional(),
});
export type AccountDeletionResult = z.infer<typeof AccountDeletionResultSchema>;

/** GET /api/account/delete: null, or why the signed-in person cannot delete their account now (a sentence). */
export const AccountDeleteCheckSchema = z.object({ refusal: z.string().nullable() });
export type AccountDeleteCheck = z.infer<typeof AccountDeleteCheckSchema>;

/**
 * The sign-in page's mark after a person deleted their own account: /login?deleted=1 (done), /login?deleted=pending
 * (off, finishing on its own). The page says so once and drops the mark from the address.
 */
export const ACCOUNT_DELETED_PARAM = 'deleted';
export const ACCOUNT_DELETED_MARKS = { deleted: '1', pending: 'pending' } as const satisfies Record<AccountDeletionState, string>;
export const accountDeletedLoginPath = (state: AccountDeletionState) => `/login?${ACCOUNT_DELETED_PARAM}=${ACCOUNT_DELETED_MARKS[state]}`;
export const ACCOUNT_DELETED_LOGIN_PATH = accountDeletedLoginPath('deleted');

/** The state a sign-in page's mark names, or null (no mark, or another value). */
export function accountDeletedMarkOf(value: string | null | undefined): AccountDeletionState | null {
  if (value === ACCOUNT_DELETED_MARKS.deleted) return 'deleted';
  if (value === ACCOUNT_DELETED_MARKS.pending) return 'pending';
  return null;
}

/** Whether the typed address is the account's (trimmed, without case), as the server compares them. */
export function typedEmailMatches(typed: string, email: string): boolean {
  return typed.trim().toLowerCase() === email.trim().toLowerCase();
}
