import { Router } from 'express';
import {
  AI_PROMPT_MAX,
  CoverLetterExportQuerySchema,
  CreateLetterTemplateBodySchema,
  defaultTemplateName,
  duplicateTemplateName,
  DuplicateLetterTemplateBodySchema,
  LETTER_PAGE,
  LetterTemplateBulkDeleteBodySchema,
  PatchLetterTemplateBodySchema,
  TEMPLATE_NAME_MAX,
  TEMPLATE_NAME_MIN,
  validateTemplateName,
  type CoverLetterPreviewResponse,
} from '@tailorit/shared';
import type { z } from 'zod';
import { requireUser, userOf } from '../../core/auth/guards';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { asyncHandler } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { letterDocument } from '../cover-letters/document';
import { extractUploadHtml, titleFromFileName, uploadKind } from '../cover-letters/extract';
import { letterDocx, letterPdf } from '../cover-letters/export';
import { CONTENT_TOO_LONG, downloadName, DOCX_MIME, parseBody, sendFile, uploadFile } from '../cover-letters/http';
import { sanitizeLetterHtml } from '../cover-letters/sanitize';
import { createTemplateRepository, toTemplateDetail, toTemplateSummary } from './repository';

// /api/cover-letter-templates: the Templates tab and the template editor. System templates are visible to everyone
// and read-only (403 system_template_read_only); Duplicate makes an editable copy.

/** A name past TEMPLATE_NAME_MAX is refused in the shared rename rule's own words (validateTemplateName's). */
const NAME_TOO_LONG = validateTemplateName('x'.repeat(TEMPLATE_NAME_MAX + 1)) ?? undefined;

/**
 * The exact sentences the editor shows. v30 ST1: the AI prompt's cap is MSG_TEMPLATE_AI_PROMPT_TOO_LONG (its number as
 * the editor writes it, "1,000"), read when the request is refused.
 */
function explainer(deps: AppDeps) {
  return (issue: z.core.$ZodIssue, key: string): string | undefined => {
    if (key === 'aiPrompt' && issue.code === 'too_big') {
      return constantsOf(deps).message('MSG_TEMPLATE_AI_PROMPT_TOO_LONG', { max: AI_PROMPT_MAX.toLocaleString('en-US') });
    }
    if (key === 'name' && issue.code === 'too_big') return NAME_TOO_LONG;
    if (key === 'contentHtml' && issue.code === 'too_big') return CONTENT_TOO_LONG;
    return undefined;
  };
}

/** Mounted at /api/cover-letter-templates. */
export function createCoverLetterTemplatesRouter(deps: AppDeps): Router {
  const router = Router();
  const templates = createTemplateRepository(deps);
  const upload = uploadFile(deps);
  const explain = explainer(deps);

  router.use(requireUser);

  router.get('/', async (req, res) => {
    const items = (await templates.list(userOf(req).id)).map(toTemplateSummary);
    res.json({ items, total: items.length });
  });

  router.post('/', async (req, res) => {
    const user = userOf(req);
    const body = parseBody(CreateLetterTemplateBodySchema, req.body, explain);
    const row = await templates.create(user.id, {
      name: body.name ?? defaultTemplateName(deps.now()),
      origin: 'blank',
      contentHtml: body.contentHtml === undefined ? '' : sanitizeLetterHtml(body.contentHtml),
      fontFamily: body.fontFamily,
      aiPrompt: body.aiPrompt,
    });
    res.status(201).json(toTemplateDetail(row));
  });

  router.post('/bulk-delete', async (req, res) => {
    const { ids } = parseBody(LetterTemplateBulkDeleteBodySchema, req.body);
    res.json(await templates.removeMany(ids, userOf(req).id));
  });

  router.post(
    '/upload',
    upload,
    asyncHandler(async (req, res) => {
      const user = userOf(req);
      const file = req.file!;
      uploadKind(file.buffer);
      const { html } = await extractUploadHtml(file.buffer);
      const fromName = titleFromFileName(file.originalname);
      const row = await templates.create(user.id, {
        name: fromName.length >= TEMPLATE_NAME_MIN ? fromName : defaultTemplateName(deps.now()),
        origin: 'uploaded',
        contentHtml: sanitizeLetterHtml(html),
      });
      res.status(201).json(toTemplateDetail(row));
    }),
  );

  router.get('/:id', async (req, res) => {
    res.json(toTemplateDetail(await templates.requireVisible(req.params.id!, userOf(req).id)));
  });

  router.patch('/:id', async (req, res) => {
    const user = userOf(req);
    const current = await templates.requireOwn(req.params.id!, user.id);
    const body = parseBody(PatchLetterTemplateBodySchema, req.body, explain);
    const contentHtml = body.contentHtml === undefined ? undefined : sanitizeLetterHtml(body.contentHtml);
    const contentChanged = contentHtml !== undefined && contentHtml !== current.content_html;
    const fontChanged = body.fontFamily !== undefined && body.fontFamily !== current.font_family;
    const row = await templates.update(current.id, user.id, {
      name: body.name,
      contentHtml: contentChanged ? contentHtml : undefined,
      fontFamily: body.fontFamily,
      aiPrompt: body.aiPrompt,
      edited: contentChanged || fontChanged,
    });
    res.json(toTemplateDetail(row));
  });

  router.delete('/:id', async (req, res) => {
    await templates.remove(req.params.id!, userOf(req).id);
    res.status(204).end();
  });

  router.post('/:id/duplicate', async (req, res) => {
    const user = userOf(req);
    const source = await templates.requireVisible(req.params.id!, user.id);
    const body = parseBody(DuplicateLetterTemplateBodySchema, req.body, explain);
    const row = await templates.create(user.id, {
      name: body.name ?? duplicateTemplateName(source.name).slice(0, TEMPLATE_NAME_MAX),
      origin: 'duplicated',
      contentHtml: source.content_html,
      fontFamily: source.font_family,
      aiPrompt: source.ai_prompt,
    });
    res.status(201).json(toTemplateDetail(row));
  });

  router.post(
    '/:id/import',
    upload,
    asyncHandler(async (req, res) => {
      const user = userOf(req);
      const current = await templates.requireOwn(req.params.id!, user.id);
      const file = req.file!;
      uploadKind(file.buffer);
      const { html } = await extractUploadHtml(file.buffer);
      const row = await templates.update(current.id, user.id, { contentHtml: sanitizeLetterHtml(html), edited: true });
      res.json(toTemplateDetail(row));
    }),
  );

  router.get('/:id/preview', async (req, res) => {
    const row = await templates.requireVisible(req.params.id!, userOf(req).id);
    const body: CoverLetterPreviewResponse = {
      html: letterDocument({ contentHtml: row.content_html, fontFamily: row.font_family, title: row.name, mode: 'preview' }),
      page: { widthPx: LETTER_PAGE.widthPx, heightPx: LETTER_PAGE.heightPx },
    };
    res.json(body);
  });

  router.get(
    '/:id/export',
    asyncHandler(async (req, res) => {
      const row = await templates.requireVisible(req.params.id!, userOf(req).id);
      const { format } = parseInput(CoverLetterExportQuerySchema, req.query, 'export');
      const printable = { title: row.name, contentHtml: row.content_html, fontFamily: row.font_family };
      if (format === 'docx') {
        sendFile(res, await letterDocx(printable), downloadName(row.name, 'docx', 'Template'), DOCX_MIME);
      } else {
        sendFile(res, await letterPdf(deps, printable), downloadName(row.name, 'pdf', 'Template'), 'application/pdf');
      }
    }),
  );

  return router;
}
