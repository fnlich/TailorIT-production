import { nowIso } from '../../core/context';
import { newReadsAllowed } from '../../core/http/identity';
import type { JobLinkRef, RecheckPosting, RecheckPostingResult } from '../../core/seams';
import { holdOf } from './hosts';
import { HostHeldError, nothingSent } from './http'; // v37 INT-A (W4)
import { postingRefOf, readLink, READABLE_KINDS, type LinkToRead } from './liveness';
import { postingApiUrl } from './postings';
import { NEW_READ_KIND_OF } from './scheduler';
import { requireIngest } from './service';
import { toSourceRecord, type SourceRow } from './sources';
import { SCHEDULED_KINDS } from './types';

// v30 S1-API: the server's re-check of a reported posting (core/seams.ts RecheckPosting; 14 §5.1 step 3, §2.5), for
// X1-API's re-check queue. Outside any transaction (a re-check reads an outside host):
//   1. every enabled listing source that lists the job is made due now (job_sources.next_run_at), so its next complete
//      listing settles the report under the two-miss rule (sourceMadeDue);
//   2. the link the reports named (or the job's newest live link TailorIT can read one posting at a time) is read once
//      through the ingest client: today's identity (INGEST_USER_AGENT: the read today's liveness check made, not a new
//      kind of read, so no assertNewReadAllowed), the host's pace for every process and its robots.txt;
//   3. the answer: `live` (the posting is stored again, as a run stores it), `gone` (nothing closes: the caller closes
//      through closeLink when the review is approved), `unreadable` (a failed read; a robots.txt refusal; v37 INT-A:
//      with `retryAt` for a held host, asked nothing) or `not_possible` (no link of a kind with a per-posting read: a page job, SmartRecruiters,
//      iCIMS, a career site while S5's reader is off; no request).
// The budget (EXT_RECHECKS_PER_DAY), one check per review at a time and the 6-hour floor are the caller's.
// v30 FIX-A (INT-4 open item S3 C): a Workday career site's link (workday_site, a new kind of read) is read too, once
// BOT_USER_AGENT is set and with it (the service's botHttp); while it is a placeholder such a link is `not_possible`.
// v37 INT-A (SP v37 PLAN W4, CLOSED's open item): a read that meets a held host or the Workday lane's pause (asked
// nothing, or its own 429 paused every Workday site), or that sent nothing (its wait for a turn ran out), is "try
// later": `unreadable` with `retryAt`, which the re-check queue (job-reviews/rechecks.ts) waits for, recording nothing.

/** v37 INT-A: when a read that sent nothing (no hold named: its wait for the host's turn ran out) is tried again. */
export const RECHECK_UNSENT_RETRY_MS = 60_000;

interface LinkRow extends SourceRow {
  source_job_id: string;
  job_url: string;
}

/** Reads a reported posting once: gone, live, unreadable or not possible (see the top). */
export const recheckPosting: RecheckPosting = async (deps, input) => {
  deps.db.assertNoTx('a re-check of a posting');
  const db = deps.db;
  const checkedAt = nowIso(deps);
  const answer = (state: RecheckPostingResult['state'], link: JobLinkRef | null, sourceMadeDue: boolean): RecheckPostingResult => ({
    state,
    checkedAt,
    link,
    sourceMadeDue,
  });
  const job = await db.one<{ id: number }>('SELECT id FROM jobs WHERE id = ?', [input.jobId]);
  if (!job) return answer('not_possible', null, false);

  // 1. Its enabled listing sources are due now.
  const due = await db.run(
    `UPDATE job_sources SET next_run_at = CAST(@now AS timestamptz)
     WHERE enabled AND kind = ANY(string_to_array(@kinds, ','))
       AND (next_run_at IS NULL OR next_run_at > CAST(@now AS timestamptz))
       AND id IN (SELECT source_id FROM job_source_links WHERE job_id = @job AND missing_since IS NULL)`,
    { now: checkedAt, kinds: SCHEDULED_KINDS.join(','), job: input.jobId },
  );
  const listed = await db.one(
    `SELECT 1 AS found FROM job_source_links l JOIN job_sources s ON s.id = l.source_id
     WHERE l.job_id = ? AND l.missing_since IS NULL AND s.enabled AND s.kind = ANY(string_to_array(?, ','))`,
    [input.jobId, SCHEDULED_KINDS.join(',')],
  );
  const sourceMadeDue = due.changes > 0 || Boolean(listed);

  // 2. The link to read: the one named (it must be this job's), else its readable live links, newest seen first.
  const links = await db.all<LinkRow>(
    `SELECT s.*, l.source_job_id, j.apply_url AS job_url FROM job_source_links l
     JOIN job_sources s ON s.id = l.source_id JOIN jobs j ON j.id = l.job_id
     WHERE l.job_id = @job AND s.kind = ANY(string_to_array(@kinds, ','))
       AND ${input.link ? 'l.source_id = @source AND l.source_job_id = @posting' : 'l.missing_since IS NULL'}
     ORDER BY l.last_seen_at DESC, l.source_id`,
    {
      job: input.jobId,
      kinds: READABLE_KINDS.join(','),
      ...(input.link ? { source: input.link.sourceId, posting: input.link.sourceJobId } : {}),
    },
  );
  const readable = links
    .map((row) => {
      const link: LinkToRead = { source: toSourceRecord(row), sourceJobId: row.source_job_id, jobUrl: row.job_url };
      // A new kind's posting is read only with BOT_USER_AGENT (v30 FIX-A).
      if (NEW_READ_KIND_OF[row.kind] && !newReadsAllowed(deps)) return { link, ref: null };
      return { link, ref: postingRefOf(link) };
    })
    .find((entry) => entry.ref !== null);
  if (!readable?.ref) return answer('not_possible', input.link ?? null, sourceMadeDue);
  const ref = readable.ref;
  const linkRef: JobLinkRef = { sourceId: readable.link.source.id, sourceJobId: readable.link.sourceJobId };

  // 3. A held host (or the Workday lane, paused) is asked nothing: v37 INT-A (W4) try later, after its hold.
  const host = new URL(postingApiUrl(ref)).host;
  const hold = await holdOf(db, host, checkedAt);
  if (hold) return { ...answer('unreadable', linkRef, sourceMadeDue), retryAt: hold.until };
  const service = requireIngest(deps);
  const http = NEW_READ_KIND_OF[readable.link.source.kind] ? service.botHttp : service.http;
  let failure: unknown = null;
  const state = await readLink(deps, { http, store: service.store }, readable.link, ref, { onFailure: (error) => (failure = error) });
  // v37 INT-A (W4): held or paused while it read (its own 429 paused every Workday site), or nothing sent: try later.
  if (state === 'unreadable' && (failure instanceof HostHeldError || nothingSent(failure))) {
    const retryAt = failure instanceof HostHeldError ? failure.until : new Date(deps.now().getTime() + RECHECK_UNSENT_RETRY_MS).toISOString();
    return { ...answer('unreadable', linkRef, sourceMadeDue), retryAt };
  }
  return answer(state, linkRef, sourceMadeDue);
};
