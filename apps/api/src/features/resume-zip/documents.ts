import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppDeps } from '../../core/context';
import { AppError } from '../../core/http/errors';
import { getResumeEngine } from '../resumes/engine';
import {
  ALL_FAILED,
  BUILT_RESUME_ESTIMATE_BYTES,
  loadResumes,
  missingFile,
  notMade,
  renderBuilt,
  resumeFacts,
  writeZip,
  ZIP_FILE,
  zipTooLarge,
  type Outcome,
  type ZipBuildOptions,
  type ZipBuildResult,
  type ZipEntryPlan,
  type ZipResume,
  type ZipSource,
} from './build';
import { documentFileName, documentsSkippedText, needsDocumentsReport, planDocumentFolders } from './zipNames';

// v20 P10 (DECISIONS A28): Documents › Resumes' batch download, the resume ZIP's "documents" source. The selected
// resumes (each the account's own) go in at "<shown name>/<First>_<Last>_resume.pdf", in the selection's order:
// - <shown name> is the resume's label as Documents shows it now, made safe, with " (2)", " (3)" for a repeat;
// - <First>_<Last> is personFileStem of the name on that resume, else of the account's name;
// - built resumes (edited and tailored ones too) are rendered to PDF once each, through the shared Chrome pool, or as
//   Word files when Chrome is missing, busy or failing (SKIPPED.txt names them);
// - uploads are never changed: a PDF goes in byte for byte, a Word upload as its original file with its own extension
//   (`…_resume.docx`), which SKIPPED.txt names.
// The registry (./registry.ts) runs it in the background, with the Tracker zip's limits, poll and download.

const SOME_NOT_FOUND = 'Some of those resumes were not found. Refresh Documents and try again.';
const ALL_GONE = 'Those resumes were deleted while the zip was being built. Refresh Documents and try again.';
const ALL_MISSING = 'The files of these uploaded resumes are missing. Upload them again in Documents.';

/**
 * What a request is answered at once, from stored data only: every id must be one of the account's resumes (404 when
 * one is not: another account's resume is "not found" exactly like one that never existed), and the size added up from
 * the uploads' sizes and an estimate per built resume must stay under the cap (413). Answers the ids, in order.
 */
export async function prepareDocumentsZip(
  deps: AppDeps,
  userId: string,
  resumeIds: readonly string[],
  maxBytes: number,
): Promise<string[]> {
  const facts = await resumeFacts(deps.db, userId);
  let bytes = 0;
  for (const id of resumeIds) {
    const fact = facts.byId.get(id);
    if (!fact) throw new AppError('not_found', SOME_NOT_FOUND);
    bytes += fact.kind === 'uploaded' ? (fact.fileBytes ?? 0) : BUILT_RESUME_ESTIMATE_BYTES;
  }
  if (bytes > maxBytes) throw zipTooLarge(deps, maxBytes, 'resumes');
  return [...resumeIds];
}

export interface DocumentsBuildInput {
  userId: string;
  /** The selection, in its order (from `prepareDocumentsZip`). */
  resumeIds: readonly string[];
  /** The person's offset east of UTC: the entries' times are their local time. */
  tzOffsetMinutes: number;
  /** The build's own folder (created here; the caller removes it). */
  dir: string;
  /** Stops the build (the deadline, a shutdown). */
  signal: AbortSignal;
  /** Date.now() past which the build is stopped (the PDF reserve is counted from it). */
  deadlineAt: number;
  progress: { setTotal(total: number): void; advance(count: number): void };
}

/** Builds the batch download's zip into `input.dir`. Throws an AppError with the sentence to show, or the signal's reason. */
export async function buildDocumentsZip(
  deps: AppDeps,
  input: DocumentsBuildInput,
  options: ZipBuildOptions,
): Promise<ZipBuildResult> {
  const { userId, signal } = input;
  await mkdir(input.dir, { recursive: true });
  getResumeEngine(deps);
  input.progress.setTotal(input.resumeIds.length);

  // The resumes as they are now: one deleted since the request is left out, and SKIPPED.txt counts it.
  const facts = await resumeFacts(deps.db, userId);
  const uses = new Map(input.resumeIds.filter((id) => facts.byId.has(id)).map((id) => [id, 1] as const));
  const resumes = await loadResumes(deps, userId, uses, facts.fallbackIsDefault ? facts.fallbackId : null, signal);
  const gone = input.resumeIds.filter((id) => !resumes.has(id)).length;
  if (gone > 0) input.progress.advance(gone);
  if (resumes.size === 0) throw new AppError('not_found', ALL_GONE);

  // Uploads: their stored files as they are, never read into memory here.
  const outcomes = new Map<string, Outcome>();
  for (const resume of resumes.values()) {
    if (resume.kind !== 'uploaded') continue;
    signal.throwIfAborted();
    const upload = resume.upload;
    const present = upload ? await stat(upload.path).then((info) => info.isFile(), () => false) : false;
    outcomes.set(
      resume.id,
      upload && present ? { source: upload, word: false } : { failed: 'missing', reason: missingFile(resume.label) },
    );
    input.progress.advance(1);
  }
  // Built resumes: a PDF each (a Word file when no PDF can be made).
  const built = [...resumes.values()].filter((resume) => resume.kind === 'built');
  const rendered = await renderBuilt(deps, userId, built, {
    dir: input.dir,
    signal,
    deadlineAt: input.deadlineAt,
    options,
    onDone: () => input.progress.advance(1),
  });
  for (const [id, outcome] of rendered) outcomes.set(id, outcome);

  // The entries, in the selection's order.
  const included: Array<{ resume: ZipResume; source: ZipSource; word: boolean }> = [];
  const skipped: Array<{ label: string; reason: string }> = [];
  for (const id of input.resumeIds) {
    const resume = resumes.get(id);
    if (!resume) continue;
    const outcome = outcomes.get(id);
    if (outcome && 'source' in outcome) included.push({ resume, source: outcome.source, word: outcome.word });
    else skipped.push({ label: resume.label, reason: outcome && 'failed' in outcome ? outcome.reason : notMade(resume.label) });
  }
  if (included.length === 0) {
    const allMissing = [...outcomes.values()].every((outcome) => 'failed' in outcome && outcome.failed === 'missing');
    throw allMissing ? new AppError('not_found', ALL_MISSING) : new AppError('render_failed', ALL_FAILED);
  }

  const folders = planDocumentFolders(included.map(({ resume }) => ({ id: resume.id, shownName: resume.label })));
  const entries: Array<ZipEntryPlan & { resume: ZipResume; word: boolean }> = included.map(({ resume, source, word }) => ({
    path: `${folders.get(resume.id)!}/${documentFileName(resume.stem, source.extension)}`,
    source,
    resume,
    word,
  }));
  const report = {
    skipped,
    gone,
    uploadedOriginals: entries
      .filter((entry) => entry.resume.kind === 'uploaded' && entry.source.extension !== 'pdf')
      .map((entry) => entry.path),
    builtAsWord: entries.filter((entry) => entry.word).map((entry) => entry.path),
  };

  const file = join(input.dir, ZIP_FILE);
  // jszip writes each entry's time from the date's UTC fields: shifted by the offset, they read as local time.
  const date = new Date(deps.now().getTime() + input.tzOffsetMinutes * 60_000);
  await writeZip(file, entries, needsDocumentsReport(report) ? documentsSkippedText(report) : null, date, signal);
  // The rendered files are in the zip now; only the zip stays until it is downloaded.
  await Promise.all(
    [...rendered.values()].map((outcome) => ('source' in outcome ? rm(outcome.source.path, { force: true }) : undefined)),
  );
  const { size } = await stat(file);
  return {
    file,
    size,
    counts: {
      included: included.length,
      skipped: skipped.length + gone,
      word: report.builtAsWord.length,
      leftOut: 0,
      usedDefault: 0,
    },
  };
}
