import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  BulletsRequestSchema,
  bulletsBlocker,
  CreateResumeBodySchema,
  DuplicateResumeBodySchema,
  duplicateTitle,
  effectiveTemplateId,
  IdParam,
  isEditorDocument,
  normalizeResumeDocument,
  PatchResumeBodySchema,
  readResumeImport,
  ResumeBulkDeleteBodySchema,
  ResumeCopyBatchIdSchema,
  ResumeExportQuerySchema,
  ResumeImportJsonBodySchema,
  LAYOUT_HEIGHT_TOLERANCE_PX,
  ResumeLayoutCheckBodySchema,
  ResumeListQuerySchema,
  ResumePreviewRequestSchema,
  ResumeUploadQuerySchema,
  resolveTemplateId,
  TECHNICAL_SKILLS_LAYOUTS,
  UpdateResumeBodySchema,
  type ResumeBulkDeleteResponse,
  type ResumeDocument,
  type ResumeEditTarget,
  type ResumeImportJsonResponse,
  type ResumeLayoutCheckResponse,
  type ResumePreviewResponse,
  type ResumeThumbnail,
  type ResumeUploadResponse,
} from '@tailorit/shared';
import { RENDER_ENGINE_VERSION, renderResumePreview } from '@tailorit/render';
import { requireAi, sendAccepted } from '../../ai/index';
import { requireUser, userOf } from '../../core/auth/guards';
import { nowIso, type AppDeps } from '../../core/context';
import { upgradeLegacyDocument } from '../../core/resume-upgrade';
import { contentDisposition, getFileStore, MIME_BY_KIND, withExtension } from '../../core/files/index';
import { AppError, asyncHandler, notFound, validationFailed } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { cancelResumeAnalysis, flushResumeAnalysis } from './analysis/deferred';
import { currentResumeAnalyses, resumeAnalysisBrief, resumeAnalysisView } from './analysis/store';
import { adoptableCopyTemplate, adoptCopyTask, requestBatchCopy } from './copies/store';
import { getResumeEngine } from './engine';
import { editorResumePlan, exportBuiltResume } from './export';
import { prunePhotos, withOwnPhoto } from './photos';
import {
  assertResumeEditable,
  assertRoomForResumes,
  builtMadeBy,
  defaultResumeId,
  deleteResumeRow,
  documentOf,
  findResume,
  insertResume,
  listResumeRows,
  newestEditableCopy,
  RESUME_NOT_FOUND,
  requireResume,
  toDetail,
  toSummary,
  updateResumeDocument,
  type ResumeWithFile,
} from './repository';
import { readableForImport, readUpload, UNREADABLE_TEXT } from './upload';

// Resumes: CRUD, upload and import, the live preview and thumbnails, downloads, what TailorIT read from each resume
// (GET /:id/analysis and the list's line), and the two AI tasks (an editable copy of an upload, and Write with AI).
// An editable copy of one upload starts here; those of several files uploaded together wait in the copy line
// (copies/), each one's row written with its upload. Owned by work package R1 (the analysis parts: WP3). Every query
// is scoped to the signed-in account. An upload, once stored, is kept: nothing here deletes or changes one except the
// person's own Delete (and Rename of its title).

const UPLOAD_HAS_NO_DOCUMENT =
  'An uploaded resume has no editable content. Make an editable copy of it first, then edit the copy.';
const COPY_NOT_STARTED = 'The editable copy could not be started. Try again with "Make editable copy" on the uploaded resume.';

/** Parse a task's optional template choice leniently (a query string or a JSON body). */
const ImportChoiceSchema = z.object({
  templateId: z.string().trim().max(100).optional().catch(undefined),
  layout: z.enum(TECHNICAL_SKILLS_LAYOUTS).optional().catch(undefined),
});

/**
 * The largest difference between the two sides' heights of a box both measured (CSS px, to 0.01); undefined when
 * they measured no box in common.
 */
function largestHeightDelta(editor: Readonly<Record<string, number>>, pdf: Readonly<Record<string, number>>): number | undefined {
  let largest: number | undefined;
  for (const [box, height] of Object.entries(editor)) {
    const printed = pdf[box];
    if (printed !== undefined) largest = Math.max(largest ?? 0, Math.abs(height - printed));
  }
  return largest === undefined ? undefined : Math.round(largest * 100) / 100;
}

function idOf(req: Request): string {
  return parseInput(IdParam, req.params.id, 'resume id');
}

async function detailOf(deps: AppDeps, userId: string, id: string) {
  return toDetail(deps, await requireResume(deps, userId, id), await defaultResumeId(deps, userId));
}

/** A built resume as the on-page editor opens it: an older document upgraded as it is read (nothing is stored). */
async function editorDocumentOf(deps: AppDeps, userId: string, document: ResumeDocument): Promise<ResumeDocument> {
  const engine = getResumeEngine(deps);
  return upgradeLegacyDocument(document, { templates: engine.templates, skills: await engine.skillsFor(userId) });
}

function sendFile(res: Response, file: { buffer: Buffer; mime: string; fileName: string }, inline = false): void {
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Disposition', contentDisposition(file.fileName, inline ? 'inline' : 'attachment'));
  res.setHeader('Content-Length', String(file.buffer.length));
  res.send(file.buffer);
}

/** Thumbnails of built resumes, by resume version, template, the user's skills and the engine version. */
const THUMBNAIL_CACHE_SIZE = 300;
const thumbnails = new Map<string, Extract<ResumeThumbnail, { kind: 'html' }>>();

function rememberThumbnail(key: string, value: Extract<ResumeThumbnail, { kind: 'html' }>): void {
  thumbnails.set(key, value);
  if (thumbnails.size > THUMBNAIL_CACHE_SIZE) {
    const oldest = thumbnails.keys().next().value;
    if (oldest !== undefined) thumbnails.delete(oldest);
  }
}

/**
 * Starts the `resume_import` task for an upload whose text is readable, when the account has room for the copy. When
 * the upload's copy in the copy line waits, failed or was stopped, that row follows this task (no second copy). The
 * copy starts on the template the request names; else on the one picked for its batch (a retired template's id as the
 * editor template that replaced it); else on the editor's default, so it is a resume of the on-page editor unless the
 * request itself names a retired template.
 *
 * v3.0 D2: the AI queue answers in a transaction of its own (never inside another), so the task is queued first and
 * the copy row adopts it right after. Its dedupe key (resume_import:<uploadId>) keeps the copy line from starting a
 * second copy of the same upload meanwhile: it would join this task.
 */
async function enqueueImport(deps: AppDeps, userId: string, row: ResumeWithFile, choice: z.infer<typeof ImportChoiceSchema>) {
  if (!readableForImport(row.extracted_text)) throw validationFailed(UNREADABLE_TEXT);
  await assertRoomForResumes(deps, userId, 1);
  const ai = requireAi(deps);
  const templateId = choice.templateId || resolveTemplateId(await adoptableCopyTemplate(deps, userId, row.id));
  const accepted = await ai.enqueue({
    kind: 'resume_import',
    userId,
    input: { sourceResumeId: row.id, ...(templateId ? { templateId } : {}), ...(choice.layout ? { layout: choice.layout } : {}) },
    dedupeKey: `resume_import:${row.id}`,
  });
  await adoptCopyTask(deps, userId, row.id, accepted.taskId);
  return accepted;
}

/**
 * Deletes a resume and its uploaded file; null when it is not the account's. v30 DB-JOBS (11 §5.8): an upload an
 * application was sent with keeps its file: the record's snapshot names it (uploads are kept byte for byte).
 */
async function deleteOne(deps: AppDeps, userId: string, id: string) {
  const outcome = await deleteResumeRow(deps, userId, id);
  if (outcome) {
    cancelResumeAnalysis(deps, id);
    await prunePhotos(deps, userId);
  }
  if (outcome?.fileId && !(await fileOfSentResume(deps, userId, outcome.fileId))) {
    try {
      await getFileStore(deps).remove(outcome.fileId, userId);
    } catch (error) {
      deps.log.warn(`[resumes] could not remove the file of deleted resume ${id}`, error);
    }
  }
  return outcome;
}

/** Whether an apply record's snapshot names the stored file (an upload an application was sent with). */
async function fileOfSentResume(deps: AppDeps, userId: string, fileId: string): Promise<boolean> {
  const row = await deps.db.one('SELECT 1 AS found FROM application_document_snapshots WHERE file_id = ? AND user_id = ? LIMIT 1', [fileId, userId]);
  return row !== undefined;
}

/**
 * Write with AI / Improve with AI: validates the entry, then 202 { taskId }. Also mounted at /api/ai/resume-bullets.
 * v2.0: the bullets go into a resume's document, which cannot be saved at the resume limit, so the limit refuses them
 * before any AI is spent (assertResumeEditable).
 */
export function bulletsHandler(deps: AppDeps) {
  return async (req: Request, res: Response) => {
    const body = parseInput(BulletsRequestSchema, req.body);
    const blocker = bulletsBlocker(body.kind, body.entry);
    if (blocker) throw validationFailed(blocker, { entry: blocker });
    if (body.task === 'improve' && !(body.entry.achievements ?? []).some((line) => line.trim())) {
      throw validationFailed('The entry has no bullets to improve yet. Choose Write with AI instead.', { task: 'nothing-to-improve' });
    }
    const userId = userOf(req).id;
    await assertResumeEditable(deps, userId);
    sendAccepted(res, await requireAi(deps).enqueue({ kind: 'entry_bullets', userId, input: body }));
  };
}

/** Mounted at /api/resumes. */
export function createResumesRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);

  // ------------------------------------------------------------------------------------------------- list, create

  router.get('/', async (req, res) => {
    const { source } = parseInput(ResumeListQuerySchema, req.query, 'query');
    const userId = userOf(req).id;
    const defaultId = await defaultResumeId(deps, userId);
    const rows = await listResumeRows(deps, userId, source);
    // What TailorIT read from each: at most READ_COMPUTE_LIMIT missing readings are made now, the backfill the rest.
    const readings = await currentResumeAnalyses(deps, userId, { resumeIds: rows.map((row) => row.id) });
    const now = deps.now();
    const items = rows.map((row) => {
      const reading = readings.get(row.id);
      return toSummary(deps, row, defaultId, reading ? resumeAnalysisBrief(reading, now) : null);
    });
    res.json({ items, total: items.length });
  });

  router.post('/', async (req, res) => {
    const body = parseInput(CreateResumeBodySchema, req.body);
    const userId = userOf(req).id;
    const id = await insertResume(deps, userId, {
      kind: 'built',
      title: body.title ?? null,
      document: await withOwnPhoto(deps, userId, normalizeResumeDocument(body.document)),
    });
    res.status(201).json(await detailOf(deps, userId, id));
  });

  // -------------------------------------------------------------------------------------- preview, bulk, import

  router.post('/preview', async (req, res) => {
    const body = parseInput(ResumePreviewRequestSchema, req.body);
    const userId = userOf(req).id;
    const engine = getResumeEngine(deps);
    let stored = null;
    if (body.resumeId) {
      const row = await requireResume(deps, userId, parseInput(IdParam, body.resumeId, 'resume id'));
      stored = documentOf(row);
      if (!stored) throw validationFailed(UPLOAD_HAS_NO_DOCUMENT);
    }
    const templateId = body.templateId?.trim() || null;
    if (templateId && !engine.templates.get(templateId)) {
      throw new AppError('not_found', 'That resume template was not found. Choose another template.');
    }
    const preview: ResumePreviewResponse = renderResumePreview({
      document: normalizeResumeDocument(body.document ?? {}, stored),
      templates: engine.templates,
      templateId,
      skills: await engine.skillsFor(userId),
      sample: body.sample === false ? null : engine.sample,
    });
    res.json(preview);
  });

  router.post('/bulk-delete', async (req, res) => {
    const { ids } = parseInput(ResumeBulkDeleteBodySchema, req.body);
    const userId = userOf(req).id;
    const defaultId = await defaultResumeId(deps, userId);
    let deleted = 0;
    const skippedIds: string[] = [];
    for (const id of [...new Set(ids)]) {
      if (id === defaultId) {
        skippedIds.push(id);
        continue;
      }
      if (await deleteOne(deps, userId, id)) deleted += 1;
    }
    const body: ResumeBulkDeleteResponse = { deleted, skippedIds };
    res.json(body);
  });

  // multer for the `file` field, made on first use (the file store is created by the files feature).
  let receiveFile: RequestHandler | null = null;
  const fileField: RequestHandler = (req, res, next) => {
    receiveFile ??= getFileStore(deps).uploadSingle('file');
    receiveFile(req, res, next);
  };

  router.post(
    '/upload',
    fileField,
    asyncHandler(async (req, res) => {
      const userId = userOf(req).id;
      const { parse } = parseInput(ResumeUploadQuerySchema, req.query, 'query');
      const choice = ImportChoiceSchema.parse({ templateId: req.query.templateId, layout: req.query.layout });
      // One of several files of an Upload dialog: its copy waits in the copy line instead of starting now.
      const batchId = parse ? (ResumeCopyBatchIdSchema.safeParse(req.query.batch).data ?? null) : null;
      const titleField = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 120) : '';
      const upload = req.file!;
      const store = getFileStore(deps);
      // A full account is told so before anything is stored.
      await assertRoomForResumes(deps, userId, 1);
      // The store checks the size and what the bytes are (PDF or DOCX; a .doc is refused with a hint).
      const stored = await store.save({ userId, purpose: 'resume', buffer: upload.buffer, originalName: upload.originalname });
      let reading: Awaited<ReturnType<typeof readUpload>>;
      try {
        reading = await readUpload(deps, upload.buffer, stored.kind);
      } catch (error) {
        // The reader refused the file (too large unpacked, damaged, timed out) or is busy: no resume exists yet, so
        // nothing is kept.
        await store.remove(stored.id, userId);
        throw error;
      }
      if (reading.thumbnail) {
        try {
          await store.saveThumbnail(stored.id, reading.thumbnail);
        } catch (error) {
          deps.log.warn('[resumes] could not store an upload thumbnail', error);
        }
      }
      if (reading.pageCount) await store.setPageCount(stored.id, reading.pageCount);
      let saved: { id: string; lined: boolean };
      try {
        saved = await deps.db.tx(
          async () => {
            const id = await insertResume(deps, userId, {
              kind: 'uploaded',
              title: titleField || null,
              fileId: stored.id,
              extractedText: reading.text,
            });
            // Several files: the copy waits in line, written with its upload, so a stored upload always has it.
            const lined = batchId ? await requestBatchCopy(deps, userId, id, { batchId, templateId: choice.templateId || null }) : false;
            return { id, lined };
          },
          { label: 'resume upload' },
        );
      } catch (error) {
        // Not stored as a resume (the account filled up meanwhile): its file goes too.
        await store.remove(stored.id, userId);
        throw error;
      }
      const { id } = saved;
      let taskId: string | null = null;
      let copyError: string | null = null;
      if (batchId) {
        // A copy refused when asked is a failed row of GET /api/resumes/copies; only a row not written is said here.
        if (saved.lined) deps.services.resumeCopies?.nudge();
        else copyError = COPY_NOT_STARTED;
      } else if (parse) {
        try {
          taskId = (await enqueueImport(deps, userId, await requireResume(deps, userId, id), choice)).taskId;
        } catch (error) {
          // The upload is kept either way; only the editable copy could not start (its text cannot be read, the AI is
          // busy or off, or the account has no room for the copy).
          if (!(error instanceof AppError)) deps.log.error('[resumes] could not start an editable copy', error);
          copyError = error instanceof AppError ? error.message : COPY_NOT_STARTED;
        }
      }
      const body: ResumeUploadResponse = {
        resume: toSummary(deps, await requireResume(deps, userId, id), await defaultResumeId(deps, userId)),
        taskId,
        copyError,
      };
      res.status(201).json(body);
    }),
  );

  router.post('/import-json', async (req, res) => {
    const body = parseInput(ResumeImportJsonBodySchema, req.body);
    const userId = userOf(req).id;
    const read = readResumeImport(body.data);
    if (!read.ok) throw validationFailed(read.message);
    await assertRoomForResumes(deps, userId, read.resumes.length);
    const ids = await deps.db.tx(
      async () => {
        const made: string[] = [];
        for (const resume of read.resumes) {
          const preferred = resume.document.preferredTemplate || resume.templateId || '';
          const document = preferred === resume.document.preferredTemplate ? resume.document : { ...resume.document, preferredTemplate: preferred };
          // A file's photo id is another account's (or none at all): an imported resume starts without a photo.
          made.push(await insertResume(deps, userId, { kind: 'built', title: resume.title, document: await withOwnPhoto(deps, userId, document) }));
        }
        return made;
      },
      { label: 'resume import-json' },
    );
    const defaultId = await defaultResumeId(deps, userId);
    const resumes = [];
    for (const id of ids) resumes.push(toSummary(deps, await requireResume(deps, userId, id), defaultId));
    const response: ResumeImportJsonResponse = { resumes, imported: ids.length };
    res.status(201).json(response);
  });

  router.post('/bullets', bulletsHandler(deps));

  // --------------------------------------------------------------------------------------------------- one resume

  router.get('/:id', async (req, res) => {
    res.json(await detailOf(deps, userOf(req).id, idOf(req)));
  });

  /**
   * The PDF's pages against the editor's, before a download: the answer's page count is what the PDF will have, and
   * a difference is logged (resume_layout_drift: the ids of the boxes only, never the resume's words). An older resume
   * is measured as the editor shows it and its Download prints it (`upgraded=1`), upgraded as it is read.
   */
  router.post(
    '/:id/layout',
    asyncHandler(async (req, res) => {
      const userId = userOf(req).id;
      const id = idOf(req);
      const body = parseInput(ResumeLayoutCheckBodySchema, req.body);
      const stored = documentOf(await requireResume(deps, userId, id));
      if (!stored) throw validationFailed('Only a resume of the on-page editor has its pages checked.');
      const document = await editorDocumentOf(deps, userId, stored);
      const { plan, heights } = await editorResumePlan(deps, userId, document);
      const startsOf = (flow: 'main' | 'side') => (plan.breaks[flow] ?? []).map((pageBreak) => pageBreak.before);
      const matches =
        plan.pageCount === body.pageCount &&
        JSON.stringify(startsOf('main')) === JSON.stringify(body.breaks.main) &&
        JSON.stringify(startsOf('side')) === JSON.stringify(body.breaks.side ?? []);
      const heightDelta = body.heights && largestHeightDelta(body.heights, heights);
      if (!matches) {
        deps.log.warn(
          `[resume_layout_drift] resume ${id}: the editor drew ${body.pageCount} page(s), the PDF ${plan.pageCount}; ` +
            `editor breaks ${JSON.stringify(body.breaks)}, PDF breaks ${JSON.stringify({ main: startsOf('main'), side: startsOf('side') })}`,
        );
      } else if (heightDelta !== undefined && heightDelta > LAYOUT_HEIGHT_TOLERANCE_PX) {
        deps.log.warn(`[resume_layout_drift] resume ${id}: the pages break alike, but a box differs by ${heightDelta}px`);
      }
      const answer: ResumeLayoutCheckResponse = {
        pageCount: plan.pageCount,
        matches,
        ...(heightDelta !== undefined ? { heightDelta } : {}),
      };
      res.json(answer);
    }),
  );

  /**
   * The resume as the on-page editor opens it: an older document comes upgraded (resume-upgrade.ts), with the same
   * content, and is stored by the editor's first save. Nothing is written here.
   */
  router.get('/:id/editor', async (req, res) => {
    const userId = userOf(req).id;
    const detail = await detailOf(deps, userId, idOf(req));
    if (!detail.document) throw validationFailed(UPLOAD_HAS_NO_DOCUMENT);
    res.json({ ...detail, document: await editorDocumentOf(deps, userId, detail.document) });
  });

  /** "What TailorIT read from this resume" (ResumeAnalysisView). */
  router.get('/:id/analysis', async (req, res) => {
    const id = idOf(req);
    // A reading the editor's saves are still holding back runs now, so what this shows is current.
    if (await findResume(deps, userOf(req).id, id)) await flushResumeAnalysis(deps, id);
    const view = await resumeAnalysisView(deps, userOf(req).id, id);
    if (!view) throw notFound(RESUME_NOT_FOUND);
    res.json(view);
  });

  router.put('/:id', async (req, res) => {
    const userId = userOf(req).id;
    const id = idOf(req);
    const body = parseInput(UpdateResumeBodySchema, req.body);
    const row = await requireResume(deps, userId, id);
    const stored = documentOf(row);
    if (!stored) throw validationFailed(UPLOAD_HAS_NO_DOCUMENT);
    // v2.0 (A15): at the resume limit a resume's document is not saved (its title still is, by PATCH).
    await assertResumeEditable(deps, userId);
    const document = await withOwnPhoto(deps, userId, normalizeResumeDocument(body.document, stored));
    await updateResumeDocument(deps, userId, id, document, body.title, { baseRevision: body.baseRevision });
    await prunePhotos(deps, userId);
    res.json(await detailOf(deps, userId, id));
  });

  // Rename: a title is not the document, so the resume limit never refuses it (A15).
  router.patch('/:id', async (req, res) => {
    const userId = userOf(req).id;
    const id = idOf(req);
    const { title } = parseInput(PatchResumeBodySchema, req.body);
    await requireResume(deps, userId, id);
    await deps.db.run('UPDATE resumes SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?', [title, nowIso(deps), id, userId]);
    res.json(await detailOf(deps, userId, id));
  });

  router.delete('/:id', async (req, res) => {
    const userId = userOf(req).id;
    const outcome = await deleteOne(deps, userId, idOf(req));
    if (!outcome) throw notFound('That resume');
    res.json({ deleted: true, defaultResumeId: outcome.defaultResumeId });
  });

  router.post('/:id/duplicate', async (req, res) => {
    const userId = userOf(req).id;
    const row = await requireResume(deps, userId, idOf(req));
    const { title } = parseInput(DuplicateResumeBodySchema, req.body ?? {});
    const label = toSummary(deps, row, null).label;
    const copyTitle = title ?? duplicateTitle(label);
    await assertRoomForResumes(deps, userId, 1);
    let id: string;
    if (row.kind === 'built') {
      // v1.5 W: a duplicate is the same kind of resume as its original (a tailored one stays in Tailored resumes).
      id = await insertResume(deps, userId, { kind: 'built', title: copyTitle, document: documentOf(row), madeBy: builtMadeBy(row) });
    } else {
      // A byte copy of the file and its text (the person asked for a copy); Claude's reading of the same text is
      // copied too, so it is not asked for again.
      const store = getFileStore(deps);
      if (!row.file_id) throw notFound('That resume file');
      const { file, buffer } = await store.read(row.file_id, userId);
      const copy = await store.save({ userId, purpose: 'resume', buffer, originalName: file.originalName });
      try {
        const thumbnail = await store.readThumbnail(file.id, userId);
        if (thumbnail) await store.saveThumbnail(copy.id, thumbnail);
        if (file.pageCount) await store.setPageCount(copy.id, file.pageCount);
        id = await insertResume(deps, userId, { kind: 'uploaded', title: copyTitle, fileId: copy.id, extractedText: row.extracted_text });
      } catch (error) {
        await store.remove(copy.id, userId);
        throw error;
      }
    }
    res.status(201).json(await detailOf(deps, userId, id));
  });

  router.post('/:id/parse', async (req, res) => {
    const userId = userOf(req).id;
    const row = await requireResume(deps, userId, idOf(req));
    if (row.kind !== 'uploaded') {
      throw validationFailed('Only an uploaded resume can be turned into an editable copy; this one is editable already.');
    }
    const choice = ImportChoiceSchema.parse(req.body && typeof req.body === 'object' ? req.body : {});
    sendAccepted(res, await enqueueImport(deps, userId, row, choice));
  });

  // v1.5 W (decision 3): what the web's /resumes/<id>/edit opens (ResumeEditTargetSchema). A built resume is opened as
  // it is; an upload opens its editable copy, and one with none starts it as "Make editable copy" does (enqueueImport:
  // a copy already being made, asked for alone or waiting in the copy line, is followed, never started twice). The
  // upload itself is never changed.
  router.post('/:id/edit', async (req, res) => {
    const userId = userOf(req).id;
    const row = await requireResume(deps, userId, idOf(req));
    const label = toSummary(deps, row, null).label;
    const answer = (resumeId: string | null, taskId: string | null): ResumeEditTarget => ({ kind: row.kind, label, resumeId, taskId });
    if (row.kind === 'built') {
      res.json(answer(row.id, null));
      return;
    }
    const copyId = await newestEditableCopy(deps, userId, row.id);
    if (copyId) {
      res.json(answer(copyId, null));
      return;
    }
    res.status(202).json(answer(null, (await enqueueImport(deps, userId, row, {})).taskId));
  });

  router.get('/:id/thumbnail', async (req, res) => {
    const userId = userOf(req).id;
    const row = await requireResume(deps, userId, idOf(req));
    if (row.kind === 'uploaded') {
      if (!row.file_id || !row.file_thumb) {
        throw new AppError('not_found', 'No picture of this upload could be made. Open the file to see it.');
      }
      const image: ResumeThumbnail = { kind: 'image', url: `/api/files/${encodeURIComponent(row.file_id)}/thumbnail` };
      res.json(image);
      return;
    }
    const engine = getResumeEngine(deps);
    const document = documentOf(row)!;
    if (isEditorDocument(document)) {
      // The page draws it, with the same components as the editor: the server has no layout to measure it with.
      const page: ResumeThumbnail = { kind: 'document', templateId: effectiveTemplateId(document), document };
      res.json(page);
      return;
    }
    const template = engine.templates.resolve(null, document.preferredTemplate);
    const key = [userId, row.id, row.updated_at, template?.id ?? '', await engine.skillsStamp(userId), RENDER_ENGINE_VERSION].join('|');
    let thumbnail = thumbnails.get(key);
    if (thumbnail) {
      thumbnails.delete(key);
      thumbnails.set(key, thumbnail);
    } else {
      const preview = renderResumePreview({ document, templates: engine.templates, skills: await engine.skillsFor(userId), sample: null });
      thumbnail = { kind: 'html', html: preview.html, page: preview.page };
      rememberThumbnail(key, thumbnail);
    }
    res.json(thumbnail);
  });

  router.get(
    '/:id/export',
    asyncHandler(async (req, res) => {
      const userId = userOf(req).id;
      const row = await requireResume(deps, userId, idOf(req));
      const { format, name, upgraded } = parseInput(ResumeExportQuerySchema, req.query, 'query');
      const summary = toSummary(deps, row, null);
      if (row.kind === 'uploaded') {
        // An upload downloads as itself, in its own format.
        if (!row.file_id || format === 'json' || summary.fileKind !== format) {
          const kind = summary.fileKind ? summary.fileKind.toUpperCase() : 'file';
          throw validationFailed(`This uploaded resume is a ${kind}: download the original file instead.`);
        }
        const { file, buffer } = await getFileStore(deps).read(row.file_id, userId);
        sendFile(res, { buffer, mime: file.mime, fileName: withExtension(file.originalName, file.kind) });
        return;
      }
      const stored = documentOf(row)!;
      // The editor's Download prints what the editor shows, an older resume upgraded as it is read; the JSON file is
      // the stored resume, which Import JSON reads back.
      const document = upgraded && format !== 'json' ? await editorDocumentOf(deps, userId, stored) : stored;
      const exported = await exportBuiltResume(
        deps,
        userId,
        { label: summary.label, title: summary.title, templateId: stored.preferredTemplate || null, document },
        format,
        { name },
      );
      // How long the print took, for the browser's network panel (and the perf check).
      if (exported.printMs !== undefined) res.setHeader('Server-Timing', `print;dur=${exported.printMs}`);
      sendFile(res, exported);
    }),
  );

  router.get('/:id/file', async (req, res) => {
    const userId = userOf(req).id;
    const row = await findResume(deps, userId, idOf(req));
    if (!row) throw notFound('That resume');
    if (row.kind !== 'uploaded' || !row.file_id) {
      throw new AppError('not_found', 'This resume was built in TailorIT and has no uploaded file. Download it as PDF or Word instead.');
    }
    const { file, buffer } = await getFileStore(deps).read(row.file_id, userId);
    const inline = req.query.inline === '1' && file.mime === MIME_BY_KIND.pdf;
    sendFile(res, { buffer, mime: file.mime, fileName: withExtension(file.originalName, file.kind) }, inline);
  });

  return router;
}

/** Mounted at /api/ai/resume-bullets (the route the shared contract names). */
export function createResumeBulletsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);
  router.post('/', bulletsHandler(deps));
  return router;
}
