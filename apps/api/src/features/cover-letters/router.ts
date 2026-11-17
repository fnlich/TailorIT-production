import { Router } from 'express';
import {
  CoverLetterBulkDeleteBodySchema,
  CoverLetterExportQuerySchema,
  CoverLetterListQuerySchema,
  CreateCoverLetterBodySchema,
  defaultLetterTitle,
  GenerateCoverLetterBodySchema,
  LETTER_PAGE,
  LETTER_TITLE_MIN,
  PatchCoverLetterBodySchema,
  type CoverLetterPreviewResponse,
} from '@tailorit/shared';
import { sendAccepted } from '../../ai/index';
import { requireUser, userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { getFileStore } from '../../core/files/index';
import { asyncHandler, notFound } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';
import { parseInput } from '../../core/http/validate';
import {
  applicationFacts,
  jobFacts,
  linkApplicationLetter,
  requireOwnResume,
  requireVisibleTemplate,
  type JobFacts,
} from './context';
import { letterDocument } from './document';
import { extractUploadHtml, titleFromFileName, uploadKind } from './extract';
import { letterDocx, letterPdf } from './export';
import { fontFaceCss, bundledFamilyNames, readFontFile } from './fonts';
import { generationInFlight, requireEvidence, startGeneration, type GenerateTaskInput } from './generate';
import { downloadName, DOCX_MIME, explainLetterIssue, parseBody, sendFile, uploadFile } from './http';
import { createLetterRepository, toDetail, type LetterRow } from './repository';
import { sanitizeLetterHtml } from './sanitize';

// /api/cover-letters: the Cover Letters tab, the letter editor, generation, upload/import, preview and export.
// Owner-scoped throughout: another account's letter answers 404.

const FONT_CACHE = 'public, max-age=31536000, immutable';

/** Mounted at /api/cover-letters. */
export function createCoverLettersRouter(deps: AppDeps): Router {
  const router = Router();
  const letters = createLetterRepository(deps);
  const upload = uploadFile(deps);

  // Fonts for the editor's paper (public: they are the bundled OFL files, nothing per account).
  router.get('/fonts.css', (_req, res) => {
    const css = fontFaceCss(bundledFamilyNames(), (file) => `/api/cover-letters/fonts/${file}`);
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(css);
  });
  router.get('/fonts/:file', (req, res, next) => {
    const font = readFontFile(String(req.params.file));
    if (!font) return next(notFound('That font'));
    res.setHeader('Content-Type', 'font/woff2');
    res.setHeader('Cache-Control', FONT_CACHE);
    res.end(font);
  });

  router.use(requireUser);

  router.get('/', async (req, res) => {
    const { q } = parseInput(CoverLetterListQuerySchema, req.query, 'search');
    const items = await letters.list(userOf(req).id, q);
    res.json({ items, total: items.length });
  });

  router.post('/', async (req, res) => {
    const user = userOf(req);
    const body = parseBody(CreateCoverLetterBodySchema, req.body);
    let facts: JobFacts | null = null;
    if (body.applicationId) facts = await applicationFacts(deps, user.id, body.applicationId);
    else if (body.jobId !== undefined) facts = await jobFacts(deps, body.jobId, user.id);
    const template = body.templateId ? await requireVisibleTemplate(deps, user.id, body.templateId) : null;
    const row = await letters.create(user.id, {
      title: defaultLetterTitle(deps.now()),
      origin: 'blank',
      applicationId: facts?.applicationId ?? null,
      jobId: facts?.jobId ?? null,
      companyName: facts?.companyName ?? '',
      jobTitle: facts?.jobTitle ?? '',
      jobDescription: facts?.jobDescription ?? '',
      templateId: template?.id ?? null,
      ...(template ? { fontFamily: template.fontFamily } : {}),
    });
    if (facts?.applicationId) await linkApplicationLetter(deps, user.id, facts.applicationId, row.id);
    res.status(201).json(toDetail(row));
  });

  router.post('/bulk-delete', async (req, res) => {
    const user = userOf(req);
    const { ids } = parseBody(CoverLetterBulkDeleteBodySchema, req.body);
    const removed = await letters.removeMany(ids, user.id);
    for (const row of removed) await forgetFile(row, user.id);
    res.json({ deleted: removed.length });
  });

  router.post(
    '/upload',
    upload,
    asyncHandler(async (req, res) => {
      const user = userOf(req);
      const file = req.file!;
      uploadKind(file.buffer);
      const { html } = await extractUploadHtml(file.buffer);
      const stored = await getFileStore(deps).save({
        userId: user.id,
        purpose: 'letter_import',
        buffer: file.buffer,
        originalName: file.originalname,
      });
      const fromName = titleFromFileName(file.originalname);
      const row = await letters.create(user.id, {
        title: fromName.length >= LETTER_TITLE_MIN ? fromName : defaultLetterTitle(deps.now()),
        origin: 'uploaded',
        contentHtml: sanitizeLetterHtml(html),
        fileId: stored.id,
      });
      res.status(201).json(toDetail(row));
    }),
  );

  router.get('/:id', async (req, res) => {
    res.json(toDetail(await letters.require(req.params.id!, userOf(req).id)));
  });

  router.patch('/:id', async (req, res) => {
    const user = userOf(req);
    const current = await letters.require(req.params.id!, user.id);
    const body = parseBody(PatchCoverLetterBodySchema, req.body, explainLetterIssue);
    if (body.templateId) await requireVisibleTemplate(deps, user.id, body.templateId);
    if (body.resumeId) await requireOwnResume(deps, user.id, body.resumeId);
    if (body.applicationId) await applicationFacts(deps, user.id, body.applicationId);

    const contentHtml = body.contentHtml === undefined ? undefined : sanitizeLetterHtml(body.contentHtml);
    const contentChanged = contentHtml !== undefined && contentHtml !== current.content_html;
    const fontChanged = body.fontFamily !== undefined && body.fontFamily !== current.font_family;
    const row = await letters.update(current.id, user.id, {
      title: body.title,
      contentHtml: contentChanged ? contentHtml : undefined,
      fontFamily: body.fontFamily,
      companyName: body.companyName,
      jobTitle: body.jobTitle,
      jobDescription: body.jobDescription,
      customPrompt: body.customPrompt,
      templateId: body.templateId,
      resumeId: body.resumeId,
      applicationId: body.applicationId,
      edited: contentChanged || fontChanged,
    });
    res.json(toDetail(row));
  });

  router.delete('/:id', async (req, res) => {
    const user = userOf(req);
    const row = await letters.remove(req.params.id!, user.id);
    if (!row) throw notFound('That cover letter');
    await forgetFile(row, user.id);
    res.status(204).end();
  });

  router.post(
    '/:id/import',
    upload,
    asyncHandler(async (req, res) => {
      const user = userOf(req);
      const current = await letters.require(req.params.id!, user.id);
      const file = req.file!;
      uploadKind(file.buffer);
      const { html } = await extractUploadHtml(file.buffer);
      const stored = await getFileStore(deps).save({
        userId: user.id,
        purpose: 'letter_import',
        buffer: file.buffer,
        originalName: file.originalname,
      });
      const row = await letters.update(current.id, user.id, {
        contentHtml: sanitizeLetterHtml(html),
        origin: 'uploaded',
        fileId: stored.id,
        edited: true,
      });
      await forgetFile(current, user.id);
      res.json(toDetail(row));
    }),
  );

  router.post('/:id/generate', async (req, res) => {
    const user = userOf(req);
    const letter = await letters.require(req.params.id!, user.id);
    const body = parseBody(GenerateCoverLetterBodySchema, req.body, explainLetterIssue);
    const template = body.templateId ? await requireVisibleTemplate(deps, user.id, body.templateId) : null;
    // Checked now so the dialog can say so at once; the task checks again when it runs.
    await requireEvidence(deps, user.id, body.resumeId);
    // Being written already (the extension's ask, or a Generate before): that writing would not be what the dialog
    // chose, so nothing here changes the letter (409 MSG_LETTER_BEING_WRITTEN).
    if (await generationInFlight(deps, user.id, letter.id)) throw refuse(deps, 'conflict', 'MSG_LETTER_BEING_WRITTEN');

    // The dialog's fields stay on the letter, so reopening it (or a failed run) keeps what was typed.
    await letters.update(letter.id, user.id, {
      companyName: body.companyName,
      jobTitle: body.jobTitle,
      jobDescription: body.jobDescription,
      customPrompt: body.customPrompt,
      templateId: template?.id ?? null,
    });

    const input: GenerateTaskInput = {
      letterId: letter.id,
      companyName: body.companyName,
      jobTitle: body.jobTitle,
      jobDescription: body.jobDescription,
      templateId: template?.id ?? null,
      customPrompt: body.customPrompt,
      resumeId: body.resumeId ?? null,
    };
    sendAccepted(res, await startGeneration(deps, user.id, input, template));
  });

  router.get('/:id/preview', async (req, res) => {
    const row = await letters.require(req.params.id!, userOf(req).id);
    const body: CoverLetterPreviewResponse = {
      html: letterDocument({ contentHtml: row.content_html, fontFamily: row.font_family, title: row.title, mode: 'preview' }),
      page: { widthPx: LETTER_PAGE.widthPx, heightPx: LETTER_PAGE.heightPx },
    };
    res.json(body);
  });

  router.get(
    '/:id/export',
    asyncHandler(async (req, res) => {
      const row = await letters.require(req.params.id!, userOf(req).id);
      const { format } = parseInput(CoverLetterExportQuerySchema, req.query, 'export');
      const printable = { title: row.title, contentHtml: row.content_html, fontFamily: row.font_family };
      if (format === 'docx') {
        sendFile(res, await letterDocx(printable), downloadName(row.title, 'docx', 'Cover Letter'), DOCX_MIME);
      } else {
        sendFile(res, await letterPdf(deps, printable), downloadName(row.title, 'pdf', 'Cover Letter'), 'application/pdf');
      }
    }),
  );

  /** A deleted or replaced letter's stored upload goes with it. */
  async function forgetFile(row: LetterRow, userId: string): Promise<void> {
    if (!row.file_id) return;
    try {
      await getFileStore(deps).remove(row.file_id, userId);
    } catch (error) {
      deps.log.warn(`[cover-letters] could not delete stored file ${row.file_id}`, error);
    }
  }

  return router;
}
