import { htmlToText, type LetterProfile } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import type { Dialect } from '../../core/db/index';
import { notFound } from '../../core/http/errors';
import { currentJobId } from '../jobs/store';
import { jobTextJoin, plainTextOf } from '../jobs/text';
import { jobVisibleTo } from '../jobs/visibility';
import type { ResumeEvidence } from '../resumes/evidence';

// What a letter is about and who writes it: the tracked application or job it comes from, the template it starts
// from, and the person's profile (from their resume, with Settings filling the gaps).
//
// v3.0 D2 (D2-E): every read and write goes through the async client. v3.0 PG-E: a job's text is read from job_texts
// (features/jobs/text.ts), and a template's `is_system` flag through the dialect.

export interface JobFacts {
  applicationId: string | null;
  jobId: number | null;
  companyName: string;
  jobTitle: string;
  jobDescription: string;
}

interface ApplicationRow {
  id: string;
  job_id: number | null;
  title: string;
  company_name: string;
  description_html: string;
}

interface JobRow {
  id: number;
  title: string;
  description_html: string;
  company_name: string | null;
}

interface TemplateDbRow {
  id: string;
  name: string;
  /** 0/1 on SQLite, a boolean on PostgreSQL. */
  is_system: unknown;
  content_html: string;
  content_text: string;
  font_family: string;
  ai_prompt: string;
}

const SELECT_APPLICATION = 'SELECT id, job_id, title, company_name, description_html FROM applications WHERE id = ? AND user_id = ?';
const LINK_LETTER = `UPDATE applications SET cover_letter_id = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND cover_letter_id IS NULL`;
const JOB_EXISTS = `SELECT 1 FROM jobs WHERE id = ? AND ${jobVisibleTo('')}`;
const SELECT_JOB = `SELECT j.id, j.title, coalesce(jt.description_html, '') AS description_html, c.name AS company_name
         FROM jobs j ${jobTextJoin('j', 'jt')} LEFT JOIN companies c ON c.id = j.company_id
         WHERE j.id = ?`;
const SELECT_TEMPLATE = (d: Dialect) => `SELECT id, name, is_system, content_html, content_text, font_family, ai_prompt
        FROM cover_letter_templates WHERE id = ? AND (is_system = ${d.true} OR user_id = ?)`;
const OWN_RESUME = 'SELECT 1 FROM resumes WHERE id = ? AND user_id = ?';

/** An application row as letter facts (the job's text and id settled by the caller). */
function applicationFactsOf(row: ApplicationRow, description: string, jobId: number | null): JobFacts {
  return { applicationId: row.id, jobId, companyName: row.company_name, jobTitle: row.title, jobDescription: description };
}

function jobFactsOfRow(row: JobRow): JobFacts {
  return {
    applicationId: null,
    jobId: row.id,
    companyName: row.company_name ?? '',
    jobTitle: row.title,
    jobDescription: plainTextOf(row.description_html),
  };
}

function templateRecordOf(d: Dialect, row: TemplateDbRow): TemplateRecord {
  return {
    id: row.id,
    name: row.name,
    isSystem: d.isTrue(row.is_system),
    contentHtml: row.content_html,
    contentText: row.content_text,
    fontFamily: row.font_family,
    aiPrompt: row.ai_prompt,
  };
}

/** One of the account's tracked applications as letter facts, or 404. */
export async function applicationFacts(deps: Pick<AppDeps, 'db'>, userId: string, applicationId: string): Promise<JobFacts> {
  const row = await deps.db.one<ApplicationRow>(SELECT_APPLICATION, [applicationId, userId]);
  if (!row) throw notFound('That application');
  let description = htmlToText(row.description_html ?? '');
  let jobId = row.job_id;
  // An application saved from Jobs may not carry the posting's text; the job does.
  if (!description && jobId !== null) description = (await jobFactsOrNull(deps, jobId, userId))?.jobDescription ?? '';
  if (jobId !== null && !(await jobExists(deps, jobId, userId))) jobId = null;
  return applicationFactsOf(row, description, jobId);
}

/**
 * A letter started from a tracked application becomes that application's cover letter, unless one is linked (the
 * Cover Letters tab's New, and a letter the extension writes).
 */
export async function linkApplicationLetter(
  deps: Pick<AppDeps, 'db' | 'now'>,
  userId: string,
  applicationId: string,
  letterId: string,
): Promise<void> {
  await deps.db.run(LINK_LETTER, [letterId, deps.now().toISOString(), applicationId, userId]);
}

/**
 * Whether TailorIT has the job for the account: every shared job, and the account's own jobs made from a page
 * (autofill API version 5), never another account's.
 */
export async function jobExists(deps: Pick<AppDeps, 'db'>, jobId: number, userId: string): Promise<boolean> {
  return Boolean(await deps.db.one(JOB_EXISTS, [jobId, userId]));
}

async function jobFactsOrNull(deps: Pick<AppDeps, 'db'>, jobId: number, userId: string): Promise<JobFacts | null> {
  // A page job an upgrade closed is the shared job it gave way to (audit D4): a letter started from a stale id is the
  // shared job's. (jobs/store.ts is D2-C's: awaited whether it answers at once or later.)
  const current = await currentJobId(deps, userId, jobId);
  if (current === null) return null;
  const row = await deps.db.one<JobRow>(SELECT_JOB, [current]);
  return row ? jobFactsOfRow(row) : null;
}

/** A job from the Jobs page as letter facts, or 404 (also for another account's job made from a page). */
export async function jobFacts(deps: Pick<AppDeps, 'db'>, jobId: number, userId: string): Promise<JobFacts> {
  const facts = await jobFactsOrNull(deps, jobId, userId);
  if (!facts) throw notFound('That job');
  return facts;
}

export interface TemplateRecord {
  id: string;
  name: string;
  isSystem: boolean;
  contentHtml: string;
  contentText: string;
  fontFamily: string;
  aiPrompt: string;
}

/** A template the account may use (a system template or one of its own), or null. */
export async function visibleTemplate(deps: Pick<AppDeps, 'db'>, userId: string, templateId: string): Promise<TemplateRecord | null> {
  const row = await deps.db.one<TemplateDbRow>(SELECT_TEMPLATE(deps.db.dialect), [templateId, userId]);
  return row ? templateRecordOf(deps.db.dialect, row) : null;
}

export async function requireVisibleTemplate(deps: Pick<AppDeps, 'db'>, userId: string, templateId: string): Promise<TemplateRecord> {
  const template = await visibleTemplate(deps, userId, templateId);
  if (!template) throw notFound('That template');
  return template;
}

export async function requireOwnResume(deps: Pick<AppDeps, 'db'>, userId: string, resumeId: string): Promise<void> {
  if (!(await deps.db.one(OWN_RESUME, [resumeId, userId]))) throw notFound('That resume');
}

/** The person a letter is written for, from their resume's evidence (which already falls back to Settings). */
export function letterProfile(evidence: ResumeEvidence): LetterProfile {
  const { profile } = evidence;
  return {
    fullName: profile.name,
    email: profile.email,
    phone: profile.phone,
    location: profile.location,
    linkedin: profile.linkedin,
    portfolio: profile.portfolio,
    title: profile.title,
  };
}
