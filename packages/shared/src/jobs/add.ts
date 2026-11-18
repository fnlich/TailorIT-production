import { z } from 'zod';
import type { MessageKey } from '../constants/constants';
import { IsoDateTime } from '../core/list';

// v31 LINK: adding a job by its link (docs/design/v3.1/21-jobs-from-links.md). Every add path (the web's Add job, a
// tracker entry with a link, the MCP tool, an admin's add, an import, the extension) runs one pipeline on the server,
// addJobByLink: the link made canonical, TailorIT's own read of the posting (an ATS's API, or the page's schema.org
// JobPosting), and one of four states. Nothing the adder typed or their browser captured reaches a job others see.

/** What an add came to. */
export const JOB_ADD_STATES = [
  /** TailorIT read the posting from its link and found it open: everyone sees the job. */
  'published',
  /** TailorIT read it, and NEW_JOBS_ADMIN_APPROVAL holds new jobs for an admin: only its adders see it until then. */
  'waiting_admin',
  /** TailorIT could not read it: only its adder sees the job (from what their browser captured, or what they typed). */
  'private_unverified',
  /** Not added: the posting has closed, the link is no job link, or an admin rejected it. */
  'refused',
] as const;
export type JobAddState = (typeof JOB_ADD_STATES)[number];

/** Who or what added the link (each add path). */
export const JOB_ADD_ORIGINS = [
  'web',
  'tracker',
  'mcp',
  'admin',
  'import',
  'sheets',
  'ft_lake',
  'extension',
  'extension_page',
  'applied',
  /** v31 LINK2: a job an import or a published page copy made before v3.1, read now from its link. */
  'legacy',
] as const;
export type JobAddOrigin = (typeof JOB_ADD_ORIGINS)[number];

/** Why TailorIT could not read a job's link (private_unverified), or did not add it (refused). */
export const JOB_VERIFY_REASONS = [
  /** A site TailorIT never reads: LinkedIn, a refused job board, a sign-in page's host. */
  'unreadable_host',
  /** The page names no schema.org JobPosting of its own. */
  'no_posting',
  /** The site's robots.txt disallows the read. */
  'robots',
  /** A sign-in wall, a bot check, 401/403/429. */
  'blocked',
  /** The site or the ATS failed or did not answer: try again later. */
  'unavailable',
  /** Page reads are off here (ADD_JOB_PAGE_READ) or wait for BOT_USER_AGENT (the owner's setting). */
  'not_set_up',
  /** An Ashby posting off its board's public list. */
  'unlisted',
  /** The company asked TailorIT not to read its site. */
  'opted_out',
  /** An admin rejected the link from Admin › Review. */
  'rejected',
  /** The posting has closed (refused). */
  'closed',
  /** Not an https job link TailorIT may read (refused). */
  'invalid_link',
] as const;
export type JobVerifyReason = (typeof JOB_VERIFY_REASONS)[number];

/** Each reason's words (constants, public). */
export const JOB_VERIFY_REASON_MESSAGE: Record<JobVerifyReason, MessageKey> = {
  unreadable_host: 'MSG_JOB_VERIFY_UNREADABLE_HOST',
  no_posting: 'MSG_JOB_VERIFY_NO_POSTING',
  robots: 'MSG_JOB_VERIFY_ROBOTS',
  blocked: 'MSG_JOB_VERIFY_BLOCKED',
  unavailable: 'MSG_JOB_VERIFY_UNAVAILABLE',
  not_set_up: 'MSG_JOB_VERIFY_NOT_SET_UP',
  unlisted: 'MSG_JOB_VERIFY_UNLISTED',
  opted_out: 'MSG_JOB_VERIFY_OPTED_OUT',
  rejected: 'MSG_JOB_VERIFY_REJECTED',
  closed: 'MSG_JOB_ADD_REFUSED_CLOSED',
  invalid_link: 'MSG_JOB_ADD_REFUSED_LINK',
};

/** Each state's words (constants, public): what the Add job dialog says. */
export const JOB_ADD_STATE_MESSAGE: Record<JobAddState, MessageKey> = {
  published: 'MSG_JOB_ADD_PUBLISHED',
  waiting_admin: 'MSG_JOB_ADD_WAITING',
  private_unverified: 'MSG_JOB_ADD_PRIVATE',
  refused: 'MSG_JOB_ADD_REFUSED_LINK',
};

/** The longest link an add takes (a stored link's cap). */
export const JOB_LINK_MAX_CHARS = 2048;

/**
 * What a person typed for a job whose link TailorIT cannot read (the Add job dialog's second step, a tracker entry):
 * kept on their own job only, never on a job others see.
 */
export const JobAddDetailsSchema = z.object({
  title: z.string().trim().min(1).max(300),
  company: z.string().trim().min(1).max(200),
  location: z.string().trim().max(300).optional(),
  description: z.string().trim().max(20_000).optional(),
});
export type JobAddDetails = z.infer<typeof JobAddDetailsSchema>;

/** POST /api/jobs/add (the web's Add job dialog). `details` is read only when TailorIT cannot read the link. */
export const AddJobBodySchema = z.object({
  url: z.string().trim().min(1).max(JOB_LINK_MAX_CHARS),
  details: JobAddDetailsSchema.optional(),
});
export type AddJobBody = z.infer<typeof AddJobBodySchema>;

/** What an add answers (POST /api/jobs/add, the MCP tool add_job, POST /api/jobs/:id/verify). */
export const AddJobResultSchema = z.object({
  state: z.enum(JOB_ADD_STATES),
  /** The job (the shared one, or the adder's own); null when nothing was added. */
  jobId: z.number().int().nullable(),
  /** The link as TailorIT keeps it (canonical); null for no link. */
  url: z.string().nullable(),
  /** Why the link could not be read, or why nothing was added; null when it was read. */
  reason: z.enum(JOB_VERIFY_REASONS).nullable(),
  /** The job is new to TailorIT. */
  created: z.boolean(),
  /** private_unverified with no job: TailorIT needs the title and company (`details`) to save it for the adder alone. */
  needsDetails: z.boolean(),
  /** What happened, in words (the state's or the reason's message, rendered by the server). */
  message: z.string(),
});
export type AddJobResult = z.infer<typeof AddJobResultSchema>;

/**
 * A job's verification, on the job DTOs (JobSummary.verification) for the person who sees a job others do not: absent
 * for a published job. `waiting_admin`: TailorIT read it, an admin's approval comes next; `private_unverified`: TailorIT
 * could not read it (`reason`), it is the viewer's own until it can.
 */
export const JobVerificationSchema = z.object({
  state: z.enum(['waiting_admin', 'private_unverified']),
  checkedAt: IsoDateTime.nullable(),
  reason: z.enum(JOB_VERIFY_REASONS).nullable(),
});
export type JobVerification = z.infer<typeof JobVerificationSchema>;

/** POST /api/admin/jobs/add: links to queue for TailorIT's own read (at most ADMIN_ADD_LINKS_MAX). */
export const AdminAddLinksBodySchema = z.object({
  urls: z.array(z.string().trim().min(1).max(JOB_LINK_MAX_CHARS)).min(1).max(20_000),
});
export type AdminAddLinksBody = z.infer<typeof AdminAddLinksBodySchema>;

/** A link the queue refused at once (no job link). */
export const RefusedLinkSchema = z.object({ url: z.string(), reason: z.enum(JOB_VERIFY_REASONS) });

/** 202 of POST /api/admin/jobs/add (and the link list an import queued). */
export const QueuedLinksSchema = z.object({
  batchId: z.string(),
  /** Links queued now. */
  queued: z.number().int().nonnegative(),
  /** Links already waiting in the queue (read once). */
  alreadyQueued: z.number().int().nonnegative(),
  /** Repeats of a link in the list, counted once. */
  repeated: z.number().int().nonnegative(),
  refused: z.array(RefusedLinkSchema),
  /**
   * v31 FIX-LINK (BEH-5): an import run's links TailorIT read lately (within JOB_PAGE_RECHECK_DAYS), not queued again;
   * absent when none.
   */
  readRecently: z.number().int().nonnegative().optional(),
});
export type QueuedLinks = z.infer<typeof QueuedLinksSchema>;

export const JOB_LINK_QUEUE_STATES = ['queued', 'working', 'done'] as const;

/** One link of a batch's progress. */
export const QueuedLinkSchema = z.object({
  url: z.string(),
  state: z.enum(JOB_LINK_QUEUE_STATES),
  result: z.enum(JOB_ADD_STATES).nullable(),
  reason: z.enum(JOB_VERIFY_REASONS).nullable(),
  jobId: z.number().int().nullable(),
});

/** GET /api/admin/jobs/add/:batchId: a batch's progress. */
export const LinkBatchProgressSchema = z.object({
  batchId: z.string(),
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  items: z.array(QueuedLinkSchema),
});
export type LinkBatchProgress = z.infer<typeof LinkBatchProgressSchema>;

/** One row of Admin › Review's "Couldn't verify" list: a link TailorIT could not read, and who added it. */
export const UnverifiedLinkSchema = z.object({
  /** The first adder's job (Retry read and Reject act on the link through it). */
  jobId: z.number().int(),
  url: z.string(),
  host: z.string(),
  reason: z.enum(JOB_VERIFY_REASONS),
  checkedAt: IsoDateTime,
  firstAddedAt: IsoDateTime,
  /** Accounts that keep their own job of this link. */
  adders: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
});
export type UnverifiedLink = z.infer<typeof UnverifiedLinkSchema>;

export const UnverifiedLinksResponseSchema = z.object({
  items: z.array(UnverifiedLinkSchema),
  nextCursor: z.string().nullable(),
});
export type UnverifiedLinksResponse = z.infer<typeof UnverifiedLinksResponseSchema>;
