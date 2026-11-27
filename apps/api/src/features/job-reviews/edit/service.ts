import {
  canonicalJobUrl,
  JOB_EDIT_ADMIN_TEXT,
  JOB_EDIT_FIELDS,
  JOB_EDIT_LIMITS,
  type AdminJobEditBody,
  type AdminJobEditor,
  type AdminJobEditSaved,
  type AdminJobRead,
  type JobAddOrigin,
  type JobEditField,
  type JobEditReadOutcome,
  type JobEditValues,
  type JobVerifyReason,
} from '@tailorit/shared';
import { nowIso, type AppDeps } from '../../../core/context';
import { conflict, validationFailed } from '../../../core/http/errors';
import { closeLink, projectJob } from '../../../core/seams';
import { factsAtIngest } from '../../ingest/facts';
import { keyHolders, keysOfAddress } from '../../ingest/keys';
import { sharedAddress } from '../../jobs/add/address';
import { legacyHeld } from '../../jobs/add/held';
import { isAddableLink, readLink, verifyJob, type AddJobByLinkOutcome } from '../../jobs/add/pipeline';
import { linkRejected, noteUnverified } from '../../jobs/add/verification';
import { sanitizeDescription } from '../../jobs/html';
import { isRefusedPageHost } from '../hosts';
import { jsonbValue, withValue, writeEditedFields } from './apply';
import { currentValues, editorOf, sameFieldValue, valueOfField, versionOfValues } from './values';

// v38 REVEDIT (SP v38 PLAN.md E1-E6): Admin › Review's "Edit job" (routes.ts mounts it on the reviews router).
//   - E1 only a job Review shows (a review of it, a review's page job, a flag, a "Couldn't verify" note) or one an admin
//     edited there (its edits stay the admin's to read again or restore once it left Review), never one that gave way to
//     another (inReview);
//   - E2/E6 an edit is checked as ingest stores a job (the shared caps; the description cleaned as every stored one),
//     against the version the admin opened (409 when the job changed since);
//   - E3 a changed link is checked like Add job (https on a public host, made canonical with the platform's clean link,
//     never a secret parameter, never a site TailorIT never reads, never a link an admin rejected); a link another job
//     TailorIT has holds answers that job (`duplicate`) and nothing is saved: no silent merge;
//   - E4 each field saved is the admin's (job_admin_edits) until restoreJobField ("Use the posting's text again");
//   - E6 a person's own job stays theirs alone: an edit never publishes it (only an approval does).
// readJobLink ("Read this link") reads the job's link at once through the one link verdict (the add pipeline's read).

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** Whether Admin › Review shows job `jobId` (a lane's row or sheet names it), and it gave way to no other job. */
export async function inReview(deps: Pick<AppDeps, 'db'>, jobId: number): Promise<boolean> {
  const row = await deps.db.one<{ found: number }>(
    `SELECT 1 AS found FROM jobs j WHERE j.id = ? AND j.superseded_by IS NULL AND (
       EXISTS (SELECT 1 FROM job_reviews r WHERE r.job_id = j.id)
       OR EXISTS (SELECT 1 FROM job_review_reports p WHERE p.page_job_id = j.id)
       OR EXISTS (SELECT 1 FROM job_reports f WHERE f.job_id = j.id)
       OR EXISTS (SELECT 1 FROM job_verifications v WHERE v.job_id = j.id)
       OR EXISTS (SELECT 1 FROM job_admin_edits e WHERE e.job_id = j.id))`,
    [jobId],
  );
  return row !== undefined;
}

/** GET /api/admin/reviews/jobs/:jobId: the editor, or null for a job Review does not show. */
export async function jobEditor(deps: Deps, jobId: number): Promise<AdminJobEditor | null> {
  if (!(await inReview(deps, jobId))) return null;
  return (await editorOf(deps.db, jobId)) ?? null;
}

/** A link as an edit keeps it (see the top), or a refusal naming the field. */
async function checkedLink(deps: Deps, given: string, field: 'link' | 'applyUrl'): Promise<string> {
  const refuse = (message: string) => validationFailed(message, { [field]: message });
  const canonical = canonicalJobUrl(given);
  const url = sharedAddress(canonical);
  if (!canonical || !url || url.length > JOB_EDIT_LIMITS.link || !isAddableLink(canonical) || !isAddableLink(url)) {
    throw refuse(JOB_EDIT_ADMIN_TEXT.invalidLink);
  }
  if (isRefusedPageHost(new URL(url).hostname)) throw refuse(JOB_EDIT_ADMIN_TEXT.siteNeverRead);
  if (field === 'link' && (await linkRejected(deps.db, url))) throw refuse(JOB_EDIT_ADMIN_TEXT.rejected);
  return url;
}

/** The changes as kept (links canonical, the description cleaned, places trimmed), the job's other values as they are. */
async function keptChanges(deps: Deps, changes: AdminJobEditBody['changes'], ownApplyLink: boolean): Promise<Partial<Record<JobEditField, unknown>>> {
  const kept: Partial<Record<JobEditField, unknown>> = {};
  if (changes.link !== undefined) kept.link = await checkedLink(deps, changes.link, 'link');
  if (changes.applyUrl !== undefined) {
    if (!ownApplyLink) throw validationFailed(JOB_EDIT_ADMIN_TEXT.ownApplyLink, { applyUrl: JOB_EDIT_ADMIN_TEXT.ownApplyLink });
    kept.applyUrl = changes.applyUrl === null || changes.applyUrl === '' ? null : await checkedLink(deps, changes.applyUrl, 'applyUrl');
  }
  if (changes.title !== undefined) kept.title = changes.title;
  if (changes.company !== undefined) kept.company = changes.company;
  if (changes.descriptionHtml !== undefined) kept.description = sanitizeDescription(changes.descriptionHtml).slice(0, JOB_EDIT_LIMITS.description);
  if (changes.locations !== undefined) kept.locations = changes.locations.map((place) => place.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (changes.workArrangement !== undefined) kept.workArrangement = changes.workArrangement;
  if (changes.employmentType !== undefined) kept.employmentType = changes.employmentType;
  if (changes.salary !== undefined) kept.salary = changes.salary;
  if (changes.postedAt !== undefined) kept.postedAt = changes.postedAt;
  return kept;
}

/** The job TailorIT already has of `url` (another shared job holding one of its keys), or null. */
async function duplicateOf(deps: Deps, jobId: number, url: string): Promise<Extract<AdminJobEditSaved, { saved: false }>['duplicate'] | null> {
  const holders = (await keyHolders(deps.db, keysOfAddress(url))).map((row) => Number(row.job_id)).filter((id) => id !== jobId);
  for (const id of [...new Set(holders)].sort((a, b) => a - b)) {
    const job = await deps.db.one<{ title: string; company_name: string; held: boolean; active: boolean }>(
      `SELECT j.title, c.name AS company_name, j.held_since IS NOT NULL AS held, j.active FROM jobs j JOIN companies c ON c.id = j.company_id
       WHERE j.id = ? AND j.owner_user_id IS NULL AND j.superseded_by IS NULL`,
      [id],
    );
    if (job) return { jobId: id, title: job.title, companyName: job.company_name, held: job.held === true, active: job.active === true };
  }
  return null;
}

/** Writes the admin's values of `fields` (job_admin_edits) and on the job, in the caller's transaction. */
async function saveFields(
  deps: Deps,
  t: Parameters<Parameters<AppDeps['db']['tx']>[0]>[0],
  jobId: number,
  before: JobEditValues,
  kept: Partial<Record<JobEditField, unknown>>,
  fields: readonly JobEditField[],
  adminId: string,
  at: string,
): Promise<void> {
  for (const field of fields) {
    // The posting's value is kept the first time a field is edited (a later edit keeps that first one).
    await t.run(
      `INSERT INTO job_admin_edits(job_id, field, value, original, edited_by, edited_at) VALUES (?, ?, CAST(? AS jsonb), CAST(? AS jsonb), ?, ?)
       ON CONFLICT (job_id, field) DO UPDATE SET value = excluded.value, edited_by = excluded.edited_by, edited_at = excluded.edited_at`,
      [jobId, field, JSON.stringify(kept[field] ?? null), JSON.stringify(valueOfField(before, field) ?? null), adminId, at],
    );
  }
  await writeEditedFields(t, jobId, (values) => fields.reduce((next, field) => withValue(next, field, kept[field]), values), fields, at);
  await factsAtIngest(deps.db, [jobId], at);
}

/**
 * PATCH /api/admin/reviews/jobs/:jobId (see the top): the fields that changed, saved as the admin's. Answers the editor
 * and the fields changed, or the job TailorIT already has of a new link (nothing saved); null for a job Review does not
 * show. Outside any transaction.
 */
export async function saveJobEdit(deps: Deps, jobId: number, body: AdminJobEditBody, admin: { id: string }): Promise<AdminJobEditSaved | null> {
  deps.db.assertNoTx('saveJobEdit');
  if (!(await inReview(deps, jobId))) return null;
  const before = await currentValues(deps.db, jobId);
  if (!before) return null;
  if (versionOfValues(before.values) !== body.version) throw conflict(JOB_EDIT_ADMIN_TEXT.changed);
  const kept = await keptChanges(deps, body.changes, before.row.note_url !== null);
  const fields = JOB_EDIT_FIELDS.filter((field) => field in kept && !sameFieldValue(field, kept[field], valueOfField(before.values, field)));
  if (fields.length === 0) return { saved: true, editor: (await editorOf(deps.db, jobId))!, changed: [] };
  if (fields.includes('link')) {
    const duplicate = await duplicateOf(deps, jobId, kept.link as string);
    if (duplicate) return { saved: false, duplicate };
  }
  const at = nowIso(deps);
  await deps.db.tx(
    async (t) => {
      // The job's row lock orders two edits (and an edit and a read's rewrite); the version is checked again under it.
      await t.one('SELECT id FROM jobs WHERE id = ? FOR UPDATE', [jobId]);
      const locked = await currentValues(t, jobId);
      if (!locked || versionOfValues(locked.values) !== body.version) throw conflict(JOB_EDIT_ADMIN_TEXT.changed);
      await saveFields(deps, t, jobId, locked.values, kept, fields, admin.id, at);
    },
    { label: 'admin: edit a job' },
  );
  return { saved: true, editor: (await editorOf(deps.db, jobId))!, changed: fields };
}

/**
 * POST /api/admin/reviews/jobs/:jobId/restore {field}: "Use the posting's text again": the field's posting value back
 * (its `original`, as last read) and the admin's edit dropped; later reads write the field again. 409 for a field no admin
 * edited. Answers the editor; null for a job Review does not show.
 */
export async function restoreJobField(deps: Deps, jobId: number, field: JobEditField): Promise<AdminJobEditor | null> {
  deps.db.assertNoTx('restoreJobField');
  if (!(await inReview(deps, jobId))) return null;
  const at = nowIso(deps);
  await deps.db.tx(
    async (t) => {
      await t.one('SELECT id FROM jobs WHERE id = ? FOR UPDATE', [jobId]);
      const edit = await t.one<{ original: unknown; has_original: boolean }>(
        'SELECT original, original IS NOT NULL AS has_original FROM job_admin_edits WHERE job_id = ? AND field = ?',
        [jobId, field],
      );
      if (!edit) throw conflict(JOB_EDIT_ADMIN_TEXT.notEdited);
      if (!edit.has_original) throw conflict(JOB_EDIT_ADMIN_TEXT.noOriginal);
      const original = jsonbValue(edit.original);
      await t.run('DELETE FROM job_admin_edits WHERE job_id = ? AND field = ?', [jobId, field]);
      await writeEditedFields(t, jobId, (values) => withValue(values, field, original), [field], at);
      await factsAtIngest(deps.db, [jobId], at);
    },
    { label: "admin: a job field's posting text again" },
  );
  return (await editorOf(deps.db, jobId)) ?? null;
}

/** A read's reason as "try later" (the site did not answer now) or "can't read". */
const unreadOutcome = (reason: JobVerifyReason | null, paused = false): JobEditReadOutcome =>
  paused || reason === 'unavailable' ? 'try_later' : 'cant_read';

/** The add pipeline's answer of a Retry read as the editor's outcome. */
function outcomeOfVerify(outcome: AddJobByLinkOutcome): { outcome: JobEditReadOutcome; reason: JobVerifyReason | null } {
  if (outcome.state === 'published') return { outcome: 'open', reason: null };
  if (outcome.state === 'waiting_admin') return { outcome: 'waiting', reason: null };
  if (outcome.state === 'refused' && outcome.reason === 'closed') return { outcome: 'closed', reason: 'closed' };
  return { outcome: unreadOutcome(outcome.reason, Boolean(outcome.pause)), reason: outcome.reason };
}

/**
 * POST /api/admin/reviews/jobs/:jobId/read ("Read this link", E3): TailorIT reads the job's link now through the one
 * link verdict. A job only its adder sees, or an import's held job (Couldn't verify), is read as its Retry read reads it
 * (pipeline.ts verifyJob: read now, it gives way to the shared job and the admin's edits go with it; closed, it closes);
 * any other job is read for real (`fresh`): the store rewrites it from the posting and the admin's edits stay
 * (apply.ts keepAdminEdits); a posting gone closes the job (closeLink: what waits on it in Review settles); a link not
 * readable now leaves the admin's text and the job in Review (a noted job's note says why). Null for a job Review does
 * not show. Outside any transaction.
 */
export async function readJobLink(deps: AppDeps, jobId: number, admin: { id: string }): Promise<AdminJobRead | null> {
  deps.db.assertNoTx('readJobLink');
  if (!(await inReview(deps, jobId))) return null;
  const current = await currentValues(deps.db, jobId);
  if (!current) return null;
  const { row } = current;
  if (!row.active) throw conflict(JOB_EDIT_ADMIN_TEXT.readClosed);
  let result: { outcome: JobEditReadOutcome; reason: JobVerifyReason | null; jobId: number };
  if (row.owner_user_id !== null || (row.held && row.note_url !== null && (await legacyHeld(deps.db, jobId)))) {
    const outcome = await verifyJob(deps, jobId, { id: admin.id, admin: true });
    result = { ...outcomeOfVerify(outcome), jobId: outcome.jobId ?? jobId };
  } else {
    const url = sharedAddress(row.note_url ?? row.apply_url);
    if (!url || !isAddableLink(url)) {
      result = { outcome: 'cant_read', reason: 'invalid_link', jobId };
    } else {
      const read = await readLink(deps, url, undefined, undefined, { fresh: true, freshFeed: true }); // v38 FIX-C (beh-M2): no kept board feed
      const at = nowIso(deps);
      if (read.kind === 'shared') {
        result = { outcome: read.held ? 'waiting' : 'open', reason: null, jobId: read.jobId };
      } else if (read.kind === 'closed') {
        await deps.db.tx(
          async (t) => {
            await closeLink(deps, t, { jobId, reason: 'gone', at });
            await projectJob(t, jobId);
          },
          { label: 'admin: read a closed link' },
        );
        result = { outcome: 'closed', reason: 'closed', jobId };
      } else {
        if (row.note_url !== null && !read.pause) {
          const note = await deps.db.one<{ user_id: string | null; origin: JobAddOrigin }>('SELECT user_id, origin FROM job_verifications WHERE job_id = ?', [jobId]);
          if (note) await noteUnverified(deps.db, { jobId, userId: note.user_id, url, origin: note.origin, reason: read.reason }, at);
        }
        result = { outcome: unreadOutcome(read.reason, Boolean(read.pause)), reason: read.reason, jobId };
      }
    }
  }
  const editor = (await inReview(deps, result.jobId)) ? ((await editorOf(deps.db, result.jobId)) ?? null) : null;
  return { outcome: result.outcome, jobId: result.jobId, reason: result.reason, editor };
}
