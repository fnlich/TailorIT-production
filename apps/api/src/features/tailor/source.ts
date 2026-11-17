import { isResumeTemplateId, type ResumeTemplateId } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import { AppError, notFound, validationFailed } from '../../core/http/errors';
import { readAutofillProfile } from '../autofill/profile/repository';
import { visibleTemplate, type TemplateRecord } from '../cover-letters/context';
import { defaultResumeId, documentOf, findResume } from '../resumes/repository';

// What a tailoring starts from (decision 15): the source resume and the two templates.
//
// The source: the resume the request names, else the one the autofill profile chose (documents.resumeId), else the
// account's default resume. A built resume is used as it is. An upload is never changed and has no document to tailor,
// so its editable copy is used (the newest built resume made from it); an upload with none is refused with
// `needs_editable_copy`, and the person makes the copy first: no import is ever started behind their back.
//
// The templates: the request's when it names them (null: none), else the profile's documents.resumeTemplateId and
// coverLetterTemplateId. A resume template null is the source's own; a letter template null is TailorIT's own layout.
// v3.0 D2-F: resolveSource and editableCopyOf on the async client.

export const NO_RESUME_TO_TAILOR = 'Add a resume in Documents first, so there is a resume to tailor.';
export const NEEDS_EDITABLE_COPY =
  'This resume is an uploaded file, which TailorIT never changes. Make an editable copy of it in Documents ' +
  '(Make editable copy), then tailor again: the copy is tailored.';
export const SOURCE_GONE = 'The resume this was tailored from was deleted. Choose another resume and try again.';
export const UNKNOWN_RESUME_TEMPLATE = 'That resume template does not exist. Choose another template.';

export interface TailorSource {
  /** The built resume tailored from. */
  resumeId: string;
  /** Its document's revision (resumes.document_revision): a change starts a new tailoring rather than the last one. */
  revision: number;
}

/** A resume of the account, as resolveSource reads it. */
export interface OwnResumeRow {
  id: string;
  kind: 'built' | 'uploaded';
  document_revision: number;
}

/** resolveSource's statements. */
export const SOURCE_SQL = {
  own: 'SELECT id, kind, document_revision FROM resumes WHERE id = ? AND user_id = ?',
  editableCopy: `SELECT id, document_revision FROM resumes
        WHERE user_id = ? AND kind = 'built' AND source_resume_id = ?
        ORDER BY updated_at DESC, created_at DESC, id ASC LIMIT 1`,
} as const;

const ownRow = (deps: Pick<AppDeps, 'db'>, userId: string, id: string) => deps.db.one<OwnResumeRow>(SOURCE_SQL.own, [id, userId]);

/** The newest built resume made from the upload (its editable copy), or null. */
export async function editableCopyOf(deps: Pick<AppDeps, 'db'>, userId: string, uploadId: string): Promise<TailorSource | null> {
  const row = await deps.db.one<{ id: string; document_revision: number }>(SOURCE_SQL.editableCopy, [userId, uploadId]);
  return row ? { resumeId: row.id, revision: row.document_revision } : null;
}

/**
 * The resume to tailor from. 404 for a requested resume that is not the account's; 400 when the account has no resume;
 * 409 `needs_editable_copy` for an upload without an editable copy.
 */
export async function resolveSource(deps: Pick<AppDeps, 'db'>, userId: string, requested?: string): Promise<TailorSource> {
  let id: string | null = null;
  if (requested) {
    if (!(await ownRow(deps, userId, requested))) throw notFound('That resume');
    id = requested;
  } else {
    const chosen = (await readAutofillProfile(deps, userId)).value.documents.resumeId;
    id = chosen && (await ownRow(deps, userId, chosen)) ? chosen : await defaultResumeId(deps, userId);
  }
  const row = id ? await ownRow(deps, userId, id) : undefined;
  return sourceOf(row, () => editableCopyOf(deps, userId, row!.id));
}

/** The source from the resume row: a built one as it is, an upload's editable copy, else the refusals. */
export async function sourceOf(row: OwnResumeRow | undefined, copyOf: () => Promise<TailorSource | null> | TailorSource | null): Promise<TailorSource> {
  if (!row) throw validationFailed(NO_RESUME_TO_TAILOR, { resumeId: NO_RESUME_TO_TAILOR });
  if (row.kind === 'built') return { resumeId: row.id, revision: row.document_revision };
  const copy = await copyOf();
  if (!copy) throw new AppError('needs_editable_copy', NEEDS_EDITABLE_COPY);
  return copy;
}

/** The source resume's stored document when the task runs; 404 when it was deleted meanwhile. */
export async function sourceDocument(deps: Pick<AppDeps, 'db'>, userId: string, resumeId: string) {
  const row = await findResume(deps, userId, resumeId);
  const document = row ? documentOf(row) : null;
  if (!row || !document) throw new AppError('not_found', SOURCE_GONE);
  return { row, document };
}

export interface ChosenTemplates {
  /** A resume template id; null: the source's own. */
  resumeTemplateId: ResumeTemplateId | null;
  coverLetterTemplate: TemplateRecord | null;
}

/**
 * The templates of a tailoring: `requested` (undefined: not named) else the profile's. A named one that does not exist
 * is refused (400 for a resume template, 404 for a letter template); one the profile names that is gone since reads as
 * none.
 */
export async function chooseTemplates(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  requested: { resumeTemplateId?: string | null; coverLetterTemplateId?: string | null },
): Promise<ChosenTemplates> {
  const documents = (await readAutofillProfile(deps, userId)).value.documents;
  let resumeTemplateId: ResumeTemplateId | null = null;
  if (requested.resumeTemplateId !== undefined) {
    if (requested.resumeTemplateId !== null) {
      if (!isResumeTemplateId(requested.resumeTemplateId)) {
        throw validationFailed(UNKNOWN_RESUME_TEMPLATE, { resumeTemplateId: UNKNOWN_RESUME_TEMPLATE });
      }
      resumeTemplateId = requested.resumeTemplateId;
    }
  } else if (isResumeTemplateId(documents.resumeTemplateId)) {
    resumeTemplateId = documents.resumeTemplateId;
  }

  let coverLetterTemplate: TemplateRecord | null = null;
  if (requested.coverLetterTemplateId !== undefined) {
    if (requested.coverLetterTemplateId !== null) {
      coverLetterTemplate = await visibleTemplate(deps, userId, requested.coverLetterTemplateId);
      if (!coverLetterTemplate) throw notFound('That cover letter template');
    }
  } else if (documents.coverLetterTemplateId) {
    coverLetterTemplate = await visibleTemplate(deps, userId, documents.coverLetterTemplateId);
  }
  return { resumeTemplateId, coverLetterTemplate };
}
