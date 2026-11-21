import {
  buildContactLine,
  composeLetterHtml,
  CreateApplicationBodySchema,
  letterVariableValues,
  normalizeCompanyName,
  normalizeJobTitle,
  STATUS,
  substituteVariables,
  type LetterProfile,
  type ResumeDocument,
} from '@tailorit/shared';
import type { Payer } from '../../core/accounts/payer'; // v33 SHARE-3 (review)
import { nowIso, type AppDeps } from '../../core/context';
import type { Dialect } from '../../core/db/index';
import { AppError } from '../../core/http/errors';
import { createApplication } from '../applications/service';
import type { TemplateRecord } from '../cover-letters/context';
import { templateHasContent } from '../cover-letters/generate';
import { createLetterRepository } from '../cover-letters/repository';
import { sanitizeLetterHtml } from '../cover-letters/sanitize';
import { insertResume } from '../resumes/repository';

// What a tailoring stores (decision 15): a new built resume (titled "<Company> - <Job title>", source_resume_id the
// resume it was tailored from), the cover letter written beside it (origin 'generated', on the chosen template), and
// the link of both to the job's tracker entry (made at Saved when the person had none): applications.resume_id and
// cover_letter_id, which the extension's lookup and its cover-letter route read first, so autofill attaches them. All in
// one transaction: nothing is stored unless all of it is.

/** The longest resume or letter title stored. */
const MAX_TITLE = 200;

/** "<Company> - <Job title>", or the one of them there is. */
export function tailoredTitle(company: string, jobTitle: string): string {
  const parts = [company.trim(), jobTitle.trim()].filter(Boolean);
  return (parts.join(' - ') || 'Tailored resume').slice(0, MAX_TITLE);
}

/** The AI variables a tailored letter fills: its body, or the whole letter. */
const BODY_VARIABLES = ['COVER_LETTER_BODY', 'FULL_COVER_LETTER'] as const;

/**
 * The letter's HTML. With a template that holds {{COVER_LETTER_BODY}} or {{FULL_COVER_LETTER}}: the template, its
 * person, job and date variables filled as the letter editor fills them, and the body (or the whole letter) put in.
 * Otherwise (no template, an empty one, or one with no place for the body): TailorIT's own layout, composeLetterHtml,
 * in the template's font when there is one.
 */
export function letterHtml(input: {
  paragraphs: readonly string[];
  profile: LetterProfile;
  company: string;
  jobTitle: string;
  today: Date;
  template: TemplateRecord | null;
}): { html: string; templateId: string | null; fontFamily: string | null } {
  const { profile, template } = input;
  const body = input.paragraphs.join('\n\n');
  const fills =
    template &&
    templateHasContent(template.contentHtml) &&
    BODY_VARIABLES.some((name) => template.contentHtml.includes(`{{${name}}}`));
  if (template && fills) {
    const values: Record<string, string> = letterVariableValues({
      profile,
      job: { companyName: input.company, jobTitle: input.jobTitle, hiringManager: null },
      today: input.today,
    });
    const salutation = values.SALUTATION ?? 'Dear Hiring Manager,';
    const signOff = values.SIGN_OFF ?? 'Sincerely,';
    values.COVER_LETTER_BODY = body;
    values.FULL_COVER_LETTER = [salutation, body, signOff, profile.fullName].filter((part) => part.trim()).join('\n\n');
    return {
      html: sanitizeLetterHtml(substituteVariables(template.contentHtml, values)),
      templateId: template.id,
      fontFamily: template.fontFamily,
    };
  }
  const html = sanitizeLetterHtml(
    composeLetterHtml({ name: profile.fullName, contactLine: buildContactLine(profile), paragraphs: input.paragraphs }),
  );
  return { html, templateId: null, fontFamily: template?.fontFamily ?? null };
}

/** Where the tailored documents go: the job, the tracker entry named, or the posting itself. */
export interface TrackerTarget {
  jobId: number | null;
  applicationId: string | null;
  company: string;
  jobTitle: string;
  postingUrl: string;
}

/** The account's tracker entry added by hand (no job) for this company and title, not archived, or null. */
async function handAddedEntry(deps: Pick<AppDeps, 'db'>, userId: string, company: string, jobTitle: string): Promise<string | null> {
  const rows = await deps.db.all<{ id: string; title: string; company_name: string }>(HAND_ADDED_SQL, [userId]);
  return handAddedOf(rows, company, jobTitle);
}

/** The hand-added entries of an account. */
export const HAND_ADDED_SQL = `SELECT id, title, company_name FROM applications
        WHERE user_id = ? AND job_id IS NULL AND archived_at IS NULL ORDER BY updated_at DESC, id`;

/** Of the hand-added entries, the one for this company and title. */
export function handAddedOf(rows: ReadonlyArray<{ id: string; title: string; company_name: string }>, company: string, jobTitle: string): string | null {
  const title = normalizeJobTitle(jobTitle);
  const companyName = normalizeCompanyName(company);
  return rows.find((row) => normalizeJobTitle(row.title) === title && normalizeCompanyName(row.company_name) === companyName)
    ?.id ?? null;
}

/**
 * The tracker entry the tailored documents are linked to: the one named (if still the account's), else the job's
 * (made at Saved, or brought back from the archive, by the tracker's own save), else for a posting TailorIT does not
 * have, the entry added by hand for its company and title, else a new one at Saved. Null only when the job is gone.
 */
async function trackerEntry(deps: AppDeps, userId: string, target: TrackerTarget, resumeId: string): Promise<string | null> {
  if (target.applicationId) {
    const own = await deps.db.one<{ id: string }>('SELECT id FROM applications WHERE id = ? AND user_id = ?', [target.applicationId, userId]);
    if (own) return own.id;
  }
  if (target.jobId !== null) {
    try {
      return (await createApplication(deps, userId, { jobId: target.jobId, status: STATUS.saved, resumeId })).detail.id;
    } catch (error) {
      if (error instanceof AppError && error.code === 'not_found') return null;
      throw error;
    }
  }
  if (target.applicationId) return null;
  const existing = await handAddedEntry(deps, userId, target.company, target.jobTitle);
  if (existing) return existing;
  const body = newEntryBody(target, resumeId);
  return (await createApplication(deps, userId, body)).detail.id;
}

/** The entry body of a posting TailorIT does not have. */
export function newEntryBody(target: TrackerTarget, resumeId: string) {
  const parsed = CreateApplicationBodySchema.safeParse({
    title: target.jobTitle.trim().slice(0, 200) || 'Untitled role',
    companyName: target.company.trim().slice(0, 200) || 'Unknown company',
    employmentType: 'full_time',
    status: STATUS.saved,
    resumeId,
    ...(target.postingUrl ? { postingUrl: target.postingUrl } : {}),
  });
  // A posting address the tracker would refuse is left off, never the entry.
  return parsed.success
    ? parsed.data
    : CreateApplicationBodySchema.parse({
        title: target.jobTitle.trim().slice(0, 200) || 'Untitled role',
        companyName: target.company.trim().slice(0, 200) || 'Unknown company',
        employmentType: 'full_time',
        status: STATUS.saved,
        resumeId,
      });
}

export interface TailoredOutput {
  resumeId: string;
  coverLetterId: string | null;
  coverLetterTemplateId: string | null;
  applicationId: string | null;
}

/** What storeTailored takes. */
export interface TailoredInput {
  title: string;
  document: ResumeDocument;
  sourceResumeId: string;
  letter: { html: string; templateId: string | null; fontFamily: string | null } | null;
  target: TrackerTarget;
  postingText: string;
  /** v33 SHARE-3 (review): who pays (B on A's profile): the resume never takes A's last places (insertResume's lock). */
  payer?: Payer;
}

/** The entry's documents: the person's choice now (v3.0 PG-F: resume_match_due is a boolean). */
export const linkDocumentsSql = (d: Dialect) => `UPDATE applications SET resume_id = ?, resume_origin = 'user', resume_matched_at = ?,
             resume_match_due = ${d.false}, cover_letter_id = coalesce(?, cover_letter_id), updated_at = ?
           WHERE id = ? AND user_id = ?`;

/** Stores the tailored resume and letter and links them to the tracker entry, in one transaction. */
export async function storeTailored(deps: AppDeps, userId: string, input: TailoredInput): Promise<TailoredOutput> {
  return deps.db.tx(
    async () => {
      // await them).
      const resumeId = await insertResume(deps, userId, {
        kind: 'built',
        title: input.title,
        document: input.document,
        sourceResumeId: input.sourceResumeId,
        madeBy: 'tailor', // v1.5 W
        ...(input.payer ? { payer: input.payer } : {}), // v33 SHARE-3 (review)
      });
      const applicationId = await trackerEntry(deps, userId, input.target, resumeId);
      const jobId =
        applicationId === null
          ? null
          : ((await deps.db.one<{ job_id: number | null }>('SELECT job_id FROM applications WHERE id = ?', [applicationId]))?.job_id ?? null);

      let coverLetterId: string | null = null;
      if (input.letter) {
        const letters = createLetterRepository(deps);
        const row = await letters.create(userId, {
          title: input.title,
          origin: 'generated',
          contentHtml: input.letter.html,
          ...(input.letter.fontFamily ? { fontFamily: input.letter.fontFamily } : {}),
          applicationId,
          jobId,
          companyName: input.target.company.slice(0, 200),
          jobTitle: input.target.jobTitle.slice(0, 200),
          jobDescription: input.postingText,
          templateId: input.letter.templateId,
        });
        await letters.update(row.id, userId, { resumeId });
        coverLetterId = row.id;
      }

      if (applicationId) {
        // The person asked for these documents for this job: they are its documents now (resume_origin 'user', so the
        // match worker never changes it).
        const now = nowIso(deps);
        await deps.db.run(linkDocumentsSql(deps.db.dialect), [resumeId, now, coverLetterId, now, applicationId, userId]);
      }
      return { resumeId, coverLetterId, coverLetterTemplateId: input.letter?.templateId ?? null, applicationId };
    },
    { label: 'storeTailored' },
  );
}
