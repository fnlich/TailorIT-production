import { HOUR_MS, linkKey } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/service';
import { nowIso, type AppDeps } from '../../../core/context';
import type { DbQueries, DbTx } from '../../../core/db/types';
import { AppError, conflict, notFound } from '../../../core/http/errors';
import { isOptedOut } from '../../../core/http/reader/read';
import { projectJob } from '../../../core/seams';
import { upgradeOwnPageJob } from '../../autofill/jobs';
import { registrableDomain } from '../../companies/domain';
import { resolveCompanyByName } from '../../companies/resolve';
import { addJobKeys, keyHolders, keysOfAddress } from '../../ingest/keys';
import { normalizeCompany } from '../../ingest/normalize';
import { isRefusedPageHost, isSiteHost } from '../../job-reviews/hosts';
import { sharedAddress } from './address';
import { legacyHeld } from './held';
import { noticeVerification } from './notify';
import { APPROVAL_LOCK, linkRejected, noteUnverified, ownJobsOfLink } from './verification';
import { versionOf } from './versions';

// v32 ADMINAPP (E6, the owner's "In admin review, admin should be able to approve manually"; the coordinator's decision
// overrides v3.1's D2 "an admin never publishes captured content": the admin is now the verifier). An admin approves a
// job TailorIT could not read from its link (Admin › Review › Couldn't verify, POST /api/admin/jobs/unverified/:jobId/
// approve; and a v3.0 page review whose page it cannot read, job-reviews/decide.ts). What is published is what the
// adder's browser captured or what they typed: the admin types nothing. In one transaction:
//   - the adder's own job becomes a shared job anyone sees (owner cleared, its search row rebuilt: projectJob), its
//     Apply link the link's shared form (address.ts, REV-SEC SEC-2), its link keys its own (a closed or retired job's
//     key moves to it; an open public job of the link is joined instead, nothing is published twice), its "Couldn't
//     verify" note kept with no adder (SB-4 below);
//   - its company is the one of its name alone (companies/resolve.ts resolveCompanyByName, v3.1's SEC-3 rule): never a
//     company with a board or a domain of its own, nothing written about any company;
//   - a row of job_admin_approvals (migration 0044) says the admin approved it, who and when; the job DTOs show it as
//     the verification state `admin_approved`; the route logs the audit line.
// A job the legacy pass holds (no adder: a v3.0 import's or page copy's words) has its hold lifted the same way.
// Refused (409, nothing changes): a site TailorIT never reads (LinkedIn, a refused job board), a site on the opt-out
// list, a link an admin rejected, a posting TailorIT found closed, a company that opted out (or a shared company of its
// name that did), a job of the link waiting in Review › New jobs (decide it there). Idempotent: an approved job, or one
// that gave way to the job approved, answers that job again (`already`). Admins only, ADMIN_APPROVALS_PER_HOUR each.
//
// v32 FIX-API (REV-SECBEH; the coordinator's decisions of 2026-11-18):
//   - SB-1: the admin approves the version they read: the list's row and its confirm draw every version of the link's
//     job in full (versions.ts), and the approval names one by its content hash ({version}); a job that changed since
//     is refused (409), checked under the job's lock. The other adders' own jobs are never closed or moved: each keeps
//     theirs and is told a public version exists (MSG_NOTIFY_JOB_PUBLIC_VERSION_*); their rows leave the list while the
//     approval is published;
//   - SB-2: the Apply link published is the link listed (the one the admin opened and the checks read); the job's own
//     Apply link must pass the same checks and be on the same site (registrable domain), else 409; only a row the list
//     shows is approved (the list switch on; never a site TailorIT never reads, never a rejected link);
//   - SB-6: a link any of whose notes says `opted_out` (TailorIT's own read found its company or site opted out) is never
//     approved, whatever company name an adder typed;
//   - SB-3: the rejection, the opt-out list and the notes are read again under the link's lock (rejectLink takes it
//     too), so a Reject made during an approval is never published over;
//   - SB-5: an admin never approves a job they added (four eyes): another admin does;
//   - an approval refused (409) gives its slot of the admin's hour back;
//   - SB-4: an approval keeps its job in search ADMIN_APPROVED_JOB_DAYS (approved.ts): then the job leaves search (still
//     open) and its link is listed again, to be approved again (`again` below), read again or rejected.

/** What an approval came to. */
export interface ApprovalOutcome {
  /** The published job: the one approved, or the public job of the link its adders' jobs gave way to. */
  jobId: number;
  /** The link, in its shared form. */
  url: string | null;
  approvedAt: string;
  /** It was approved before: nothing changed now. */
  already: boolean;
  /** The adders whose own job of the link is now the published one. */
  adders: number;
}

// The admin's words of each refusal (an admin route: as the review decisions' words, decide.ts).
const REFUSED = {
  closed: 'TailorIT found this posting closed, so there is nothing to publish. Retry read to check it again.',
  site: 'TailorIT never publishes jobs from this site (a job board or a sign-in page).',
  optedOutSite: 'This site asked TailorIT not to read it, so its jobs are never published.',
  rejected: 'An admin rejected this link, so it is never published.',
  optedOutCompany: 'This company asked TailorIT not to list its jobs, so this job is never published.',
  waiting: 'TailorIT has a job of this link waiting in Review › New jobs. Approve or reject it there.',
  // v32 FIX-API
  changed: 'This job changed since you opened it. Open it again to read what would be published.',
  yours: 'You added this job, so another admin approves it.',
  otherSite: "This job's Apply link is on another site than the link listed, so it is not published. Retry read or reject it.",
  listOff: "Turn on the Couldn't verify list to approve its links.",
} as const;

// ------------------------------------------------------------------------------------------------- the hourly budget

type LimitDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;
const windows = new WeakMap<object, Map<string, number[]>>();

/**
 * Takes one approval from the admin's hour (ADMIN_APPROVALS_PER_HOUR), or refuses (429 with Retry-After). Kept in this
 * process, as the API's other limits are, per database handle so each test context has its own. v32 FIX-API: answers
 * the slot's release, called when the approval is then refused (a refused approval uses none of the hour).
 */
export function takeApprovalSlot(deps: LimitDeps, adminId: string): () => void {
  let byAdmin = windows.get(deps.db);
  if (!byAdmin) {
    byAdmin = new Map();
    windows.set(deps.db, byAdmin);
  }
  const owner = byAdmin;
  const now = deps.now().getTime();
  const kept = (byAdmin.get(adminId) ?? []).filter((at) => now - at < HOUR_MS);
  byAdmin.set(adminId, kept);
  if (kept.length < constantsOf(deps).get('ADMIN_APPROVALS_PER_HOUR')) {
    kept.push(now);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const list = owner.get(adminId);
      const at = list ? list.indexOf(now) : -1;
      if (list && at >= 0) list.splice(at, 1);
    };
  }
  const retryAfterSeconds = Math.max(1, Math.ceil(((kept[0] ?? now) + HOUR_MS - now) / 1000));
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  throw new AppError('rate_limited', `You have approved the most jobs one admin may approve in an hour. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`, {
    retryAfterSeconds,
  });
}

/** Runs `work` with one slot of the admin's hour, given back when it throws (v32 FIX-API). */
export async function withApprovalSlot<T>(deps: LimitDeps, adminId: string, work: () => Promise<T>): Promise<T> {
  const release = takeApprovalSlot(deps, adminId);
  try {
    return await work();
  } catch (error) {
    release();
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------- the checks

/** Refuses (409) a link whose job is never published: a refused or opted-out site, or a link an admin rejected. */
export async function assertPublishable(db: DbQueries, url: string): Promise<void> {
  const host = new URL(url).hostname;
  if (!isSiteHost(host) || isRefusedPageHost(host)) throw conflict(REFUSED.site);
  if (await isOptedOut(db, host)) throw conflict(REFUSED.optedOutSite);
  if (await linkRejected(db, url)) throw conflict(REFUSED.rejected);
}

/** v32 FIX-API (SB-6): whether TailorIT's own read of the link found its company or site opted out (any note of it). */
async function linkOptedOut(db: DbQueries, urlKey: string): Promise<boolean> {
  return (await db.one("SELECT 1 FROM job_verifications WHERE url_key = ? AND reason = 'opted_out' LIMIT 1", [urlKey])) !== undefined;
}

/** Whether the company, or a shared company of its name, opted out (companies.do_not_fetch). */
async function companyOptedOut(t: DbQueries, companyId: number): Promise<boolean> {
  const row = await t.one<{ found: number }>(
    `SELECT 1 AS found FROM companies c WHERE c.id = ? AND (c.do_not_fetch OR EXISTS (SELECT 1 FROM companies o
       WHERE o.name_key = c.name_key AND o.do_not_fetch AND o.owner_user_id IS NULL AND o.merged_into_id IS NULL))`,
    [companyId],
  );
  return row !== undefined;
}

/**
 * v32 FIX-API (SB-3, SB-6): the link's checks again under its lock, in the approval's transaction: a Reject made
 * meanwhile, an opt-out of its site, a note that found its company opted out.
 */
async function assertStillPublishable(t: DbTx, url: string, key: string): Promise<void> {
  await assertPublishable(t, url);
  if (await linkOptedOut(t, key)) throw conflict(REFUSED.optedOutCompany);
}

/** v32 FIX-API (SB-1): refuses (409) a job whose version is not the one the admin read. */
async function assertVersion(t: DbTx, jobId: number, version: string | undefined): Promise<void> {
  if (version !== undefined && (await versionOf(t, jobId)) !== version) throw conflict(REFUSED.changed);
}

/** The approval of `jobId`, or of the job it gave way to (a few steps of jobs.superseded_by); null when none. */
async function approvalOf(
  db: DbQueries,
  jobId: number,
): Promise<{ job_id: number; url_key: string; approved_at: string; adders: number; live: boolean } | null> {
  let id: number | null = jobId;
  for (let step = 0; id !== null && step < 5; step += 1) {
    const row:
      | { job_id: number | null; url_key: string | null; approved_at: string | null; adders: number | null; superseded_by: number | null; live: boolean }
      | undefined = await db.one(
      `SELECT a.job_id, a.url_key, a.approved_at, a.adders, j.superseded_by,
         (j.active AND j.owner_user_id IS NULL AND j.unverified_since IS NULL) AS live FROM jobs j
       LEFT JOIN job_admin_approvals a ON a.job_id = j.id WHERE j.id = ?`,
      [id],
    );
    if (!row) return null;
    if (row.job_id !== null && row.superseded_by === null) {
      return {
        job_id: Number(row.job_id),
        url_key: row.url_key!,
        approved_at: new Date(row.approved_at!).toISOString(),
        adders: Number(row.adders ?? 0),
        live: row.live === true,
      };
    }
    id = row.superseded_by === null ? null : Number(row.superseded_by);
  }
  return null;
}

/** v32 FIX-API (SB-1): the link's published approval (its job open, everyone's, in search), when there is one. */
async function publishedApprovalOfLink(db: DbQueries, urlKey: string): Promise<{ job_id: number; approved_at: string; adders: number } | null> {
  const row = await db.one<{ job_id: number; approved_at: string; adders: number }>(
    `SELECT a.job_id, a.approved_at, a.adders FROM job_admin_approvals a JOIN jobs j ON j.id = a.job_id
     WHERE a.url_key = ? AND j.active AND j.owner_user_id IS NULL AND j.superseded_by IS NULL AND j.unverified_since IS NULL
     ORDER BY a.approved_at LIMIT 1`,
    [urlKey],
  );
  return row ? { job_id: Number(row.job_id), approved_at: new Date(row.approved_at).toISOString(), adders: Number(row.adders) } : null;
}

// ---------------------------------------------------------------------------------------------- the publication

/** What publishing a captured job in a transaction came to: the job published now, or the open public job joined. */
export interface PublishedCapture {
  jobId: number;
  /** An open public job of the link was there: nothing was published now. */
  joined: boolean;
  /** The job is an admin's approval (published now, or joined: approved before), not a job TailorIT read. */
  approved: boolean;
}

/**
 * Publishes an account's own job `jobId` of link `url` (its shared form) as it was captured (see the top), in the
 * caller's transaction: its link's lock first, the link's checks again (SB-3), then its keys, its company by name
 * alone, the approval row. Refuses (409) a job of the link waiting for an admin, a company that opted out, the admin's
 * own job (SB-5), a version other than `version` when given (SB-1), an Apply link on another site (SB-2); the
 * transaction then rolls back. The caller runs the adders' notices after its commit (giveWayToApproved).
 */
export async function publishCapturedIn(
  deps: AppDeps,
  t: DbTx,
  input: { jobId: number; url: string; adminId: string | null; at: string; version?: string },
): Promise<PublishedCapture> {
  const key = linkKey(input.url);
  if (!key) throw conflict(REFUSED.site);
  await t.run('SELECT pg_advisory_xact_lock(?, hashtext(?))', [APPROVAL_LOCK, key]);
  await assertStillPublishable(t, input.url, key);
  // An approval of this link made meanwhile (another adder's job, the same row approved twice): its job is the one.
  const approved = await t.one<{ job_id: number }>(
    `SELECT a.job_id FROM job_admin_approvals a JOIN jobs j ON j.id = a.job_id
     WHERE a.url_key = ? AND j.active AND j.superseded_by IS NULL AND j.owner_user_id IS NULL ORDER BY a.approved_at LIMIT 1`,
    [key],
  );
  if (approved) return { jobId: Number(approved.job_id), joined: true, approved: true };
  const job = await t.one<{ owner_user_id: string | null; active: boolean; superseded_by: number | null; apply_url: string; company: string }>(
    `SELECT j.owner_user_id, j.active, j.superseded_by, j.apply_url, c.name AS company FROM jobs j JOIN companies c ON c.id = j.company_id
     WHERE j.id = ? FOR UPDATE OF j`,
    [input.jobId],
  );
  if (!job || job.owner_user_id === null || job.superseded_by !== null) throw conflict(REFUSED.changed);
  if (!job.active) throw conflict(REFUSED.closed);
  if (input.adminId !== null && job.owner_user_id === input.adminId) throw conflict(REFUSED.yours);
  await assertVersion(t, input.jobId, input.version);
  // SB-2: the job's own Apply link passes the link's checks and is on its site; the link listed is what is published.
  const ownLink = sharedAddress(job.apply_url);
  if (ownLink && ownLink !== input.url) {
    await assertPublishable(t, ownLink);
    if (registrableDomain(ownLink) !== registrableDomain(input.url)) throw conflict(REFUSED.otherSite);
  }

  // The link's keys (its own and, for an ATS posting, the posting's): a public open job holding one is the job of this
  // link (the adders' jobs give way to it); one waiting for an admin is decided in New jobs; a closed or retired job's
  // key moves to the job published now, so a later add of the link finds it.
  const keys = keysOfAddress(input.url);
  const holders = (await keyHolders(t, keys)).filter((row) => Number(row.job_id) !== input.jobId);
  const retired: number[] = [];
  for (const holderId of [...new Set(holders.map((row) => Number(row.job_id)))]) {
    const holder = await t.one<{ owner_user_id: string | null; active: boolean; held: boolean; superseded_by: number | null }>(
      'SELECT owner_user_id, active, held_since IS NOT NULL AS held, superseded_by FROM jobs WHERE id = ?',
      [holderId],
    );
    if (!holder || holder.owner_user_id !== null) continue;
    if (holder.active && holder.superseded_by === null) {
      if (holder.held) throw conflict(REFUSED.waiting);
      return { jobId: holderId, joined: true, approved: false };
    }
    retired.push(holderId);
  }

  // The company of its name alone (SEC-3): never one with a board or a domain, nothing written about it.
  const source = await t.one<{ source_id: number }>('SELECT source_id FROM job_source_links WHERE job_id = ? ORDER BY seq LIMIT 1', [
    input.jobId,
  ]);
  const company = await resolveCompanyByName(t, {
    company: normalizeCompany({ name: job.company }),
    sourceId: source ? Number(source.source_id) : null,
    at: input.at,
  });
  if (company.doNotFetch || (await companyOptedOut(t, company.companyId))) throw conflict(REFUSED.optedOutCompany);

  if (retired.length > 0) {
    for (const row of holders.filter((holder) => retired.includes(Number(holder.job_id)))) {
      await t.run('UPDATE job_keys SET job_id = ? WHERE key_kind = ? AND key = ? AND job_id = ?', [input.jobId, row.key_kind, row.key, row.job_id]);
    }
  }
  await addJobKeys(t, input.jobId, keys);
  await t.run('UPDATE jobs SET owner_user_id = NULL, company_id = ?, apply_url = ?, held_since = NULL, updated_at = ? WHERE id = ?', [
    company.companyId,
    input.url,
    input.at,
    input.jobId,
  ]);
  // SB-4: its note stays, with no adder: once the approval runs out the link is listed again (verification.ts LISTED),
  // and the weekly re-read moves its check time (approved.ts). A page review's job has none yet: one is made.
  const kept = await t.run('UPDATE job_verifications SET user_id = NULL WHERE job_id = ?', [input.jobId]);
  if (kept.changes === 0) {
    await noteUnverified(t, { jobId: input.jobId, userId: null, url: input.url, origin: 'extension_page', reason: 'no_posting' }, input.at);
  }
  await t.run(
    `INSERT INTO job_admin_approvals(job_id, url_key, kind, approved_by, approved_at, adders) VALUES (?, ?, 'captured', ?, ?, 1)
     ON CONFLICT (job_id) DO NOTHING`,
    [input.jobId, key, input.adminId, input.at],
  );
  await projectJob(t, input.jobId);
  return { jobId: input.jobId, joined: false, approved: true };
}

/**
 * After an approval committed (or a job TailorIT read was joined): the link's adders hear it. `told`: the adder whose
 * own job was published itself. `approvedByAdmin` (the job is an admin's approval of captured words): v32 FIX-API
 * (SB-1) every other account's own job of the link stays theirs, never closed or moved, and its adder is told a public
 * version exists. Otherwise (an open job TailorIT read was joined) each own job gives way to it (upgradeOwnPageJob,
 * sameLink), as a Retry read's does. Answers how many adders the job is now theirs for.
 */
export async function giveWayToApproved(
  deps: AppDeps,
  input: { jobId: number; url: string; told: readonly string[]; approvedByAdmin: boolean },
): Promise<number> {
  const key = linkKey(input.url);
  const owners = key ? await ownJobsOfLink(deps.db, key) : [];
  if (input.approvedByAdmin) {
    for (const userId of [...new Set(input.told)].sort()) {
      await noticeVerification(deps, { userId, jobId: input.jobId, state: 'published', approvedByAdmin: true });
    }
    const others = [...new Set(owners.map((row) => row.user_id).filter((userId) => !input.told.includes(userId)))].sort();
    for (const userId of others) {
      await noticeVerification(deps, { userId, jobId: input.jobId, state: 'published', publicVersion: true });
    }
    return new Set(input.told).size;
  }
  const heard = new Set<string>(input.told);
  for (const row of owners) {
    try {
      if (await upgradeOwnPageJob(deps, row.user_id, Number(row.job_id), input.jobId, { sameLink: true })) heard.add(row.user_id);
    } catch (error) {
      deps.log.warn('[job-links] an own job could not give way to the read job', error instanceof Error ? error.name : 'unknown');
    }
  }
  for (const userId of [...heard].sort()) {
    await noticeVerification(deps, { userId, jobId: input.jobId, state: 'published' });
  }
  return heard.size;
}

// ------------------------------------------------------------------------------------------------------- the route

/**
 * POST /api/admin/jobs/unverified/:jobId/approve {version} (see the top): the row's version (any adder's own job of the
 * link, a legacy job left held, or a job whose approval ran out: approved again) published as captured. Outside any
 * transaction.
 */
export async function approveUnverifiedJob(
  deps: AppDeps,
  jobId: number,
  admin: { id: string },
  input: { version?: string } = {},
): Promise<ApprovalOutcome> {
  deps.db.assertNoTx('approveUnverifiedJob');
  const before = await approvalOf(deps.db, jobId);
  if (before?.live) {
    return { jobId: before.job_id, url: await urlOf(deps.db, before.job_id), approvedAt: before.approved_at, already: true, adders: before.adders };
  }

  const row = await deps.db.one<{
    owner_user_id: string | null;
    active: boolean;
    held: boolean;
    out: boolean;
    approved: boolean;
    superseded_by: number | null;
    url: string;
    url_key: string;
    user_id: string | null;
    reason: string;
  }>(
    `SELECT j.owner_user_id, j.active, j.held_since IS NOT NULL AS held, j.unverified_since IS NOT NULL AS out,
       EXISTS (SELECT 1 FROM job_admin_approvals a WHERE a.job_id = j.id) AS approved, j.superseded_by, v.url, v.url_key, v.user_id, v.reason
     FROM jobs j JOIN job_verifications v ON v.job_id = j.id WHERE j.id = ?`,
    [jobId],
  );
  const free = row !== undefined && row.user_id === null && row.owner_user_id === null && row.superseded_by === null;
  const own = row !== undefined && row.user_id !== null && row.owner_user_id === row.user_id && row.superseded_by === null;
  const legacy = free && row.held && !row.approved;
  const again = free && !row.held && row.approved && row.out; // SB-4: an approval that ran out
  if (!row || (!own && !legacy && !again)) {
    // An adder's job that gave way to the link's public job meanwhile (an approval that joined it, a Retry read): that
    // job is the answer again.
    const joined = await gaveWayTo(deps.db, jobId);
    if (joined) return { jobId: joined.jobId, url: await urlOf(deps.db, joined.jobId), approvedAt: joined.at, already: true, adders: 0 };
    throw notFound('That job');
  }
  // SB-1: an approval of the link published meanwhile (another adder's version) is the answer.
  if (own) {
    const made = await publishedApprovalOfLink(deps.db, row.url_key);
    if (made) return { jobId: made.job_id, url: await urlOf(deps.db, made.job_id), approvedAt: made.approved_at, already: true, adders: made.adders };
  }
  // SB-2: only a row the list shows; SB-6: never a link TailorIT found opted out; SB-5: never the admin's own words.
  if (!constantsOf(deps).get('EXT_NEW_PAGE_JOBS_REVIEW')) throw conflict(REFUSED.listOff);
  if (row.reason === 'unreadable_host') throw conflict(REFUSED.site);
  if (row.reason === 'rejected') throw conflict(REFUSED.rejected);
  if (!row.active || row.reason === 'closed') throw conflict(REFUSED.closed);
  if (row.reason === 'opted_out' || (await linkOptedOut(deps.db, row.url_key))) throw conflict(REFUSED.optedOutCompany);
  if (own && row.user_id === admin.id) throw conflict(REFUSED.yours);
  const url = sharedAddress(row.url) ?? row.url;
  await assertPublishable(deps.db, url);
  const at = nowIso(deps);

  return withApprovalSlot(deps, admin.id, async () => {
    if (legacy || again) {
      await deps.db.tx(
        async (t) => {
          await t.run('SELECT pg_advisory_xact_lock(?, hashtext(?))', [APPROVAL_LOCK, row.url_key]);
          await t.one('SELECT id FROM jobs WHERE id = ? FOR UPDATE', [jobId]);
          await assertStillPublishable(t, url, row.url_key);
          await assertVersion(t, jobId, input.version);
          const company = await t.one<{ company_id: number }>('SELECT company_id FROM jobs WHERE id = ?', [jobId]);
          if (company && (await companyOptedOut(t, Number(company.company_id)))) throw conflict(REFUSED.optedOutCompany);
          if (again) {
            // SB-4: approved again: back in search for ADMIN_APPROVED_JOB_DAYS more.
            const state = await t.one<{ active: boolean; out: boolean }>(
              'SELECT active, unverified_since IS NOT NULL AS out FROM jobs WHERE id = ? AND owner_user_id IS NULL AND superseded_by IS NULL',
              [jobId],
            );
            if (!state?.active || !state.out) throw conflict(REFUSED.changed);
            await t.run('UPDATE job_admin_approvals SET approved_by = ?, approved_at = ? WHERE job_id = ?', [admin.id, at, jobId]);
            await t.run('UPDATE jobs SET unverified_since = NULL, updated_at = ? WHERE id = ?', [at, jobId]);
            await projectJob(t, jobId);
            return;
          }
          if (!(await legacyHeld(t, jobId))) throw conflict(REFUSED.changed);
          await t.run('UPDATE jobs SET held_since = NULL, updated_at = ? WHERE id = ? AND held_since IS NOT NULL', [at, jobId]);
          await projectJob(t, jobId);
          // Its legacy read is done (held.ts settleHeldAfterRead's rule): published. Its note stays (SB-4).
          await t.run(
            `UPDATE job_link_queue SET state = 'done', result = 'published', reason = NULL, job_id = ?, lease_until = NULL, done_at = ?
             WHERE for_job_id = ? AND origin = 'legacy' AND state = 'queued'`,
            [jobId, at, jobId],
          );
          await t.run(
            `INSERT INTO job_admin_approvals(job_id, url_key, kind, approved_by, approved_at, adders) VALUES (?, ?, 'legacy', ?, ?, 0)
             ON CONFLICT (job_id) DO NOTHING`,
            [jobId, row.url_key, admin.id, at],
          );
        },
        { label: again ? 'approve a job again' : 'approve a legacy job' },
      );
      return { jobId, url, approvedAt: at, already: false, adders: 0 };
    }

    const published = await deps.db.tx(
      (t) => publishCapturedIn(deps, t, { jobId, url, adminId: admin.id, at, ...(input.version !== undefined ? { version: input.version } : {}) }),
      { label: 'approve a captured job' },
    );
    const adders = await giveWayToApproved(deps, {
      jobId: published.jobId,
      url,
      told: published.joined ? [] : [row.user_id!],
      approvedByAdmin: published.approved,
    });
    if (published.joined) {
      // Joined an approval made meanwhile: answered as that approval.
      const made = await approvalOf(deps.db, published.jobId);
      if (made) return { jobId: made.job_id, url, approvedAt: made.approved_at, already: true, adders: made.adders };
    }
    return { jobId: published.jobId, url, approvedAt: at, already: false, adders };
  });
}

/**
 * The open public job an account's own job gave way to (jobs.superseded_by, a few steps), and when it did; null for a
 * job that gave way to nothing, or to a job that is not open and public.
 */
async function gaveWayTo(db: DbQueries, jobId: number): Promise<{ jobId: number; at: string } | null> {
  const start = await db.one<{ superseded_by: number | null; closed_at: string | null; updated_at: string }>(
    'SELECT superseded_by, closed_at, updated_at FROM jobs WHERE id = ?',
    [jobId],
  );
  if (!start || start.superseded_by === null) return null;
  let id = Number(start.superseded_by);
  for (let step = 0; step < 5; step += 1) {
    const job = await db.one<{ superseded_by: number | null; owner_user_id: string | null; active: boolean; held: boolean }>(
      'SELECT superseded_by, owner_user_id, active, held_since IS NOT NULL AS held FROM jobs WHERE id = ?',
      [id],
    );
    if (!job) return null;
    if (job.superseded_by !== null) {
      id = Number(job.superseded_by);
      continue;
    }
    if (job.owner_user_id !== null || !job.active || job.held) return null;
    return { jobId: id, at: new Date(start.closed_at ?? start.updated_at).toISOString() };
  }
  return null;
}

/** A job's Apply link (its shared form). */
async function urlOf(db: DbQueries, jobId: number): Promise<string | null> {
  const row = await db.one<{ apply_url: string }>('SELECT apply_url FROM jobs WHERE id = ?', [jobId]);
  return row ? sharedAddress(row.apply_url) : null;
}
