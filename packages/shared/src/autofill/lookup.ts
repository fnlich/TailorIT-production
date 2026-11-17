import { z } from 'zod';
import { InstantSchema } from './common';
import { WORK_ARRANGEMENTS } from './profile';
import { AUTOFILL_FILE_KINDS, AUTOFILL_RESUME_KINDS } from './resumes';

// The job behind an application page (POST /api/autofill/lookup): which TailorIT job it is, whether the person has
// already tracked it, which resume to attach and how well that resume matches the job. The page's URL travels in the
// body, never in the path or the query, because the error handler logs URLs; it is never stored, logged or echoed.
// `parseAtsUrl` is the shared reading of such an address: the server resolves with it, and the extension reads the
// same addresses with the same code. Adding a posting TailorIT does not have (POST /api/autofill/jobs) answers the
// same lookup, once the job is in TailorIT's jobs and in the person's tracker as Saved.
//
// Version 5 (LinkedIn and company career sites, v3 Phase 8): a page that is not the posting's own (a LinkedIn job, a
// company's careers page) names the employer's posting in `employerUrl` when the person's page shows it (its Apply
// link); `parseLinkedInJobUrl` reads a LinkedIn job's address; POST /api/autofill/jobs/from-page adds the job from the
// text the person sees when no ATS API can read it; and the answer's `page` says how TailorIT read the page. TailorIT's
// server never requests LinkedIn, for anything: LinkedIn's robots.txt disallows automated access, so its addresses
// are only compared, never fetched.

// Version 6 (the new ATSs of the owner's snapshots of 2026-11-06): Jobvite, JazzHR, BambooHR, Rippling, Breezy HR,
// CareerPlug, Pinpoint, Paycor, HiBob, UltiPro (UKG Pro), Dayforce, Paylocity, Dice, ClearCompany, ADP Workforce Now
// and SmartRecruiters, read exactly as the extension's adapters read them; Oracle Recruiting Cloud on Oracle's
// government cloud; Workable's job-search site; and iCIMS's application steps after its email gate.

// Version 7 (jr7, the owner's snapshot7 of 2026-11-11): UKG Ready (secure<n>.saashr.com), Paycom (www.paycomonline.net's
// candidate portal), JobDiva (www<n>.jobdiva.com/portal/) and Eightfold (<company>.eightfold.ai/careers), read exactly
// as the extension's adapters read them (src/adapters/{ukgready,paycom,jobdiva,eightfold}/url.ts).

/**
 * The applicant-tracking systems the extension fills. Equals the extension's PLATFORMS, in its order, without `site` (a
 * company's own careers page, which is no ATS) and (version 7) `jibe`, iCIMS's candidate front, whose jobs TailorIT
 * keeps as the iCIMS postings their Apply leads to.
 */
export const ATS_KINDS = [
  'greenhouse',
  'lever',
  'ashby',
  'workday',
  'workable',
  'icims',
  'taleo',
  'successfactors',
  'oracle',
  'jobvite',
  'jazzhr',
  'bamboohr',
  'rippling',
  'breezy',
  'careerplug',
  'pinpoint',
  'paycor',
  'hibob',
  'ultipro',
  'dayforce',
  'paylocity',
  'dice',
  'clearcompany',
  'adp',
  'smartrecruiters',
  // Version 7.
  'ukgready',
  'paycom',
  'jobdiva',
  'eightfold',
] as const;
export type AtsKind = (typeof ATS_KINDS)[number];

/** Each ATS's name as TailorIT's pages and prompts write it (the extension's COPY.platforms). */
export const ATS_NAMES: Readonly<Record<AtsKind, string>> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workday: 'Workday',
  workable: 'Workable',
  icims: 'iCIMS',
  taleo: 'Taleo',
  successfactors: 'SuccessFactors',
  oracle: 'Oracle Recruiting Cloud',
  jobvite: 'Jobvite',
  jazzhr: 'JazzHR',
  bamboohr: 'BambooHR',
  rippling: 'Rippling',
  breezy: 'Breezy HR',
  careerplug: 'CareerPlug',
  pinpoint: 'Pinpoint',
  paycor: 'Paycor',
  hibob: 'HiBob',
  ultipro: 'UltiPro (UKG Pro)',
  dayforce: 'Dayforce',
  paylocity: 'Paylocity',
  dice: 'Dice',
  clearcompany: 'ClearCompany',
  adp: 'ADP Workforce Now',
  smartrecruiters: 'SmartRecruiters',
  ukgready: 'UKG Ready',
  paycom: 'Paycom',
  jobdiva: 'JobDiva',
  eightfold: 'Eightfold',
};

/** The longest page address a lookup takes. */
export const AUTOFILL_LOOKUP_URL_MAX = 2048;
/** The most of a posting's stored text a lookup answers. */
export const AUTOFILL_POSTING_TEXT_MAX = 20_000;

/** A resume's id as a request names it (TailorIT's ids are UUIDs; anything else is a resume that is not there). */
const RequestResumeIdSchema = z.string().min(1).max(64);

/**
 * LinkedIn's own hosts: linkedin.com and every host under it (www., its country hosts uk., de., …), its China site
 * linkedin.cn, its link shortener lnkd.in and its static host licdn.com, compared in lower case and with any trailing
 * dots dropped. TailorIT's server never requests one of them, and an employer's link is never one.
 */
export function isLinkedInHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.+$/, '');
  return ['linkedin.com', 'linkedin.cn', 'lnkd.in', 'licdn.com'].some((domain) => name === domain || name.endsWith(`.${domain}`));
}

/**
 * Why `address` cannot be an employer's link, or null when it can: an https address (default port, no user name or
 * password) on a host that is not LinkedIn's, at most AUTOFILL_LOOKUP_URL_MAX characters. The extension sends the
 * visible Apply link, a LinkedIn redirect's `url=` decoded, and never a LinkedIn address.
 */
export function employerUrlProblem(address: string): string | null {
  if (address.length > AUTOFILL_LOOKUP_URL_MAX) return 'An employer link has at most 2,048 characters';
  const url = runtimeUrl(address);
  if (!url || url.protocol !== 'https:') return 'An employer link is an https address';
  if (url.port !== '' || url.username !== '' || url.password !== '') return 'An employer link names no port or user';
  if (!url.hostname || isLinkedInHost(url.hostname)) return "An employer link is the employer's own page, never LinkedIn's";
  return null;
}

/** An employer's link (version 5): https, never LinkedIn's (employerUrlProblem). */
const EmployerUrlSchema = z
  .string()
  .min(1)
  .max(AUTOFILL_LOOKUP_URL_MAX)
  .superRefine((address, ctx) => {
    const problem = employerUrlProblem(address);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

export const AutofillLookupRequestSchema = z.object({
  url: z.string().min(1).max(AUTOFILL_LOOKUP_URL_MAX),
  /**
   * Version 5: the employer's own link for the posting this page shows, when the page is not the posting's own (a
   * LinkedIn job's Apply link, a company page's link to its ATS): https, never a LinkedIn host. A LinkedIn job's address
   * the person keeps for a job (POST /api/autofill/jobs/from-page) answers first; then the employer's posting, only
   * when parseAtsUrl reads one from the link (any other link, a careers site's home page two jobs may share, names no
   * job); then the page; then the person's tracker by the posting links saved on it, however they are spelt. A job
   * another account made from a page never answers.
   */
  employerUrl: EmployerUrlSchema.optional(),
  /** Ask for the job's stored posting text, for the extension's policy check. */
  includePostingText: z.boolean().default(false),
  /**
   * The resume the person chose in the extension (its Change button). When it is one of the account's resumes the
   * extension may attach, it is the suggested resume (reason `chosen`) and the one the match scores; otherwise it is
   * passed over as if it had not been sent.
   */
  resumeId: RequestResumeIdSchema.optional(),
  /**
   * The TailorIT job this form is for, when the person chose one (the side panel's "Autofill for another job", version
   * 3; a job GET /api/autofill/jobs/search or a lookup answered): it is the job (`matchedBy` `chosen`) whatever the
   * address names, and its tracker entry is the application. 404 `not_found` when TailorIT has no such job.
   */
  jobId: z.number().int().positive().optional(),
});
export type AutofillLookupRequest = z.infer<typeof AutofillLookupRequestSchema>;

/** Why this resume is suggested, in the order the server tries them. */
export const RESUME_CHOICE_REASONS = [
  'chosen',
  'application',
  'profile',
  'best_match',
  'only_resume',
  'default',
  'latest',
] as const;
export type ResumeChoiceReason = (typeof RESUME_CHOICE_REASONS)[number];

/** The resume to attach to this application. */
export const AutofillResumeChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(AUTOFILL_RESUME_KINDS),
  fileKind: z.enum(AUTOFILL_FILE_KINDS),
  fileName: z.string(),
  reason: z.enum(RESUME_CHOICE_REASONS),
});
export type AutofillResumeChoice = z.infer<typeof AutofillResumeChoiceSchema>;

/**
 * How the job was found: the ATS's own posting id (a source TailorIT ingests), the posting's link, (version 3) the
 * request's `jobId`, the job the person chose, or (version 5) another address TailorIT keeps for the job (a LinkedIn
 * job's, the page's or the employer's link a job added from its page was saved with: job_link_aliases).
 */
export const LOOKUP_JOB_MATCHES = ['source_link', 'link_key', 'chosen', 'alias'] as const;
/** How the application was found: by its job, or by the posting link saved on it. */
export const LOOKUP_APPLICATION_MATCHES = ['job', 'posting_url'] as const;

// v30 FIX-B
/**
 * Version 9 (additive, REV-REQ REQ-1): the credit line a job's source asks for wherever the job is shown (Himalayas'
 * "visible credit with a link", Jobicy's: docs/design/part2/12-job-sourcing.md §3.6-3.7), as the Jobs card shows it:
 * its words, and its https link when it has one. The same shape as the web's JobCredit (jobs/dto.ts), kept here so
 * this folder stays the extension's own copy.
 */
export const AutofillJobCreditSchema = z.object({
  text: z.string().trim().min(1).max(200),
  url: z.string().max(2048).regex(/^https:\/\/\S+$/).optional(),
});
export type AutofillJobCredit = z.infer<typeof AutofillJobCreditSchema>;
// end v30 FIX-B

/**
 * The tracker's statuses as TailorIT names them (tracker/statuses.ts STATUS_INFO, in its order): the extension names a
 * tracked application's status with them. A code not listed is one added later.
 */
export const AUTOFILL_TRACKER_STATUSES = [
  { code: 1, label: 'Saved' },
  { code: 2, label: 'Applied' },
  { code: 11, label: 'Screen' },
  { code: 12, label: 'Interviewing' },
  { code: 13, label: 'Offer' },
  { code: 21, label: 'Withdrawn' },
  { code: 22, label: 'Ghosted' },
  { code: 23, label: 'Rejected' },
  { code: 24, label: 'Accepted' },
] as const;

/**
 * The suggested resume's keyword match to the job (`resumeId` is suggestedResume.id), counted as the Jobs page counts
 * it ("9 out of 12 required keywords found") and shown as Resume Score and the tracker's resume picker show it ("9 of
 * 12 keywords · 75%"): percentage = round(matchedCount / total * 100). `no_keywords`: the posting names none, so there
 * is no number. `unreadable`: an upload with under 50 characters of text (MIN_READABLE_RESUME_TEXT: a scan TailorIT
 * could not read), whose number would mislead. A new state is a new value the answer may hold: it bumps
 * AUTOFILL_API_VERSION.
 */
export const AutofillLookupMatchSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ok'),
    resumeId: z.string(),
    matchedCount: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    percentage: z.number().int().min(0).max(100),
  }),
  z.object({ state: z.literal('no_keywords'), resumeId: z.string() }),
  z.object({ state: z.literal('unreadable'), resumeId: z.string() }),
]);
export type AutofillLookupMatch = z.infer<typeof AutofillLookupMatchSchema>;

/** An ATS posting as parseAtsUrl reads an address: its ATS, board (null when the address names none) and id. */
const AtsReadingSchema = z.object({
  kind: z.enum(ATS_KINDS),
  board: z.string().nullable(),
  externalId: z.string().nullable(),
});

/**
 * What a page is, to TailorIT (version 5): `linkedin`, a LinkedIn job (parseLinkedInJobUrl reads it); `ats`, a posting
 * parseAtsUrl reads; `site`, any other page (a company's careers page, a LinkedIn page that shows no job).
 */
export const AUTOFILL_PAGE_KINDS = ['linkedin', 'ats', 'site'] as const;
export type AutofillPageKind = (typeof AUTOFILL_PAGE_KINDS)[number];

/**
 * How "Add to TailorIT" adds the posting while TailorIT lacks it (version 5): `ats`, POST /api/autofill/jobs with the
 * page's address (a posting addablePosting reads: TailorIT reads it from its ATS's public API); `page`, POST
 * /api/autofill/jobs/from-page (a LinkedIn job or another page: TailorIT reads the employer's posting from its ATS when
 * the employer's link is one addablePosting reads, else keeps the text the person sees).
 */
export const AUTOFILL_ADD_ROUTES = ['ats', 'page'] as const;
export type AutofillAddRoute = (typeof AUTOFILL_ADD_ROUTES)[number];

/**
 * The answer's `page` (version 5): how TailorIT read the page and the employer's link, so the extension needs no
 * reading of its own to choose its buttons. `linkedInUrl` is a LinkedIn job's canonical address,
 * https://www.linkedin.com/jobs/view/<id>/, the one TailorIT keeps for a job added from it (null on any other page);
 * `employer` is parseAtsUrl's reading of the request's employerUrl (null without one, or when it names no posting an
 * ATS TailorIT knows holds); `addWith` is how Add to TailorIT adds the posting (AUTOFILL_ADD_ROUTES), null on a page it
 * cannot add from (a LinkedIn page that shows no job, an address that is not https).
 */
export const AutofillLookupPageSchema = z.object({
  kind: z.enum(AUTOFILL_PAGE_KINDS),
  linkedInUrl: z.string().nullable(),
  employer: AtsReadingSchema.nullable(),
  addWith: z.enum(AUTOFILL_ADD_ROUTES).nullable(),
});
export type AutofillLookupPage = z.infer<typeof AutofillLookupPageSchema>;

/**
 * `ats` is null when parseAtsUrl does not read the address, `job` and `application` when TailorIT has neither: the
 * extension still fills, without job context. `suggestedResume` is the resume the person chose when it can be
 * attached, else the application's, the profile's choice, TailorIT's best match, the default or the latest; null only
 * when the account has no resume to attach. `match` scores that resume against the job, read-only. The fields marked
 * optional are absent from a TailorIT older than them.
 */
export const AutofillLookupResponseSchema = z.object({
  ats: AtsReadingSchema.nullable(),
  job: z
    .object({
      id: z.number().int(),
      title: z.string(),
      companyName: z.string(),
      location: z.string(),
      active: z.boolean(),
      matchedBy: z.enum(LOOKUP_JOB_MATCHES),
      /** Only with includePostingText: TailorIT's stored plain text, at most 20,000 characters. Policy check only. */
      postingText: z.string().max(AUTOFILL_POSTING_TEXT_MAX).optional(),
      /** When it was posted, else when TailorIT first saw it (the Jobs page's "2 days ago"); null when neither reads. */
      postedAt: InstantSchema.nullable().optional(),
      /** The pay as the Jobs page writes it ("$120k - $150k/yr"); null when the posting names none. */
      salary: z.string().nullable().optional(),
      /** Remote, hybrid or on-site; null when the posting does not say. */
      workArrangement: z.enum(WORK_ARRANGEMENTS).nullable().optional(),
      /** The industry as the Jobs page names it ("Finance"), the job's own else its company's; null when unknown. */
      industry: z.string().max(120).nullable().optional(),
      // v30 CT
      /**
       * Version 9: the job is held for review (a posting first read through the extension from a board no enabled
       * source runs): it is in this person's Saved Jobs, and in nobody's search until an admin approves it. The card
       * says so. Absent or false: not held.
       */
      held: z.boolean().optional(),
      /** Version 9: this account has a pending closed report on the job ("You reported this posting as closed"). */
      reported: z.boolean().optional(),
      // end v30 CT
      /** Version 9 (v30 FIX-B, REQ-1): the source's credit line the card shows; absent when the source asks none. */
      credit: AutofillJobCreditSchema.optional(),
    })
    .nullable(),
  /** The person's own tracker entry for this posting: the extension warns before a second application. */
  application: z
    .object({
      id: z.string(),
      /** The tracker's status code (1 Saved, 2 Applied, ...). */
      status: z.number().int(),
      trackedOn: z.string(),
      archived: z.boolean(),
      resumeId: z.string().nullable(),
      matchedBy: z.enum(LOOKUP_APPLICATION_MATCHES),
    })
    .nullable(),
  suggestedResume: AutofillResumeChoiceSchema.nullable(),
  /**
   * The suggested resume's keyword match to the job. Null without a job or a suggested resume, or when it could not be
   * computed.
   */
  match: AutofillLookupMatchSchema.nullable().optional(),
  /** Version 5: how TailorIT read the page and the employer's link (AutofillLookupPageSchema). */
  page: AutofillLookupPageSchema.optional(),
  // v1.3 A
  /**
   * v1.3 (additive within version 6): whether TailorIT keeps the application questions of this job (or, with no job,
   * of the posting the page names), so the extension can prefetch them (POST /api/autofill/forms/known).
   */
  formKnown: z.boolean().optional(),
  // end v1.3 A
  // v1.5 P
  /**
   * v1.5 (additive within version 6): whether this person has a prebuilt application draft for the job that is ready
   * (Prebuild on TailorIT's Auto-apply page): its tailored resume (and its cover letter, when one was asked) linked to
   * the job's tracker entry, which `application` and `suggestedResume` then name, and its answers made (each ready or
   * not ready: POST /api/autofill/forms/known's `drafts`). Absent when the person has no draft for the job.
   */
  draftReady: z.boolean().optional(),
  // end v1.5 P
});
export type AutofillLookupResponse = z.infer<typeof AutofillLookupResponseSchema>;

/**
 * POST /api/autofill/jobs: add the posting this application page shows to TailorIT's jobs, and to the person's
 * tracker as Saved. A job TailorIT has is found from any address the lookup finds it by; a posting it lacks must be at
 * an address `addablePosting` reads (400 `unsupported` otherwise). `resumeId` is the lookup's.
 */
export const AutofillAddJobRequestSchema = z.object({
  url: z.string().min(1).max(AUTOFILL_LOOKUP_URL_MAX),
  resumeId: RequestResumeIdSchema.optional(),
});
export type AutofillAddJobRequest = z.infer<typeof AutofillAddJobRequestSchema>;

/**
 * POST /api/autofill/jobs's answer (200): `created` is true when the job is new to TailorIT (read from its ATS just
 * now), false when TailorIT had it already (found by the lookup, or the posting read turned out to be a job another
 * source holds). Either way the person's tracker holds it (Saved, or further along as it was), and `lookup` is the
 * lookup's answer for the same address, as POST /api/autofill/lookup gives it.
 */
export const AutofillAddJobResponseSchema = z.object({
  created: z.boolean(),
  lookup: AutofillLookupResponseSchema,
});
export type AutofillAddJobResponse = z.infer<typeof AutofillAddJobResponseSchema>;

/** The caps of POST /api/autofill/jobs/from-page's text (version 5), in characters. */
export const AUTOFILL_FROM_PAGE_LIMITS = {
  title: 300,
  company: 200,
  location: 300,
  description: 20_000,
  criteria: 12,
  criterionLabel: 100,
  criterionValue: 300,
} as const;

/**
 * POST /api/autofill/jobs/from-page (version 5, scope jobs:add): add the job a page the person has open shows, when
 * no ATS API can read it (a LinkedIn job, an iCIMS, Taleo, SuccessFactors or Oracle posting, (version 6) a posting on
 * one of the new ATSs, a company's careers page), to TailorIT's jobs and to the person's tracker as Saved. `url` is the page's https address (a LinkedIn
 * address must be a job's: parseLinkedInJobUrl); `employerUrl` the employer's own link when the page shows it. The
 * text is what the person sees on the page, read from the page by the extension: TailorIT keeps it as untrusted text
 * (never fetched, expanded or followed, its markup shown as text) and its AI reads it as data. A job TailorIT has
 * for the person (found as the lookup finds it; by a link or an alias alone only when its title and company are the
 * page's) is saved as it is; a posting the employer's link or the page names that addablePosting reads is read from
 * its ATS instead, as POST /api/autofill/jobs reads it, and the text is not used. A job made from the text is the
 * person's alone: no other account sees it. `url` names no user name, password or port (400 `unsupported`), and
 * TailorIT keeps no session parameter of either address. Answers AutofillAddJobResponse, its lookup the page's (with
 * the same employerUrl).
 */
export const AutofillFromPageRequestSchema = z.object({
  url: z.string().min(1).max(AUTOFILL_LOOKUP_URL_MAX),
  employerUrl: EmployerUrlSchema.optional(),
  title: z.string().trim().min(1).max(AUTOFILL_FROM_PAGE_LIMITS.title),
  company: z.string().trim().min(1).max(AUTOFILL_FROM_PAGE_LIMITS.company),
  location: z.string().trim().max(AUTOFILL_FROM_PAGE_LIMITS.location).optional(),
  description: z.string().trim().min(1).max(AUTOFILL_FROM_PAGE_LIMITS.description),
  /** The posting's facts as the page lists them (LinkedIn's "Seniority level", "Employment type", …). */
  criteria: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(AUTOFILL_FROM_PAGE_LIMITS.criterionLabel),
        value: z.string().trim().min(1).max(AUTOFILL_FROM_PAGE_LIMITS.criterionValue),
      }),
    )
    .max(AUTOFILL_FROM_PAGE_LIMITS.criteria)
    .optional(),
  resumeId: RequestResumeIdSchema.optional(),
});
export type AutofillFromPageRequest = z.infer<typeof AutofillFromPageRequestSchema>;

/**
 * What POST /api/autofill/jobs refuses with, besides every token route's refusals (401, 403, 409 `conflict` for another
 * API version, 429), and the status of each: `validation_failed` (no address, or one over 2,048 characters),
 * `unsupported` (a job TailorIT does not have, at an address it cannot add from: not Greenhouse, Lever, Ashby,
 * Workable or (version 5) Workday, a page that does not name the board or the Workable account, Greenhouse's EU
 * boards, or a Workday site whose robots.txt asks not to be read; for POST /api/autofill/jobs/from-page, an address
 * that is not https or a LinkedIn page that shows no job), `not_found` (the ATS has no such posting: it closed),
 * `ats_failed` (the ATS answered with something TailorIT cannot read), `ats_unavailable` (it could not be reached in
 * time; try again later) and `internal` (the posting was read but TailorIT could not save it; try again).
 */
export const AUTOFILL_ADD_JOB_REFUSALS = {
  validation_failed: 400,
  unsupported: 400,
  not_found: 404,
  ats_failed: 502,
  ats_unavailable: 503,
  internal: 500,
} as const;

/** What `parseAtsUrl` reads from an application page's address. */
export interface ParsedAtsUrl {
  kind: AtsKind;
  /**
   * The Greenhouse board or the Lever site, as the address writes it, or the Ashby job board or the Workable account in
   * lower case; (version 5) the Workday tenant in lower case, the iCIMS or Taleo portal's host label, the SuccessFactors
   * company as written, or the Oracle Recruiting Cloud site in capitals; (version 6) the Jobvite company, the Rippling
   * board, the Dayforce client namespace and the SmartRecruiters company as written, the tenant's host label on JazzHR,
   * BambooHR, Breezy, CareerPlug, Pinpoint, HiBob and ClearCompany, the Paycor client id, the UltiPro tenant in lower
   * case and the ADP client id (cid) in lower case; (version 7) UKG Ready's company number, the Paycom client key and the
   * JobDiva portal key as written, and the Eightfold company's host label; as the extension's adapters read them. Null
   * when the address does not name it (a Workable link naming no account, Workable's job-search site, Paylocity, Dice).
   */
  board: string | null;
  /**
   * The posting's id on that ATS (a Workable shortcode in capitals; a Workday requisition id, the text after the last
   * '_' of the posting's name; version 6: the Workable job-search site's own id, a Jobvite id and a JazzHR code as
   * written, a Breezy position's 12 hexadecimal digits, a SmartRecruiters posting's number or its one-click
   * application's publication UUID in lower case, an UltiPro opportunity in lower case).
   */
  externalId: string;
  /**
   * The posting's own addresses, to find the job by its stored link (compare them through `linkKey`). The first is the
   * one the extension names the page by (version 6: its adapter's application address for the platform): built from
   * the posting's board and id alone, never holding a page's token, state, code, OTP or session parameter.
   */
  canonical: string[];
}

interface UrlLike {
  protocol: string;
  hostname: string;
  port: string;
  username: string;
  password: string;
  pathname: string;
  href: string;
  searchParams: Iterable<[string, string]>;
}

// URL exists in every browser and in Node; this package's lib types (ES only) do not declare it.
const runtime = globalThis as unknown as { URL?: new (input: string) => UrlLike };

/** An address read as a URL (any scheme), or null. */
function runtimeUrl(address: string): UrlLike | null {
  if (!runtime.URL) return null;
  try {
    return new runtime.URL(address.trim());
  } catch {
    return null;
  }
}

/** Greenhouse's hosts, with the region part of their twins (job-boards.eu.greenhouse.io). */
const GREENHOUSE_REGIONS = new Map([
  ['boards.greenhouse.io', ''],
  ['job-boards.greenhouse.io', ''],
  ['boards.eu.greenhouse.io', 'eu.'],
  ['job-boards.eu.greenhouse.io', 'eu.'],
]);
const LEVER_HOSTS = new Set(['jobs.lever.co', 'jobs.eu.lever.co']);
const GREENHOUSE_BOARD = /^[A-Za-z0-9_-]+$/;
const GREENHOUSE_JOB_ID = /^\d+$/;
const LEVER_SITE = /^[A-Za-z0-9_.-]+$/;
const LEVER_POSTING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASHBY_HOST = 'jobs.ashbyhq.com';
/** An Ashby job board's name as its address writes it, percent-decoded: letters, digits, '.', '_', '-' and spaces. */
const ASHBY_BOARD = /^[A-Za-z0-9_. -]{1,100}$/;
/** Ashby's posting ids are UUIDs, as Lever's are. */
const ASHBY_POSTING_ID = LEVER_POSTING_ID;
/** Workable's application pages, the host its accounts' own (<account>.workable.com) and www's /j/ links lead to. */
const WORKABLE_HOST = 'apply.workable.com';
/** A Workable account's name: a host name's label (<account>.workable.com), compared in lower case. */
const WORKABLE_ACCOUNT = /^[a-z0-9](?:[a-z0-9-]{0,62})$/i;
/** A Workable posting's shortcode: ten hexadecimal digits, served in either case and written in capitals. */
const WORKABLE_SHORTCODE = /^[0-9a-f]{10}$/i;
/** Workable's job-search site (version 6): its posting pages, /view/<id>/<slug>, show the application form in a dialog. */
const WORKABLE_JOBS_HOST = 'jobs.workable.com';
/** The job-search site's own id for a posting (22 letters and digits in the owner's capture), kept as written. */
const WORKABLE_VIEW_ID = /^[A-Za-z0-9]{8,64}$/;
/** The title's words after it. */
const WORKABLE_VIEW_SLUG = /^[a-z0-9-]+$/;

/**
 * Names that are Workable's own, never an account's: its hosts' labels (www.workable.com, apply., jobs., help., …)
 * and apply.workable.com's own first path segments (api, j). parseAtsUrl reads an account only from a name that is not
 * one of these, under apply.workable.com/<account>/j/<shortcode> or <account>.workable.com/j/<shortcode>; TailorIT's
 * Workable sources take none of them as an account either. Compared in lower case.
 */
export const WORKABLE_SERVICE_NAMES = [
  'www',
  'apply',
  'jobs',
  'j',
  'api',
  'app',
  'help',
  'support',
  'resources',
  'blog',
  'engineering',
  'developers',
  'status',
  'careers',
  'marketplace',
  'partners',
  'academy',
  'community',
  'id',
  'login',
  'signin',
  'accounts',
  'cdn',
  'static',
  'assets',
  'mail',
  'email',
] as const;

/** Whether a name may be a Workable account's: a host name's label that is not one of Workable's own. */
export function isWorkableAccountName(name: string): boolean {
  const lower = name.toLowerCase();
  return WORKABLE_ACCOUNT.test(lower) && !(WORKABLE_SERVICE_NAMES as readonly string[]).includes(lower);
}

/** The first value of a query parameter, its name compared in lower case. */
function queryValue(url: UrlLike, name: string): string | null {
  for (const [key, value] of url.searchParams) if (key.toLowerCase() === name) return value;
  return null;
}

/** The path's segments, one trailing slash ignored: "/acme/jobs/1/" -> ["acme", "jobs", "1"]. */
function segmentsOf(url: UrlLike): string[] {
  const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  return path ? path.split('/').slice(1) : [];
}

const greenhouseJobUrls = (region: string, board: string, id: string) => [
  `https://job-boards.${region}greenhouse.io/${board}/jobs/${id}`,
  `https://boards.${region}greenhouse.io/${board}/jobs/${id}`,
];

/** /{board}/jobs/{id}, or the embedded form /embed/job_app?for={board}&token={id}. */
function greenhousePosting(url: UrlLike, region: string): ParsedAtsUrl | null {
  const parts = segmentsOf(url);
  if (parts.length === 2 && parts[0] === 'embed' && parts[1] === 'job_app') {
    const id = queryValue(url, 'token');
    if (id === null || !GREENHOUSE_JOB_ID.test(id)) return null;
    const named = queryValue(url, 'for');
    const board = named !== null && GREENHOUSE_BOARD.test(named) ? named : null;
    return { kind: 'greenhouse', board, externalId: id, canonical: board ? greenhouseJobUrls(region, board, id) : [] };
  }
  const [board, jobs, id] = parts;
  if (parts.length !== 3 || jobs !== 'jobs' || !board || !id) return null;
  if (!GREENHOUSE_BOARD.test(board) || !GREENHOUSE_JOB_ID.test(id)) return null;
  return { kind: 'greenhouse', board, externalId: id, canonical: greenhouseJobUrls(region, board, id) };
}

/** /{site}/{posting id}, then /apply, /thanks or both. */
function leverPosting(url: UrlLike): ParsedAtsUrl | null {
  const [site, posting, ...rest] = segmentsOf(url);
  const tail = rest.join('/');
  if (!site || !posting || !['', 'apply', 'thanks', 'apply/thanks'].includes(tail)) return null;
  if (!LEVER_SITE.test(site) || !LEVER_POSTING_ID.test(posting)) return null;
  const id = posting.toLowerCase();
  const page = `https://${url.hostname}/${site}/${id}`;
  return { kind: 'lever', board: site, externalId: id, canonical: [page, `${page}/apply`] };
}

/** A path segment percent-decoded, or null when it is not percent-encoding after all ("acme%"). */
function decodedSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * jobs.ashbyhq.com/{board}/{posting id}, then /application or not, or the board's page naming the posting in
 * ?ashby_jid= (the embedded board's own address). The board's name is case-insensitive: it is read in lower case. The
 * query (?embed=js, tracking parameters) never matters.
 */
function ashbyPosting(url: UrlLike): ParsedAtsUrl | null {
  const [segment, posting, ...rest] = segmentsOf(url);
  const named = segment === undefined ? null : decodedSegment(segment);
  if (named === null || !ASHBY_BOARD.test(named)) return null;
  const board = named.toLowerCase();
  let id: string | null = null;
  if (posting === undefined) id = queryValue(url, 'ashby_jid');
  else if (rest.length === 0 || (rest.length === 1 && rest[0] === 'application')) id = posting;
  if (id === null || !ASHBY_POSTING_ID.test(id)) return null;
  const externalId = id.toLowerCase();
  // The board's page in lower case first (the API's jobUrl), then as the address wrote it.
  const pages = [...new Set([board, segment!])].map((name) => `https://${ASHBY_HOST}/${name}/${externalId}`);
  return { kind: 'ashby', board, externalId, canonical: pages.flatMap((page) => [page, `${page}/application`]) };
}

/**
 * Workable (version 4): apply.workable.com/{account}/j/{shortcode}, then /apply or not, and the account's own host's
 * /j/{shortcode} (<account>.workable.com, which Workable redirects there); the account in lower case (Workable redirects
 * any other case to it), the shortcode in capitals, as Workable writes them. The links that name no account,
 * apply.workable.com/j/{shortcode} (the widget API's `url` and `application_url`, with /apply) and
 * www.workable.com/j/{shortcode}, are read with no board: Workable redirects them to the account's pages, and the
 * shortcode alone names the posting. An account is never one of Workable's own names (WORKABLE_SERVICE_NAMES: its
 * job-search site jobs.workable.com, help., api., apply.workable.com/api/…), which are not read. The query never
 * matters. Version 6: the job-search site's posting pages (workableJobsSitePosting).
 */
function workablePosting(url: UrlLike): ParsedAtsUrl | null {
  if (url.hostname === WORKABLE_JOBS_HOST) return plainHttps(url) ? workableJobsSitePosting(url) : null;
  const parts = segmentsOf(url);
  let named: string | null = null;
  let path = parts;
  if (url.hostname === WORKABLE_HOST) {
    if (parts[0] !== 'j') {
      named = parts[0] ?? null;
      if (named === null) return null;
      path = parts.slice(1);
    }
  } else {
    // www's /j/<shortcode> names no account; any other host of Workable's own is not read (below).
    const label = url.hostname.slice(0, -'.workable.com'.length);
    if (label !== 'www') named = label;
  }
  const [j, code, ...tail] = path;
  if (j !== 'j' || code === undefined || !WORKABLE_SHORTCODE.test(code)) return null;
  if (tail.length > 1 || (tail.length === 1 && tail[0] !== 'apply')) return null;
  if (named !== null && !isWorkableAccountName(named)) return null;
  const externalId = code.toUpperCase();
  const links = [`https://${WORKABLE_HOST}/j/${externalId}`, `https://${WORKABLE_HOST}/j/${externalId}/apply`];
  if (named === null) return { kind: 'workable', board: null, externalId, canonical: links };
  const board = named.toLowerCase();
  // The account's pages as Workable writes them first (its canonical link, the widget's form), then as the address
  // wrote them, then the links that name no account.
  const pages = [...new Set([`${board}/j/${externalId}`, `${named}/j/${code}`])].map(
    (page) => `https://${WORKABLE_HOST}/${page}/`,
  );
  const canonical = [...pages.flatMap((page) => [page, `${page}apply/`]), ...links];
  return { kind: 'workable', board, externalId, canonical };
}

/**
 * Workable's job-search site (version 6, the owner's captures of 2026-11-06): jobs.workable.com/view/<id>, then the
 * title's words or not, a posting's page that shows its application form in a dialog. The page names no account and
 * no shortcode, so it is read as the extension reads it: no board, the site's own id as written, its canonical address
 * https://jobs.workable.com/view/<id>. Any other page of the site (its search, a company's jobs) names no posting.
 */
function workableJobsSitePosting(url: UrlLike): ParsedAtsUrl | null {
  const [view, id, ...rest] = segmentsOf(url);
  if (view !== 'view' || id === undefined || !WORKABLE_VIEW_ID.test(id)) return null;
  if (rest.length > 1 || (rest.length === 1 && !WORKABLE_VIEW_SLUG.test(rest[0]!))) return null;
  return { kind: 'workable', board: null, externalId: id, canonical: [`https://${WORKABLE_JOBS_HOST}/view/${id}`] };
}

/**
 * A company's own careers page that embeds a Greenhouse form names the posting in ?gh_jid=. Its canonical address is
 * the page's scheme, host, port and path with `gh_jid` alone (jr7 review A-2): never the page's other parameters (a
 * session's, a token's, an email's), nor its user name and password, nor its fragment.
 */
function greenhouseOnCompanyPage(url: UrlLike): ParsedAtsUrl | null {
  const id = queryValue(url, 'gh_jid');
  if (id === null || !GREENHOUSE_JOB_ID.test(id)) return null;
  const port = url.port === '' ? '' : `:${url.port}`;
  const page = `${url.protocol}//${url.hostname}${port}${url.pathname}?gh_jid=${id}`;
  return { kind: 'greenhouse', board: null, externalId: id, canonical: [page] };
}

/** An address over https or http, read; null for anything else. */
function webUrl(address: string): UrlLike | null {
  const url = runtimeUrl(address);
  return url && (url.protocol === 'https:' || url.protocol === 'http:') ? url : null;
}

// Version 5: Workday, iCIMS, Taleo, SuccessFactors and Oracle Recruiting Cloud, read exactly as the extension's
// adapters read them (its src/adapters/<platform>/url.ts, from the public capture of 2026-11-04/05): the same hosts,
// pages, board and id, so a posting's platform, board and id are one reading in both. The query parameter names these
// platforms use are compared as written, as the adapters compare them.

/** The first value of a query parameter named exactly `name` (URLSearchParams.get), or null. */
function exactQueryValue(url: UrlLike, name: string): string | null {
  for (const [key, value] of url.searchParams) if (key === name) return value;
  return null;
}

/** A tenant's own Workday host: <tenant>.wd<n>.myworkdayjobs.com, or <tenant>.myworkdayjobs.com (never www or a bare
 *  wd<n>). */
const WORKDAY_JOBS_HOST = /^(?!(?:www|wd\d{1,3})\.)([a-z0-9-]+)\.(?:wd\d{1,3}\.)?myworkdayjobs\.com$/;
/** The shared host of myworkdaysite.com: wd<n>.myworkdaysite.com, the tenant in the path. */
const WORKDAY_SITE_HOST = /^wd\d{1,3}\.myworkdaysite\.com$/;
/** A locale (en-US as Workday writes it, en-us, fr, zh-Hans): read as one only where a site follows it. */
const WORKDAY_LOCALE = /^[a-z]{2,3}(?:-[a-z0-9]{2,4})?$/i;
/** A tenant or a site as Workday's addresses write them. */
const WORKDAY_NAME = /^[A-Za-z0-9_-]+$/;
/** <slug>_<reqId>: the requisition id is everything after the last '_'. */
const WORKDAY_POSTING = /^(.+)_([^_]+)$/;
/** What may follow <slug>_<reqId>: nothing (the posting), its Apply choice, or the application (its three ways). */
const WORKDAY_PAGES: ReadonlySet<string> = new Set([
  '',
  'apply',
  'apply/applyManually',
  'apply/autofillWithResume',
  'apply/useMyLastApplication',
]);

/**
 * A location or posting segment TailorIT never puts into a Workday address of its own (the read Add job makes, so
 * addablePosting refuses it): a dot segment, or one holding a '/', '\', '?', '#' or a control character, decoded once
 * or twice (%2e%2e, %252e%252e, %2F, %5C, %3F, %23, %00). parseAtsUrl still reads the posting it names, as the
 * extension does, so the lookup and the tracker know it by the same identity.
 */
export function unsafeWorkdaySegment(segment: string): boolean {
  const once = decodedSegment(segment);
  if (once === null) return true;
  const twice = decodedSegment(once) ?? once;
  return [once, twice].some((text) => text === '.' || text === '..' || /[/\\?#\p{Cc}]/u.test(text));
}

/** The longest Workday posting page path TailorIT reads a posting from (its read's path is a few characters longer). */
export const WORKDAY_PATH_MAX = 512;

/** A Workday posting as its address names it. */
interface WorkdayAddress {
  host: string;
  /** The tenant in lower case: the host's first label, or the path's on myworkdaysite.com. */
  tenant: string;
  /** '' on a tenant's own host; /recruiting/<tenant as written> on myworkdaysite.com. */
  prefix: string;
  locale: string | null;
  /** The career site as written (Workday reads it in any case). */
  site: string;
  /** The location segment as written (free text: Workday reads any). */
  location: string;
  /** <slug>_<reqId>, percent-encoding folded one way. */
  posting: string;
  reqId: string;
}

/** A path segment percent-decoded and encoded again the one way (a ',' and its '%2C' are one), or null. */
function foldedSegment(segment: string): string | null {
  const decoded = decodedSegment(segment);
  return decoded === null ? null : encodeURIComponent(decoded);
}

/**
 * <tenant>.wd<n>.myworkdayjobs.com/[<locale>/]<site>/job/<location>/<slug>_<reqId>, and on wd<n>.myworkdaysite.com
 * /[<locale>/]recruiting/<tenant>/<site>/job/...; then nothing, /apply or /apply/applyManually. Any other page (the
 * choice's other ways, /login, /userHome, /details/... search pages) names no posting of ours.
 */
function workdayAddress(url: UrlLike): WorkdayAddress | null {
  const host = url.hostname;
  const own = WORKDAY_JOBS_HOST.exec(host);
  if (!own && !WORKDAY_SITE_HOST.test(host)) return null;
  let parts = segmentsOf(url);
  let locale: string | null = null;
  // A first segment shaped like a locale is one only where a site follows it (a site named "ext" is no locale).
  const siteFollows = own ? parts[2] === 'job' : parts[1] === 'recruiting';
  if (parts[0] !== undefined && WORKDAY_LOCALE.test(parts[0]) && siteFollows) {
    locale = parts[0];
    parts = parts.slice(1);
  }
  let tenant: string;
  let prefix = '';
  if (own) {
    tenant = own[1]!;
  } else {
    const [recruiting, named, ...rest] = parts;
    if (recruiting !== 'recruiting' || named === undefined || !WORKDAY_NAME.test(named)) return null;
    tenant = named.toLowerCase();
    prefix = `/recruiting/${named}`;
    parts = rest;
  }
  const [site, job, location, posting, ...rest] = parts;
  if (site === undefined || !WORKDAY_NAME.test(site) || job !== 'job' || !location || posting === undefined) return null;
  if (!WORKDAY_PAGES.has(rest.join('/'))) return null;
  const folded = foldedSegment(posting);
  const match = folded === null ? null : WORKDAY_POSTING.exec(folded);
  if (!folded || !match) return null;
  return { host, tenant, prefix, locale, site, location, posting: folded, reqId: match[2]! };
}

/** The Workday posting's own page, with its locale or not. */
function workdayPage(address: WorkdayAddress, locale: string | null): string {
  const lead = locale ? `/${locale}` : '';
  return `https://${address.host}${lead}${address.prefix}/${address.site}/job/${address.location}/${address.posting}`;
}

/** Workday (version 5): the tenant is the board, the requisition id the posting's id. */
function workdayPosting(url: UrlLike): ParsedAtsUrl | null {
  const address = workdayAddress(url);
  if (!address) return null;
  const pages = [...new Set([workdayPage(address, null), workdayPage(address, address.locale)])];
  return { kind: 'workday', board: address.tenant, externalId: address.reqId, canonical: pages };
}

/** A company's iCIMS portal: careers-<co>.icims.com or <co>.icims.com, never iCIMS's www, api or login hosts, nor an
 *  employees' internal-<co> portal. */
const ICIMS_HOST = /^(?!(?:www|api|login)\.)(?!internal-)[a-z0-9-]+\.icims\.com$/;
const ICIMS_POSTING_ID = /^\d{1,12}$/;
/**
 * The words a posting's pages end in, as the extension reads them: its posting (job, and job?mode=submit_apply, the
 * page after submitting), its email gate (login) and (version 6, the owner's snapshots of 2026-11-06) the application's
 * steps after the gate: the Candidate Profile (candidate), the Candidate and Job Specific Questions (questions), EEO
 * (eeo) and an IForm's page (form); jr7 7a (additive within version 6, the owner's snapshot7 of 2026-11-11): the
 * Assessments step after the final IForm (assessment), which the extension reads as the same application (ICIMS7-04).
 */
const ICIMS_PAGES: ReadonlySet<string> = new Set(['job', 'login', 'candidate', 'questions', 'eeo', 'form', 'assessment']);

/**
 * iCIMS (version 5): /jobs/<id>/[<slug>/]job, the posting, and /jobs/<id>/[<slug>/]login, its email gate (the slug is
 * free); version 6: the steps after the gate, /jobs/<id>/[<slug>/]candidate, questions, eeo and form (jr7 7a: and
 * assessment); never "Log back
 * in" (login?loginOnly=1, iCIMS's own sign-in, which names no job) nor any other page under a posting (its referral).
 * The board is the portal's host label (careers-<co>), the id the posting's number; every page reads as the posting
 * (its /jobs/<id>/job), and the query (the wrapper's layout, in_iframe, hashed, a step's eem, code and csrf, the
 * page after submitting's mode) never matters and is never kept.
 */
function icimsPosting(url: UrlLike): ParsedAtsUrl | null {
  const parts = segmentsOf(url);
  if (parts.length < 3 || parts.length > 4 || parts[0] !== 'jobs' || !ICIMS_POSTING_ID.test(parts[1]!)) return null;
  const name = parts.at(-1)!;
  if (!ICIMS_PAGES.has(name)) return null;
  if (name === 'login' && exactQueryValue(url, 'loginOnly') === '1') return null;
  const id = parts[1]!;
  const board = url.hostname.slice(0, -'.icims.com'.length);
  const pages = [`https://${url.hostname}/jobs/${id}/job`];
  if (parts.length === 4) pages.push(`https://${url.hostname}/jobs/${id}/${parts[2]}/job`);
  return { kind: 'icims', board, externalId: id, canonical: pages };
}

/** A company's Taleo (Enterprise) portal: <co>.taleo.net, never www; Taleo Business Edition (<co>.tbe.taleo.net) is
 *  another product, not read. */
const TALEO_HOST = /^(?!www\.)[a-z0-9-]+\.taleo\.net$/;
const TALEO_SECTION = /^[A-Za-z0-9_-]{1,40}$/;
const TALEO_JOB_ID = /^[A-Za-z0-9_-]{1,40}$/;
/** A career section's pages that name a posting in ?job=. */
const TALEO_PAGES: ReadonlySet<string> = new Set(['jobdetail.ftl', 'jobapply.ftl', 'flow.jsf', 'application.jss']);
/** The account pages and the pre-sign-in agreement, which name their job in redirectionURI or TARGET. */
const TALEO_ACCOUNT_FOLDERS = ['/careersection/iam/accessmanagement/', '/careersection/careersection/privacyagreement/'];
/** An address as an account page names it in its query (decoded once): https, its host, path and query. */
const TALEO_NAMED = /^https:\/\/([^/?#]+)(\/[^?#]*)(?:\?([^#]*))?/;

/** A career section's page, by its path and its job parameter: its section and job, or null. */
function taleoSectionPage(pathname: string, job: string | null): { section: string; job: string } | null {
  const parts = pathname.split('/').slice(1);
  if (parts.length !== 3 || parts[0] !== 'careersection' || !TALEO_SECTION.test(parts[1]!)) return null;
  if (!TALEO_PAGES.has(parts[2]!) || job === null || !TALEO_JOB_ID.test(job)) return null;
  return { section: parts[1]!, job };
}

/** The job an account page returns to: its redirectionURI's (or TARGET's) apply address on the same host, as written. */
function taleoReturnsTo(url: UrlLike): { section: string; job: string } | null {
  for (const name of ['redirectionURI', 'TARGET']) {
    const written = exactQueryValue(url, name);
    const match = written === null ? null : TALEO_NAMED.exec(written);
    if (match === null || match[1]!.toLowerCase() !== url.hostname) continue;
    // Its job is the first job= of the named address's own query; written plain with its lang= first
    // (jobapply.ftl?lang=en&job=N), that job= became the page's own parameter: that one, then.
    const job = /(?:^|&)job=([^&]*)/.exec(match[3] ?? '')?.[1] ?? null;
    const read = taleoSectionPage(match[2]!, job === null ? exactQueryValue(url, 'job') : decodedSegment(job));
    if (read !== null) return read;
  }
  return null;
}

/**
 * Taleo (version 5): a career section's /careersection/<cs>/jobdetail.ftl?job=<id> (and its jobapply.ftl, flow.jsf
 * and application.jss), and the account pages naming that address in redirectionURI or TARGET. The board is the
 * portal's host label, the id the job parameter as written.
 */
function taleoPosting(url: UrlLike): ParsedAtsUrl | null {
  const account = TALEO_ACCOUNT_FOLDERS.some((folder) => url.pathname.startsWith(folder)) && url.pathname.endsWith('.jsf');
  const read = account ? taleoReturnsTo(url) : taleoSectionPage(url.pathname, exactQueryValue(url, 'job'));
  if (read === null) return null;
  const board = url.hostname.slice(0, -'.taleo.net'.length);
  const section = `https://${url.hostname}/careersection/${read.section}`;
  const pages = [
    `${section}/jobdetail.ftl?job=${read.job}`,
    `${section}/jobdetail.ftl?job=${read.job}&lang=en`,
    `${section}/jobapply.ftl?job=${read.job}&lang=en`,
  ];
  return { kind: 'taleo', board, externalId: read.job, canonical: pages };
}

/** SuccessFactors' career sites: career<n>.successfactors.com or .eu. */
const SUCCESSFACTORS_HOST = /^career\d{0,3}\.successfactors\.(?:com|eu)$/;
const SUCCESSFACTORS_COMPANY = /^[A-Za-z0-9_-]{1,60}$/;
const SUCCESSFACTORS_REQ_ID = /^\d{1,12}$/;

/**
 * SuccessFactors (version 5, its classic career sites): /career with ?company=<co> (or career_company) and
 * career_job_req_id=<id>, the posting and its account pages alike. The board is the company as written.
 */
function successFactorsPosting(url: UrlLike): ParsedAtsUrl | null {
  if (url.pathname !== '/career' && url.pathname !== '/career/') return null;
  const company = exactQueryValue(url, 'company') ?? exactQueryValue(url, 'career_company');
  const id = exactQueryValue(url, 'career_job_req_id');
  if (company === null || id === null || !SUCCESSFACTORS_COMPANY.test(company) || !SUCCESSFACTORS_REQ_ID.test(id)) {
    return null;
  }
  const page = `https://${url.hostname}/career?career_job_req_id=${id}&career_ns=job_listing&company=${company}`;
  return { kind: 'successfactors', board: company, externalId: id, canonical: [page] };
}

/**
 * An Oracle Recruiting Cloud tenant: <tenant>.fa.<region>.oraclecloud.com or <tenant>.fa.oraclecloud.com; and (version
 * 6, the owner's snapshots of 2026-11-06) one on Oracle's government cloud, <tenant>.fa.ocs.oraclegovcloud.com, which
 * serves the same Candidate Experience.
 */
const ORACLE_HOST = /^[a-z0-9-]+\.fa(?:(?:\.[a-z0-9-]+)?\.oraclecloud|\.ocs\.oraclegovcloud)\.com$/;
const ORACLE_ROOT = '/hcmUI/CandidateExperience/';
const ORACLE_LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const ORACLE_SITE = /^[A-Za-z0-9_-]{1,40}$/;
const ORACLE_POSTING_ID = /^\d{1,15}$/;
/** The pages after a posting's id that are its application: the apply flow, and the quick apply's. */
const ORACLE_APPLY_TAILS: ReadonlySet<string> = new Set(['apply', 'easy-apply']);

/**
 * Oracle Recruiting Cloud (version 5): /hcmUI/CandidateExperience/<lang>/sites/<site>/job/<id> (or
 * /requisitions/preview/<id>), then nothing, /apply/... or /easy-apply/...; never the site's search or its profile
 * pages. The board is the site in capitals, as the application writes it.
 */
function oraclePosting(url: UrlLike): ParsedAtsUrl | null {
  if (!url.pathname.startsWith(ORACLE_ROOT)) return null;
  const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  const [language, sites, site, ...rest] = path.slice(ORACLE_ROOT.length).split('/');
  if (language === undefined || !ORACLE_LANGUAGE.test(language) || sites !== 'sites' || site === undefined) return null;
  if (!ORACLE_SITE.test(site)) return null;
  let at: number;
  if (rest[0] === 'job') at = 1;
  else if (rest[0] === 'requisitions' && rest[1] === 'preview') at = 2;
  else return null;
  const id = rest[at];
  const tail = rest.slice(at + 1);
  if (id === undefined || !ORACLE_POSTING_ID.test(id) || (tail.length > 0 && !ORACLE_APPLY_TAILS.has(tail[0]!))) return null;
  const board = site.toUpperCase();
  const pages = [...new Set([`en/sites/${board}`, `${language}/sites/${site}`])].map(
    (where) => `https://${url.hostname}${ORACLE_ROOT}${where}/job/${id}`,
  );
  return { kind: 'oracle', board, externalId: id, canonical: pages };
}

// Version 6: the new ATSs of the owner's snapshots of 2026-11-06, read exactly as the extension's adapters read them
// (its src/adapters/<platform>/url.ts): the same hosts, pages, board and id, so a posting's platform, board and id are
// one reading in both, and the first canonical address is the adapter's own application address. Paths and query
// parameter names are compared as written, as the adapters compare them. A page's token, state, code, OTP or session
// parameter (UltiPro's AuthCode/Register state, ADP's OTP_login, a ClearCompany application's id) is never kept.

/** Every value of a query parameter named exactly `name` (URLSearchParams.getAll). */
function exactQueryValues(url: UrlLike, name: string): string[] {
  const values: string[] = [];
  for (const [key, value] of url.searchParams) if (key === name) values.push(value);
  return values;
}

/** A lower-case UUID, as Rippling, Pinpoint and HiBob write their postings'. */
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A UUID in either case. */
const ANY_UUID = LEVER_POSTING_ID;
/** A host's first label: the tenant on the platforms whose tenants are hosts of their own. */
const tenantOf = (url: UrlLike) => url.hostname.split('.')[0]!;

/** Jobvite: its candidate host. */
const JOBVITE_HOST = 'jobs.jobvite.com';
const JOBVITE_COMPANY = /^[A-Za-z0-9-]+$/;
const JOBVITE_JOB_ID = /^[A-Za-z0-9]+$/;

/**
 * Jobvite: jobs.jobvite.com/<company>/job/<id>, the posting, and .../apply, its application (its consent gate and its
 * three steps at that one address). The company and the id as written (the id is mixed case).
 */
function jobvitePosting(url: UrlLike): ParsedAtsUrl | null {
  const [company, job, id, ...rest] = segmentsOf(url);
  if (company === undefined || job !== 'job' || id === undefined || !JOBVITE_COMPANY.test(company)) return null;
  const tail = rest.join('/');
  if (!JOBVITE_JOB_ID.test(id) || (tail !== '' && tail !== 'apply')) return null;
  const posting = `https://${JOBVITE_HOST}/${company}/job/${id}`;
  return { kind: 'jobvite', board: company, externalId: id, canonical: [`${posting}/apply`, posting] };
}

/** JazzHR: a tenant's host, <tenant>.applytojob.com, never www. */
const JAZZHR_HOST = /^(?!www\.)[a-z0-9-]+\.applytojob\.com$/;
/** A JazzHR posting's code: ten letters and digits, as written. */
const JAZZHR_CODE = /^[A-Za-z0-9]{10}$/;

/** JazzHR: /apply/<code>/<slug>, a posting and its form on one page (the tenant's board, /apply/, names none). */
function jazzhrPosting(url: UrlLike): ParsedAtsUrl | null {
  if (!url.pathname.startsWith('/apply/')) return null;
  const [apply, code, slug, ...rest] = segmentsOf(url);
  if (apply !== 'apply' || code === undefined || !JAZZHR_CODE.test(code) || !slug || rest.length > 0) return null;
  const canonical = [`https://${url.hostname}/apply/${code}/${slug}`];
  return { kind: 'jazzhr', board: tenantOf(url), externalId: code, canonical };
}

/** BambooHR: a tenant's host, <tenant>.bamboohr.com, under /careers/ alone (every other path is its employee system). */
const BAMBOOHR_HOST = /^[a-z0-9-]+\.bamboohr\.com$/;
const DIGITS = /^\d+$/;

/** BambooHR: /careers/<id>, a posting's application form (the job list, /careers, names none). */
function bambooHrPosting(url: UrlLike): ParsedAtsUrl | null {
  if (!url.pathname.startsWith('/careers/')) return null;
  const [careers, id, ...rest] = segmentsOf(url);
  if (careers !== 'careers' || id === undefined || !DIGITS.test(id) || rest.length > 0) return null;
  return { kind: 'bamboohr', board: tenantOf(url), externalId: id, canonical: [`https://${url.hostname}/careers/${id}`] };
}

/** Rippling: its one candidate host. */
const RIPPLING_HOST = 'ats.rippling.com';
const RIPPLING_BOARD = /^[a-z0-9-]+$/;

/**
 * jr7 7a (RBP7-01, the owner's snapshot7 of 2026-11-11: a board under /<language>-<REGION>/): a first segment shaped as
 * a locale (a language, then a script, a region or a UN M.49 area), dropped only where the path goes on
 * <board>/jobs/<uuid>, so a board whose name looks like one (/ab/jobs/<uuid>, /en/jobs/<uuid>) stays a board.
 */
const RIPPLING_LOCALE = /^[a-z]{2,3}(?:-(?:[A-Za-z]{4}|[A-Za-z]{2}|\d{3}))?$/;

/**
 * Rippling: ats.rippling.com/<board>/jobs/<uuid>, the posting, and .../apply, its form (whose query the path
 * decides); jr7 7a: the same under a locale (RIPPLING_LOCALE), /<locale>/<board>/jobs/<uuid>[/apply]. The form's
 * address names the board and the posting again in its query, which its canonical address keeps (jobBoardSlug, jobId
 * and step=application, in that order): whether the form loads without them is not known. The canonical addresses name
 * no locale, so both spellings are one posting.
 */
function ripplingPosting(url: UrlLike): ParsedAtsUrl | null {
  const parts = segmentsOf(url);
  const localized = parts.length > 1 && parts[1] !== 'jobs' && RIPPLING_LOCALE.test(parts[0]!);
  const [board, jobs, id, ...rest] = localized ? parts.slice(1) : parts;
  const tail = rest.join('/');
  if (board === undefined || !RIPPLING_BOARD.test(board) || jobs !== 'jobs' || id === undefined) return null;
  if (!LOWER_UUID.test(id) || (tail !== '' && tail !== 'apply')) return null;
  const posting = `https://${RIPPLING_HOST}/${board}/jobs/${id}`;
  const form = `${posting}/apply?jobBoardSlug=${board}&jobId=${id}&step=application`;
  return { kind: 'rippling', board, externalId: id, canonical: [form, posting] };
}

/** Breezy HR: a tenant's host, <tenant>.breezy.hr, under /p/. */
const BREEZY_HOST = /^[a-z0-9-]+\.breezy\.hr$/;
/** A position's segment: its 12 hexadecimal digits, then its slug. */
const BREEZY_POSITION = /^([0-9a-f]{12})-[^/]+$/;

/** Breezy HR: /p/<id>-<slug>, the posting, and .../apply, its form; the id is the position's 12 hexadecimal digits. */
function breezyPosting(url: UrlLike): ParsedAtsUrl | null {
  if (!url.pathname.startsWith('/p/')) return null;
  const [p, position, ...rest] = segmentsOf(url);
  const tail = rest.join('/');
  const match = position === undefined ? null : BREEZY_POSITION.exec(position);
  if (p !== 'p' || match === null || (tail !== '' && tail !== 'apply')) return null;
  const posting = `https://${url.hostname}/p/${position!}`;
  return { kind: 'breezy', board: tenantOf(url), externalId: match[1]!, canonical: [`${posting}/apply`, posting] };
}

/** CareerPlug: a tenant's host, <tenant>.careerplug.com, under /jobs/. */
const CAREERPLUG_HOST = /^[a-z0-9-]+\.careerplug\.com$/;

/** CareerPlug: /jobs/<id>/apps/new, a posting and its form on one page (?loc=es is the same page in Spanish). */
function careerPlugPosting(url: UrlLike): ParsedAtsUrl | null {
  if (!url.pathname.startsWith('/jobs/')) return null;
  const [jobs, id, apps, isNew, ...rest] = segmentsOf(url);
  if (jobs !== 'jobs' || id === undefined || !DIGITS.test(id) || apps !== 'apps' || isNew !== 'new' || rest.length > 0) {
    return null;
  }
  const canonical = [`https://${url.hostname}/jobs/${id}/apps/new`];
  return { kind: 'careerplug', board: tenantOf(url), externalId: id, canonical };
}

/** Pinpoint: a tenant's host, <tenant>.pinpointhq.com, never app. (Pinpoint's own), under /en/postings/. */
const PINPOINT_HOST = /^(?!app\.)[a-z0-9-]+\.pinpointhq\.com$/;
/**
 * What follows a Pinpoint posting's id: nothing (the posting), its form, and the page after submitting; jr7 7a
 * (RBP7-22): .../applications, where the form posts (the form again after a refusal).
 */
const PINPOINT_PAGES: ReadonlySet<string> = new Set(['', 'applications/new', 'applications/thanks', 'applications']);

/**
 * Pinpoint: /en/postings/<uuid>, the posting, .../applications/new, its form, .../applications (jr7 7a), where the form
 * posts, and .../applications/thanks, the page after submitting (its ?token= never kept).
 */
function pinpointPosting(url: UrlLike): ParsedAtsUrl | null {
  if (!url.pathname.startsWith('/en/postings/')) return null;
  const [locale, postings, id, ...rest] = segmentsOf(url);
  if (locale !== 'en' || postings !== 'postings' || id === undefined || !LOWER_UUID.test(id)) return null;
  if (!PINPOINT_PAGES.has(rest.join('/'))) return null;
  const posting = `https://${url.hostname}/en/postings/${id}`;
  return { kind: 'pinpoint', board: tenantOf(url), externalId: id, canonical: [`${posting}/applications/new`, posting] };
}

/** Paycor Recruiting: its one host, and its application form's path. */
const PAYCOR_HOST = 'recruitingbypaycor.com';
const PAYCOR_FORM = '/career/SubmitResume.action';
/** An employer's (clientId) or a posting's (id) id: 32 hexadecimal digits. */
const PAYCOR_ID = /^[0-9a-f]{32}$/;

/** Paycor: /career/SubmitResume.action?clientId=<employer>&id=<posting>, a posting's one-page application. */
function paycorPosting(url: UrlLike): ParsedAtsUrl | null {
  if (url.pathname !== PAYCOR_FORM) return null;
  const clientId = exactQueryValue(url, 'clientId');
  const id = exactQueryValue(url, 'id');
  if (clientId === null || id === null || !PAYCOR_ID.test(clientId) || !PAYCOR_ID.test(id)) return null;
  const canonical = [`https://${PAYCOR_HOST}${PAYCOR_FORM}?clientId=${clientId}&id=${id}&specialization=`];
  return { kind: 'paycor', board: clientId, externalId: id, canonical };
}

/** HiBob: a tenant's careers host, <tenant>.careers.hibob.com. */
const HIBOB_HOST = /^[a-z0-9-]+\.careers\.hibob\.com$/;

/** HiBob: /jobs/<uuid>/apply, a posting's Application tab (its form). */
function hiBobPosting(url: UrlLike): ParsedAtsUrl | null {
  const [jobs, id, apply, ...rest] = segmentsOf(url);
  if (jobs !== 'jobs' || id === undefined || !LOWER_UUID.test(id) || apply !== 'apply' || rest.length > 0) return null;
  const tenant = url.hostname.slice(0, -'.careers.hibob.com'.length);
  return { kind: 'hibob', board: tenant, externalId: id, canonical: [`https://${url.hostname}/jobs/${id}/apply`] };
}

/** UltiPro (UKG Pro Recruiting): its candidate host. */
const ULTIPRO_HOST = 'recruiting.ultipro.com';
/**
 * jr7 7a (additive within version 6; UP7-05, the owner's snapshot7 of 2026-11-11 on recruiting2.ultipro.com): UKG's
 * other candidate-only recruiting hosts, read whole as ULTIPRO_HOST is (the extension's ultipro/url.ts
 * RECRUITING_HOSTS), their account step too.
 */
const ULTIPRO_RECRUITING_HOSTS: ReadonlySet<string> = new Set([ULTIPRO_HOST, 'recruiting2.ultipro.com', 'recruiting.ultipro.ca']);
/** jr7 7a: UKG's recruiting tenants' own hosts, read on their job boards' pages alone (the extension's OTHER_HOST). */
const ULTIPRO_TENANT_HOST = /^[a-z0-9-]+\.rec\.pro\.ukg\.net$/;
const ULTIPRO_TENANT = /^[A-Za-z0-9_-]{1,64}$/;
/** A board's pages that name a posting in ?opportunityId=: its application and its posting. */
const ULTIPRO_PAGES: ReadonlySet<string> = new Set(['OpportunityApply', 'OpportunityDetail']);

/**
 * /<tenant>/JobBoard/<board uuid>/<page> with its opportunityId (read by `param`), on `host`: the posting it names,
 * its canonical addresses on that host (jr7 7a: each host's postings are its own), and whether the page is its
 * application; or null.
 */
function ultiproBoardPosting(
  path: string,
  param: (name: string) => string | null,
  host: string,
): { posting: ParsedAtsUrl; apply: boolean } | null {
  const [tenant, jobBoard, board, page, ...rest] = path.split('/').slice(1);
  const id = param('opportunityId') ?? '';
  if (tenant === undefined || !ULTIPRO_TENANT.test(tenant) || jobBoard !== 'JobBoard' || board === undefined) return null;
  if (!ANY_UUID.test(board) || page === undefined || !ULTIPRO_PAGES.has(page) || rest.length > 0 || !ANY_UUID.test(id)) {
    return null;
  }
  const lower = tenant.toLowerCase();
  const externalId = id.toLowerCase();
  const pages = `https://${host}/${lower}/JobBoard/${board.toLowerCase()}`;
  const canonical = [
    `${pages}/OpportunityApply?opportunityId=${externalId}`,
    `${pages}/OpportunityDetail?opportunityId=${externalId}`,
  ];
  return { posting: { kind: 'ultipro', board: lower, externalId, canonical }, apply: page === 'OpportunityApply' };
}

/** A raw query's parameter (`a=1&b=2`) named exactly `name`, decoded once ('+' a space), or null. */
function rawQueryValue(query: string, name: string): string | null {
  for (const pair of query.split('&')) {
    const at = pair.indexOf('=');
    if (at < 0 || pair.slice(0, at) !== name) continue;
    return decodedSegment(pair.slice(at + 1).replace(/\+/g, ' '));
  }
  return null;
}

/**
 * UltiPro: /<tenant>/JobBoard/<board uuid>/OpportunityApply?opportunityId=<uuid>, the application, and its
 * OpportunityDetail, the posting; and the account step, /<TENANT>/AuthCode/Register?state=returnUrl=<that
 * application's path and query>|ta=<TENANT>, read as the application its returnUrl names on the same tenant, as Taleo's
 * account pages are (its state is never kept). The board is the tenant in lower case, the id the opportunity in lower
 * case. jr7 7a: the same on recruiting2.ultipro.com and recruiting.ultipro.ca, and the board pages alone on a tenant's
 * <x>.rec.pro.ukg.net; the canonical addresses on the page's own host.
 */
function ultiproPosting(url: UrlLike): ParsedAtsUrl | null {
  const direct = ultiproBoardPosting(url.pathname, (name) => exactQueryValue(url, name), url.hostname);
  if (direct !== null) return direct.posting;
  if (!ULTIPRO_RECRUITING_HOSTS.has(url.hostname)) return null;
  const [tenant, auth, register, ...rest] = url.pathname.split('/').slice(1);
  if (tenant === undefined || !ULTIPRO_TENANT.test(tenant) || auth !== 'AuthCode' || register !== 'Register') return null;
  if (rest.length > 0) return null;
  // state=returnUrl=/<tenant>/JobBoard/<uuid>/OpportunityApply?opportunityId=<uuid>|ta=<TENANT>, decoded once.
  const parts = (exactQueryValue(url, 'state') ?? '').split('|');
  const returnUrl = parts.find((part) => part.startsWith('returnUrl='))?.slice('returnUrl='.length) ?? '';
  const ta = parts.find((part) => part.startsWith('ta='))?.slice('ta='.length) ?? '';
  const [path, query] = returnUrl.split('?', 2) as [string, string | undefined];
  const read =
    path.startsWith('/') && query !== undefined
      ? ultiproBoardPosting(path, (name) => rawQueryValue(query, name), url.hostname)
      : null;
  const tenantBoard = tenant.toLowerCase();
  if (read === null || !read.apply || read.posting.board !== tenantBoard) return null;
  return ta === '' || ta.toLowerCase() === tenantBoard ? read.posting : null;
}

/** Dayforce: its candidate host. */
const DAYFORCE_HOST = 'jobs.dayforcehcm.com';
const DAYFORCE_LOCALE = /^[A-Za-z]{2,3}-[A-Za-z]{2}$/;
const DAYFORCE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const DAYFORCE_POSTING_ID = /^\d{1,15}$/;

/** A Dayforce posting's canonical addresses: step 1 of its guest application, then (jr7 7a) its posting, in en-US. */
function dayforceAddresses(namespace: string, site: string, id: string): string[] {
  const posting = `https://${DAYFORCE_HOST}/en-US/${namespace}/${site}/jobs/${id}`;
  return [`${posting}/apply/manualApplication?applicationSource=Manual`, posting];
}

/**
 * jr7 7a (AUTO7-02, DF7-07; the owner's snapshot7 of 2026-11-11): a Dayforce posting's own page,
 * /[<locale>/]<client namespace>/<career site>/jobs/<id>, and its way-to-apply choice, .../apply, one trailing slash
 * ignored, as the extension's dayforce/url.ts reads them (its posting page, under the application's key); or null.
 */
function dayforcePostingPage(url: UrlLike): ParsedAtsUrl | null {
  const segments = segmentsOf(url);
  const posting = (length: number) => segments.length === length || (segments.length === length + 1 && segments[length] === 'apply');
  if (DAYFORCE_LOCALE.test(segments[0] ?? '') && posting(5)) segments.shift();
  if (!posting(4)) return null;
  const [namespace, site, jobs, id] = segments as [string, string, string, string];
  if (!DAYFORCE_SEGMENT.test(namespace) || !DAYFORCE_SEGMENT.test(site) || jobs !== 'jobs') return null;
  if (!DAYFORCE_POSTING_ID.test(id)) return null;
  return { kind: 'dayforce', board: namespace, externalId: id, canonical: dayforceAddresses(namespace, site, id) };
}

/**
 * Dayforce: /[<locale>/]<client namespace>/<career site>/jobs/<id>/apply/manualApplication, every step of a guest
 * application (step 1 with its locale, the later steps without it, their query naming the step); and (jr7 7a) the
 * posting and its way-to-apply choice (dayforcePostingPage), under the same job. The board is the client namespace as
 * written; the canonical addresses are step 1's, in en-US, with ?applicationSource=Manual, then the posting's.
 */
function dayforcePosting(url: UrlLike): ParsedAtsUrl | null {
  const segments = url.pathname.split('/').slice(1);
  if (segments.length === 7 && DAYFORCE_LOCALE.test(segments[0]!)) segments.shift();
  const [namespace, site, jobs, id, apply, manual] = segments as [string, string, string, string, string, string];
  const step =
    segments.length === 6 &&
    DAYFORCE_SEGMENT.test(namespace) &&
    DAYFORCE_SEGMENT.test(site) &&
    jobs === 'jobs' &&
    DAYFORCE_POSTING_ID.test(id) &&
    apply === 'apply' &&
    manual === 'manualApplication';
  if (!step) return dayforcePostingPage(url);
  return { kind: 'dayforce', board: namespace, externalId: id, canonical: dayforceAddresses(namespace, site, id) };
}

/** Paylocity: its recruiting host, under /Recruiting/ (compared as written). */
const PAYLOCITY_HOST = 'recruiting.paylocity.com';

/** Paylocity: /Recruiting/Jobs/Apply/<id>, every step of the application; it names no board. */
function paylocityPosting(url: UrlLike): ParsedAtsUrl | null {
  if (!url.pathname.startsWith('/Recruiting/')) return null;
  const [recruiting, jobs, apply, id, ...rest] = segmentsOf(url);
  if (recruiting !== 'Recruiting' || jobs !== 'Jobs' || apply !== 'Apply' || !id || !DIGITS.test(id) || rest.length > 0) {
    return null;
  }
  return { kind: 'paylocity', board: null, externalId: id, canonical: [`https://${PAYLOCITY_HOST}/Recruiting/Jobs/Apply/${id}`] };
}

/**
 * Dice: its host, under /job-applications/ (its Easy Apply) and, since jr7 7a, /job-detail/ (its postings); its
 * sign-in and every other page are not read.
 */
const DICE_HOST = 'www.dice.com';

/**
 * Dice: /job-applications/<uuid>/wizard, every step of an Easy Apply; and (jr7 7a, AUTO7-02: the owner's snapshot7 of
 * 2026-11-11, whose wizard names its posting's own uuid) /job-detail/<uuid>, its posting, read only (no run opens it).
 * It names no board, the uuid as written; the canonical addresses are the wizard's, then the posting's.
 */
function dicePosting(url: UrlLike): ParsedAtsUrl | null {
  const [section, id, wizard, ...rest] = segmentsOf(url);
  if (!id || !ANY_UUID.test(id) || rest.length > 0) return null;
  const easyApply = section === 'job-applications' && wizard === 'wizard';
  const detail = section === 'job-detail' && wizard === undefined;
  if (!easyApply && !detail) return null;
  const canonical = [`https://${DICE_HOST}/job-applications/${id}/wizard`, `https://${DICE_HOST}/job-detail/${id}`];
  return { kind: 'dice', board: null, externalId: id, canonical };
}

/** ClearCompany: a tenant's host, never its cc- file hosts, under /careers/ alone (its other pages are not a candidate's). */
const CLEARCOMPANY_HOST = /^(?!cc-)[a-z0-9-]+\.clearcompany\.com$/;

/**
 * ClearCompany: /careers/jobs/<uuid>/apply, the application's account step, and /careers/jobs/<uuid>/apply/<application
 * uuid>, every page after it: one application, its own uuid (the person's) never kept. The uuids as written.
 */
function clearCompanyPosting(url: UrlLike): ParsedAtsUrl | null {
  if (!url.pathname.startsWith('/careers/')) return null;
  const [careers, jobs, id, apply, application, ...rest] = segmentsOf(url);
  if (careers !== 'careers' || jobs !== 'jobs' || !id || !ANY_UUID.test(id) || apply !== 'apply' || rest.length > 0) {
    return null;
  }
  if (application !== undefined && !ANY_UUID.test(application)) return null;
  const canonical = [`https://${url.hostname}/careers/jobs/${id}/apply`];
  return { kind: 'clearcompany', board: tenantOf(url), externalId: id, canonical };
}

/** ADP Workforce Now: its host, and its two candidate pages (the guest page, and every step after the emailed code). */
const ADP_HOST = 'workforcenow.adp.com';
const ADP_GUEST = '/mascsr/default/mdf/recruitment/recruitment.html';
const ADP_STEPS = '/mascsr/applicant/mdf/recruitment/postLogin.html';
const ADP_JOB_ID = /^\d{1,15}$/;
const ADP_CC_ID = /^\d{8}_\d{6}$/;

/**
 * ADP Workforce Now: the guest page (recruitment.html) and every step after the emailed code (postLogin.html), both
 * naming the employer (cid, a uuid) and the posting (jobId; twice on the steps, the same both times), with the client's
 * ccId; never two different jobIds. The board is the cid in lower case; the canonical address is the guest page's with
 * cid, jobId and ccId alone (never the steps' OTP_login, requisitionId or params). Every other path of the host (an
 * employer's employee pages among them) is not read.
 */
function adpPosting(url: UrlLike): ParsedAtsUrl | null {
  if (url.pathname !== ADP_GUEST && url.pathname !== ADP_STEPS) return null;
  const cid = exactQueryValue(url, 'cid') ?? '';
  const jobIds = [...new Set(exactQueryValues(url, 'jobId'))];
  const ccId = exactQueryValue(url, 'ccId');
  if (!ANY_UUID.test(cid) || jobIds.length !== 1 || !ADP_JOB_ID.test(jobIds[0]!)) return null;
  if (ccId !== null && !ADP_CC_ID.test(ccId)) return null;
  const board = cid.toLowerCase();
  const tail = ccId === null ? '' : `&ccId=${ccId}`;
  return { kind: 'adp', board, externalId: jobIds[0]!, canonical: [`https://${ADP_HOST}${ADP_GUEST}?cid=${board}&jobId=${jobIds[0]!}${tail}`] };
}

/** SmartRecruiters: the one host the snapshots show. */
const SMARTRECRUITERS_HOST = 'jobs.smartrecruiters.com';
const SMARTRECRUITERS_COMPANY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
/** A posting's own segment: its number, then its slug after a hyphen. */
const SMARTRECRUITERS_POSTING = /^(\d{6,20})(?:-.*)?$/;
/** The one-click application's steps after its publication: its first page and its screening questions. */
const SMARTRECRUITERS_STEPS: ReadonlySet<string> = new Set(['', 'screening']);
/** The host's own first segments, which are no company. */
const SMARTRECRUITERS_RESERVED: ReadonlySet<string> = new Set(['oneclick-ui', 'external-referrals']);

/**
 * SmartRecruiters: a posting, /<Company>/<number>-<slug> (its own canonical address /<Company>/<number>), and its
 * one-click application, /oneclick-ui/company/<Company>/publication/<uuid>[/screening] (its canonical address without
 * the screening step and the query). Neither names the other's id, so they are two readings, as the extension keys
 * them: the posting by its number, the application by its publication's uuid in lower case; the company as written.
 */
function smartRecruitersPosting(url: UrlLike): ParsedAtsUrl | null {
  const parts = segmentsOf(url);
  const origin = `https://${SMARTRECRUITERS_HOST}`;
  if (parts[0] === 'oneclick-ui') {
    const [, company, board, publication, id, ...tail] = parts;
    if (company !== 'company' || publication !== 'publication' || board === undefined || id === undefined) return null;
    if (!SMARTRECRUITERS_COMPANY.test(board) || !ANY_UUID.test(id) || !SMARTRECRUITERS_STEPS.has(tail.join('/'))) return null;
    const externalId = id.toLowerCase();
    return { kind: 'smartrecruiters', board, externalId, canonical: [`${origin}/oneclick-ui/company/${board}/publication/${externalId}`] };
  }
  if (parts.length !== 2) return null;
  const [board, segment] = parts as [string, string];
  const posting = SMARTRECRUITERS_POSTING.exec(segment);
  if (!SMARTRECRUITERS_COMPANY.test(board) || SMARTRECRUITERS_RESERVED.has(board) || posting === null) return null;
  const externalId = posting[1]!;
  const canonical = [...new Set([`${origin}/${board}/${externalId}`, `${origin}/${board}/${segment}`])];
  return { kind: 'smartrecruiters', board, externalId, canonical };
}

// Version 7: the platforms of the owner's snapshot7 (2026-11-11), read exactly as the extension's adapters read them
// (its src/adapters/{ukgready,paycom,jobdiva,eightfold}/url.ts): the same hosts, pages, board and id. A page that names
// no job (UKG Ready's applicant session, Paycom's application page, whose number is the person's) is none here: the
// extension names those by the posting the tab came from.

/** UKG Ready: its candidate hosts, secure<n>.saashr.com. */
const UKGREADY_HOST = /^secure\d{0,2}\.saashr\.com$/;
/** Its careers page, the company's number in its path. */
const UKGREADY_PATH = /^\/ta\/(\d{3,10})\.careers$/;
/** A posting's ShowJob and the employer's ein_id: digits. */
const UKGREADY_ID = /^\d{1,15}$/;

/**
 * UKG Ready (version 7): /ta/<company>.careers with exactly one ShowJob=<digits>, a posting whose choice ("Apply for
 * Job") and start form are drawn in place at that address. The board is the company's number, the id the ShowJob. The
 * canonical addresses are the posting by ShowJob alone (the extension's key: every spelling of one posting is one),
 * then, when the address names exactly one ein_id (the employer's id, public), the same with it (UKGR-V3: the address
 * a run opens keeps it). The applicant session after the start form (an ActiveSessionId, no ShowJob) names no job, nor
 * does any other page of the host (its employee pages, /ta/<n>.login and the rest).
 */
function ukgReadyPosting(url: UrlLike): ParsedAtsUrl | null {
  const company = UKGREADY_PATH.exec(url.pathname)?.[1];
  const jobs = exactQueryValues(url, 'ShowJob');
  if (company === undefined || jobs.length !== 1 || !UKGREADY_ID.test(jobs[0]!)) return null;
  const posting = `https://${url.hostname}/ta/${company}.careers?ShowJob=${jobs[0]!}`;
  const employers = exactQueryValues(url, 'ein_id');
  const withEmployer = employers.length === 1 && UKGREADY_ID.test(employers[0]!) ? [`${posting}&ein_id=${employers[0]!}`] : [];
  return { kind: 'ukgready', board: company, externalId: jobs[0]!, canonical: [posting, ...withEmployer] };
}

/** Paycom: its candidate host, and a posting's path on the client's portal (the client key, 32 hexadecimal digits). */
const PAYCOM_HOST = 'www.paycomonline.net';
const PAYCOM_POSTING = /^\/v4\/ats\/web\.php\/portal\/([A-Fa-f0-9]{32})\/jobs\/(\d{1,15})\/?$/;

/**
 * Paycom (version 7): /v4/ats/web.php/portal/<client key>/jobs/<n>, a posting (its Apply opens the contact dialog in
 * place). The board is the client key as written, the id the posting's number. The application page,
 * …/portal/<client key>/applications#/applications/<m>, names the person's own application, never the posting: none
 * here; so is every other path (the employee pages under /v4/ee/ and /v4/cl/).
 */
function paycomPosting(url: UrlLike): ParsedAtsUrl | null {
  const match = PAYCOM_POSTING.exec(url.pathname);
  if (match === null) return null;
  const [, key, id] = match as unknown as [string, string, string];
  return { kind: 'paycom', board: key, externalId: id, canonical: [`https://${PAYCOM_HOST}/v4/ats/web.php/portal/${key}/jobs/${id}`] };
}

/** JobDiva: its candidate hosts (www, www1, www2 …). */
const JOBDIVA_HOST = /^www\d{0,2}\.jobdiva\.com$/;
/** An agency's portal key (64 letters and digits in the captures), and a job's id. */
const JOBDIVA_KEY = /^[0-9A-Za-z]{16,128}$/;
const JOBDIVA_JOB = /^\d{1,12}$/;
/** The portal's job route in the fragment: #/jobs/<id>, a later number and a query of its own allowed. */
const JOBDIVA_ROUTE = /^#\/jobs\/(\d{1,12})(?:\/\d{1,12})?\/?(?:\?.*)?$/;
/** The legacy job page. */
const JOBDIVA_LEGACY = '/candidates/myjobs/openjob.jsp';

/** An address's fragment as its text writes it (the URL reader's href keeps it); '' for none or an empty one. */
function fragmentOf(url: UrlLike): string {
  const at = url.href.indexOf('#');
  return at < 0 || at === url.href.length - 1 ? '' : url.href.slice(at);
}

/**
 * JobDiva (version 7): an agency's portal, /portal/?a=<key>#/jobs/<id>, one job's posting and its application (the
 * choice, Quick Apply, the EEO steps and the "Thank you!" are dialogs drawn at that one address); the job is in the
 * address's fragment. With no fragment at all, the query's `id` names the job (an older link's), and the legacy page
 * /candidates/myjobs/openjob.jsp?a=<key>&id=<id> names that job too. A fragment routing elsewhere (the job list, the
 * sign-in) names none. The board is the portal key as written (exactly one `a`), the id the job's. The canonical
 * addresses are the portal's job (the extension's, the fragment kept: the job lives only there), then the legacy page.
 */
function jobDivaPosting(url: UrlLike): ParsedAtsUrl | null {
  const portal = url.pathname === '/portal/' || url.pathname === '/portal';
  if (!portal && url.pathname !== JOBDIVA_LEGACY) return null;
  const keys = exactQueryValues(url, 'a');
  if (keys.length !== 1 || !JOBDIVA_KEY.test(keys[0]!)) return null;
  const fragment = portal ? fragmentOf(url) : '';
  const ids = exactQueryValues(url, 'id');
  const id = fragment !== '' ? (JOBDIVA_ROUTE.exec(fragment)?.[1] ?? null) : ids.length === 1 ? ids[0]! : null;
  if (id === null || !JOBDIVA_JOB.test(id)) return null;
  const key = keys[0]!;
  const canonical = [`https://${url.hostname}/portal/?a=${key}#/jobs/${id}`, `https://${url.hostname}${JOBDIVA_LEGACY}?a=${key}&id=${id}`];
  return { kind: 'jobdiva', board: key, externalId: id, canonical };
}

/** Eightfold: a company's host (never its recruiters' app. nor www.), and a posting's id (pid: digits). */
const EIGHTFOLD_HOST = /^(?!(?:app|www)\.)[a-z0-9-]+\.eightfold\.ai$/;
const EIGHTFOLD_PID = /^\d{1,20}$/;
/** The pages that name their posting in one `pid`: the job list's details pane, the form and the page after submitting. */
const EIGHTFOLD_PAGES: ReadonlySet<string> = new Set(['/careers', '/careers/apply', '/careers/apply/success']);
/** A posting's own page by its path (Jobright's site list; no capture shows it). */
const EIGHTFOLD_JOB = /^\/careers\/job\/(\d{1,20})$/;

/**
 * Eightfold (version 7): /careers?…pid=<id> (the job list with the posting's details, whose Apply Now leads to the
 * form), /careers/apply?pid=<id> (the form, one page), /careers/apply/success?…pid=<id> (the page after submitting)
 * and /careers/job/<id>, one posting, named by exactly one numeric pid. The board is the company's host label. The
 * canonical addresses are the form's (the extension's: it opens directly), then the posting's two.
 */
function eightfoldPosting(url: UrlLike): ParsedAtsUrl | null {
  const path = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  let pid: string | null = null;
  if (EIGHTFOLD_PAGES.has(path)) {
    const pids = exactQueryValues(url, 'pid');
    pid = pids.length === 1 ? pids[0]! : null;
  } else {
    pid = EIGHTFOLD_JOB.exec(path)?.[1] ?? null;
  }
  if (pid === null || !EIGHTFOLD_PID.test(pid)) return null;
  const careers = `https://${url.hostname}/careers`;
  const board = url.hostname.slice(0, -'.eightfold.ai'.length);
  return { kind: 'eightfold', board, externalId: pid, canonical: [`${careers}/apply?pid=${pid}`, `${careers}?pid=${pid}`, `${careers}/job/${pid}`] };
}

/**
 * The ATS posting an application page's address names, or null. Greenhouse: its boards and job boards (and their
 * .eu. twins) at /{board}/jobs/{id}, the embedded form at /embed/job_app?for={board}&token={id}, and a company page
 * with ?gh_jid={id}. Lever: jobs.lever.co and jobs.eu.lever.co at /{site}/{id}, with /apply or /thanks. Ashby (version
 * 3): jobs.ashbyhq.com at /{board}/{id}, with /application or not, and /{board}?ashby_jid={id}; a company page with
 * ?ashby_jid= names no board, so it is not read (its job is found by its link, as any page's). Workable (version 4):
 * apply.workable.com at /{account}/j/{shortcode}, with /apply or not, and an account's own host at /j/{shortcode}; its
 * /j/{shortcode} links naming no account are read with no board (see workablePosting). Version 5: Workday (a tenant's
 * <tenant>.wd<n>.myworkdayjobs.com, company career sites such as Cisco's, Adobe's and NVIDIA's among them, and
 * wd<n>.myworkdaysite.com with the tenant in the path), iCIMS, Taleo, SuccessFactors and Oracle Recruiting Cloud, as
 * the extension's adapters read them (see each reader). Version 6: Jobvite, JazzHR, BambooHR, Rippling, Breezy HR,
 * CareerPlug, Pinpoint, Paycor, HiBob, UltiPro, Dayforce, Paylocity, Dice, ClearCompany, ADP Workforce Now and
 * SmartRecruiters, Oracle's government cloud, Workable's job-search site and iCIMS's steps after its gate, likewise.
 * jr7 7a (additive within version 6, the owner's snapshot7 of 2026-11-11): Dayforce's posting and its way-to-apply
 * choice, Rippling's boards under a locale, UltiPro's other recruiting hosts, Pinpoint's .../applications, iCIMS's
 * Assessments step and Dice's posting page, each read as the posting the platform's other pages name. Version 7: UKG
 * Ready, Paycom, JobDiva and Eightfold. Hosts are compared in lower case, and the query parameter names of Greenhouse,
 * Lever, Ashby and Workable too; the fragment never matters but on JobDiva's portal, whose job lives only there.
 */
export function parseAtsUrl(address: string): ParsedAtsUrl | null {
  const url = webUrl(address);
  if (!url) return null;
  const host = url.hostname;
  const region = GREENHOUSE_REGIONS.get(host);
  if (region !== undefined) return greenhousePosting(url, region) ?? greenhouseOnCompanyPage(url);
  if (LEVER_HOSTS.has(host)) return leverPosting(url);
  if (host === ASHBY_HOST) return ashbyPosting(url);
  if (host === WORKABLE_HOST || host.endsWith('.workable.com')) return workablePosting(url);
  const reader = HOST_READERS.find(([pattern]) => (typeof pattern === 'string' ? pattern === host : pattern.test(host)))?.[1];
  if (reader) return plainHttps(url) ? reader(url) : null;
  return greenhouseOnCompanyPage(url);
}

/** Whether an address is https on the default port, without a user name or password, as the adapters read theirs. */
function plainHttps(url: UrlLike): boolean {
  return url.protocol === 'https:' && url.port === '' && url.username === '' && url.password === '';
}

/**
 * Version 5's and 6's platforms by host (a host's own name, or a pattern over it), each read over https on the default
 * port and without a user name or password, as the adapters read them (a stored link is compared as linkKey writes it,
 * https, so an http spelling loses nothing). A host here is the platform's alone: a page of it no reader reads is no
 * posting (never a company page's ?gh_jid=).
 */
const HOST_READERS: ReadonlyArray<readonly [RegExp | string, (url: UrlLike) => ParsedAtsUrl | null]> = [
  [WORKDAY_JOBS_HOST, workdayPosting],
  [WORKDAY_SITE_HOST, workdayPosting],
  [ICIMS_HOST, icimsPosting],
  [TALEO_HOST, taleoPosting],
  [SUCCESSFACTORS_HOST, successFactorsPosting],
  [ORACLE_HOST, oraclePosting],
  [JOBVITE_HOST, jobvitePosting],
  [JAZZHR_HOST, jazzhrPosting],
  [BAMBOOHR_HOST, bambooHrPosting],
  [RIPPLING_HOST, ripplingPosting],
  [BREEZY_HOST, breezyPosting],
  [CAREERPLUG_HOST, careerPlugPosting],
  [PINPOINT_HOST, pinpointPosting],
  [PAYCOR_HOST, paycorPosting],
  [HIBOB_HOST, hiBobPosting],
  [ULTIPRO_HOST, ultiproPosting],
  // jr7 7a: UKG's other recruiting hosts (ultiproPosting).
  ['recruiting2.ultipro.com', ultiproPosting],
  ['recruiting.ultipro.ca', ultiproPosting],
  [ULTIPRO_TENANT_HOST, ultiproPosting],
  [DAYFORCE_HOST, dayforcePosting],
  [PAYLOCITY_HOST, paylocityPosting],
  [DICE_HOST, dicePosting],
  [CLEARCOMPANY_HOST, clearCompanyPosting],
  [ADP_HOST, adpPosting],
  [SMARTRECRUITERS_HOST, smartRecruitersPosting],
  // Version 7.
  [UKGREADY_HOST, ukgReadyPosting],
  [PAYCOM_HOST, paycomPosting],
  [JOBDIVA_HOST, jobDivaPosting],
  [EIGHTFOLD_HOST, eightfoldPosting],
];

/** A LinkedIn job, as parseLinkedInJobUrl reads its address. */
export interface ParsedLinkedInJob {
  /** LinkedIn's job id: digits. */
  jobId: string;
  /** https://www.linkedin.com/jobs/view/<id>/ */
  canonical: string;
}

/** LinkedIn's hosts a job is shown on: linkedin.com, www. and a country's (uk., de., …). */
const LINKEDIN_JOB_HOST = /^(?:www\.|[a-z]{2}\.)?linkedin\.com$/;
/** A LinkedIn job id: 6 to 20 digits (its ids today are 10). */
const LINKEDIN_JOB_ID = /^\d{6,20}$/;
/** /jobs/view/<id> or /jobs/view/<slug>-<id>. */
const LINKEDIN_VIEW = /^(?:.*-)?(\d{6,20})$/;

/**
 * A LinkedIn job's canonical address (version 5) from the address of a page showing it: /jobs/view/<id> and
 * /jobs/view/<slug>-<id>, and /jobs/search or /jobs/collections[/<name>] with ?currentJobId=<id>, on linkedin.com, www.
 * or a country's host; https://www.linkedin.com/jobs/view/<id>/ for each. Null for any other address: another LinkedIn
 * page, a look-alike host, another scheme. Read only: TailorIT never requests it.
 */
export function parseLinkedInJobUrl(address: string): ParsedLinkedInJob | null {
  const url = webUrl(address);
  if (!url || !LINKEDIN_JOB_HOST.test(url.hostname)) return null;
  if (url.port !== '' || url.username !== '' || url.password !== '') return null;
  const parts = segmentsOf(url);
  let id: string | null = null;
  if (parts.length === 3 && parts[0] === 'jobs' && parts[1] === 'view') {
    id = LINKEDIN_VIEW.exec(parts[2]!)?.[1] ?? null;
  } else if (
    parts[0] === 'jobs' &&
    ((parts.length === 2 && parts[1] === 'search') || (parts[1] === 'collections' && parts.length <= 3))
  ) {
    const current = exactQueryValue(url, 'currentJobId');
    id = current !== null && LINKEDIN_JOB_ID.test(current) ? current : null;
  }
  return id === null ? null : { jobId: id, canonical: `https://www.linkedin.com/jobs/view/${id}/` };
}

/**
 * A Greenhouse board's own page naming a posting in ?gh_jid= (job-boards.greenhouse.io/{board}?gh_jid={id}, or
 * boards.greenhouse.io's, or their .eu. twins'), read with its board: its canonical addresses are the posting's job
 * pages. parseAtsUrl reads such a page as it reads any page naming a posting in ?gh_jid= (no board, the page itself the
 * posting's address), as the extension's adapters do (no capture shows a form there); the auto-apply agent opens the
 * posting's job page instead (agentApplicationUrl). Null for any other address.
 */
export function greenhouseBoardPage(address: string): ParsedAtsUrl | null {
  const url = webUrl(address);
  const region = url ? GREENHOUSE_REGIONS.get(url.hostname) : undefined;
  if (!url || region === undefined) return null;
  const [board, ...rest] = segmentsOf(url);
  if (!board || rest.length > 0 || board === 'embed' || !GREENHOUSE_BOARD.test(board)) return null;
  const id = queryValue(url, 'gh_jid');
  if (id === null || !GREENHOUSE_JOB_ID.test(id)) return null;
  return { kind: 'greenhouse', board, externalId: id, canonical: greenhouseJobUrls(region, board, id) };
}

/**
 * The ATSs POST /api/autofill/jobs can read one posting from (their public job APIs; Ashby and Workable since version
 * 3; Workday since version 5, through the read its posting page makes itself, on a tenant whose robots.txt allows it).
 */
export const AUTOFILL_ADDABLE_ATS = ['greenhouse', 'lever', 'ashby', 'workable', 'workday'] as const;
export type AddableAtsKind = (typeof AUTOFILL_ADDABLE_ATS)[number];

/** A Workday posting's address parts its read needs (version 5): the host, the career site and the posting's name. */
export interface WorkdayPostingRef {
  /** <tenant>.wd<n>.myworkdayjobs.com or wd<n>.myworkdaysite.com. */
  host: string;
  /** The career site as the address writes it. */
  site: string;
  /** The location segment as the address writes it (free text: Workday reads any). */
  location: string;
  /** <slug>_<reqId>, as Workday names the posting (the slug must match). */
  posting: string;
}

/**
 * A posting POST /api/autofill/jobs can add: its ATS, board, site or account, id, and the ATS region it is hosted in
 * (Ashby's, Workable's and Workday's are always `global`); a Workday posting's address parts too.
 */
export interface AddablePosting {
  kind: AddableAtsKind;
  board: string;
  externalId: string;
  region: 'global' | 'eu';
  workday?: WorkdayPostingRef;
}

/**
 * The posting an address lets TailorIT add (the extension offers "Add this job to TailorIT" exactly for these), or
 * null: Greenhouse needs the board in the address (a company page's ?gh_jid= has none: the embedded form's own address
 * names it) and is read on its global boards only, as TailorIT's Greenhouse sources are; Lever on either of its hosts;
 * Ashby from its job board's addresses (one read of the board's API, which lists the posting); Workable from the
 * addresses that name the account (one read of the posting from Workable's API, which needs the account), never from
 * a /j/{shortcode} link that names none; Workday (version 5) from a posting's page on either kind of host (one read of
 * the posting from the tenant's own job API, the read the posting's page makes, when the tenant's robots.txt allows
 * it: the server checks that before it reads). iCIMS, Taleo, SuccessFactors and Oracle have no public posting API, and
 * neither have (version 6) the new ATSs but SmartRecruiters, whose Posting API's robots.txt (api.smartrecruiters.com)
 * allows no reader but LinkedIn's: POST /api/autofill/jobs/from-page adds theirs, and a Workable job-search page's.
 */
export function addablePosting(parsed: ParsedAtsUrl | null): AddablePosting | null {
  if (!parsed || parsed.board === null) return null;
  // The canonical addresses keep the host's region (job-boards.eu.greenhouse.io, jobs.eu.lever.co).
  const region = /^https:\/\/[a-z-]+\.eu\./.test(parsed.canonical[0] ?? '') ? 'eu' : 'global';
  if (parsed.kind === 'greenhouse' && region === 'global') {
    return { kind: 'greenhouse', board: parsed.board, externalId: parsed.externalId, region };
  }
  if (parsed.kind === 'lever') return { kind: 'lever', board: parsed.board, externalId: parsed.externalId, region };
  if (parsed.kind === 'ashby' || parsed.kind === 'workable') {
    return { kind: parsed.kind, board: parsed.board, externalId: parsed.externalId, region: 'global' };
  }
  if (parsed.kind === 'workday') {
    // The posting's own page, which workdayPosting put first.
    const url = webUrl(parsed.canonical[0] ?? '');
    const address = url ? workdayAddress(url) : null;
    if (!address || address.reqId !== parsed.externalId) return null;
    // Never a segment that would change the read's path, nor a path longer than WORKDAY_PATH_MAX.
    if (unsafeWorkdaySegment(address.location) || unsafeWorkdaySegment(address.posting)) return null;
    const path = `${address.prefix}/${address.site}/job/${address.location}/${address.posting}`;
    if (path.length > WORKDAY_PATH_MAX) return null;
    const workday = { host: address.host, site: address.site, location: address.location, posting: address.posting };
    return { kind: 'workday', board: parsed.board, externalId: parsed.externalId, region: 'global', workday };
  }
  return null;
}
