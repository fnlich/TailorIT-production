import type { Router } from 'express';
import { AdminJobEditBodySchema, AdminJobRestoreBodySchema, HOUR_MS, type JobEditField } from '@tailorit/shared';
import { PositiveId, type AdminActor, type AdminRouteHelpers } from '../../../core/admin/index';
import { rateKeyOf } from '../../../core/auth/guards';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import { notFound } from '../../../core/http/errors';
import { parseInput } from '../../../core/http/validate';
import { keyedRateLimit } from '../../../core/rate-limit';
import { jobEditor, readJobLink, restoreJobField, saveJobEdit } from './service';

// v38 REVEDIT (SP v38 PLAN.md E1-E6): "Edit job" on Admin › Review's lanes, mounted on the reviews router
// (job-reviews/router.ts: administrators only, a named profile refused, acting `never`):
//   GET   /api/admin/reviews/jobs/:jobId                   the editor (404 for a job Review does not show)
//   PATCH /api/admin/reviews/jobs/:jobId {version, changes} saved ({saved: true, editor, changed}), or the job
//                                                          TailorIT already has of a new link ({saved: false, duplicate})
//   POST  /api/admin/reviews/jobs/:jobId/read              "Read this link": the link verdict now ({outcome, jobId, ...})
//   POST  /api/admin/reviews/jobs/:jobId/restore {field}   "Use the posting's text again" for one field
// The three changes take one of the admin's ADMIN_JOB_EDITS_PER_HOUR each (429 with Retry-After past it). Each change is
// audited in one log line: who, which job, which fields (never a value).

/** The audit line of a change (who, what, which job, which fields; never their values). */
function auditLine(deps: Pick<AppDeps, 'log'>, admin: AdminActor, action: string, jobId: number, fields: readonly JobEditField[], extra = ''): void {
  const named = fields.length > 0 ? `: ${fields.join(', ')}` : '';
  deps.log.info(`[admin] ${admin.email} ${action} job ${jobId}${named}${extra}`);
}

/** "Try again in 12 minutes." */
function waitWords(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `You have made the most job edits one admin may make in an hour. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/** Adds the editor's routes to the reviews router (before its /:id routes, as adminRouter mounts `routes`). */
export function addJobEditRoutes(deps: AppDeps, router: Router, helpers: AdminRouteHelpers): void {
  const hourly = keyedRateLimit({
    windowMs: HOUR_MS,
    limit: () => constantsOf(deps).get('ADMIN_JOB_EDITS_PER_HOUR'),
    key: (req) => `job-edit:${rateKeyOf(req, HOUR_MS)}`,
    message: waitWords,
  });
  const jobIdOf = (params: Record<string, string>) => {
    const id = PositiveId.safeParse(params.jobId);
    if (!id.success) throw notFound('That job');
    return id.data;
  };

  router.get(
    '/jobs/:jobId',
    helpers.handle(async (req) => {
      const editor = await jobEditor(deps, jobIdOf(req.params));
      if (!editor) throw notFound('That job');
      return editor;
    }),
  );
  router.patch(
    '/jobs/:jobId',
    hourly,
    helpers.handle(async (req, admin) => {
      const jobId = jobIdOf(req.params);
      const body = parseInput(AdminJobEditBodySchema, req.body ?? {}, 'edit');
      const saved = await saveJobEdit(deps, jobId, body, admin);
      if (!saved) throw notFound('That job');
      if (saved.saved && saved.changed.length > 0) auditLine(deps, admin, 'edit', jobId, saved.changed);
      return saved;
    }),
  );
  router.post(
    '/jobs/:jobId/read',
    hourly,
    helpers.handle(async (req, admin) => {
      const jobId = jobIdOf(req.params);
      const read = await readJobLink(deps, jobId, admin);
      if (!read) throw notFound('That job');
      auditLine(deps, admin, 'read', jobId, [], ` (${read.outcome}${read.jobId !== jobId ? `, now job ${read.jobId}` : ''})`);
      return read;
    }),
  );
  router.post(
    '/jobs/:jobId/restore',
    hourly,
    helpers.handle(async (req, admin) => {
      const jobId = jobIdOf(req.params);
      const body = parseInput(AdminJobRestoreBodySchema, req.body ?? {}, 'field');
      const editor = await restoreJobField(deps, jobId, body.field);
      if (!editor) throw notFound('That job');
      auditLine(deps, admin, 'restore', jobId, [body.field]);
      return editor;
    }),
  );
}
