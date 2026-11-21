import type { MessageKey } from '@tailorit/shared';
import { isProfileKey, linkAs } from '@tailorit/shared/sharing'; // v33 SHARE-6
import { guarded, notify, notifyStats, type NotifyDeps, type NotifyOutcome } from './service';

// v3.1 NOTIFY: a job a person added, read (or not) by TailorIT's server. LINK's add pipeline (features/jobs/add,
// addJobByLink) and its retry read call notifyJobVerification with the state it reached; this module only words it.

/** LINK's result states (build plan §4 LINK.2): the same strings as LINK's shared enum. */
export type JobVerificationState = 'published' | 'waiting_admin' | 'private_unverified' | 'refused';

export interface JobVerificationEvent {
  /** Who added the job (the person the notification is for). */
  userId: string;
  /** The job kept for it; null when nothing was kept (a refused link). */
  jobId: number | null;
  state: JobVerificationState;
  /**
   * Why, in people's words (a sentence of LINK's message constants), added after the body; null or a bare code
   * (`robots_disallowed`) adds nothing.
   */
  reason?: string | null;
  /**
   * v32 ADMINAPP (E6): a `published` job TailorIT could not read that an admin published as it was captured: the body
   * says so (MSG_NOTIFY_JOB_APPROVED_BODY) rather than that TailorIT read it. v32 FIX-API (REV-UXREQ UXREQ-9): and so
   * does its title (MSG_NOTIFY_JOB_APPROVED_TITLE).
   */
  approvedByAdmin?: boolean;
  /**
   * v32 FIX-API (REV-SECBEH SB-1): a `published` job that is another adder's version of the person's own job, published
   * by an admin: theirs stays as they added it (MSG_NOTIFY_JOB_PUBLIC_VERSION_*); the link opens the published one.
   */
  publicVersion?: boolean;
  /**
   * v33 SHARE-6 (PLAN-sharing §4 "Explicit changes"): the shared profile the job is on, for a notice to the person who
   * added it there (jobs/add/notify.ts linkNoticeTarget): its link opens the job on that profile (?as=<key>).
   */
  profile?: string;
}

/** v33 SHARE-6: the job's page, on the shared profile it was added on when the notice names one. */
const jobLink = (jobId: number, profile: string | undefined) =>
  profile && isProfileKey(profile) ? linkAs(`/jobs?jobId=${jobId}`, profile) : `/jobs?jobId=${jobId}`;

const KIND_OF = {
  published: 'job_verified',
  waiting_admin: 'job_waiting',
  private_unverified: 'job_unverified',
  refused: 'job_refused',
} as const satisfies Record<JobVerificationState, string>;

/** A sentence for people, not a code. */
const isSentence = (reason: string | null | undefined): reason is string => !!reason && !/^[a-z0-9_.:-]+$/i.test(reason.trim());

/**
 * One notification for the person who added a job, once per job and state (dedupe `job:<id>:<state>`): verified,
 * waiting for an admin, couldn't verify (only they see it), or not added. Call it in LINK's transaction or after it
 * committed. Never throws.
 */
export async function notifyJobVerification(deps: NotifyDeps, event: JobVerificationEvent): Promise<NotifyOutcome> {
  const kind = KIND_OF[event.state];
  if (!kind) return 'skipped';
  const jobId = event.jobId;
  let job: { title: string; company: string } | undefined;
  if (jobId !== null) {
    try {
      job = await guarded(deps, (db) =>
        db.one<{ title: string; company: string }>(
          'SELECT j.title, c.name AS company FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = ?',
          [jobId],
        ),
      );
    } catch (error) {
      notifyStats.failed += 1;
      deps.log.warn(`[notifications] ${kind} for account ${event.userId}: the job could not be read`, error);
      return 'failed';
    }
  }
  const published = event.state === 'published';
  // v32 FIX-API: an admin's approval, and another adder's version published, say so in their title and body.
  const words: { title?: MessageKey; body?: readonly MessageKey[] } =
    published && event.publicVersion
      ? { title: 'MSG_NOTIFY_JOB_PUBLIC_VERSION_TITLE', body: ['MSG_NOTIFY_JOB_PUBLIC_VERSION_BODY'] }
      : published && event.approvedByAdmin
        ? { title: 'MSG_NOTIFY_JOB_APPROVED_TITLE', body: ['MSG_NOTIFY_JOB_APPROVED_BODY'] } // v32 ADMINAPP
        : {};
  const unnamed: MessageKey | undefined = !job && event.state === 'refused' ? 'MSG_NOTIFY_JOB_REFUSED_UNNAMED_TITLE' : undefined;
  if (!job && !unnamed) return 'skipped';
  const title = unnamed ?? words.title;
  return notify(deps, event.userId, {
    kind,
    params: { title: job?.title ?? '', company: job?.company ?? '' },
    ...(title ? { title } : {}),
    ...(words.body ? { body: words.body } : {}),
    bodyExtra: isSentence(event.reason) ? event.reason : null,
    // A refused job is not listed: nothing to open.
    link: job && event.state !== 'refused' ? jobLink(jobId!, event.profile) : null, // v33 SHARE-6: on the profile it was added on
    // A refused link with no job kept is told each time (nothing names it twice).
    dedupeKey: job ? `job:${jobId}:${event.state}` : null,
  });
}
