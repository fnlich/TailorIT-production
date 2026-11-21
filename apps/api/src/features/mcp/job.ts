import {
  effectiveTemplateId,
  isResumeTemplateId,
  personSideFamily,
  STATUS,
  type LetterProfile,
  type RoleFamilyId,
  type ResumeDocument,
  type ResumeTemplateId,
} from '@tailorit/shared';
import { AUTOFILL_TAILOR_LIMITS } from '@tailorit/shared/autofill';
import type { AppDeps } from '../../core/context';
import { AppError } from '../../core/http/errors';
import { editorDocumentOf } from '../../core/skills/index'; // v33 LEGACY
import { untrustedLines } from '../autofill/ai/untrusted';
import { jobFacts, letterProfile, type TemplateRecord } from '../cover-letters/context';
import { getResumeEvidence, type ResumeEvidence } from '../resumes/evidence';
import { jobFamilyOf, profileFamilyOf } from '../roles/index'; // v33 PROMPTS
import { analysisPromptHash } from '../tailor/analysis';
import { tailorFitOf, type TailorFit } from '../tailor/pipeline';
import { referenceFor } from '../tailor/skills/reference';
import { analysisFromSaved, withTargetRoleTitle } from '../tailor/keywords';
import { profileFromDocument } from '../tailor/mapping';
import { resolveSource } from '../tailor/source';
import { createAnalysisStore } from '../tailor/store';
import { chooseTemplates, sourceDocument } from '../tailor/source';
import { postingHashOf } from '../tailor/store';
import type { JobAnalysis, Profile } from '../tailor/types';
import { workFor, type Work } from './work';

// One job of the person's Prepare, as the MCP tools read it (v1.5 M): a Tracker entry of theirs at Saved that has a
// job (decision 4's scope), its posting cleaned as page text is (v1.4's tailoring cleans it the same way), the resume
// it is tailored from read as tailor_builder0's Profile (as tailor/service.ts runTailoring reads it), the profile's
// templates, and the keyword analysis TailorIT holds for the posting. Every read names the account: a job that is not
// one of the account's Saved entries is "not found", whoever else tracks it.
// v3.0 D2: async. The resume, template, letter and analysis helpers of other features are awaited whether they are
// async yet or not (their folders convert them: D2-C, D2-E, D2-F).

export const NOT_IN_PREPARE =
  'That job is not one of your Saved jobs in the Tracker. Prepare works on the Saved jobs only: call prepare_queue ' +
  'for the jobs to work on.';

export interface McpJob {
  applicationId: string;
  jobId: number;
  company: string;
  title: string;
  postingUrl: string;
  /** The posting's text, cleaned line by line as page text is (untrustedLines), at most 20,000 characters. */
  posting: string;
  /** v33 PROMPTS (F5): the job's stored category (null when it has none). */
  categoryId: string | null;
  /** v33 PROMPTS (F5): the job's role family (jobFamilyOf): the analysis and review steps are written for it. */
  family: RoleFamilyId;
}

/** The account's Saved Tracker entry of `jobId` with its posting; 404 `not_found` otherwise. */
export async function mcpJobOf(deps: Pick<AppDeps, 'db'>, userId: string, jobId: number): Promise<McpJob> {
  const row = await deps.db.one<{ id: string; title: string; company_name: string; posting_url: string; category_id: string | null }>(
    `SELECT a.id, a.title, a.company_name, a.posting_url, j.category_id FROM applications a LEFT JOIN jobs j ON j.id = a.job_id
      WHERE a.user_id = ? AND a.job_id = ? AND a.archived_at IS NULL AND a.current_status = ?`,
    [userId, jobId, STATUS.saved],
  );
  if (!row) throw new AppError('not_found', NOT_IN_PREPARE);
  let facts: Awaited<ReturnType<typeof jobFacts>> | null = null;
  try {
    facts = await jobFacts(deps, jobId, userId);
  } catch (error) {
    if (!(error instanceof AppError && error.code === 'not_found')) throw error;
  }
  if (!facts) throw new AppError('not_found', NOT_IN_PREPARE);
  const title = (facts.jobTitle || row.title).trim().slice(0, AUTOFILL_TAILOR_LIMITS.title);
  return {
    applicationId: row.id,
    jobId,
    company: (facts.companyName || row.company_name).trim().slice(0, AUTOFILL_TAILOR_LIMITS.company),
    title,
    postingUrl: row.posting_url,
    posting: untrustedLines(facts.jobDescription ?? '', AUTOFILL_TAILOR_LIMITS.jobDescription),
    categoryId: row.category_id,
    family: await jobFamilyOf(deps, { jobId, title }),
  };
}

/** The resume a job is tailored from, read as runTailoring reads it. */
export interface SourceProfile {
  resumeId: string;
  /** The source as a document of the on-page editor (an older one upgraded on the way, never stored). */
  editor: ResumeDocument;
  evidence: ResumeEvidence | null;
  profile: Profile;
  /** The template the tailored resume is drawn on: the profile's, else the source's own. */
  templateId: ResumeTemplateId;
  coverLetterTemplate: TemplateRecord | null;
  /** v33 PROMPTS (F5): the person's field, this resume's (profileFamilyOf). */
  family: RoleFamilyId;
}

/** v33 PROMPTS (F5): what a tailoring from `source` for `job` is written for: the person's field, else the job's. */
export function personFitOf(source: Pick<SourceProfile, 'family'>, job: Pick<McpJob, 'family'>): TailorFit {
  return tailorFitOf(personSideFamily(source.family, job.family));
}

/**
 * The source resume (the profile's resume, else the default; an upload's editable copy) and the profile's templates.
 * Refuses as v1.4's tailoring does: no resume (400), an upload with no editable copy (409 `needs_editable_copy`).
 */
export async function sourceProfile(deps: AppDeps, userId: string): Promise<SourceProfile> {
  const source = await resolveSource(deps, userId);
  return builtProfile(deps, userId, source.resumeId);
}

/**
 * v2.0 P5: one built resume of the account read as runTailoring reads its source (the profile's templates), for the
 * resume a Prepare chose (DECISIONS A29: the letter and the answers are written from it). 404 when it is gone.
 */
export async function builtProfile(deps: AppDeps, userId: string, resumeId: string): Promise<SourceProfile> {
  const { row, document: stored } = await sourceDocument(deps, userId, resumeId);
  const templates = await chooseTemplates(deps, userId, {});
  const templateId: ResumeTemplateId = isResumeTemplateId(templates.resumeTemplateId)
    ? templates.resumeTemplateId
    : effectiveTemplateId(stored);
  const editor = await editorDocumentOf(deps, userId, stored, templateId); // v33 LEGACY
  const evidence = await getResumeEvidence(deps, userId, row.id);
  return {
    resumeId: row.id,
    editor,
    evidence,
    profile: profileFromDocument(editor, evidence?.profile),
    templateId,
    coverLetterTemplate: templates.coverLetterTemplate,
    family: (await profileFamilyOf(deps, userId, row.id)).familyId,
  };
}

/** The person a letter is from, as v1.4's tailoring reads them (runTailoring's `person`). */
export function letterPerson(source: SourceProfile): LetterProfile {
  const { profile, evidence } = source;
  return evidence
    ? letterProfile(evidence)
    : {
        fullName: profile.name,
        email: profile.contact.email,
        phone: profile.contact.phone,
        location: profile.contact.location,
        linkedin: '',
        portfolio: '',
        title: profile.title,
      };
}

/** Who made the analysis TailorIT holds for a posting: the person's own AI, or TailorIT's (a server tailoring). */
export type AnalysisMaker = 'your-ai' | 'tailorit';

/**
 * The keyword analysis of the job's posting, filtered in code (toJobAnalysis) every time it is read: the one the
 * person's AI saved for this posting, else the one TailorIT's own tailoring keeps for it (tailor_job_analyses, on the
 * model the server tailors with); null when there is neither.
 */
export async function heldAnalysis(
  deps: AppDeps,
  userId: string,
  job: McpJob,
  given?: Work,
): Promise<{ analysis: JobAnalysis; madeBy: AnalysisMaker } | null> {
  const work = given ?? (await workFor(deps, userId, job.jobId));
  // v33 PROMPTS (F5): an analysis is the job's: filtered with the job family's skill library.
  const skills = referenceFor(job.family);
  const postingHash = postingHashOf(job.posting);
  if (work.analysisRaw && work.postingHash === postingHash) {
    const own = analysisFromSaved(work.analysisRaw, job.posting, skills);
    if (own) return { analysis: withTargetRoleTitle(own, job.title), madeBy: 'your-ai' };
  }
  // v33 PROMPTS: TailorIT's own analysis of the posting is kept per job family (tailor/analysis.ts analysisPromptHash).
  const kept = await createAnalysisStore(deps).read({
    postingHash,
    promptHash: analysisPromptHash(job.family),
    model: deps.config.ai.features.tailor.model,
  });
  const server = kept ? analysisFromSaved(kept, job.posting, skills) : null;
  return server ? { analysis: withTargetRoleTitle(server, job.title), madeBy: 'tailorit' } : null;
}
