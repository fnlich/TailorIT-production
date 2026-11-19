import { normalizeResumeDocument, type ResumeDocument } from '@tailorit/shared';
import type { AiTaskContext } from '../../../ai/index';
import { AiError } from '../../../ai/errors';
import { createResultCache, itemHash } from '../../../ai/resultCache';
import { resumeImportPrompt } from '../../../ai/prompts/resumes/resume-import';
import type { AppDeps } from '../../../core/context';
import { AppError } from '../../../core/http/errors';
import { MAX_EXTRACTED_TEXT, readableForImport, UNREADABLE_TEXT } from '../upload';
import { hasImportedContent, importedDocument, NO_RESUME_CONTENT } from './resumeImport';

// v3.2 FILL: an uploaded file read by the AI without making a resume of it ("Fill from my resume" on an upload). The
// `resume_import` task runs it when its input says `readOnly` (resumes/tasks.ts): the same prompt as "Make an editable
// copy" (copy, never infer) reads the upload's stored text into a resume document, which is kept in the account's
// result cache (ai/resultCache.ts, 30 days, scoped to the account and gone with it) under a hash of that text, so the
// same file is read once. No resume is made and the upload is never changed: its text is only read. What the reading
// may be used for, and how it is checked against the text, is the reader's business (autofill/profile/seed.ts).
// v32 FIX-API (REV-SECBEH SF-2, SF-3): a reading that finds no resume in the file is kept too ({ empty: true }: an
// answer with no resume content, or one that is no resume document at all), so the file is read (and charged) once
// whatever it holds; a failure of the AI itself (unavailable, a timeout) keeps nothing. Deleting the upload deletes its
// reading (forgetUploadReading).

/** Bump to read every upload again (the reading's own shape or meaning changed, not the prompt's: that is its version). */
const UPLOAD_READING_REVISION = 1;

/** The cache key of an account's upload readings: the import prompt's kind, model and version, the account alone. */
function readingKey(deps: Pick<AppDeps, 'config'>, userId: string) {
  return {
    kind: 'resume_import' as const,
    model: deps.config.ai.features.resume_import.model,
    version: resumeImportPrompt.version,
    scope: { userId },
  };
}

/** What a reading is kept under: the text as the prompt reads it (the stored text, cut as the import cuts it). */
const readingHash = (text: string) =>
  itemHash({ reading: 'upload-document', revision: UPLOAD_READING_REVISION, text: text.slice(0, MAX_EXTRACTED_TEXT) });

/** v32 FIX-API (SF-2): what the AI read of an upload: a resume document, or no resume at all (`empty`). */
export type UploadReading = { kind: 'read'; document: ResumeDocument } | { kind: 'empty' };

/** The kept reading of a file that holds no resume (SF-2). */
const EMPTY_READING = { empty: true } as const;

/** v32 FIX-API (SF-2): the AI's reading of this upload text for the account, when it has one (null otherwise). */
export async function uploadReadingOf(
  deps: Pick<AppDeps, 'config' | 'db' | 'now'>,
  userId: string,
  text: string,
): Promise<UploadReading | null> {
  const hash = readingHash(text);
  const found = await createResultCache(deps.db, deps.now).getMany<unknown>(readingKey(deps, userId), [hash]);
  if (!found.has(hash)) return null;
  const value = found.get(hash);
  if (value && typeof value === 'object' && (value as { empty?: unknown }).empty === true) return { kind: 'empty' };
  return { kind: 'read', document: normalizeResumeDocument(value) };
}

/** The AI's reading of this upload text for the account, when it has one with a resume in it (null otherwise). */
export async function cachedUploadReading(
  deps: Pick<AppDeps, 'config' | 'db' | 'now'>,
  userId: string,
  text: string,
): Promise<ResumeDocument | null> {
  const reading = await uploadReadingOf(deps, userId, text);
  return reading?.kind === 'read' ? reading.document : null;
}

/**
 * v32 FIX-API (REV-SECBEH SF-3): forgets the account's readings of an upload's text (every model and prompt version),
 * once no other upload of the account has the same text: the upload was deleted, so is the AI's copy of what it says.
 */
export async function forgetUploadReading(deps: Pick<AppDeps, 'db'>, userId: string, text: string | null): Promise<number> {
  if (!text) return 0;
  const twin = await deps.db.one("SELECT 1 FROM resumes WHERE user_id = ? AND kind = 'uploaded' AND extracted_text = ? LIMIT 1", [userId, text]);
  if (twin) return 0;
  const { changes } = await deps.db.run("DELETE FROM ai_result_cache WHERE kind = 'resume_import' AND user_id = ? AND item_hash = ?", [
    userId,
    readingHash(text),
  ]);
  return changes;
}

/** The dedupe key of an upload's reading: one task per upload at a time, never the editable copy's (resume_import:<id>). */
export const uploadReadingDedupeKey = (uploadId: string) => `resume_import:reading:${uploadId}`;

/** The `resume_import` task's result for a reading: nothing of the resume (the reading itself is in the cache). */
export interface UploadReadingResult {
  read: true;
}

/**
 * The `resume_import` task with `readOnly` (resumes/tasks.ts): reads the upload's stored text with the import prompt and
 * keeps the document for the account. Refused before any AI call when the upload is gone or its text cannot be read;
 * a reading with no resume content in it fails the task (ai_failed), as the copy does.
 */
export async function runUploadReading(
  deps: AppDeps,
  input: { sourceResumeId: string },
  ctx: AiTaskContext,
): Promise<UploadReadingResult> {
  const userId = ctx.userId;
  if (!userId) throw new AppError('forbidden', 'A resume reading needs an account.');
  const upload = await deps.db.one<{ extracted_text: string | null }>(
    "SELECT extracted_text FROM resumes WHERE id = ? AND user_id = ? AND kind = 'uploaded'",
    [input.sourceResumeId, userId],
  );
  if (!upload) throw new AppError('not_found', 'The uploaded resume was deleted before it could be read.');
  const text = (upload.extracted_text ?? '').slice(0, MAX_EXTRACTED_TEXT);
  if (!readableForImport(text)) throw new AppError('validation_failed', UNREADABLE_TEXT);
  if (await uploadReadingOf(deps, userId, text)) return { read: true };
  const keepEmpty = () => createResultCache(deps.db, deps.now).putMany(readingKey(deps, userId), [[readingHash(text), EMPTY_READING]]);
  let answer;
  try {
    answer = await ctx.runPrompt(resumeImportPrompt, { text });
  } catch (error) {
    // SF-2: the model answered, but no resume ("Sorry, there is no resume here."): kept, as an empty reading is.
    if (error instanceof AiError && error.kind === 'malformed') await keepEmpty();
    throw error;
  }
  const document = importedDocument(answer);
  if (!hasImportedContent(document)) {
    // SF-2: kept as it is, so the file is not read (and charged) again at every Fill.
    await keepEmpty();
    throw new AppError('ai_failed', NO_RESUME_CONTENT);
  }
  await createResultCache(deps.db, deps.now).putMany(readingKey(deps, userId), [[readingHash(text), document]]);
  return { read: true };
}
