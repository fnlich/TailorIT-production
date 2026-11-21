import { resumeDownloadFileName } from '@tailorit/shared';
import {
  AUTOFILL_RESUME_MAX_BYTES,
  type AutofillFileKind,
  type AutofillResumeItem,
  type AutofillResumeList,
} from '@tailorit/shared/autofill';
import type { AppDeps } from '../../core/context';
import { getFileStore, kindOfMime, withExtension } from '../../core/files/index';
import { notFound } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';
import { exportBuiltResume } from '../resumes/export';
import {
  defaultResumeId,
  documentOf,
  findResume,
  listResumeRows,
  RESUME_NOT_FOUND,
  toSummary,
  type ResumeListRow,
} from '../resumes/repository';

// The resumes the extension may attach to an application, and the file it uploads into the form. A built resume is
// printed exactly as the Download button prints it (exportBuiltResume, a PDF); an upload is sent as it was uploaded,
// byte for byte, never converted (a Word file stays a Word file: the extension checks the form's `accept` first).
// Labels follow the Resumes tab's rule (toSummary). Nothing is cached, here or in the browser (no-store on /api).

/** v30 ST3: the refusal of a file over AUTOFILL_RESUME_MAX_BYTES, the constant MSG_AUTOFILL_RESUME_TOO_LARGE. */
const tooLarge = (deps: AppDeps) =>
  refuse(deps, 'file_too_large', 'MSG_AUTOFILL_RESUME_TOO_LARGE', { max_mb: AUTOFILL_RESUME_MAX_BYTES / (1024 * 1024) });

/**
 * What the extension may attach of a resume: a built one as the PDF Download prints, named as Download names it; an
 * upload as its own file. Null for an upload whose file is gone (nothing to attach).
 */
export function attachableResume(deps: AppDeps, row: ResumeListRow, defaultId: string | null): AutofillResumeItem | null {
  const summary = toSummary(deps, row, defaultId);
  const item = {
    id: row.id,
    label: summary.label,
    kind: row.kind,
    isDefault: summary.isDefault,
    updatedAt: row.updated_at,
    // v1.5 W: the folder the extension's resume list files it in (Tailored ones by the day they were made).
    madeBy: summary.madeBy,
    createdAt: row.created_at,
  };
  if (row.kind === 'built') {
    // exportBuiltResume's name: the person's name (v33 LEGACY: an older resume prints as the editor shows it, too).
    const fileName = resumeDownloadFileName({ name: summary.nameOnResume }, 'pdf');
    return { ...item, fileKind: 'pdf', fileName };
  }
  const kind = row.file_id && row.file_mime ? kindOfMime(row.file_mime) : null;
  return kind ? { ...item, fileKind: kind, fileName: withExtension(row.file_name ?? 'resume', kind) } : null;
}

/** GET /resumes: every resume the extension may attach, most recently updated first, and which is the default. */
export async function listAttachableResumes(deps: AppDeps, userId: string): Promise<AutofillResumeList> {
  const defaultId = await defaultResumeId(deps, userId);
  const items = (await listResumeRows(deps, userId, 'all'))
    .map((row) => attachableResume(deps, row, defaultId))
    .filter((item): item is AutofillResumeItem => item !== null);
  return { items, defaultResumeId: items.some((item) => item.id === defaultId) ? defaultId : null };
}

/** One of the account's resumes, when the extension may attach it; null otherwise (another account's included). */
export async function findAttachableResume(deps: AppDeps, userId: string, id: string | null): Promise<AutofillResumeItem | null> {
  const row = id ? await findResume(deps, userId, id) : null;
  return row ? attachableResume(deps, row, await defaultResumeId(deps, userId)) : null;
}

/** The most recently updated resume the extension may attach, or null. */
export async function latestAttachableResume(deps: AppDeps, userId: string): Promise<AutofillResumeItem | null> {
  const row = await deps.db.one<{ id: string }>(
    `SELECT r.id FROM resumes r LEFT JOIN stored_files f ON f.id = r.file_id AND f.user_id = r.user_id
     WHERE r.user_id = ? AND (r.kind = 'built' OR f.id IS NOT NULL)
     ORDER BY r.updated_at DESC, r.created_at DESC, r.id ASC LIMIT 1`,
    [userId],
  );
  return row ? findAttachableResume(deps, userId, row.id) : null;
}

export interface AttachedFile {
  buffer: Buffer;
  kind: AutofillFileKind;
  fileName: string;
  /** A built resume: how long its print took (ms). */
  printMs: number | null;
}

/**
 * GET /resumes/:id/file: the bytes the extension uploads. 404 for another account's resume or an upload whose file is
 * gone, 413 `file_too_large` above AUTOFILL_RESUME_MAX_BYTES; a print refused by Chrome is its 503 or 500.
 */
export async function resumeFileOf(deps: AppDeps, userId: string, id: string): Promise<AttachedFile> {
  const row = await findResume(deps, userId, id);
  if (!row) throw notFound(RESUME_NOT_FOUND);
  let file: AttachedFile;
  if (row.kind === 'uploaded') {
    const kind = row.file_id && row.file_mime ? kindOfMime(row.file_mime) : null;
    if (!row.file_id || !kind) throw notFound("That resume's file");
    // Refused before its bytes are read.
    if ((row.file_size ?? 0) > AUTOFILL_RESUME_MAX_BYTES) throw tooLarge(deps);
    const stored = await getFileStore(deps).read(row.file_id, userId);
    file = { buffer: stored.buffer, kind, fileName: withExtension(stored.file.originalName, kind), printMs: null };
  } else {
    // Exactly as GET /api/resumes/:id/export?format=pdf prints it.
    const document = documentOf(row)!;
    const summary = toSummary(deps, row, null);
    const started = performance.now();
    const printed = await exportBuiltResume(
      deps,
      userId,
      { label: summary.label, title: summary.title, templateId: document.preferredTemplate || null, document },
      'pdf',
    );
    const printMs = printed.printMs ?? Math.round(performance.now() - started);
    file = { buffer: printed.buffer, kind: 'pdf', fileName: printed.fileName, printMs };
  }
  if (file.buffer.length > AUTOFILL_RESUME_MAX_BYTES) throw tooLarge(deps);
  return file;
}
