import { STATUS, type JobAddState, type JobVerifyReason } from '@tailorit/shared';
import { addablePosting, parseAtsUrl } from '@tailorit/shared/autofill';
import { nowIso, type AppDeps } from '../../../core/context';
import type { DbTx } from '../../../core/db/types';
import type { DailyStep } from '../../../core/feature';
import { closeLink, projectJob } from '../../../core/seams';
import { ROW_SOURCE_KINDS } from '../../ingest/types';
import { sharedAddress } from './address';
import { legacyHeld } from './held';
import { noticeVerification } from './notify';
import { isAddableLink, readLink } from './pipeline';
import { queueJobLinks } from './queue';
import { noteUnverified } from './verification';
import { TRY_LATER_REASONS } from './verdict'; // v37 INT-A: the verdict's try-later reasons (was TRANSIENT_REASONS here)

// v31 LINK2 (21-jobs-from-links.md §9; the coordinator's decision of 2026-11-17): the shared jobs stored before v3.1
// from what a person or a file said, never from TailorIT's own read: an import's rows (CSV, JSON, a Google Sheet, the
// free_tailor lake) and the page jobs an admin published from browsers' text (`ext_page`). A job any other source
// lists (a board TailorIT reads) is no legacy job.
//
// Once (the daily step `job-links.legacy-links`, its own marker `v31:legacy-links`, nothing on a database with no job):
// each such job is HELD (held_since: out of search, seen only by the accounts that track it) and its link queued for
// TailorIT's own read (job_link_queue, origin `legacy`, for that job). The read (settleLegacyJob, in the worker):
//   - read: the posting TailorIT read is the job's. When the store's dedupe landed on the job itself, its title,
//     company and text were rewritten from the read (a reader's source outranks or ties an import's) and the hold is
//     lifted; when the read made another job, the legacy job gives way to it (retireLegacyJob: tracker entries,
//     aliases and queue rows move; it closes, superseded). Published either way, the old text gone;
//   - closed: its links close (closeLink, `gone`);
//   - page reads not set up yet (ADD_JOB_PAGE_READ off, BOT_USER_AGENT the placeholder): it stays held and its read is
//     asked again a day later (LEGACY_WAIT_MS), never called unreadable for it;
//   - unreadable: when one account added it (the one reporter of the published page copy, tracked by no one else) it
//     becomes that account's own job (its identity keys dropped, so no later read lands on it) and is noted for
//     "Couldn't verify"; else it stays held, its trackers' alone, and is noted with no adder.
//
// v31 FIX-LINK (REV-BEH BEH-1..BEH-4, the coordinator's decisions of 2026-11-18):
//   - BEH-1: only OPEN legacy jobs are held and read (a closed one is in no search: it is left as it is); the reads are
//     queued newest posting first, the ATS links (read through their APIs) before the pages, so the open jobs that left
//     search come back first;
//   - BEH-2: a legacy job is settled only by a real read (readLink `fresh`): never the shortcut of a held job another
//     account's add made;
//   - BEH-3: only a lasting answer settles it: read (published, or D12's Review for a page), closed (404, 410, a past
//     validThrough), or unreadable for good (no JobPosting, robots.txt, a site TailorIT never reads, an opt-out, an
//     admin's reject). A failure for now (`unavailable`: 5xx, a timeout, the network; `blocked`: 401, 403, 429, a wall)
//     is read again with a growing wait (queue.ts), up to three times LINK_QUEUE_ATTEMPTS, and even then the job is
//     never made anyone's own nor its keys dropped: it stays held and is listed in "Couldn't verify" for a Retry read;
//   - BEH-4: any read of TailorIT's that lands on a legacy job settles it in its own transaction (held.ts).

const MARK = 'v31:legacy-links';
/** The source kinds whose jobs were stored from what a row or a browser said (ingest/types.ts, the store reads it too). */
export const LEGACY_KINDS = ROW_SOURCE_KINDS;
/** Jobs one batch of the pass holds and queues. */
const LEGACY_BATCH = 500;

const KINDS_SQL = LEGACY_KINDS.map((kind) => `'${kind}'`).join(', ');

/** The SQL condition of a legacy job `j` (see the top). v31 FIX-LINK (BEH-1): an open one. */
export const LEGACY_JOB_SQL = `j.active AND j.owner_user_id IS NULL AND j.superseded_by IS NULL
  AND EXISTS (SELECT 1 FROM job_source_links l JOIN job_sources s ON s.id = l.source_id WHERE l.job_id = j.id AND s.kind IN (${KINDS_SQL}))
  AND NOT EXISTS (SELECT 1 FROM job_source_links l JOIN job_sources s ON s.id = l.source_id
                  WHERE l.job_id = j.id AND l.missing_since IS NULL AND s.kind NOT IN (${KINDS_SQL}))`;

/** A legacy job to read, as the pass orders the reads (see the top). */
interface LegacyRead {
  jobId: number;
  url: string;
  /** Read through an ATS's API (Greenhouse, Lever, Ashby, Workable, Workday): first. */
  ats: boolean;
  /** Its posting's date (posted, else first seen), epoch ms: the newest first. */
  posted: number;
}

/** The pass's order of reads (BEH-1): the ATS links first, then the newest posting first, then the newest job. */
export function legacyReadOrder(a: LegacyRead, b: LegacyRead): number {
  if (a.ats !== b.ats) return a.ats ? -1 : 1;
  if (a.posted !== b.posted) return b.posted - a.posted;
  return b.jobId - a.jobId;
}

/** The daily step (see the top): jobs held and queued; nothing once done, nothing on a database with no job. */
export const legacyLinksStep: DailyStep = {
  name: 'legacy-links',
  async run(deps) {
    if (await deps.db.one('SELECT 1 FROM app_settings WHERE key = ?', [MARK])) return 0;
    if (!(await deps.db.one('SELECT 1 FROM jobs LIMIT 1'))) return 0;
    let held = 0;
    const reads: LegacyRead[] = [];
    for (let after = 0; ; ) {
      const rows = await deps.db.all<{ id: number; apply_url: string; posted: string | null }>(
        `SELECT j.id, j.apply_url, j.posted_sort AS posted FROM jobs j WHERE j.id > ? AND ${LEGACY_JOB_SQL} ORDER BY j.id LIMIT ?`,
        [after, LEGACY_BATCH],
      );
      if (rows.length === 0) break;
      after = Number(rows[rows.length - 1]!.id);
      const at = nowIso(deps);
      await deps.db.tx(
        async (t) => {
          for (const row of rows) {
            await t.run('UPDATE jobs SET held_since = COALESCE(held_since, ?), updated_at = ? WHERE id = ?', [at, at, row.id]);
            await projectJob(t, Number(row.id));
          }
        },
        { label: 'legacy jobs held' },
      );
      held += rows.length;
      for (const row of rows) {
        const url = sharedAddress(row.apply_url);
        if (url !== null && isAddableLink(url)) {
          const posted = row.posted ? Date.parse(row.posted) : 0;
          reads.push({ jobId: Number(row.id), url, ats: addablePosting(parseAtsUrl(url)) !== null, posted: Number.isNaN(posted) ? 0 : posted });
        } else {
          // A link TailorIT can never read (no https address of a public host) is settled at once: unreadable.
          await settleUnread(deps, Number(row.id), row.apply_url, 'invalid_link');
        }
      }
    }
    // BEH-1: queued in the order they are read (the queue reads a host's due rows oldest first: the insert's order).
    reads.sort(legacyReadOrder);
    await queueJobLinks(deps, reads, 'legacy');
    const at = nowIso(deps);
    await deps.db.run('INSERT INTO app_settings(key, value, updated_at) VALUES (?, CAST(? AS json), ?) ON CONFLICT (key) DO NOTHING', [
      MARK,
      JSON.stringify({ done: at, held }),
      at,
    ]);
    return held;
  },
};

/** The one account that added the job (the one reporter of its published page copy) when no other account tracks it. */
async function soleAdderOf(deps: Pick<AppDeps, 'db'>, jobId: number): Promise<string | null> {
  const adders = await deps.db.all<{ user_id: string }>(
    `SELECT DISTINCT p.user_id FROM job_review_reports p JOIN job_reviews r ON r.id = p.review_id
     WHERE r.kind = 'new_job' AND r.origin = 'page' AND r.subject_key IN (
       SELECT 'page:' || l.source_job_id FROM job_source_links l JOIN job_sources s ON s.id = l.source_id
       WHERE l.job_id = ? AND s.kind = 'ext_page')
     LIMIT 2`,
    [jobId],
  );
  if (adders.length !== 1) return null;
  const adder = adders[0]!.user_id;
  const others = await deps.db.one('SELECT 1 FROM applications WHERE job_id = ? AND user_id <> ? LIMIT 1', [jobId, adder]);
  return others ? null : adder;
}

/** An unreadable legacy job (see the top): its one adder's own, or held with no adder; noted for "Couldn't verify". */
async function settleUnread(deps: AppDeps, jobId: number, url: string, reason: JobVerifyReason): Promise<'private_unverified'> {
  const owner = await soleAdderOf(deps, jobId);
  const at = nowIso(deps);
  await deps.db.tx(
    async (t) => {
      if (owner) {
        // Its own now: never in anyone else's search, and keyed by nothing a later read could land on.
        await t.run('UPDATE jobs SET owner_user_id = ?, held_since = NULL, updated_at = ? WHERE id = ? AND owner_user_id IS NULL', [owner, at, jobId]);
        await t.run('DELETE FROM job_keys WHERE job_id = ?', [jobId]);
        await projectJob(t, jobId);
      }
      await noteUnverified(t, { jobId, userId: owner, url, origin: 'legacy', reason }, at);
    },
    { label: 'legacy job unread' },
  );
  if (owner) await noticeVerification(deps, { userId: owner, jobId, state: 'private_unverified', reason });
  return 'private_unverified';
}

/**
 * The legacy job gives way to the shared job TailorIT read for its link: every account's tracker entry moves to it
 * (unless the account has one of it), so do aliases, queue rows, dismissals and marks; the legacy job closes, its links
 * missing, superseded by the shared job. In one transaction.
 */
export async function retireLegacyJob(t: DbTx, legacyId: number, sharedId: number, at: string): Promise<void> {
  const moved = await t.all<{ id: string }>(
    `UPDATE applications SET job_id = ?, updated_at = ? WHERE job_id = ?
       AND NOT EXISTS (SELECT 1 FROM applications o WHERE o.user_id = applications.user_id AND o.job_id = ?)
     RETURNING id`,
    [sharedId, at, legacyId, sharedId],
  );
  // An entry moved while Saved, its resume TailorIT's, has it chosen again for the new text.
  for (const { id } of moved) {
    await t.run(
      `UPDATE applications SET resume_match_due = true WHERE id = ? AND current_status = ${STATUS.saved} AND archived_at IS NULL
         AND (resume_origin IS NULL OR resume_origin = 'auto')`,
      [id],
    );
  }
  await t.run('UPDATE job_link_aliases SET job_id = ? WHERE job_id = ?', [sharedId, legacyId]);
  for (const table of ['autofill_agent_queue', 'autofill_agent_dismissed', 'user_job_state']) {
    await t.run(
      `UPDATE ${table} SET job_id = ? WHERE job_id = ?
         AND NOT EXISTS (SELECT 1 FROM ${table} o WHERE o.user_id = ${table}.user_id AND o.job_id = ?)`,
      [sharedId, legacyId, sharedId],
    );
  }
  await t.run('UPDATE autofill_agent_tombstones SET job_id = ? WHERE job_id = ?', [sharedId, legacyId]);
  await t.run('UPDATE job_source_links SET missing_since = COALESCE(missing_since, ?) WHERE job_id = ?', [at, legacyId]);
  await t.run(
    'UPDATE jobs SET active = false, closed_at = COALESCE(closed_at, ?), superseded_by = ?, updated_at = ? WHERE id = ?',
    [at, sharedId, at, legacyId],
  );
  await t.run('DELETE FROM job_verifications WHERE job_id = ?', [legacyId]);
  await projectJob(t, legacyId);
}

/** What reading a legacy job's link came to. */
export interface LegacyOutcome {
  state: JobAddState;
  jobId: number | null;
  reason: JobVerifyReason | null;
  /** v31 FIX-LINK (BEH-3): the read failed for now and the job is left as it was: the queue reads it again later. */
  retry?: boolean;
  /** v37 INT-A: the read met a site's pause (every Workday site's): the queue reads it again then, its try given back. */
  until?: string;
}

/** A settled job's state as it is now (another read settled it first: an add's, an admin's Retry read). */
async function stateNow(deps: Pick<AppDeps, 'db'>, jobId: number): Promise<LegacyOutcome> {
  const job = await deps.db.one<{ active: boolean; held: boolean; owner_user_id: string | null; superseded_by: number | null }>(
    'SELECT active, held_since IS NOT NULL AS held, owner_user_id, superseded_by FROM jobs WHERE id = ?',
    [jobId],
  );
  if (!job) return { state: 'refused', jobId: null, reason: null };
  if (job.superseded_by !== null) return stateNow(deps, Number(job.superseded_by));
  if (job.owner_user_id !== null) return { state: 'private_unverified', jobId, reason: null };
  if (!job.active) return { state: 'refused', jobId, reason: 'closed' };
  return { state: job.held ? 'waiting_admin' : 'published', jobId, reason: null };
}

/**
 * Reads a legacy job's link and settles the job (see the top): the worker's `legacy` rows, an add that found it (BEH-4)
 * and an admin's Retry read of a held legacy job. Outside any transaction. A job the legacy pass no longer holds
 * (settled already) is left as it is, its state answered. `final`: the last try, so a failure for now is noted for
 * "Couldn't verify" (the job stays held) rather than tried again; `readAt`: the link as an add gave it (read there).
 */
export async function settleLegacyJob(
  deps: AppDeps,
  jobId: number,
  url: string,
  options: { final?: boolean; readAt?: string } = {},
): Promise<LegacyOutcome> {
  if (!(await legacyHeld(deps.db, jobId))) return stateNow(deps, jobId);
  // BEH-2: a real read, never a held job's shortcut.
  const read = await readLink(deps, url, undefined, undefined, { fresh: true, ...(options.readAt ? { readAt: options.readAt } : {}) });
  const at = nowIso(deps);
  if (read.kind === 'shared') {
    // Read onto the job itself: the read's own transaction settled it (held.ts). Into another job: it gives way to it.
    if (read.jobId !== jobId) await deps.db.tx((t) => retireLegacyJob(t, jobId, read.jobId, at), { label: 'legacy job read' });
    return { state: read.held ? 'waiting_admin' : 'published', jobId: read.jobId, reason: null };
  }
  if (read.kind === 'closed') {
    await deps.db.tx((t) => closeLink(deps, t, { jobId, reason: 'gone', at }), { label: 'legacy job closed' });
    return { state: 'refused', jobId, reason: 'closed' };
  }
  // Page reads are not set up here yet (ADD_JOB_PAGE_READ off, BOT_USER_AGENT the placeholder): the job stays held
  // and its read waits (the queue asks again a day later), rather than being called unreadable.
  if (read.reason === 'not_set_up') return { state: 'private_unverified', jobId, reason: 'not_set_up' };
  // BEH-3: a failure for now is no answer about the job: read again later; on the last try it is listed, still held.
  // v37 INT-A: the try-later reasons are the verdict's (verdict.ts TRY_LATER_REASONS), a pause's end carried.
  if (TRY_LATER_REASONS.has(read.reason)) {
    if (!options.final) {
      return { state: 'private_unverified', jobId, reason: read.reason, retry: true, ...(read.pause ? { until: read.pause.until } : {}) };
    }
    await noteUnverified(deps.db, { jobId, userId: null, url, origin: 'legacy', reason: read.reason }, at);
    return { state: 'private_unverified', jobId, reason: read.reason };
  }
  await settleUnread(deps, jobId, url, read.reason);
  return { state: 'private_unverified', jobId, reason: read.reason };
}
