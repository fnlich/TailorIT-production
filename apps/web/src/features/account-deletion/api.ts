import {
  ACCOUNT_DELETE_PATH,
  AccountDeleteCheckSchema,
  AccountDeletionResultSchema,
  adminAccountDeletePath,
  type AccountDeleteCheck,
  type AccountDeletionResult,
} from '@tailorit/shared/account-deletion';
import { api } from '@/lib/api';

// v34 ACCTDEL (PLAN G10): the deletion routes (@tailorit/shared/account-deletion). The address is typed by hand in the
// dialog and checked again by the server.

/** The query key of GET /api/account/delete (whether the person may delete their account now). */
export const DELETE_CHECK_QUERY_KEY = ['account-deletion', 'check'] as const;

/** GET /api/account/delete: null, or why the signed-in person cannot delete their account now. */
export function fetchDeleteCheck(signal?: AbortSignal): Promise<AccountDeleteCheck> {
  return api.get<AccountDeleteCheck>(ACCOUNT_DELETE_PATH, { schema: AccountDeleteCheckSchema, signal });
}

/**
 * POST /api/account/delete: the signed-in person's own account (the session cookie is cleared). Answers `deleted` (204)
 * or `pending` (202: off, the rest finishes on its own).
 */
export async function deleteMyAccount(email: string): Promise<AccountDeletionResult> {
  const answer = await api.post<AccountDeletionResult | undefined>(ACCOUNT_DELETE_PATH, { email });
  return answer ? AccountDeletionResultSchema.parse(answer) : { state: 'deleted' };
}

/** POST /api/admin/users/:id/delete: another account (an administrator). */
export function deleteAccountAsAdmin(id: string, email: string): Promise<AccountDeletionResult> {
  return api.post<AccountDeletionResult>(adminAccountDeletePath(id), { email }, { schema: AccountDeletionResultSchema });
}
