import type { SharePermission } from '@tailorit/shared/sharing';
import { payerOfRow, type Payer, type PersonPayer } from '../../core/accounts/payer';
import type { AppDeps } from '../../core/context';
import { AppError } from '../../core/http/errors';

// v33 SHARE-3 (PLAN F9 "Who pays"; SP v33 PLAN-sharing.md §5 "Resume backlogs"): who pays for the work a resume
// backlog row starts. Both backlogs (resume_analysis_backlog, resume_copy_backlog) store it in charge_user_id and
// grant_id (migration 0049): NULL and NULL is the resume's owner (as in v3.2); B under a grant when B uploaded (or asked
// again) on A's profile. The row's work runs under `documents:edit`; usage deferral, the usage pause, fairness and the
// one-copy-at-a-time rule read the payer (coalesce(charge_user_id, user_id)), never the owner alone.

/** The permission a backlog row's work runs under (B's uploads and copies on A's profile). */
export const BACKLOG_PERMISSION: SharePermission = 'documents:edit';

/** What a backlog row stores of the request's payer: B under a grant, or NULLs for the owner's own work. */
export function backlogPayerColumns(payer: Payer | undefined): { charge_user_id: string | null; grant_id: string | null } {
  return payer?.grantId && payer.id !== null ? { charge_user_id: payer.id, grant_id: payer.grantId } : { charge_user_id: null, grant_id: null };
}

/** A backlog row's payer (payerOfRow under documents:edit): throws profile_ended for a row whose grant is gone. */
export function backlogPayerOf(row: { user_id: string; charge_user_id: string | null; grant_id: string | null }): PersonPayer {
  return payerOfRow({ user_id: row.user_id, charge_user_id: row.charge_user_id, grant_id: row.grant_id }, BACKLOG_PERMISSION);
}

/** Whether a refusal means the grant a row runs under no longer allows it (the row stops; it is never retried). */
export function isAccessEnded(error: unknown): boolean {
  return error instanceof AppError && (error.code === 'profile_ended' || error.code === 'profile_not_shared');
}

/** The SQL of a backlog row's payer: whose places and whose budget its work takes. */
export const BACKLOG_PAYER_SQL = (alias: string) => `coalesce(${alias}.charge_user_id, ${alias}.user_id)`;

/**
 * The upload B made on A's profile is read at B's cost: its new row in Claude's backlog (written with the upload, as the
 * owner's) names B and the grant. A no-op for the owner's own upload (`payer` without a grant) and for a row already
 * read, skipped or started.
 */
export async function setUploadReadingPayer(deps: Pick<AppDeps, 'db'>, resumeId: string, payer: Payer | undefined): Promise<void> {
  const columns = backlogPayerColumns(payer);
  if (columns.grant_id === null) return;
  await deps.db.run(
    `UPDATE resume_analysis_backlog SET charge_user_id = ?, grant_id = ? WHERE resume_id = ? AND state IN ('waiting', 'failed')`,
    [columns.charge_user_id, columns.grant_id, resumeId],
  );
}
