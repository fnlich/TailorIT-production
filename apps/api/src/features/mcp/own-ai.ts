import { z } from 'zod';
import {
  buildContactLine,
  composeLetterHtml,
  documentPlainText,
  ENTRY_BULLETS_KINDS,
  escapeInline,
  normalizeResumeDocument,
  printedDocument,
  resumeLabel,
  type BulletsRequest,
  type ResumeDocument,
} from '@tailorit/shared';
import type { AiTaskContext, PromptModule } from '../../ai/index';
import type { AppDeps } from '../../core/context';
import { AppError, notFound, validationFailed } from '../../core/http/errors';
import { stringsOf } from '../autofill/ai/tasks';
import { untrustedBlock } from '../autofill/ai/untrusted';
import { applicationFacts, letterProfile, visibleTemplate } from '../cover-letters/context';
import { requireEvidence } from '../cover-letters/generate';
import { coverLetterPrompt } from '../../ai/prompts/cover-letters/cover-letter';
import { resumeForPrompt } from '../cover-letters/resume-input';
import { tidyAiText } from '../cover-letters/tidy';
import { createLetterRepository } from '../cover-letters/repository';
import { sanitizeLetterHtml } from '../cover-letters/sanitize';
import { readAutofillProfile } from '../autofill/profile/repository';
import { finishBullets, runEntryBullets } from '../resumes/ai/entryBullets';
import { ImportedResumeSchema, resumeImportPrompt } from '../../ai/prompts/resumes/resume-import';
import { importedDocument } from '../resumes/ai/resumeImport';
import { documentOf, findResume, insertResume, updateResumeDocument } from '../resumes/repository';
import { MAX_EXTRACTED_TEXT, readableForImport, UNREADABLE_TEXT } from '../resumes/upload';
import { tailoredTitle } from '../tailor/output';
import { assertResumeEditable, assertRoomForResumes } from './limits';
import { tailorContext, tailorSave } from './own-ai-tailor';
import { contentProblem, CONTENT_REFUSALS } from './screen';

// v2.0 P5 (A17; 07-mcp.md "Every AI feature is usable through MCP"): the server-AI features beside Prepare, with the
// person's own AI doing the AI part and TailorIT the rest. own_ai_context answers TailorIT's own prompt for the
// feature (the server task's words), the input data (an upload's text, a posting, in <untrusted> wrappers) and the
// output's shape in one line; own_ai_save checks the output with the server task's own schema and normaliser and
// stores it as the server path would. Nothing here runs or charges TailorIT's AI. Only the person's own documents:
// another account's id is "not found".
// - resume_copy: an upload's editable copy (resume import). The resume limit before it is stored (room for 1), the
//   same insert as the copy line (made_by 'copy', the upload as its source).
// - entry_bullets: one entry's bullets (Write with AI / Improve with AI). Saving edits the resume's document: refused at
//   or over the plan's limit (assertResumeEditable's rule), written to the entry at the resume's current revision
//   (`replace` or `append`), refused when the person saved the resume since the context was read.
// - cover_letter: the editor's letter for a Tracker application (cover_letter prompt), 1 to 6 paragraphs, stored as a
//   generated letter linked to the application, from the resume named (else the application's, else the default).
// - tailor (v2.0 FIX-C, REQ-6): the web's "Tailor my resume" for one job (jobId, or applicationId), which it does not
//   queue: the keyword analysis, then the resume, saved as a new tailored resume under the resume limit and
//   the plan's tailorings an hour (FREE_/PAID_TAILOR_PER_HOUR, own-ai-tailor.ts).

export const OWN_AI_FEATURES = ['resume_copy', 'entry_bullets', 'cover_letter', 'tailor'] as const;
export type OwnAiFeature = (typeof OWN_AI_FEATURES)[number];

/** The upload's text the context quotes, at most. */
const UPLOAD_TEXT = MAX_EXTRACTED_TEXT;

/** A letter's paragraphs as own_ai_save takes them (the design's 1 to 6; the server's own task writes 3 or 4). */
const LetterOutputSchema = z.union([
  z.object({ paragraphs: z.array(z.string().max(3000)).min(1).max(6) }),
  z.string().max(20_000).transform((text) => ({ paragraphs: text.split(/\n\s*\n/) })),
]);

const refuseContent = (texts: unknown) => {
  const problem = contentProblem(stringsOf(texts), []);
  if (problem) throw new AppError('validation_failed', CONTENT_REFUSALS[problem]);
};

/** The shape a save takes, in one line, with the call that saves it. */
const saveLine = (feature: OwnAiFeature, ids: string, output: string) =>
  `own_ai_save {"feature": "${feature}", ${ids}, "output": ${output}}`;

// ------------------------------------------------------------------------------------------------ resume_copy

async function ownUpload(deps: Pick<AppDeps, 'db'>, userId: string, resumeId: string) {
  const row = await deps.db.one<{ id: string; extracted_text: string | null }>(
    "SELECT id, extracted_text FROM resumes WHERE id = ? AND user_id = ? AND kind = 'uploaded'",
    [resumeId, userId],
  );
  if (!row) throw notFound('That uploaded resume');
  const text = (row.extracted_text ?? '').slice(0, UPLOAD_TEXT);
  if (!readableForImport(text)) throw new AppError('validation_failed', UNREADABLE_TEXT);
  return { id: row.id, text };
}

async function resumeCopyContext(deps: AppDeps, userId: string, resumeId: string) {
  const upload = await ownUpload(deps, userId, resumeId);
  return {
    feature: 'resume_copy',
    prompt: resumeImportPrompt.system({ text: '' }),
    input: `RESUME TEXT (the person's uploaded file):\n${untrustedBlock(upload.text, UPLOAD_TEXT)}`,
    output: saveLine('resume_copy', `"resumeId": "${upload.id}"`, '<the document JSON in the shape above>'),
  };
}

async function resumeCopySave(deps: AppDeps, userId: string, resumeId: string, output: unknown) {
  const upload = await ownUpload(deps, userId, resumeId);
  // No resume is made past the plan's limit, whatever the person's AI wrote.
  await assertRoomForResumes(deps, userId, 1);
  const parsed = ImportedResumeSchema.safeParse(output);
  if (!parsed.success) {
    throw validationFailed('output: expected the resume document JSON in the shape own_ai_context gave.');
  }
  refuseContent(parsed.data);
  const document = importedDocument(parsed.data);
  if (!document.name && !document.summary && document.experience.length === 0 && document.education.length === 0 && document.skills.length === 0) {
    throw validationFailed('output: the document holds no resume content. Copy the resume text into it, then save again.');
  }
  // v3.0 D2 (the resume limit: count, then insert): checked again with the insert, behind the person's lock, so two saves
  // at once never pass the limit. insertResume joins this transaction (features/resumes keeps it tx-joinable).
  const id = await deps.db.tx(
    async (t) => {
      await t.lockPerson(userId);
      await assertRoomForResumes(deps, userId, 1);
      return await insertResume(deps, userId, { kind: 'built', document, sourceResumeId: upload.id, madeBy: 'copy' });
    },
    { label: 'own_ai_save resume_copy' },
  );
  return { feature: 'resume_copy', resumeId: id, name: resumeLabel(document, null) };
}

// ------------------------------------------------------------------------------------------------ entry_bullets

type EntryKind = (typeof ENTRY_BULLETS_KINDS)[number];
const LISTS: Record<EntryKind, 'experience' | 'projects' | 'volunteering'> = {
  experience: 'experience',
  project: 'projects',
  volunteering: 'volunteering',
};

/** The person's built resume, its document as stored and its revision. */
async function ownBuilt(deps: AppDeps, userId: string, resumeId: string) {
  const row = await findResume(deps, userId, resumeId);
  const document = row ? documentOf(row) : null;
  if (!row || !document) throw notFound('That resume (an editable one)');
  return { row, document, revision: row.document_revision };
}

/** An entry's key: its own id, else (an older document's entry has none) "<kind>:<index>". */
const entryKeyOf = (kind: EntryKind, index: number, entry: Record<string, unknown>) =>
  typeof entry.id === 'string' && entry.id ? entry.id : `${kind}:${index}`;

/** Every entry whose bullets the AI may write, by key. */
function entriesOf(document: ResumeDocument) {
  return ENTRY_BULLETS_KINDS.flatMap((kind) =>
    ((document[LISTS[kind]] ?? []) as Array<Record<string, unknown>>).map((entry, index) => ({
      kind,
      index,
      entry,
      key: entryKeyOf(kind, index, entry),
    })),
  );
}

function findEntry(document: ResumeDocument, entryId: string): { kind: EntryKind; index: number; entry: Record<string, unknown> } {
  const found = entriesOf(document).find((item) => item.key === entryId);
  if (!found) throw notFound('That entry (a role, a project or a volunteering entry of the resume)');
  return found;
}

/** The entries of a resume, for an AI that does not know their ids yet. */
function entryList(document: ResumeDocument) {
  const name = (entry: Record<string, unknown>, ...keys: string[]) =>
    keys.map((key) => entry[key]).find((value): value is string => typeof value === 'string' && value.trim() !== '') ?? '';
  return {
    cols: ['entryId', 'kind', 'title', 'at'] as const,
    rows: entriesOf(document).map(({ kind, entry, key }) => [
      key,
      kind,
      name(entry, 'title', 'name', 'role'),
      name(entry, 'company', 'organization', 'role'),
    ]),
  };
}

/** The Write with AI request the editor would send for the entry. */
function bulletsRequest(document: ResumeDocument, kind: EntryKind, entry: Record<string, unknown>, task: 'write' | 'improve'): BulletsRequest {
  const plain = documentPlainText(printedDocument(document));
  const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : undefined);
  return {
    kind,
    entry: {
      title: text(entry.title, 500),
      company: text(entry.company, 500),
      name: text(entry.name, 500),
      role: text(entry.role, 500),
      organization: text(entry.organization, 500),
      startDate: text(entry.startDate, 50),
      endDate: text(entry.endDate, 50),
      location: text(entry.location, 500),
      description: text(entry.description, 5000),
      achievements: Array.isArray(entry.achievements) ? (entry.achievements as string[]).slice(0, 50).map((item) => item.slice(0, 1000)) : [],
      skills: Array.isArray(entry.skills) ? (entry.skills as string[]).slice(0, 100).map((item) => item.slice(0, 100)) : [],
    },
    resume: {
      name: plain.name.slice(0, 200),
      title: plain.title.slice(0, 200),
      summary: plain.summary.slice(0, 5000),
      skills: plain.skills.slice(0, 200).map((skill) => skill.slice(0, 100)),
    },
    task,
    ...(document.markupVersion === 1 ? { markupVersion: 1 as const } : {}),
  };
}

/** The server task's own prompt for a request: it is run with a stand-in AI that only hears the prompt. */
async function capturedPrompt(request: BulletsRequest): Promise<{ module: PromptModule<unknown, unknown>; input: unknown }> {
  let heard: { module: PromptModule<unknown, unknown>; input: unknown } | null = null;
  const stop = new Error('captured');
  const ctx = {
    signal: new AbortController().signal,
    userId: null,
    taskId: 'mcp-own-ai',
    runPrompt: (async (module: PromptModule<unknown, unknown>, input: unknown) => {
      heard = { module, input };
      throw stop;
    }) as unknown as AiTaskContext['runPrompt'],
  } satisfies AiTaskContext;
  try {
    await runEntryBullets(request, ctx);
  } catch (error) {
    if (error !== stop) throw error;
  }
  if (!heard) throw new AppError('internal', 'The bullets prompt could not be read.');
  return heard;
}

async function entryBulletsContext(deps: AppDeps, userId: string, resumeId: string, entryId?: string, task?: 'write' | 'improve') {
  const { document, revision } = await ownBuilt(deps, userId, resumeId);
  if (!entryId) {
    return { feature: 'entry_bullets', resumeId, entries: entryList(document), next: 'Call own_ai_context again with one "entryId".' };
  }
  const { kind, entry } = findEntry(document, entryId);
  const existing = Array.isArray(entry.achievements) && (entry.achievements as unknown[]).length > 0;
  const { module, input } = await capturedPrompt(bulletsRequest(document, kind, entry, task ?? (existing ? 'improve' : 'write')));
  return {
    feature: 'entry_bullets',
    prompt: module.system(input),
    input: module.user(input),
    revision,
    output: saveLine(
      'entry_bullets',
      `"resumeId": "${resumeId}", "entryId": "${entryId}", "revision": ${revision}, "mode": "replace"|"append"`,
      '{"bullets": ["...", "..."]}',
    ),
  };
}

async function entryBulletsSave(
  deps: AppDeps,
  userId: string,
  input: { resumeId: string; entryId: string; output: unknown; mode?: 'replace' | 'append'; revision?: number },
) {
  // Saving a resume's document: refused at or over the plan's limit (A15: "at the limit, block ... edits").
  await assertResumeEditable(deps, userId);
  const parsed = z.object({ bullets: z.array(z.string()).min(1).max(20) }).safeParse(input.output);
  if (!parsed.success) throw validationFailed('output: expected {"bullets": ["...", "..."]}: 1 to 8 one-line bullets.');
  refuseContent(parsed.data.bullets);
  const bullets = finishBullets(parsed.data.bullets);
  if (bullets.length === 0) throw validationFailed('output: no usable bullet. Write them again.');
  return deps.db.tx(async () => {
    const { row, document, revision } = await ownBuilt(deps, userId, input.resumeId);
    if (input.revision !== undefined && input.revision !== revision) {
      throw new AppError(
        'revision_conflict',
        'This resume was saved since own_ai_context read it. Read the entry again with own_ai_context, then save.',
      );
    }
    const { kind, index, entry } = findEntry(document, input.entryId);
    const written = document.markupVersion === 1 ? bullets.map(escapeInline) : bullets;
    const current = Array.isArray(entry.achievements) ? (entry.achievements as string[]) : [];
    const achievements = input.mode === 'append' ? [...current, ...written] : written;
    const list = [...((document[LISTS[kind]] ?? []) as Array<Record<string, unknown>>)];
    list[index] = { ...entry, achievements };
    const next = normalizeResumeDocument({ ...document, [LISTS[kind]]: list });
    const saved = await updateResumeDocument(deps, userId, row.id, next, undefined, { baseRevision: revision });
    return { feature: 'entry_bullets', resumeId: row.id, entryId: input.entryId, bullets: written.length, revision: saved.documentRevision };
  }, { label: 'own_ai_save entry_bullets' });
}

// ------------------------------------------------------------------------------------------------ cover_letter

interface LetterJob {
  applicationId: string;
  jobId: number | null;
  company: string;
  title: string;
  description: string;
  resumeId: string | null;
}

/** The application as the editor's letter reads it (applicationFacts: 404 when it is not the person's). */
async function ownApplication(deps: Pick<AppDeps, 'db'>, userId: string, applicationId: string): Promise<LetterJob> {
  const facts = await applicationFacts(deps, userId, applicationId);
  const row = await deps.db.one<{ resume_id: string | null }>('SELECT resume_id FROM applications WHERE id = ? AND user_id = ?', [
    applicationId,
    userId,
  ]);
  return {
    applicationId,
    jobId: facts.jobId,
    company: facts.companyName.trim(),
    title: facts.jobTitle.trim(),
    description: facts.jobDescription,
    resumeId: row?.resume_id ?? null,
  };
}

/** The letter's resume: the one named, else the application's own, else the default (the editor's rule). */
async function letterResume(deps: AppDeps, userId: string, job: LetterJob, resumeId?: string) {
  const own = resumeId ?? (job.resumeId && (await findResume(deps, userId, job.resumeId)) ? job.resumeId : null);
  return await requireEvidence(deps, userId, own);
}

async function letterTemplateOf(deps: AppDeps, userId: string) {
  const id = (await readAutofillProfile(deps, userId)).value.documents.coverLetterTemplateId;
  return id ? await visibleTemplate(deps, userId, id) : null;
}

async function coverLetterContext(deps: AppDeps, userId: string, applicationId: string, resumeId?: string) {
  const job = await ownApplication(deps, userId, applicationId);
  const evidence = await letterResume(deps, userId, job, resumeId);
  const input = {
    job: { companyName: job.company, jobTitle: job.title, jobDescription: job.description },
    resume: resumeForPrompt(evidence),
    templatePrompt: (await letterTemplateOf(deps, userId))?.aiPrompt ?? '',
    customPrompt: '',
  };
  return {
    feature: 'cover_letter',
    prompt: coverLetterPrompt.system(input),
    input: [coverLetterPrompt.context?.(input) ?? '', coverLetterPrompt.user(input)].filter((part) => part.trim()).join('\n\n'),
    output: saveLine(
      'cover_letter',
      `"applicationId": "${job.applicationId}", "resumeId": "${evidence.resumeId}"`,
      '{"paragraphs": ["...", "..."]} (1 to 6, the body only)',
    ),
  };
}

async function coverLetterSave(deps: AppDeps, userId: string, applicationId: string, output: unknown, resumeId?: string) {
  const job = await ownApplication(deps, userId, applicationId);
  const evidence = await letterResume(deps, userId, job, resumeId);
  const parsed = LetterOutputSchema.safeParse(output);
  if (!parsed.success) throw validationFailed('output: expected {"paragraphs": ["...", "..."]}, 1 to 6 paragraphs of plain text.');
  refuseContent(parsed.data.paragraphs);
  const paragraphs = parsed.data.paragraphs
    .flatMap((paragraph) => tidyAiText(paragraph).split(/\n\s*\n/))
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  if (paragraphs.length < 1 || paragraphs.length > 6) throw validationFailed('output: a cover letter needs 1 to 6 paragraphs.');
  const profile = letterProfile(evidence);
  const template = await letterTemplateOf(deps, userId);
  const html = sanitizeLetterHtml(composeLetterHtml({ name: profile.fullName, contactLine: buildContactLine(profile), paragraphs }));
  const letters = createLetterRepository(deps);
  const title = tailoredTitle(job.company, job.title);
  const row = await deps.db.tx(async () => {
    const created = await letters.create(userId, {
      title,
      origin: 'generated',
      contentHtml: html,
      ...(template ? { fontFamily: template.fontFamily, templateId: template.id } : {}),
      applicationId: job.applicationId,
      ...(job.jobId !== null ? { jobId: job.jobId } : {}),
      companyName: job.company.slice(0, 200),
      jobTitle: job.title.slice(0, 200),
    });
    await letters.update(created.id, userId, { resumeId: evidence.resumeId });
    return created;
  }, { label: 'own_ai_save cover_letter' });
  return { feature: 'cover_letter', coverLetterId: row.id, name: title };
}

// ------------------------------------------------------------------------------------------------ the tools

export interface OwnAiContextInput {
  feature: OwnAiFeature;
  resumeId?: string;
  entryId?: string;
  applicationId?: string;
  /** v2.0 FIX-C: tailor's job (or its applicationId). */
  jobId?: number;
  task?: 'write' | 'improve';
}

export interface OwnAiSaveInput extends OwnAiContextInput {
  output: unknown;
  mode?: 'replace' | 'append';
  revision?: number;
}

const need = (value: string | undefined, name: string, feature: string): string => {
  if (!value) throw validationFailed(`${name}: ${feature} needs it.`);
  return value;
};

export async function ownAiContext(deps: AppDeps, userId: string, input: OwnAiContextInput) {
  switch (input.feature) {
    case 'resume_copy':
      return resumeCopyContext(deps, userId, need(input.resumeId, 'resumeId', input.feature));
    case 'entry_bullets':
      return entryBulletsContext(deps, userId, need(input.resumeId, 'resumeId', input.feature), input.entryId, input.task);
    case 'cover_letter':
      return coverLetterContext(deps, userId, need(input.applicationId, 'applicationId', input.feature), input.resumeId);
    case 'tailor':
      return tailorContext(deps, userId, input);
  }
}

export async function ownAiSave(deps: AppDeps, userId: string, input: OwnAiSaveInput) {
  const result = await (() => {
    switch (input.feature) {
      case 'resume_copy':
        return resumeCopySave(deps, userId, need(input.resumeId, 'resumeId', input.feature), input.output);
      case 'entry_bullets':
        return entryBulletsSave(deps, userId, {
          resumeId: need(input.resumeId, 'resumeId', input.feature),
          entryId: need(input.entryId, 'entryId', input.feature),
          output: input.output,
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.revision !== undefined ? { revision: input.revision } : {}),
        });
      case 'cover_letter':
        return coverLetterSave(deps, userId, need(input.applicationId, 'applicationId', input.feature), input.output, input.resumeId);
      case 'tailor':
        return tailorSave(deps, userId, input, input.output);
    }
  })();
  deps.log.debug(`[mcp] account ${userId}: own_ai_save ${input.feature} stored`);
  return result;
}
