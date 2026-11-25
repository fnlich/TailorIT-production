import {
  canonicalJobUrl,
  linkKey,
  type JobAddDetails,
  type JobAddOrigin,
  type JobAddState,
  type JobVerifyReason,
} from '@tailorit/shared';
import { nowIso, type AppDeps } from '../../../core/context';
import { notFound } from '../../../core/http/errors';
import { refuse } from '../../../core/http/refuse';
import { closeLink } from '../../../core/seams'; // v37 CLOSED (C5)
import { aliasValueHash } from '../../autofill/alias-key';
import { storeOwnJobFromDetails } from '../../autofill/from-page';
import {
  ATS_NAMES, // v37 CLOSED (C3)
  heldJobOf,
  newInFlight,
  readShared,
  saveToTracker,
  upgradeOwnPageJob,
  upgradeOwnPageJobsFor,
  type InFlight,
} from '../../autofill/jobs';
import { findPageJob, readPage, type PageReading } from '../../autofill/lookup';
import { isRefusedPageHost, isSiteHost } from '../../job-reviews/hosts';
import { noteHeldAdd } from '../../job-reviews/new-jobs'; // v31 FIX-LINK (D12)
import { sharedAddress } from './address';
import { legacyHeld } from './held';
import { settleLegacyJob } from './legacy';
import { readPageToSharedJob, type ImportRead } from './page'; // v35 INT-A: ImportRead
import { fillPayFromRate } from './import-jobs'; // v35 IMPORT
import { linkNoticeTarget, noticeVerification } from './notify'; // v33 SHARE-6: linkNoticeTarget
import { linkRejected, noteUnverified, ownJobsOfLink } from './verification';
import { atsFailure, type LinkRead, type ReadPause } from './verdict'; // v37 CLOSED (C1, C3)
import { offerBoardOfClosedLink, postingOfLink } from './closed-link'; // v37 CLOSED (C4, C7)

// v31 LINK: addJobByLink, the ONE pipeline every add path runs (docs/design/v3.1/21-jobs-from-links.md §3; the build
// plan's D1-D3). In order:
//   1. The link made canonical (canonicalJobUrl: no "?utm_source=Simplify", no "?source=..."), and checked: an https
//      address on a public host name (never an IP address, a local name or a port), else `refused` (invalid_link).
//   2. A job TailorIT has of that link (the lookup's order: the ATS posting it names, its link keys, the person's
//      alias): it is linked to the person (saved to their tracker when asked), never read again; a closed one is read
//      again (a posting listed again reopens). The person's own job of it (one TailorIT could not read before) is read
//      again too, and gives way to the shared job when the read works.
//   3. TailorIT's own read (readLink): the ATS's API where one reads the posting (Greenhouse, Lever, Ashby, Workable,
//      Workday: ingest/postings.ts, through readShared), else the page's own schema.org JobPosting (page.ts, the shared
//      reader, D3). A posting read is stored through the ingest pipeline: its title, company (and the company's domain
//      and logo, then the enrichment queue) and text are the posting's, never the adder's. It is `published` at once,
//      or `waiting_admin` while NEW_JOBS_ADMIN_APPROVAL holds new jobs (D1). A closed posting is `refused` (closed).
//   4. A link TailorIT cannot read (LinkedIn and the refused boards are never read; a sign-in page, no JobPosting,
//      robots.txt, a switch off): `private_unverified` (D2). What the person typed (`details`) makes their own job,
//      seen by them alone and labelled as from their browser; without details nothing is kept (`needsDetails`). Either
//      way it is noted for Admin › Review's "Couldn't verify" (Retry read, Reject). An import's or an admin's link that
//      cannot be read adds nothing (`refused`, with the reason).
// No step trusts a title, a company or a description from the adder for a job others see.
//
// v31 FIX-LINK: every address kept or answered is the link's shared form (address.ts, SEC-2: no ?email=, ?token=, ...);
// the page is read at the link as given. A link an admin rejected stays rejected with a parameter added or its path's
// case changed (verification.ts linkRejected, SEC-8). A job the legacy pass holds (legacy.ts) is never answered as
// "waiting for an admin" from step 2: TailorIT reads its link now and the read settles it (held.ts, BEH-4); and that
// read, as a legacy row's or a Retry read's, is a real one (`fresh`: never the shortcut of a held job another account's
// add made, BEH-2).

export interface AddJobByLinkInput {
  url: string;
  /** The person adding: their tracker and their own job. Null for an import's or an admin's link. */
  userId: string | null;
  origin: JobAddOrigin;
  /** What the person typed for a link TailorIT cannot read: their own job only. */
  details?: JobAddDetails | null;
  /** Make the person's own job from `details` when the link cannot be read (default true; the tracker keeps its entry). */
  privateJob?: boolean;
  /** Save the job to the person's tracker at Saved (the web's Add job, the MCP tool). */
  save?: boolean;
  /** Reads under way, shared (a router's). */
  inFlight?: InFlight;
  /**
   * v33 SHARE-6 (PLAN-sharing §4 "Explicit changes"): who adds, when that is someone working on `userId`'s profile (B),
   * and the grant they work under: the link's later notices go to them (verification.ts LinkAdder; notify.ts). Left
   * out: the person adds on their own profile.
   */
  actor?: { id: string; grantId: string | null };
  // v34 FANOUT (the FANOUT review, sharing 5): an add of one link on several profiles in one request reads it once.
  /** Step 3's read of this link made earlier in the same request (closed or unreadable): reused, never read again. */
  knownRead?: Extract<LinkRead, { kind: 'closed' | 'unreadable' }>;
  /** Told step 3's read, once made (the next profile's add reuses a failed one). */
  onRead?: (read: LinkRead) => void;
  // end v34 FANOUT
  /** v37 CLOSED (C3): the read's budget (the link queue's LINK_QUEUE_READ_TIMEOUT_MS; a person's add keeps 15 s). */
  timeoutMs?: number;
}

export interface AddJobByLinkOutcome {
  state: JobAddState;
  jobId: number | null;
  /** The link in its canonical form; null when it is none. */
  url: string | null;
  reason: JobVerifyReason | null;
  created: boolean;
  needsDetails: boolean;
  /**
   * v37 CLOSED (C3): the site (every Workday site) paused TailorIT: `refused` (`unavailable`) at once, nothing kept, and
   * the answer says when to try again (router.ts addJobResultOf). Absent otherwise (every other answer as before).
   */
  pause?: ReadPause;
}

/** How readLink reads. */
export interface ReadLinkOptions {
  /** The link as given (its canonical form, a person's own parameters kept): the page is read there. */
  readAt?: string;
  /**
   * v31 FIX-LINK (BEH-2): read the ATS posting itself, never the held job another account's add made of it
   * (autofill/jobs.ts readShared's shortcut): the legacy pass's reads and Retry read.
   */
  fresh?: boolean;
  /** v31 FIX-LINK (D12): an admin approves the posting at this link: a page's new job is published, never held. */
  approved?: boolean;
  /** v35 INT-A: an admin import's read: its row fills what the read lacks; a new job it holds is the import's (page.ts). */
  importRead?: ImportRead;
  /** v37 CLOSED (C3): an ATS read's budget (the link queue's LINK_QUEUE_READ_TIMEOUT_MS; people's reads keep 15 s). */
  timeoutMs?: number;
}

/** What TailorIT's own read of a link came to (v37 CLOSED: verdict.ts, with a paused read's pause). */
export type { LinkRead } from './verdict';

/**
 * Whether a canonical link is one TailorIT may add: an https address with no port on a public host name (never an IP
 * address or a local name), or on a site TailorIT never reads (LinkedIn, a refused job board: its job can only be the
 * adder's own).
 */
export function isAddableLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.port !== '') return false;
    return isSiteHost(parsed.hostname) || (DNS_NAME.test(parsed.hostname) && isRefusedPageHost(parsed.hostname));
  } catch {
    return false;
  }
}

/** A dotted DNS name (letters, digits, hyphens), the last label letters only. */
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

async function isHeld(deps: Pick<AppDeps, 'db'>, jobId: number): Promise<boolean> {
  const row = await deps.db.one<{ held: boolean }>('SELECT held_since IS NOT NULL AS held FROM jobs WHERE id = ?', [jobId]);
  return row?.held === true;
}

/**
 * TailorIT's own read of a canonical link (step 3 above): the shared job it stored (made, or found by the store's
 * dedupe), closed, or why it could not be read. LinkedIn and the refused boards are never read, and a link an admin
 * rejected is never published. Outside any transaction.
 */
export async function readLink(
  deps: AppDeps,
  url: string,
  inFlight?: InFlight,
  page?: PageReading,
  options: ReadLinkOptions = {},
): Promise<LinkRead> {
  deps.db.assertNoTx('reading a job link');
  const reading = page ?? readPage(url, undefined, aliasValueHash(deps));
  const host = new URL(url).hostname;
  if (reading.linkedIn || isRefusedPageHost(host)) return { kind: 'unreadable', reason: 'unreadable_host' };
  if (await linkRejected(deps.db, sharedAddress(url) ?? url)) return { kind: 'unreadable', reason: 'rejected' };
  // v37 CLOSED (C4): a Workday link without a location is a posting read too (closed-link.ts postingOfLink).
  const posting = postingOfLink(reading, url);
  if (posting) {
    try {
      const stored = await readShared(deps, posting, inFlight ?? newInFlight(), {
        fresh: options.fresh === true,
        ...(options.importRead ? { importRead: options.importRead } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
      return { kind: 'shared', jobId: stored.jobId, created: stored.created, held: await isHeld(deps, stored.jobId) };
    } catch (error) {
      return atsFailure(error, ATS_NAMES[posting.kind]); // v37 CLOSED (C1): verdict.ts
    }
  }
  return readPageToSharedJob(deps, options.readAt ?? url, {
    approved: options.approved === true,
    ...(options.importRead ? { importRead: options.importRead } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), // v37 FIX-37A (F9): a BambooHR/iCIMS link's budget too
  });
}

/** The state of a shared job: waiting for an admin while held, else published. */
const stateOf = (held: boolean): JobAddState => (held ? 'waiting_admin' : 'published');

/** addJobByLink (see the top). Outside any transaction. */
export async function addJobByLink(deps: AppDeps, input: AddJobByLinkInput): Promise<AddJobByLinkOutcome> {
  deps.db.assertNoTx('addJobByLink');
  // The link as given is read; its shared form (no secret parameter) is what is kept and answered (SEC-2).
  const given = canonicalJobUrl(input.url);
  const url = sharedAddress(given);
  const outcome = (state: JobAddState, jobId: number | null, reason: JobVerifyReason | null, created = false, needsDetails = false) => ({
    state,
    jobId,
    url,
    reason,
    created,
    needsDetails,
  });
  if (!given || !url || given.length > 2100 || !isAddableLink(given) || !isAddableLink(url)) return outcome('refused', null, 'invalid_link');
  const { userId } = input;
  const page = readPage(url, undefined, aliasValueHash(deps));
  // v33 SHARE-6 (the SHARE-6 review): a held job's add names who added it (the actor on a shared profile, else nobody).
  const heldAdder = { addedBy: input.actor?.id ?? userId ?? null, grantId: input.actor?.grantId ?? null };
  const save = async (jobId: number) => {
    if (userId && input.save) await saveToTracker(deps, userId, jobId, undefined, heldAdder);
  };

  // 2. A job TailorIT has (an import's or an admin's link: a shared one only, as nobody's viewer).
  const found = (await findPageJob(deps, userId ?? '', page)) ?? (await heldJobOf(deps, page));
  let own: number | null = null;
  if (found) {
    const job = await deps.db.one<{ owner_user_id: string | null; active: boolean; held: boolean }>(
      'SELECT owner_user_id, active, held_since IS NOT NULL AS held FROM jobs WHERE id = ?',
      [found.id],
    );
    // v31 FIX-LINK (BEH-4): a job the legacy pass holds is read now: the read settles it.
    if (job && job.owner_user_id === null && job.active && job.held && (await legacyHeld(deps.db, found.id))) {
      const settled = await settleLegacyJob(deps, found.id, url, { final: true, readAt: given });
      const kept = settled.jobId ?? found.id;
      if (settled.state === 'published' || settled.state === 'waiting_admin') {
        if (userId) await upgradeOwnPageJobsFor(deps, userId, kept);
        await save(kept);
        return outcome(settled.state, kept, null);
      }
      if (settled.state === 'refused') return outcome('refused', null, settled.reason ?? 'closed');
      // Not read now (the site failed, or the job became its adder's own): it stays as it is, the person's to see.
      await save(found.id);
      return outcome('private_unverified', found.id, settled.reason);
    }
    if (job && job.owner_user_id === null && job.active) {
      await save(found.id);
      return outcome(stateOf(job.held), found.id, null);
    }
    if (job && userId && job.owner_user_id === userId) own = found.id;
  }

  // 3. TailorIT's own read (v34 FANOUT: or the failed one this request already made of the link).
  const read =
    input.knownRead ?? (await readLink(deps, url, input.inFlight, page, { readAt: given, ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) }));
  input.onRead?.(read);
  if (read.kind === 'shared') {
    if (userId) {
      // The person's own job of this link gives way to the shared one (its tracker entry, aliases and queue rows move).
      if (own !== null) await upgradeOwnPageJob(deps, userId, own, read.jobId, { sameLink: true });
      await upgradeOwnPageJobsFor(deps, userId, read.jobId);
    }
    await save(read.jobId);
    return outcome(stateOf(read.held), read.jobId, null, read.created);
  }
  if (read.kind === 'closed') {
    // v37 CLOSED (C7): a person's closed link offers its board to discovery (a candidate, no person's data).
    if (userId) await offerBoardOfClosedLink(deps, url, isExtensionOrigin(input.origin) ? 'extension' : 'application_link');
    return outcome('refused', null, 'closed');
  }
  // v37 CLOSED (C3, LANE's W5): the site (every Workday site) asked TailorIT to slow down: answered at once with when to
  // try again; nothing is kept and nothing goes to Review (an import's queued read reads it again after the pause:
  // import-pipeline.ts). A host TailorIT holds for another reason (a bot check, the breaker, an admin) is answered as any
  // link it cannot read now, as before.
  if (read.pause?.slowDown) return { ...outcome('refused', own, 'unavailable'), pause: read.pause };

  // 4. A link TailorIT cannot read.
  const reason = read.reason;
  if (!userId) return outcome('refused', null, reason);
  // v33 SHARE-6: the note names who added it (the actor on a shared profile, else the owner: nobody else).
  const adder = { addedBy: input.actor?.id ?? userId, grantId: input.actor?.grantId ?? null };
  const note = (jobId: number) => noteUnverified(deps.db, { jobId, userId, url, origin: input.origin, reason, ...adder }, nowIso(deps));
  if (own !== null) {
    await note(own);
    await save(own);
    return outcome('private_unverified', own, reason);
  }
  if (input.details && input.privateJob !== false) {
    const made = await storeOwnJobFromDetails(deps, userId, url, input.details);
    // v35 IMPORT (SP v35 PLAN.md H4): the Rate the person gave is the job's pay when its description states none.
    const rate = input.details.rate;
    if (rate) await deps.db.tx((t) => fillPayFromRate(t, made.jobId, rate, nowIso(deps)), { label: 'add job: pay from rate' });
    await note(made.jobId);
    await save(made.jobId);
    return outcome('private_unverified', made.jobId, reason, made.created);
  }
  return outcome('private_unverified', null, reason, false, input.privateJob !== false);
}

/** v37 CLOSED (C7): the add paths of the extension (its add, From page, Applied): their closed links are its finds. */
function isExtensionOrigin(origin: JobAddOrigin): boolean {
  return origin === 'extension' || origin === 'extension_page' || origin === 'applied';
}

/**
 * Retry read (POST /api/jobs/:id/verify, Admin › Review's Retry read): TailorIT reads the link of a job only its adder
 * sees again. Read now, the shared job takes the place of every account's own job of that link (upgradeOwnPageJob);
 * still unreadable, the attempt is noted. The job's adder or an admin only (404 for anyone else: the job is not theirs
 * to see). A shared job answers its state, nothing read.
 */
export async function verifyJob(
  deps: AppDeps,
  jobId: number,
  actor: { id: string; admin: boolean },
  askerId: string = actor.id, // v33 SHARE-6: who asked (B on A's profile; `actor` is then A, the profile's owner)
): Promise<AddJobByLinkOutcome> {
  deps.db.assertNoTx('verifyJob');
  const job = await deps.db.one<{
    owner_user_id: string | null;
    apply_url: string;
    held: boolean;
    active: boolean;
    url: string | null;
    origin: string | null;
    added_by: string | null; // v33 SHARE-6
    grant_id: string | null; // v33 SHARE-6
  }>(
    `SELECT j.owner_user_id, j.apply_url, j.held_since IS NOT NULL AS held, j.active, v.url, v.origin, v.added_by, v.grant_id
     FROM jobs j LEFT JOIN job_verifications v ON v.job_id = j.id WHERE j.id = ? AND j.superseded_by IS NULL`,
    [jobId],
  );
  if (!job || (job.owner_user_id !== null && job.owner_user_id !== actor.id && !actor.admin)) throw notFound('That job');
  const url = sharedAddress(job.url ?? job.apply_url);
  const answer = (state: JobAddState, id: number | null, reason: JobVerifyReason | null) => ({
    state,
    jobId: id,
    url,
    reason,
    created: false,
    needsDetails: false,
  });
  if (job.owner_user_id === null) {
    // v31 LINK2: a held job of v3.0 TailorIT could not read and no one account added (legacy.ts): an admin's Retry read
    // reads its link again and settles it.
    if (job.held && job.url !== null && actor.admin && url && (await legacyHeld(deps.db, jobId))) {
      const settled = await settleLegacyJob(deps, jobId, url, { final: true });
      return { ...answer(settled.state, settled.jobId, settled.reason) };
    }
    if (job.held && !actor.admin) {
      // A held job is its adders' to see: one who is not an adder gets the 404 any hidden job gets.
      const adder = await deps.db.one(
        `SELECT 1 FROM applications WHERE job_id = ? AND user_id = ?
         UNION ALL SELECT 1 FROM job_review_reports p JOIN job_reviews r ON r.id = p.review_id WHERE r.job_id = ? AND p.user_id = ? LIMIT 1`,
        [jobId, actor.id, jobId, actor.id],
      );
      if (!adder) throw notFound('That job');
    }
    return answer(stateOf(job.held), jobId, null);
  }
  if (job.owner_user_id !== actor.id && !actor.admin) throw refuse(deps, 'forbidden', 'MSG_JOB_VERIFY_NOT_YOURS');
  if (!url || !isAddableLink(url)) return answer('private_unverified', jobId, 'invalid_link');
  const read = await readLink(deps, url, undefined, undefined, { fresh: true });
  if (read.kind === 'shared') {
    const key = linkKey(url);
    const owners = key ? await ownJobsOfLink(deps.db, key) : [];
    if (!owners.some((row) => Number(row.job_id) === jobId)) {
      owners.push({ job_id: jobId, user_id: job.owner_user_id, added_by: job.added_by, grant_id: job.grant_id }); // v33 SHARE-6: its adder
    }
    for (const row of owners) {
      const moved = await upgradeOwnPageJob(deps, row.user_id, Number(row.job_id), read.jobId, { sameLink: true });
      // v31 FIX-LINK (D12): a job read now that waits for an admin counts each adder as one (their report row), so they
      // hear it once the admin approves it.
      // v33 SHARE-6: the report row names the note's adder (B on the owner's profile hears the approval there).
      if (moved && read.held) await noteHeldAdd(deps, row.user_id, read.jobId, { addedBy: row.added_by ?? row.user_id, grantId: row.grant_id ?? null });
      // Each adder hears that TailorIT read their job (the one who asked sees the answer). v33 SHARE-6: the one who
      // added it on someone else's profile hears it there (linkNoticeTarget); the asker is whoever asked (askerId).
      const target = moved ? await linkNoticeTarget(deps, row) : null;
      if (target && target.userId !== askerId) {
        await noticeVerification(deps, { userId: target.userId, profile: target.profile, jobId: read.jobId, state: stateOf(read.held) });
      }
    }
    return { ...answer(stateOf(read.held), read.jobId, null), created: read.created };
  }
  // v37 CLOSED (C3): the site paused TailorIT: nothing is read or noted; the answer says when to try again.
  if (read.kind === 'unreadable' && read.pause) return { ...answer('private_unverified', jobId, 'unavailable'), pause: read.pause };
  const reason: JobVerifyReason = read.kind === 'closed' ? 'closed' : read.reason;
  const origin = (job.origin ?? 'web') as JobAddOrigin;
  if (read.kind === 'closed') {
    // v37 CLOSED (C5): the posting has closed: the person's own job closes (its Closed badge; out of their open jobs)
    // and is no link to verify any more (its Couldn't verify note goes); its board is offered to discovery.
    const at = nowIso(deps);
    await deps.db.tx(
      async (t) => {
        await closeLink(deps, t, { jobId, reason: 'gone', at });
        await t.run('DELETE FROM job_verifications WHERE job_id = ?', [jobId]);
      },
      { label: 'retry read: a closed posting' },
    );
    await offerBoardOfClosedLink(deps, url, isExtensionOrigin(origin) ? 'extension' : 'application_link');
  } else {
    await noteUnverified(deps.db, { jobId, userId: job.owner_user_id, url, origin, reason }, nowIso(deps));
  }
  const state = read.kind === 'closed' ? 'refused' : 'private_unverified';
  // v33 SHARE-6: as above, the adder on the owner's profile hears it there; the asker sees the answer.
  const target = await linkNoticeTarget(deps, { user_id: job.owner_user_id, added_by: job.added_by, grant_id: job.grant_id });
  if (target.userId !== askerId) await noticeVerification(deps, { userId: target.userId, profile: target.profile, jobId, state, reason });
  return answer(state, jobId, reason);
}
