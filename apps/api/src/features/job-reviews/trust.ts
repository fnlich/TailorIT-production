import type { AppDeps } from '../../core/context';
import { constantsOf } from '../../core/constants/service';
import { DAY_MS } from '@tailorit/shared';

// v30 X1-API: the trust rule of the extension's reports (docs/design/part2/14-extension-reports.md §7). Only a trusted
// account counts toward an automatic decision (the reporters' rule of a closed link, the agreement rule of a page job):
// one at least EXT_REPORTER_MIN_ACCOUNT_DAYS old, not disabled, with fewer than EXT_REPORTER_REJECTS_TO_IGNORE of its
// reports rejected, or reopened by their source (job_reviews.reopened_at), in the last 30 days. Nothing the reporter
// sees changes with trust: an untrusted report is answered `queued` like any other, so trust cannot be probed. The rule
// is read at the moment of use (an account ages into trust; a rejection counts at once), never stored per report.

/** The named parameters trustedSql reads (@trustAgeBefore, @trustSince, @trustRejects), at `now`. */
export function trustParams(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, now: Date): Record<string, unknown> {
  const constants = constantsOf(deps);
  return {
    trustAgeBefore: new Date(now.getTime() - constants.get('EXT_REPORTER_MIN_ACCOUNT_DAYS') * DAY_MS).toISOString(),
    // v30 FIX-WEB (REQ-7): the window is the constant TRUST_REJECT_WINDOW_DAYS (14 §7's "in 30 days").
    trustSince: new Date(now.getTime() - constants.get('TRUST_REJECT_WINDOW_DAYS') * DAY_MS).toISOString(),
    trustRejects: constants.get('EXT_REPORTER_REJECTS_TO_IGNORE'),
  };
}

/**
 * The SQL predicate "this account is trusted" for a `users` row under `user` (its alias), with trustParams' named
 * parameters. Rejected reviews of either kind count (a report row is an account's word about a posting, an add's too).
 * v37 FIX-REV (SP v37 FIXES-361.md D1): except a New jobs review TailorIT rejected itself (`server_check`): its job
 * closed (settle.ts), which says nothing against the people who added it.
 */
export function trustedSql(user = 'u'): string {
  return (
    `(${user}.disabled_at IS NULL AND ${user}.created_at <= CAST(@trustAgeBefore AS timestamptz) AND ` +
    `(SELECT count(*) FROM job_review_reports tr JOIN job_reviews tv ON tv.id = tr.review_id WHERE tr.user_id = ${user}.id ` +
    `AND ((tv.state = 'rejected' AND tv.decided_at >= CAST(@trustSince AS timestamptz) ` +
    `AND NOT (tv.kind = 'new_job' AND tv.decided_by = 'server_check')) ` +
    `OR tv.reopened_at >= CAST(@trustSince AS timestamptz))) < CAST(@trustRejects AS integer))`
  );
}
