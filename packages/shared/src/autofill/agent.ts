import { z } from 'zod';
import { InstantSchema } from './common';
import { addablePosting, greenhouseBoardPage, parseAtsUrl, type AtsKind, type ParsedAtsUrl } from './lookup';

// The auto-apply agent's queue (version 3). The person queues jobs from TailorIT's Jobs and Tracker pages ("Auto-apply")
// and may turn on a rule ("auto-apply to new jobs of at least N% match", off until they turn it on); there is no daily
// limit. Version 8 (v2.0): a job reaches the queue only through TailorIT's Prepare & Queue (source `prepare`), which
// queues a job the extension cannot open with the run kind `manual` (the person applies by hand; no run takes it); the
// rule saves new jobs instead of queueing them; and a Free account may auto-apply to a limited number of jobs a day,
// counted when a run takes a row (the claim's `dailyLimit`). The extension's worker, with its token (scope agent:run) and only when the person turned on "Run auto-apply"
// in its options, takes one job at a time (GET /api/autofill/agent/next), opens its application page, fills and
// submits it, and reports how it went (POST /api/autofill/agent/:id/result); a submitted one is marked Applied in the
// tracker. The queue keeps states and reason codes only: never a value the form was filled with.

/**
 * Where a queued job stands. `queued`: waiting. `running`: a browser took it (that browser alone gets it again from
 * GET …/next; `needs-you` with `timed_out` when it does not report within AUTOFILL_AGENT_RUN_TIMEOUT_MS). `submitted`:
 * the form was sent, and the job is Applied in the tracker. `skipped`: the agent left it on purpose (the posting forbids
 * AI, it was applied for already). `needs-you`: the person must finish it (a CAPTCHA, a sign-in, an email code, a
 * required field the profile cannot fill, a run that never reported). `failed`: it went wrong (the page broke, the
 * posting closed, a validation error that stayed).
 */
export const AUTOFILL_AGENT_STATES = ['queued', 'running', 'submitted', 'skipped', 'needs-you', 'failed'] as const;
export type AutofillAgentState = (typeof AUTOFILL_AGENT_STATES)[number];

/** The states a result reports, and the ones "Clear finished" removes. */
export const AUTOFILL_AGENT_FINISHED_STATES = ['submitted', 'skipped', 'needs-you', 'failed'] as const;
export type AutofillAgentFinishedState = (typeof AUTOFILL_AGENT_FINISHED_STATES)[number];

/**
 * How a job came into the queue: the person's Auto-apply, or the rule (both before v2.0), or (version 8) TailorIT's
 * Prepare & Queue, the only way in from v2.0.
 */
export const AUTOFILL_AGENT_SOURCES = ['manual', 'rule', 'prepare'] as const;
export type AutofillAgentSource = (typeof AUTOFILL_AGENT_SOURCES)[number];

/**
 * Why a job was not submitted, a closed list (a new code is a new value in an answer: it bumps AUTOFILL_API_VERSION).
 * `required_field_empty`: a required field is still empty. `posting_forbids_ai`: the posting asks applicants not to
 * use AI. `ai_guess_legal`: a legal answer was an AI guess and the person's skip rule says to stop. `captcha`: a
 * CAPTCHA or bot check. `sign_in`: a sign-in or account page (Sign-in mode Manual, or no saved sign-in).
 * `sign_in_failed`: Sign-in mode Auto could not sign in. `email_code`: the site sent a code to the person's email.
 * `validation_error`: the page still shows an error after one retry. `unsupported_site`: the extension cannot fill this
 * page. `posting_closed`: the posting is gone (or TailorIT closed the job before the agent took it). `page_error`: the
 * page did not load or broke. `timed_out`: the run did not report within AUTOFILL_AGENT_RUN_TIMEOUT_MS.
 * `already_applied`: the site says the person applied already, or the tracker had the job past Saved when the agent
 * came to it. `cancelled`: the person stopped the run. `other`: none of these.
 */
export const AUTOFILL_AGENT_REASONS = [
  'required_field_empty',
  'posting_forbids_ai',
  'ai_guess_legal',
  'captcha',
  'sign_in',
  'sign_in_failed',
  'email_code',
  'validation_error',
  'unsupported_site',
  'posting_closed',
  'page_error',
  'timed_out',
  'already_applied',
  'cancelled',
  'other',
] as const;
export type AutofillAgentReason = (typeof AUTOFILL_AGENT_REASONS)[number];

/**
 * A run the agent took and did not report within this long is left for the person: `needs-you`, `timed_out` (it may
 * have been sent; they look and queue it again). It never goes back to the queue by itself.
 */
export const AUTOFILL_AGENT_RUN_TIMEOUT_MS = 30 * 60_000;

/**
 * The platforms whose application forms the agent fills: a job queues only when its posting is on one of them. A
 * platform joins only when the extension can walk its application end to end: an address that opens it (the posting
 * with its entry, or the form), its steps' Next, its Submit, and a sign of success its adapter reads, seen in a capture
 * or snapshot of the page after submitting. Version 6 (the owner's snapshots of 2026-11-06): iCIMS (its posting's
 * "Apply for this job online", the email gate, the steps' Submit, and /job?mode=submit_apply's .iCIMS_SuccessMessage)
 * and Pinpoint (its one-page form, and /applications/thanks's section#application-thanks). Not yet: Workday, Taleo,
 * SuccessFactors, Oracle Recruiting Cloud and SmartRecruiters (no page after submitting seen, so no success sign), Breezy
 * HR (its confirmation is in the form's markup, hidden in both snapshots: never seen shown), and the other new ATSs (no
 * confirmation in any snapshot). The extension's Queue tab, which the person watches, opens more (AUTOFILL_QUEUE_ATS).
 *
 * Version 7 (jr7, the owner's snapshot7 of 2026-11-11 and the integration's readiness tests): a platform joins when a
 * capture of the page after its Submit shows a success sign its adapter reads, the same sign is absent on every other
 * capture of the platform, and no capture shows a CAPTCHA, a human check or a code on the way. Three join:
 * - Jobvite (`jobvite`): /applyConfirmation and "Application Sent!" on jobvite1's confirmation
 *   (fixtures/jobvite/jr7-jobvite1-confirmation), none on its posting and steps; Apply, the steps' Next and Send
 *   Application walked to a recorded submission; no CAPTCHA, check or code in any of its captures.
 * - Workday (`workday`), its guest tenants: the page after submitting on all three tenants of snapshot7
 *   (fixtures/workday/jr7-workday{1,2,3}-confirmation: the address, the drawn sign after its fade, and Workday's own
 *   finalize answer), none on the 41 pages before them; Apply, Apply Manually, each step's Next and Submit. An account
 *   tenant's run ends needing the person at its Create Account or its email verification (Workday's design).
 * - SmartRecruiters (`smartrecruiters`): /success and its confirmation heading on smartrecruiter1's page after
 *   submitting (fixtures/smartrecruiters/jr7-smartrecruiter1-success), none on its other pages; the posting's "I'm
 *   interested", its one-click application and screening step, recorded once under the posting.
 * Never, for D-5's reasons (the person's step on every application):
 * - ADP Workforce Now (`adp`) never joins: every guest application sends the person a one-time verification code by
 *   text or email before its first step (snapshot6 adp1 and adp2, snapshot7 adp1), which an unattended run never
 *   requests or types; the Queue tab opens its job details (`queueApplicationUrl`) and the person types the code there.
 * - Oracle Recruiting Cloud (`oracle`): a code at Submit (snapshot7 oraclecloud1) or at the email gate on other
 *   tenants.
 * - JazzHR (`jazzhr`) and BambooHR (`bamboohr`): a checkbox reCAPTCHA on every form.
 * - UltiPro (`ultipro`): UKG's candidate sign-in on every new tenant.
 * - Dayforce (`dayforce`): an image check at Submit, and no capture of its page after submitting.
 * Out until the owner's live checks (Q7-1, Q7-2) clear their invisible or empty check widgets and open lists: Rippling
 * (`rippling`), UKG Ready (`ukgready`), Paycom (`paycom`), JobDiva (`jobdiva`) and Eightfold (`eightfold`). The
 * Queue tab opens all of these.
 */
export const AUTOFILL_AGENT_ATS = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'icims',
  'pinpoint',
  // Version 7.
  'jobvite',
  'workday',
  'smartrecruiters',
] as const satisfies readonly AtsKind[];

/** The longest application address the agent opens. */
export const AUTOFILL_AGENT_URL_MAX = 2048;

/**
 * The application form's address for a posting at `url`, on a host the extension's agent opens, or null when the agent
 * cannot fill it. Greenhouse: the posting's job page on job-boards.greenhouse.io (the form is on it), from its job page
 * on either global host, the embedded form naming its board, or a board's own page naming it in ?gh_jid=; never from a
 * company's own page naming it in ?gh_jid= (its form is a frame of the company's page, which the agent never opens), an
 * embed naming no board, or an EU board (the extension works on no EU Greenhouse host yet). Lever: `…/apply`, on either
 * of its hosts. Ashby: `…/application`, the board in lower case (percent-encoded), from the posting, its form or the
 * board naming it in ?ashby_jid=. Workable: apply.workable.com/{account}/j/{shortcode}/apply/, the account in lower case
 * and the shortcode in capitals, from the posting or its form on apply.workable.com or the account's own host; never
 * from a /j/{shortcode} link that names no account, nor from Workable's job-search site. Version 6: iCIMS, the
 * posting's own page, https://<portal>/jobs/<id>/job (its entry opens the email gate), from the posting, its gate or
 * any step after it; Pinpoint, the form, https://<tenant>.pinpointhq.com/en/postings/<uuid>/applications/new, from the
 * posting, the form or the page after submitting. Version 7: Jobvite, the application, …/job/<id>/apply (its consent
 * gate and steps at that address); Workday, the posting's own page without its locale (its Apply, then Apply
 * Manually), only when its location and posting segments are ones TailorIT puts into an address of its own
 * (addablePosting's check); SmartRecruiters, the posting, https://jobs.smartrecruiters.com/<Company>/<number> (its "I'm
 * interested" opens the one-click application), never a one-click application's own address. Read with parseAtsUrl, so
 * the extension and TailorIT agree: the answer reads as itself again.
 */
export function agentApplicationUrl(url: string): string | null {
  const read = url.length <= AUTOFILL_AGENT_URL_MAX ? parseAtsUrl(url) : null;
  // parseAtsUrl reads any page naming the posting in ?gh_jid= with no board; a Greenhouse board's own page names one.
  const posting = read?.kind === 'greenhouse' && read.board === null ? greenhouseBoardPage(url) : read;
  const address = posting ? formAddress(posting) : null;
  return address !== null && address.length <= AUTOFILL_AGENT_URL_MAX ? address : null;
}

/** The application form's address of a posting on a platform the agent fills, when its board is known; else null. */
function formAddress(posting: ParsedAtsUrl): string | null {
  const { kind, board, externalId, canonical } = posting;
  if (board === null) return null;
  switch (kind) {
    case 'greenhouse': {
      // One of the posting's own addresses, unless it is on an EU board.
      const page = `https://job-boards.greenhouse.io/${board}/jobs/${externalId}`;
      return canonical.includes(page) ? page : null;
    }
    case 'lever':
      return canonical[1] ?? null;
    case 'ashby':
      return `https://jobs.ashbyhq.com/${encodeURIComponent(board)}/${externalId}/application`;
    case 'workable':
      // The account is a host name's label and the shortcode hexadecimal: nothing to encode.
      return `https://apply.workable.com/${board}/j/${externalId}/apply/`;
    case 'icims':
    case 'pinpoint':
    case 'jobvite':
      // The posting's own page (iCIMS) or its form (Pinpoint; version 7: Jobvite's …/job/<id>/apply), as parseAtsUrl
      // builds it from the host and the id alone.
      return canonical[0] ?? null;
    case 'workday':
      // Version 7: the posting (its first canonical address, without its locale), only when its location and posting
      // segments are ones TailorIT puts into an address of its own (addablePosting's check: no dot segment, no encoded
      // '/'), so both runs open the same address.
      return addablePosting(posting) !== null ? (canonical[0] ?? null) : null;
    case 'smartrecruiters':
      // Version 7: the posting by its number; a one-click application's own address names no posting to open.
      return canonical[0] !== undefined && !canonical[0].includes('/oneclick-ui/') ? canonical[0] : null;
    default:
      return null;
  }
}

/** True when the agent can apply to the posting at `url` (the Jobs and Tracker pages' `autoApply`). */
export function agentCanApply(url: string): boolean {
  return agentApplicationUrl(url) !== null;
}

// jr7 7a (additive within version 6; APPLYPLAN F4b, the owner's snapshot7 of 2026-11-11): the extension's Queue tab
// opens every platform the extension fills, not only the agent's.
/**
 * The platforms whose jobs the extension's Queue tab opens (POST /api/autofill/agent/:id/opened): every platform the
 * extension fills with a posting TailorIT reads, the agent's (AUTOFILL_AGENT_ATS) among them, but Dice (no page after
 * submitting captured, and its posting is outside the pages the extension runs on). The Queue tab is attended: the
 * person is at the browser, so a CAPTCHA, a code or a sign-in a platform asks for (JazzHR's and BambooHR's reCAPTCHA,
 * ADP's and Oracle's codes, UKG's sign-in for UltiPro, Dayforce's image check) is theirs there, in that tab. Run
 * auto-apply, unattended, still takes only AUTOFILL_AGENT_ATS. Version 7 (the integration's readiness verdict): every
 * kind of ATS_KINDS but Dice, the four new ones too (UKG Ready, Paycom, JobDiva and Eightfold: each keeps one
 * application from its posting to its page after submitting, Eightfold by one key, Paycom and UKG Ready by the
 * extension's chain from the posting the tab opened). Where the extension reads no success sign in a capture after
 * Submit (Dayforce, Taleo, SuccessFactors, Breezy HR, CareerPlug, Paycor, HiBob, Paylocity, ClearCompany), the Queue tab
 * leaves Submit to the person whatever Submit is set to (the extension's QUEUE_SUBMIT_PLATFORMS).
 */
export const AUTOFILL_QUEUE_ATS = [
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
  'clearcompany',
  'adp',
  'smartrecruiters',
  // Version 7.
  'ukgready',
  'paycom',
  'jobdiva',
  'eightfold',
] as const satisfies readonly AtsKind[];

/**
 * The address the Queue tab opens for a posting at `url`, or null when neither run can open it: the agent's
 * (agentApplicationUrl) when it has one (version 7: Workday's posting, SmartRecruiters' posting and Jobvite's …/apply
 * among them), else, on a platform of AUTOFILL_QUEUE_ATS the agent does not take, an address built from the posting's
 * board and id alone (parseAtsUrl's canonical addresses) that says hello before any redirect: the posting, whose own
 * Apply the extension presses (Oracle Recruiting Cloud; Dayforce's posting, before its way-to-apply choice; UltiPro's
 * OpportunityDetail, never OpportunityApply, which sends a new visitor to UKG's sign-in first; version 7: UKG Ready's
 * posting, with its employer's ein_id when the address names one; Paycom's posting; JobDiva's portal job,
 * …/portal/?a=<key>#/jobs/<id>, whose Apply Now leads to Quick Apply), or the application form where the platform has
 * one address for it (ADP's guest page, which opens the posting's details; BambooHR's /careers/<id>; JazzHR's page;
 * Rippling's form; version 7: Eightfold's /careers/apply?pid=<id>; Taleo, SuccessFactors, Breezy HR, CareerPlug,
 * Paycor, HiBob, Paylocity and ClearCompany as parseAtsUrl names them first). The answer reads as itself again, at most
 * AUTOFILL_AGENT_URL_MAX characters.
 */
export function queueApplicationUrl(url: string): string | null {
  const agent = agentApplicationUrl(url);
  if (agent !== null) return agent;
  const read = url.length <= AUTOFILL_AGENT_URL_MAX ? parseAtsUrl(url) : null;
  const address = read ? queueFormAddress(read) : null;
  return address !== null && address.length <= AUTOFILL_AGENT_URL_MAX ? address : null;
}

/** The address the Queue tab opens on a platform it alone takes (queueApplicationUrl); null on any other. */
function queueFormAddress({ kind, canonical }: ParsedAtsUrl): string | null {
  if (!(AUTOFILL_QUEUE_ATS as readonly AtsKind[]).includes(kind)) return null;
  // The agent's platforms open at the agent's address, or not at all (an EU Greenhouse board, a link naming no account,
  // version 7: a Workday location that would change the path, a SmartRecruiters one-click application).
  if ((AUTOFILL_AGENT_ATS as readonly AtsKind[]).includes(kind)) return null;
  switch (kind) {
    case 'ultipro':
      // [OpportunityApply, OpportunityDetail]: the posting, on the page's own host.
      return canonical.find((address) => address.includes('/OpportunityDetail?')) ?? null;
    case 'dayforce':
      // [step 1 of the guest application, the posting]: the posting, whose Apply leads to the choice.
      return canonical[1] ?? null;
    case 'ukgready':
      // Version 7, UKGR-V3: [the posting by ShowJob, the same with its ein_id when the address names one]: the latter
      // when there is one (the employer's id, public), else the former.
      return canonical.find((address) => address.includes('&ein_id=')) ?? canonical[0] ?? null;
    default:
      return canonical[0] ?? null;
  }
}

/** True when the Queue tab can open the posting at `url` (queueApplicationUrl): the Jobs and Tracker pages' `queueApply`. */
export function queueCanOpen(url: string): boolean {
  return queueApplicationUrl(url) !== null;
}
/**
 * The most jobs one Auto-apply click queued (unused from v2.0: POST /api/autofill/agent/queue answers 409 `conflict`;
 * kept until version 9), and the most rows an account's queue holds by default (TailorIT enforces its own
 * QUEUE_SIZE_MAX, whose default this is).
 */
export const AUTOFILL_AGENT_ENQUEUE_MAX = 100;
export const AUTOFILL_AGENT_QUEUE_MAX = 500;
/** The rule's default threshold, used until the person sets one. */
export const AUTOFILL_AGENT_DEFAULT_MIN_MATCH = 80;

/** A queue row's id: TailorIT's random UUID in lower case. */
export const AutofillAgentIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/**
 * The job the agent applies to now: open `url`, the application form's address (agentApplicationUrl: Greenhouse's job
 * page on job-boards.greenhouse.io, Lever's `…/apply`, Ashby's `…/application`, Workable's `…/apply/`, and since
 * version 6 iCIMS's posting page `…/jobs/<id>/job` and Pinpoint's `…/applications/new`; version 7 Jobvite's
 * `…/job/<id>/apply`, Workday's posting page and SmartRecruiters' posting), and attach `resumeId` when set. jr7 7a: the
 * Queue tab's task (POST …/agent/:id/opened) carries queueApplicationUrl's address instead, which is the agent's on the
 * agent's platforms.
 */
export const AutofillAgentTaskSchema = z.object({
  id: AutofillAgentIdSchema,
  jobId: z.number().int().positive(),
  url: z.string().max(AUTOFILL_AGENT_URL_MAX).regex(/^https?:\/\/\S+$/i),
  company: z.string(),
  title: z.string(),
  /** The resume to attach: the one TailorIT matched to the job (a rule's), the tracker entry's, else null (the lookup's
   *  suggestion then). */
  resumeId: z.string().nullable(),
});
export type AutofillAgentTask = z.infer<typeof AutofillAgentTaskSchema>;

/**
 * Version 8: a Free account's daily auto-apply limit, as the claim answers it (GET …/agent/next, POST …/:id/opened).
 * Each run that takes a row counts once in the current window (a day by default, from TailorIT's reset time); a run
 * that ends `failed`, `skipped`, or `needs-you` before Submit was pressed gives its count back. When `reached`, the
 * claim's `item` is null and the rows stay queued: wait until `resetsAt` (Run auto-apply stays on), and show
 * `message` as it is.
 */
export const AutofillDailyLimitSchema = z.object({
  /** True when this account may not start another auto-apply until resetsAt. */
  reached: z.boolean(),
  used: z.number().int().nonnegative(),
  /** null: unlimited (a Paid account). */
  limit: z.number().int().nonnegative().nullable(),
  resetsAt: InstantSchema,
  /** TailorIT's words for the person when reached (MSG_LIMIT_AUTO_APPLY); show them as they are. */
  message: z.string().max(400).optional(),
});
export type AutofillDailyLimit = z.infer<typeof AutofillDailyLimitSchema>;

/**
 * GET /api/autofill/agent/next (scope agent:run): this browser's own running job again, when it has one (a worker that
 * restarted asks anew; nothing changes); else the account's oldest queued job, now `running` for this browser (checked
 * again as it is taken: one tracked past Saved by now is `skipped`, a closed one `failed`, and the next taken); else,
 * with the rule on, a new job: open, posted (else updated, else first seen) since the rule was turned on, from a board
 * TailorIT reads (not an import alone), not tracked, never queued, never taken out of the queue by the person, on a
 * platform the agent fills (agentCanApply), and whose match with the account's best resume for it is at least the
 * rule's `minMatch`; weighed in the order TailorIT first saw them, each once, and counted toward
 * AUTOFILL_AGENT_QUEUE_MAX. `item` null: nothing to do. jr7 7a: the queued jobs the agent takes are those whose posting
 * it opens (agentApplicationUrl); a queued job only the Queue tab opens (queueCanOpen) is left queued for it, never
 * failed, and the next is looked at.
 */
export const AutofillAgentNextSchema = z.object({
  item: AutofillAgentTaskSchema.nullable(),
  /**
   * Version 8: the account's daily auto-apply count after this claim (absent from an older server). When `reached`,
   * `item` is null and the queued rows stay queued: poll again at `resetsAt`.
   */
  dailyLimit: AutofillDailyLimitSchema.optional(),
});
export type AutofillAgentNext = z.infer<typeof AutofillAgentNextSchema>;

/**
 * POST /api/autofill/agent/:id/result (scope agent:run): how a run went. `submitted` (no reason) is taken whatever the
 * row's state, from any of the account's browsers, so a sent form is never lost (a run left `needs-you`, `timed_out`
 * included): the job is marked Applied in the tracker (POST /api/autofill/applied's way, with the run's resume as the
 * entry's when it is made or restored now); again for a submitted row, it changes nothing. Any other state needs a
 * reason, and the row `running` for this browser, or for a connection that no longer works (revoked, expired or
 * deleted: a browser that connected again during the run reports it with its new token); 409 `conflict` otherwise, but
 * the same result again, which changes nothing. 404 for another account's row or one removed since. `aiGuesses`: how
 * many answers were AI guesses, a count only (shown on TailorIT's Auto-apply page). Answers 204.
 */
export const AutofillAgentResultBodySchema = z
  .object({
    state: z.enum(AUTOFILL_AGENT_FINISHED_STATES),
    reason: z.enum(AUTOFILL_AGENT_REASONS).nullable(),
    aiGuesses: z.number().int().min(0).max(1000).optional(),
    /**
     * Version 8: Submit was pressed in this run. TailorIT keeps the run's daily auto-apply count when it was (a form
     * that may have been sent), and gives it back otherwise for a run that `failed`, was `skipped` or `needs-you`.
     */
    submitPressed: z.boolean().optional(),
  })
  .superRefine((body, ctx) => {
    if (body.state === 'submitted' && body.reason !== null) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'A submitted application has no reason' });
    }
    if (body.state !== 'submitted' && body.reason === null) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Say why it was not submitted' });
    }
  });
export type AutofillAgentResultBody = z.infer<typeof AutofillAgentResultBodySchema>;

/** POST /api/autofill/agent/queue (the Jobs and Tracker pages' Auto-apply): queue these jobs. */
export const AutofillAgentEnqueueBodySchema = z.object({
  jobIds: z.array(z.number().int().positive()).min(1).max(AUTOFILL_AGENT_ENQUEUE_MAX),
});
export type AutofillAgentEnqueueBody = z.infer<typeof AutofillAgentEnqueueBodySchema>;

/**
 * Why a job was not queued: `already_queued` (queued or running now), `already_applied` (its tracker entry is past
 * Saved, or the agent submitted it), `posting_closed` (the posting has closed), `unsupported_site` (the agent cannot
 * open its posting's form: not on a platform the agent fills, or a company's own page naming a Greenhouse posting in
 * ?gh_jid=: agentCanApply; jr7 7a: nor can the Queue tab, queueCanOpen), `not_found` (TailorIT has no such job).
 * `timed_out` is never answered by POST …/queue; it is listed so one set of words labels both these skips and the
 * rows' reasons.
 */
export const AUTOFILL_AGENT_SKIPS = [
  'already_queued',
  'already_applied',
  'posting_closed',
  'timed_out',
  'unsupported_site',
  'not_found',
] as const;
export type AutofillAgentSkip = (typeof AUTOFILL_AGENT_SKIPS)[number];

/**
 * The answer: the jobs queued now (a job the agent left earlier, skipped, needing the person or failed, is queued
 * again), and the rest with why. 409 `conflict` when the queue would hold more than AUTOFILL_AGENT_QUEUE_MAX rows.
 */
export const AutofillAgentEnqueueResponseSchema = z.object({
  queued: z.array(z.number().int().positive()),
  skipped: z.array(z.object({ jobId: z.number().int().positive(), reason: z.enum(AUTOFILL_AGENT_SKIPS) })),
});
export type AutofillAgentEnqueueResponse = z.infer<typeof AutofillAgentEnqueueResponseSchema>;

// v1.5 Q2: the extension's Queue tab (a sequential run that opens queued jobs in new tabs, one by one).
/**
 * Which run took a row: `agent`, the background "Run auto-apply" worker (GET …/agent/next), or `tab`, the Queue tab's
 * sequential run (POST …/agent/:id/opened). A row one run took is never handed to the other: GET …/next takes only
 * `queued` rows and gives a browser back only its own `agent` runs, and …/opened takes only a `queued` row (or this
 * browser's own `tab` run again).
 */
export const AUTOFILL_AGENT_RUNS = ['agent', 'tab'] as const;
export type AutofillAgentRun = (typeof AUTOFILL_AGENT_RUNS)[number];

/**
 * Version 8: who applies to a row. The two runs, or `manual`: a job neither run can open, queued by Prepare & Queue
 * for the person to apply to by hand on TailorIT's Auto-apply page. No run ever takes a `manual` row: GET …/next skips
 * it, POST …/:id/opened refuses it (409), and a token's queue list leaves it out. A row's `run` is one of these.
 */
export const AUTOFILL_AGENT_RUN_KINDS = ['agent', 'tab', 'manual'] as const;
export type AutofillAgentRunKind = (typeof AUTOFILL_AGENT_RUN_KINDS)[number];

/** The most rows one page of GET /api/autofill/agent/queue answers, and the page size when `cursor` comes alone. */
export const AUTOFILL_AGENT_QUEUE_PAGE_MAX = 100;
export const AUTOFILL_AGENT_QUEUE_PAGE_DEFAULT = 50;
/** The longest page cursor. */
export const AUTOFILL_AGENT_QUEUE_CURSOR_MAX = 200;

const AGENT_STATE_LIST = new RegExp(
  `^(?:${AUTOFILL_AGENT_STATES.join('|')})(?:,(?:${AUTOFILL_AGENT_STATES.join('|')}))*$`,
);

/**
 * GET /api/autofill/agent/queue's query (the Queue tab, with a token of scope agent:run; the Auto-apply page sends
 * none). `state`: one state, or several joined by commas ("queued,running"). `limit`: 1 to AUTOFILL_AGENT_QUEUE_PAGE_MAX
 * rows. `cursor`: the last page's `nextCursor`, read under the same `state` (under another one the list starts again
 * from the top). With none of the three, the answer is the whole list, as the Auto-apply page reads it.
 */
export const AutofillAgentQueueQuerySchema = z.object({
  state: z.string().max(80).regex(AGENT_STATE_LIST).optional(),
  cursor: z
    .string()
    .min(1)
    .max(AUTOFILL_AGENT_QUEUE_CURSOR_MAX)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(AUTOFILL_AGENT_QUEUE_PAGE_MAX).optional(),
});
export type AutofillAgentQueueQuery = z.infer<typeof AutofillAgentQueueQuerySchema>;
// end v1.5 Q2

/** One row of the Auto-apply page. */
export const AutofillAgentQueueItemSchema = z.object({
  id: AutofillAgentIdSchema,
  jobId: z.number().int().positive(),
  title: z.string(),
  company: z.string(),
  location: z.string(),
  /** The posting's address. */
  url: z.string(),
  /** The job is still open. */
  active: z.boolean(),
  state: z.enum(AUTOFILL_AGENT_STATES),
  /** Why it was not submitted; null while queued or running, and when submitted. */
  reason: z.enum(AUTOFILL_AGENT_REASONS).nullable(),
  source: z.enum(AUTOFILL_AGENT_SOURCES),
  /** How many times the agent took it. */
  attempts: z.number().int().nonnegative(),
  /** AI guesses in the run that finished it; null when it did not say. */
  aiGuesses: z.number().int().nonnegative().nullable(),
  createdAt: InstantSchema,
  startedAt: InstantSchema.nullable(),
  finishedAt: InstantSchema.nullable(),
  // v1.5 Q2 (optional, so an older server's list still parses)
  /**
   * The application form's address a run opens (agentApplicationUrl), or null when the agent cannot open it. jr7 7a:
   * the Queue tab's address (queueApplicationUrl, the agent's on the agent's platforms), or null when neither run can
   * open it.
   */
  applyUrl: z.string().max(AUTOFILL_AGENT_URL_MAX).nullable().optional(),
  /**
   * Which run took the row (AUTOFILL_AGENT_RUNS); null while no run took it. Version 8: `manual`, a row the person
   * applies to by hand (AUTOFILL_AGENT_RUN_KINDS), set when Prepare & Queue inserts it.
   */
  run: z.enum(AUTOFILL_AGENT_RUN_KINDS).nullable().optional(),
  // end v1.5 Q2
  // jr7 7a (optional, so an older server's list still parses)
  /**
   * The runs that can take the row (AUTOFILL_AGENT_RUNS, in that order): `agent` when Run auto-apply opens its posting
   * (agentApplicationUrl), `tab` when the Queue tab does (queueApplicationUrl); `['tab']` alone is a job that waits for
   * the Queue tab, `[]` one neither opens.
   */
  runs: z.array(z.enum(AUTOFILL_AGENT_RUNS)).max(AUTOFILL_AGENT_RUNS.length).optional(),
  // end jr7 7a
});
export type AutofillAgentQueueItem = z.infer<typeof AutofillAgentQueueItemSchema>;

/**
 * GET /api/autofill/agent/queue (the Auto-apply page; v1.5 Q2: also a token of scope agent:run, the Queue tab): the
 * account's queue, running first, then queued (oldest first, the order the agent takes them), then the finished ones
 * (latest first). `limit` is AUTOFILL_AGENT_QUEUE_MAX. DELETE /api/autofill/agent/queue/:id removes one (204);
 * POST /api/autofill/agent/queue/clear-finished removes the finished ones ({removed}).
 *
 * v1.5 Q2: with a query (AutofillAgentQueueQuery), `items` is one page in that order, of the rows in `state` when it is
 * given; `total` counts every row the query names (all pages); `nextCursor` is present while more rows follow.
 */
export const AutofillAgentQueueListSchema = z.object({
  items: z.array(AutofillAgentQueueItemSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  // v1.5 Q2
  nextCursor: z.string().max(AUTOFILL_AGENT_QUEUE_CURSOR_MAX).optional(),
  // end v1.5 Q2
  /**
   * Version 8 (additive): the account's auto-applies in the current window, for "3 of 7 used today" (`limit` null:
   * unlimited).
   */
  autoApply: z
    .object({
      used: z.number().int().nonnegative(),
      limit: z.number().int().nonnegative().nullable(),
      resetsAt: InstantSchema,
    })
    .optional(),
});
export type AutofillAgentQueueList = z.infer<typeof AutofillAgentQueueListSchema>;

// v1.5 Q2
/**
 * POST /api/autofill/agent/:id/opened (scope agent:run, no body): the Queue tab's sequential run takes this queued row
 * before it opens the job in a new tab. The row is then `running` for this browser's tab run (attempts + 1, started
 * now, the tracker entry's resume to attach), so GET …/agent/next never hands it to the background agent; its result
 * goes to POST …/agent/:id/result as the agent's does (a run that never reports is `needs-you`, `timed_out`, after
 * AUTOFILL_AGENT_RUN_TIMEOUT_MS, as the agent's). The row is checked as the agent's claim checks it: a job tracked past
 * Saved by now is `skipped` (`already_applied`), a closed one `failed` (`posting_closed`), one the agent can no longer
 * open `failed` (`unsupported_site`); `item` is then null, with that state and reason (open the next one). The same
 * browser asking again for its own tab run gets the same `item` (a worker that restarted). 409 `conflict` when the row
 * is running for the background agent or for another browser, or finished; 404 for another account's row or one
 * removed. jr7 7a: the item's `url` is the Queue tab's address (queueApplicationUrl), and `unsupported_site` is a job
 * the Queue tab can no longer open (queueCanOpen).
 */
export const AutofillAgentOpenedSchema = z.object({
  item: AutofillAgentTaskSchema.nullable(),
  state: z.enum(AUTOFILL_AGENT_STATES),
  reason: z.enum(AUTOFILL_AGENT_REASONS).nullable(),
  /**
   * Version 8: the account's daily auto-apply count after this claim. When `reached`, `item` is null and the row stays
   * `queued` (state `queued`, reason null): stop the run with the limit's message. A `manual` row is refused (409).
   */
  dailyLimit: AutofillDailyLimitSchema.optional(),
});
export type AutofillAgentOpened = z.infer<typeof AutofillAgentOpenedSchema>;
// end v1.5 Q2

/** POST /api/autofill/agent/queue/clear-finished's answer: how many finished rows were removed. */
export const AutofillAgentClearedSchema = z.object({ removed: z.number().int().nonnegative() });
export type AutofillAgentCleared = z.infer<typeof AutofillAgentClearedSchema>;

/**
 * GET and PUT /api/autofill/agent/settings (the Auto-apply page): the rule "auto-apply to new jobs of at least
 * `minMatch`% match", off by default. Turning it on starts its "new": only jobs TailorIT first sees from then on.
 */
export const AutofillAgentSettingsSchema = z.object({
  ruleEnabled: z.boolean(),
  minMatch: z.number().int().min(0).max(100),
});
export type AutofillAgentSettings = z.infer<typeof AutofillAgentSettingsSchema>;
