import { z } from 'zod';
import { messageError } from '../constants/public/defaults';
import { IsoDate, IsoDateTime } from '../core/list';
import { JOB_VERIFY_REASONS } from '../jobs/add';
import { EMPLOYMENT_TYPES, SALARY_PERIODS, WORK_ARRANGEMENTS } from '../jobs/enums';

// v38 REVEDIT (SP v38 PLAN.md E1-E6, the owner's addendum of 2026-11-25: "admin should be able to edit on review job tab
// so that admin can change the job link, job description, ..."): an admin corrects a job from Admin › Review (every lane:
// Couldn't verify, New jobs, Closed links, Flags). The editor holds every field an admin sees on the job's details; a
// field the admin changed keeps the admin's value over later reads of the posting (source runs, re-checks, Retry read)
// until the admin asks for the posting's text again. The routes are the reviews router's (`/api/admin/reviews/jobs/:jobId`,
// admins only); the shapes are here so the API and the web read them the same.

/** The fields an admin can edit, in the editor's order. */
export const JOB_EDIT_FIELDS = [
  'link',
  'applyUrl',
  'title',
  'company',
  'description',
  'locations',
  'workArrangement',
  'employmentType',
  'salary',
  'postedAt',
] as const;
export type JobEditField = (typeof JOB_EDIT_FIELDS)[number];

/** Each field's name, as the editor and the "Edited by an admin" lines say it. */
export const JOB_EDIT_FIELD_LABEL: Record<JobEditField, string> = {
  link: 'Job link',
  applyUrl: 'Apply link',
  title: 'Title',
  company: 'Company',
  description: 'Description',
  locations: 'Places',
  workArrangement: 'Work mode',
  employmentType: 'Employment type',
  salary: 'Salary',
  postedAt: 'Posted date',
};

/**
 * The caps of an edit: ingest's own (apps/api/src/features/ingest/normalize.ts: a title of 300 characters, a company of
 * 200, a description of 200,000 after cleaning; store.ts: 200 places of 300 characters) and a job link's (Add job's 2,100).
 * The API test pins them to ingest's.
 */
export const JOB_EDIT_LIMITS = {
  link: 2100,
  title: 300,
  company: 200,
  /** The description as sent (before cleaning); what is kept is cleaned and cut to ingest's 200,000. */
  descriptionSent: 400_000,
  description: 200_000,
  places: 200,
  place: 300,
  /** A salary amount's highest value (a year's pay in any currency fits). */
  salary: 1_000_000_000,
} as const;

const Link = z.string().trim().min(1, 'Enter the job link.').max(JOB_EDIT_LIMITS.link, messageError('MSG_TEXT_TOO_LONG', { max: JOB_EDIT_LIMITS.link }));

/** A job's pay as an admin enters it: an amount or a range, its currency and period; null: the job states none. */
export const JobEditSalarySchema = z
  .object({
    min: z.number().nonnegative().max(JOB_EDIT_LIMITS.salary).nullable(),
    max: z.number().nonnegative().max(JOB_EDIT_LIMITS.salary).nullable(),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, 'Use a three-letter currency code, such as USD.')
      .transform((value) => value.toUpperCase()),
    period: z.enum(SALARY_PERIODS).nullable(),
  })
  .refine((salary) => salary.min !== null || salary.max !== null, { message: 'Enter an amount, or clear the salary.', path: ['min'] });
export type JobEditSalary = z.infer<typeof JobEditSalarySchema>;

/** Every editable value of a job, as the editor shows it and an edit sends it. */
export const JobEditValuesSchema = z.object({
  /** The link TailorIT reads (its canonical form once saved). */
  link: Link,
  /**
   * The Apply link when it differs from the job link (a job added from a page keeps the employer's own link); null:
   * Apply opens the job link. Only a job whose link was added (a "Couldn't verify" note) keeps one of its own.
   */
  applyUrl: Link.nullable(),
  title: z.string().trim().min(1, 'Enter the title.').max(JOB_EDIT_LIMITS.title, messageError('MSG_TEXT_TOO_LONG', { max: JOB_EDIT_LIMITS.title })),
  company: z
    .string()
    .trim()
    .min(1, 'Enter the company.')
    .max(JOB_EDIT_LIMITS.company, messageError('MSG_TEXT_TOO_LONG', { max: JOB_EDIT_LIMITS.company })),
  /** The description as HTML (cleaned as every stored description is). */
  descriptionHtml: z.string().max(JOB_EDIT_LIMITS.descriptionSent, 'This description is too long to keep.'),
  /** The places, one each ("Austin, TX", "Remote"); [] when the job names none. */
  locations: z
    .array(z.string().trim().min(1).max(JOB_EDIT_LIMITS.place, messageError('MSG_TEXT_TOO_LONG', { max: JOB_EDIT_LIMITS.place })))
    .max(JOB_EDIT_LIMITS.places, messageError('MSG_LIST_TOO_LONG', { max: JOB_EDIT_LIMITS.places })),
  workArrangement: z.enum(WORK_ARRANGEMENTS).nullable(),
  employmentType: z.enum(EMPLOYMENT_TYPES).nullable(),
  salary: JobEditSalarySchema.nullable(),
  /** The day the job was posted; null: TailorIT shows when it first saw it. */
  postedAt: IsoDate.nullable(),
});
export type JobEditValues = z.infer<typeof JobEditValuesSchema>;

/** Which value a field of JobEditValues holds (`description` is `descriptionHtml`). */
export const JOB_EDIT_VALUE_KEY: Record<JobEditField, keyof JobEditValues> = {
  link: 'link',
  applyUrl: 'applyUrl',
  title: 'title',
  company: 'company',
  description: 'descriptionHtml',
  locations: 'locations',
  workArrangement: 'workArrangement',
  employmentType: 'employmentType',
  salary: 'salary',
  postedAt: 'postedAt',
};

/** Who can see the job now: everyone, its adders while an admin approves it, its adder alone, or nobody (closed). */
export const JOB_EDIT_VISIBILITIES = ['public', 'waiting', 'private', 'closed'] as const;
export type JobEditVisibility = (typeof JOB_EDIT_VISIBILITIES)[number];

/** A field an admin edited: when, by whom (their email; null when that account is gone). */
export const JobEditMarkSchema = z.object({
  field: z.enum(JOB_EDIT_FIELDS),
  editedAt: IsoDateTime,
  editedBy: z.string().nullable(),
});
export type JobEditMark = z.infer<typeof JobEditMarkSchema>;

/** GET /api/admin/reviews/jobs/:jobId: the editor's job. */
export const AdminJobEditorSchema = z.object({
  jobId: z.number().int().positive(),
  values: JobEditValuesSchema,
  /** A hash of `values`: an edit names it, and is refused (409) when the job changed since. */
  version: z.string().regex(/^[0-9a-f]{64}$/),
  /** The fields an admin edited (they keep the admin's value over later reads). */
  edited: z.array(JobEditMarkSchema),
  /** Whether the Apply link is its own field (a job whose link was added); else Apply opens the job link. */
  ownApplyLink: z.boolean(),
  visibility: z.enum(JOB_EDIT_VISIBILITIES),
});
export type AdminJobEditor = z.infer<typeof AdminJobEditorSchema>;

/** PATCH /api/admin/reviews/jobs/:jobId: the changed values only, and the version they were made on. */
export const AdminJobEditBodySchema = z.object({
  version: z.string().regex(/^[0-9a-f]{64}$/),
  changes: JobEditValuesSchema.partial().refine((changes) => Object.keys(changes).length > 0, { message: 'Change a field first.' }),
});
export type AdminJobEditBody = z.infer<typeof AdminJobEditBodySchema>;

/** The job TailorIT already has of a link an edit names (the editor offers to open it; nothing is merged). */
export const JobEditDuplicateSchema = z.object({
  jobId: z.number().int().positive(),
  title: z.string(),
  companyName: z.string(),
  /** Waiting for an admin (it opens in Admin › Review), else a job the Jobs page opens. */
  held: z.boolean(),
  active: z.boolean(),
});
export type JobEditDuplicate = z.infer<typeof JobEditDuplicateSchema>;

/** What an edit came to: saved (the editor again, and the fields it changed), or another job already has the link. */
export const AdminJobEditSavedSchema = z.discriminatedUnion('saved', [
  z.object({ saved: z.literal(true), editor: AdminJobEditorSchema, changed: z.array(z.enum(JOB_EDIT_FIELDS)) }),
  z.object({ saved: z.literal(false), duplicate: JobEditDuplicateSchema }),
]);
export type AdminJobEditSaved = z.infer<typeof AdminJobEditSavedSchema>;

/** POST /api/admin/reviews/jobs/:jobId/restore: "Use the posting's text again" for one field. */
export const AdminJobRestoreBodySchema = z.object({ field: z.enum(JOB_EDIT_FIELDS) });
export type AdminJobRestoreBody = z.infer<typeof AdminJobRestoreBodySchema>;

/**
 * What "Read this link" came to (POST /api/admin/reviews/jobs/:jobId/read), through the one link verdict: `open` (the
 * posting's own text filled the fields the admin did not edit; the job is everyone's), `waiting` (read, and waiting for
 * an admin's approval in New jobs), `closed` (the job closed and its review settled), `try_later` (the site did not answer
 * now) or `cant_read` (TailorIT can't read this link): the admin's text stays and the job stays in Review.
 */
export const JOB_EDIT_READ_OUTCOMES = ['open', 'waiting', 'closed', 'try_later', 'cant_read'] as const;
export type JobEditReadOutcome = (typeof JOB_EDIT_READ_OUTCOMES)[number];

export const AdminJobReadSchema = z.object({
  outcome: z.enum(JOB_EDIT_READ_OUTCOMES),
  /** The job now: the one edited, or the shared job a person's own job gave way to. */
  jobId: z.number().int().positive(),
  reason: z.enum(JOB_VERIFY_REASONS).nullable(),
  /** The editor of `jobId` after the read; null when the job is no longer one Review shows. */
  editor: AdminJobEditorSchema.nullable(),
});
export type AdminJobRead = z.infer<typeof AdminJobReadSchema>;

/** The admin's words of an edit's refusals (an admin route: the API's and the web's one source). */
export const JOB_EDIT_ADMIN_TEXT = {
  notInReview: 'That job was not found in Admin › Review.',
  changed: 'This job changed since you opened it. Open it again to see what is there now.',
  invalidLink: 'Enter a job link that starts with https:// on a public site.',
  // v38 FIX-APP (REVIEW38-ux L17): plain words, and what to enter instead.
  siteNeverRead: "TailorIT doesn't read jobs from this site (a job board or a sign-in page). Enter the employer's own posting link.",
  rejected: 'An admin rejected this link, so it is never published. Enter another link.',
  ownApplyLink: 'This job has no Apply link of its own: Apply opens the job link.',
  noChange: 'Nothing changed: the job already says this.',
  notEdited: "This field shows the posting's text already.",
  noOriginal: "TailorIT has no posting's text for this field yet. Read this link first.",
  readClosed: 'This job is closed. Its link was not read.',
} as const;
