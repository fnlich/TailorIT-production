import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Router, type Request } from 'express';
import { DocumentsZipBodySchema, IdParam, ResumeZipBodySchema } from '@tailorit/shared';
import { payerOf, requireUser, userOf } from '../../core/auth/guards'; // v33 SHARE-3: payerOf
import type { AppDeps } from '../../core/context';
import { contentDisposition } from '../../core/files/names';
import { AppError, asyncHandler } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';
import { parseInput } from '../../core/http/validate';
import type { ResumeZipService } from './registry';

// "Build resumes" (work package WP11), mounted at /api/applications/resume-zip ahead of the tracker's own router, so
// its /:id routes never see these paths. Every route needs a signed-in account and answers only about that account's
// builds (another account's is 404, as one that never existed); POST also needs the app's Origin (app-wide check).
//   POST /                  { ids?, tzOffsetMinutes? } -> 202 { buildId }
//   POST /documents         { resumeIds, tzOffsetMinutes? } -> 202 { buildId }: v20 P10 (A28), Documents' batch
//                           download of the selected resumes; Paid only (403 `paid_feature` for Free)
//   GET  /:buildId          the build's progress (ResumeZipBuild)
//   GET  /:buildId/file     the zip, with its Content-Length; removed once it was downloaded whole

function serviceOf(deps: AppDeps): ResumeZipService {
  const service = deps.services.resumeZip;
  if (!service) throw new AppError('internal', 'Building resumes is not set up on this server.');
  return service;
}

function buildIdOf(req: Request): string {
  return parseInput(IdParam, req.params.buildId, 'link');
}

export function createResumeZipRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);

  router.post('/', async (req, res) => {
    const body = parseInput(ResumeZipBodySchema, req.body ?? {}, 'request');
    res.status(202).json(await serviceOf(deps).start(userOf(req).id, body, payerOf(req))); // v33 SHARE-3: the asker's plan
  });

  // v20 P10 (A28): the "documents" source. Its build is polled and downloaded through the routes below.
  router.post('/documents', async (req, res) => {
    const body = parseInput(DocumentsZipBodySchema, req.body ?? {}, 'request');
    res.status(202).json(await serviceOf(deps).startDocuments(userOf(req).id, body, payerOf(req))); // v33 SHARE-3
  });

  router.get('/:buildId', (req, res) => {
    res.json(serviceOf(deps).status(userOf(req).id, buildIdOf(req)));
  });

  router.get(
    '/:buildId/file',
    asyncHandler(async (req, res) => {
      const download = serviceOf(deps).download(userOf(req).id, buildIdOf(req));
      let complete = false;
      try {
        // Opened before any header is set: a file that is gone is a plain JSON 404, never a broken download.
        const handle = await open(download.path, 'r').catch(() => {
          throw refuse(deps, 'not_found', 'MSG_ZIP_GONE');
        });
        const { size } = await handle.stat().catch(async (error: unknown) => {
          await handle.close();
          throw error;
        });
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', contentDisposition(download.fileName));
        res.setHeader('Content-Length', String(size));
        if (req.method === 'HEAD') {
          await handle.close();
          res.end();
          return;
        }
        // A client that goes away mid-download closes the response: the read stops and the zip stays for a retry.
        await pipeline(handle.createReadStream(), res);
        complete = true;
      } catch (error) {
        if (!res.headersSent) {
          // Nothing was sent yet: the error goes out as JSON, not as an attachment named like the zip.
          for (const header of ['Content-Type', 'Content-Disposition', 'Content-Length']) res.removeHeader(header);
          throw error;
        }
        deps.log.info(`[resume-zip] a download of ${download.fileName} ended early`, error);
        res.destroy();
      } finally {
        download.finish(complete);
      }
    }),
  );

  return router;
}
