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

/**
 * v35 FIX-STORE (the fix list's item 10): each reason in an admin's words (Admin › Review, Admin › Import's results):
 * what to do about a link TailorIT could not read, where JOB_VERIFY_REASON_MESSAGE speaks to the person who added it.
 * Admin › Review's REASON_ADMIN_TEXT (apps/web .../review/unverified.ts) is this map.
 */
export const JOB_VERIFY_REASON_ADMIN_TEXT: Record<JobVerifyReason, string> = {
  unreadable_host: 'A site TailorIT never reads (a job board or a sign-in page).',
  no_posting: "The page doesn't describe its job as a schema.org JobPosting.",
  robots: "The site's robots.txt asks automated readers not to read it.",
  blocked: 'The site asked for a sign-in or a bot check.',
  unavailable: 'No answer from the site this time. Retry read later.',
  not_set_up: 'Page reads are off here: set BOT_USER_AGENT in .env, and keep "Read job pages on add" on in Constants.',
  unlisted: "The posting is not on its board's public list.",
  // v32 FIX-API (SB-6): such a link is never published, so its row has no Approve.
  opted_out: 'The company asked TailorIT not to list its jobs: this link is never published.',
  rejected: 'An admin rejected this link.',
  closed: 'The posting has closed.',
  invalid_link: 'Not an https job link TailorIT may read.',
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
  /**
   * v35 IMPORT (SP v35 PLAN.md H4): the pay as the person wrote it ("$40/hr", "90k-110k"): the job's pay when its
   * description states none (the description's pay first). Kept on their own job only, as the rest.
   */
  rate: z.string().trim().max(120).optional(),
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
 *
 * v32 ADMINAPP (E6): `admin_approved`, on a published job anyone sees: TailorIT could not read it, and an admin
 * approved it as it was captured (`checkedAt`: when; who is the admins' to see, never sent here). v36 JOBS (PLAN J7):
 * sent to administrators only (the signed-in role); everyone else gets no `verification` for such a job.
 */
export const JobVerificationSchema = z.object({
  state: z.enum(['waiting_admin', 'private_unverified', 'admin_approved']),
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
  /** v32 ADMINAPP (E6): the row's job as captured (its title and company), what an approval publishes. */
  title: z.string().optional(),
  companyName: z.string().optional(),
  /** v32 FIX-API (SB-1): the row's job's place as captured (absent: none). */
  location: z.string().optional(),
  /**
   * v32 FIX-API (SB-1): how many different versions of the job the link's adders captured: the admin reads them in full
   * (GET /api/admin/jobs/unverified/:jobId) and picks the one an approval publishes.
   */
  versions: z.number().int().nonnegative().optional(),
  /**
   * v32 FIX-API (SB-4): the link's job was published by an approval that ran out (ADMIN_APPROVED_JOB_DAYS): it left
   * search, and waits to be approved again, read again or rejected.
   */
  approvedBefore: z.boolean().optional(),
  /**
   * v35 IMPORT (H3): where the row came from: `import`, an admin's import (its job made from the row, no adder; the
   * import's id and run); `add`, a person's add; `other` (a v3.0 job). Absent from v3.4 answers.
   */
  from: z.enum(['import', 'add', 'other']).optional(),
  importId: z.number().int().nullable().optional(),
  runId: z.number().int().nullable().optional(),
  /**
   * v35 OPSWEB (SPECS-W2 OPSWEB §3): the import's name and the row the link came from, for the row's "Import · jobs.csv,
   * row 12" (null or absent: no import's row).
   */
  importName: z.string().nullable().optional(),
  importRow: z.number().int().positive().nullable().optional(),
});
export type UnverifiedLink = z.infer<typeof UnverifiedLinkSchema>;

/** v32 FIX-API (SB-1): the most versions of a link's job the detail shows (the first captured first). */
export const UNVERIFIED_VERSIONS_MAX = 20;

/**
 * v32 FIX-API (SB-1, the coordinator's decision): one version of a link's job as its adders captured it, in full: what
 * an approval of it publishes, word for word. `version` is its content hash: the approval sends it back and is refused
 * (409) when the job changed since.
 */
export const UnverifiedVersionSchema = z.object({
  /** The adder's job an approval of this version publishes. */
  jobId: z.number().int(),
  version: z.string(),
  title: z.string(),
  companyName: z.string(),
  locations: z.array(z.string()),
  /** The pay as captured ("$120k - $150k/yr", or as written); null when none. */
  pay: z.string().nullable(),
  /** The description as it is stored and would be shown (sanitised HTML; captured text is escaped). */
  descriptionHtml: z.string(),
  /** The Apply link an approval publishes: the link listed, in its shared form. */
  applyUrl: z.string(),
  /** Accounts that captured this very version. */
  adders: z.number().int().positive(),
  /** Only the viewing admin captured it: another admin approves it (an admin never publishes words they added). */
  yours: z.boolean(),
  /** Published before by an approval that ran out (SB-4): approving it publishes it again. */
  published: z.boolean(),
  addedAt: IsoDateTime,
});
export type UnverifiedVersion = z.infer<typeof UnverifiedVersionSchema>;

/** v32 FIX-API (SB-1): GET /api/admin/jobs/unverified/:jobId, the row's link and every version of its job. */
export const UnverifiedLinkDetailSchema = z.object({
  url: z.string(),
  host: z.string(),
  reason: z.enum(JOB_VERIFY_REASONS),
  versions: z.array(UnverifiedVersionSchema).max(UNVERIFIED_VERSIONS_MAX),
  /** Versions past UNVERIFIED_VERSIONS_MAX, not shown. */
  moreVersions: z.number().int().nonnegative(),
});
export type UnverifiedLinkDetail = z.infer<typeof UnverifiedLinkDetailSchema>;

/** v32 FIX-API (SB-1): POST .../approve's body: the version the admin read (UnverifiedVersion.version). */
export const UnverifiedApproveBodySchema = z.object({
  version: z.string().regex(/^[0-9a-f]{64}$/, 'Open the job again to approve it.'),
});
export type UnverifiedApproveBody = z.infer<typeof UnverifiedApproveBodySchema>;

// v35 IMPORT (SP v35 PLAN.md H3): "Couldn't verify" for imports. The list's From filter (All, Imports, People's adds,
// one import), its rows' origin, and its bulk actions: Approve or Reject a selection (at most UNVERIFIED_BULK_MAX), or
// every row the filter matches ("all": in batches on the server, after a confirm that shows the count).

/** Where a "Couldn't verify" row came from: an admin's import, a person's add (their own job), or other (a v3.0 job). */
export const UNVERIFIED_FROM = ['all', 'imports', 'adds'] as const;
export type UnverifiedFrom = (typeof UNVERIFIED_FROM)[number];

/** GET /api/admin/jobs/unverified(/count): the page and the filter (one import: its id, or its run's). */
export const UnverifiedListQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  from: z.enum(UNVERIFIED_FROM).optional(),
  importId: z.coerce.number().int().positive().optional(),
  runId: z.coerce.number().int().positive().optional(),
});
export type UnverifiedListQuery = z.infer<typeof UnverifiedListQuerySchema>;

/** The most rows one selection's bulk action takes. */
export const UNVERIFIED_BULK_MAX = 100;

/** POST /api/admin/jobs/unverified/bulk: Approve or Reject the rows chosen (their jobIds, as the list gives them). */
export const UnverifiedBulkBodySchema = z.object({
  action: z.enum(['approve', 'reject']),
  jobIds: z
    .array(z.number().int().positive())
    .min(1, 'Choose at least one row.')
    .max(UNVERIFIED_BULK_MAX)
    .refine((ids) => new Set(ids).size === ids.length, 'Each row once.'),
});
export type UnverifiedBulkBody = z.infer<typeof UnverifiedBulkBodySchema>;

/** POST /api/admin/jobs/unverified/all: Approve all or Reject all for every row the filter matches. */
export const UnverifiedAllBodySchema = z.object({
  action: z.enum(['approve', 'reject']),
  from: z.enum(UNVERIFIED_FROM).optional(),
  importId: z.number().int().positive().optional(),
  runId: z.number().int().positive().optional(),
  /** v35 FIX-STORE (S6): the count's `upTo` (absent: every row the filter matches, as before). */
  upTo: z.string().max(40).optional(),
});
export type UnverifiedAllBody = z.infer<typeof UnverifiedAllBodySchema>;

/**
 * v35 FIX-STORE (S6): GET /api/admin/jobs/unverified/count: the links the list holds for the filter, and `upTo`, what was
 * counted (opaque): Approve all / Reject all send it back and decide nothing beyond it (rows that arrive later stay).
 */
export const UnverifiedCountSchema = z.object({ count: z.number().int().nonnegative(), upTo: z.string().max(40) });
export type UnverifiedCount = z.infer<typeof UnverifiedCountSchema>;

/** What a row of a bulk action came to. */
export const UnverifiedBulkItemSchema = z.object({
  jobId: z.number().int(),
  outcome: z.enum(['approved', 'rejected', 'skipped']),
  /** Why it was skipped (the refusal's words), or null. */
  message: z.string().nullable(),
});

/** A bulk action's answer (selection or all): its counts, one line in words, and (selection) each row's outcome. */
export const UnverifiedBulkResultSchema = z.object({
  action: z.enum(['approve', 'reject']),
  done: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  /** Rows the filter still matches that this call left (the hour's approvals used, or the time ran out): call again. */
  left: z.number().int().nonnegative(),
  /** The result in one line ("Approved 1,240 jobs."). */
  message: z.string(),
  items: z.array(UnverifiedBulkItemSchema),
});
export type UnverifiedBulkResult = z.infer<typeof UnverifiedBulkResultSchema>;

export const UnverifiedLinksResponseSchema = z.object({
  items: z.array(UnverifiedLinkSchema),
  nextCursor: z.string().nullable(),
});
export type UnverifiedLinksResponse = z.infer<typeof UnverifiedLinksResponseSchema>;

/**
 * v32 ADMINAPP (E6, the owner's "admin should be able to approve manually"): POST
 * /api/admin/jobs/unverified/:jobId/approve, an admin's approval of a link TailorIT could not read. The job is published
 * as it was captured (its adder's browser or typed words: the admin types nothing), marked approved by the admin.
 * `already`: it was approved before (the same answer again). v32 FIX-API (SB-1): the version the admin read
 * (UnverifiedApproveBody), and only it; every other adder keeps their own job and is told a public version exists.
 */
export const UnverifiedApprovalSchema = z.object({
  approved: z.literal(true),
  /** The published job (the one approved, or the public job of the link the adders' jobs gave way to). */
  jobId: z.number().int(),
  /** The link, in its shared form. */
  url: z.string().nullable(),
  approvedAt: IsoDateTime,
  already: z.boolean(),
  /** The adders whose own job of the link is now the published one (each is told): v32 FIX-API, its one adder. */
  adders: z.number().int().nonnegative(),
});
export type UnverifiedApproval = z.infer<typeof UnverifiedApprovalSchema>;

/**
 * v32 ADMINAPP (E6): POST /api/admin/reviews/:id/retry, Retry read of a new job waiting in Review › New jobs (an ATS's
 * or a page's read, D12): TailorIT reads its link again now, so the admin approves its latest words. `read`: read again
 * (the job keeps waiting, its words the new read's); `closed`: the posting is gone (Reject it); `unreadable`: why not.
 */
export const ReviewRetryReadSchema = z.object({
  state: z.enum(['read', 'closed', 'unreadable']),
  jobId: z.number().int(),
  reason: z.enum(JOB_VERIFY_REASONS).nullable(),
});
export type ReviewRetryRead = z.infer<typeof ReviewRetryReadSchema>;
