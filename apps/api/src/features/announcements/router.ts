import { Router } from 'express';
import { z } from 'zod';
import {
  AnnouncementBodySchema,
  IdParam,
  type AdminAnnouncementList,
  type AnnouncementList,
} from '@tailorit/shared';
import { adminRouter } from '../../core/admin/index';
import { requireUser, userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { parseInput } from '../../core/http/validate';
import {
  activeAnnouncements,
  adminAnnouncements,
  createAnnouncement,
  deleteAnnouncement,
  dismissAnnouncement,
  updateAnnouncement,
} from './store';

const idOf = (raw: string | undefined) => parseInput(IdParam, raw ?? '', 'announcement id');

/** Mounted at /api/announcements (session): the person's banner and their dismissals. */
export function createAnnouncementsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);

  router.get('/', async (req, res) => {
    const body: AnnouncementList = { items: await activeAnnouncements(deps, userOf(req).id) };
    res.json(body);
  });

  router.post('/:id/dismiss', async (req, res) => {
    await dismissAnnouncement(deps, userOf(req).id, idOf(req.params.id));
    res.status(204).end();
  });

  return router;
}

/** Mounted at /api/admin/announcements (admin only): the list with expired ones, and publish, edit, delete. */
export function createAdminAnnouncementsRouter(deps: AppDeps): Router {
  return adminRouter(deps, {
    resource: 'announcement',
    id: IdParam,
    list: {
      query: z.object({}),
      run: async () => {
        const body: AdminAnnouncementList = { items: await adminAnnouncements(deps) };
        return body;
      },
    },
    routes(router, { handle, audit }) {
      // A route answering with its own status sets it on req.res; handle sends the JSON (or nothing once ended).
      router.post(
        '/',
        handle(async (req, admin) => {
          const body = parseInput(AnnouncementBodySchema, req.body ?? {}, 'announcement');
          const created = await createAnnouncement(deps, admin.id, body);
          await audit({ action: 'create', ids: [created.id], actor: admin, change: body });
          req.res!.status(201);
          return created;
        }),
      );

      router.put(
        '/:id',
        handle(async (req, admin) => {
          const id = idOf(req.params.id);
          const body = parseInput(AnnouncementBodySchema, req.body ?? {}, 'announcement');
          const updated = await updateAnnouncement(deps, admin.id, id, body);
          await audit({ action: 'update', ids: [id], actor: admin, change: body });
          return updated;
        }),
      );

      router.delete(
        '/:id',
        handle(async (req, admin) => {
          const id = idOf(req.params.id);
          await deleteAnnouncement(deps, admin.id, id);
          await audit({ action: 'delete', ids: [id], actor: admin, change: null });
          req.res!.status(204).end();
        }),
      );
    },
  });
}
