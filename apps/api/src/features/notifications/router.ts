import { Router, type Request, type RequestHandler } from 'express';
import { MINUTE_MS } from '@tailorit/shared';
import {
  NotificationListQuerySchema,
  NotificationPrefsUpdateSchema,
  type HeaderSummary,
  type NotificationCount,
  type NotificationList,
  type NotificationPrefs,
  type NotificationReadAll,
} from '@tailorit/shared/notifications';
import { requireUser, userOf } from '../../core/auth/guards';
import type { AppDeps } from '../../core/context';
import { parseInput } from '../../core/http/validate';
import { keyedRateLimit } from '../../core/rate-limit';
import { waitSentence } from '../autofill/auth';
import { headerSummary } from './header';
import {
  listNotifications,
  markAllRead,
  markRead,
  notificationIdOf,
  prefsOf,
  unreadCount,
  updatePrefs,
  type Reader,
} from './store';

// v3.1 NOTIFY (D8, D9): the person's notifications and switches, and the header's summary. Session only (the
// extension and MCP tokens get none of it). Every page asks GET /api/me/header every 60 s, and the bell its list when
// opened: the reads have a per-account anti-flood limit, the changes a smaller one.
//   GET  /api/notifications?cursor&unread=1&limit   → NotificationList
//   GET  /api/notifications/count                   → NotificationCount
//   POST /api/notifications/:id/read                → 204
//   POST /api/notifications/read-all                → NotificationReadAll
//   GET  /api/notifications/prefs                   → NotificationPrefs
//   PUT  /api/notifications/prefs                   → NotificationPrefs
//   GET  /api/me/header                             → HeaderSummary

/** Reads of the list, the count and the header per account per minute (a page polls the header every 60 s per tab). */
export const NOTIFICATION_READS_PER_MINUTE = 120;
/** Marks read and switch changes per account per minute. */
export const NOTIFICATION_CHANGES_PER_MINUTE = 60;

const readerOf = (req: Request): Reader => {
  const user = userOf(req);
  return { id: user.id, admin: user.role === 'admin' };
};

function perAccount(name: string, limit: number): RequestHandler {
  return keyedRateLimit({
    windowMs: MINUTE_MS,
    limit,
    key: (req) => `${name}:${userOf(req).id}`,
    message: (seconds) => `There have been too many notification requests. ${waitSentence(seconds)}`,
  });
}

/** Mounted at /api/notifications. */
export function createNotificationsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);
  const readLimit = perAccount('notifications-read', NOTIFICATION_READS_PER_MINUTE);
  const changeLimit = perAccount('notifications-change', NOTIFICATION_CHANGES_PER_MINUTE);

  router.get('/', readLimit, async (req, res) => {
    const query = parseInput(NotificationListQuerySchema, req.query ?? {}, 'query');
    const body: NotificationList = await listNotifications(deps, readerOf(req), query);
    res.json(body);
  });

  router.get('/count', readLimit, async (req, res) => {
    const body: NotificationCount = { unread: await unreadCount(deps, readerOf(req)) };
    res.json(body);
  });

  router.post('/read-all', changeLimit, async (req, res) => {
    const body: NotificationReadAll = { marked: await markAllRead(deps, readerOf(req)) };
    res.json(body);
  });

  router.get('/prefs', readLimit, async (req, res) => {
    const body: NotificationPrefs = await prefsOf(deps, readerOf(req));
    res.json(body);
  });

  router.put('/prefs', changeLimit, async (req, res) => {
    const update = parseInput(NotificationPrefsUpdateSchema, req.body ?? {}, 'notification settings');
    const body: NotificationPrefs = await updatePrefs(deps, readerOf(req), update);
    res.json(body);
  });

  router.post('/:id/read', changeLimit, async (req, res) => {
    await markRead(deps, readerOf(req), notificationIdOf(req.params.id));
    res.status(204).end();
  });

  return router;
}

/** Mounted at /api/me/header (after /api/me, whose router has no such path). */
export function createHeaderRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);
  const readLimit = perAccount('header-read', NOTIFICATION_READS_PER_MINUTE);

  router.get('/', readLimit, async (req, res) => {
    // Personal and changing: app.ts's noStore keeps it out of every cache, as every /api answer.
    const body: HeaderSummary = await headerSummary(deps, readerOf(req));
    res.json(body);
  });

  return router;
}
