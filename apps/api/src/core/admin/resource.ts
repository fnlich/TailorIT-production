import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { ownProfileOnly } from '../auth/grants'; // v33 SHARE-1
import { requireAdmin, userOf } from '../auth/guards';
import { nowIso, type AppDeps } from '../context';
import { notFound } from '../http/errors';
import { parseInput } from '../http/validate';

// v30 ST0: the admin API base (PLAN §6, "Admin APIs"). Every admin router is administrators-only, lists a resource
// (paged, filtered), reads one, changes one, changes several at once, and says who changed what. adminRouter writes
// that skeleton once: the guard, the input checks (parseInput: 400 validation_failed with per-field words), the 404
// for an id that is not there, the JSON answers, the audit after each change, and async handlers (wave 1 makes the
// data layer async: a handler may answer a value or a promise). A feature writes only its queries and its rules.
//
//   export function createReportsRouter(deps: AppDeps): Router {
//     return adminRouter(deps, {
//       resource: 'report',
//       id: PositiveId,
//       list: { query: ReportsQuery, run: (deps, query) => listReports(deps, query) },
//       patch: { body: PatchReportBody, run: (deps, id, change, admin) => patchReport(deps, id, change, admin) },
//       bulk: { body: BulkReportsBody, run: (deps, bulk, admin) => decideReports(deps, bulk, admin) },
//       routes: (router, helpers) => { router.post('/:id/recheck', helpers.handle(async (req) => ...)); },
//     });
//   }
//
// Routes, in this order: GET / (list), POST /bulk (bulk), the feature's own `routes`, GET /:id (get), PATCH /:id
// (patch). Each part is optional; a part not given has no route (404 from the API's not-found handler).

/** A positive integer id from the path ("12"). */
export const PositiveId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** A text id from the path (an account's uuid). */
export const TextId = z.string().min(1).max(64);

/** The signed-in administrator a handler acts as. */
export interface AdminActor {
  id: string;
  email: string;
}

/** What one change did, for the audit. */
export interface AdminAuditEvent {
  /** The resource's name ("report", "source"). */
  resource: string;
  action: 'patch' | 'bulk' | string;
  /** The rows it changed. */
  ids: ReadonlyArray<string | number>;
  actor: AdminActor;
  /** The change as the admin sent it (after its checks). */
  change: unknown;
  at: string;
}

type Awaitable<T> = T | Promise<T>;

export interface AdminResourceSpec<Id, Row, Query, Patch, Bulk> {
  /** The resource's name, singular ("report"): the audit's and the not-found words' ("That report was not found."). */
  resource: string;
  /** The path id's schema (PositiveId, TextId, or the feature's own). Default: PositiveId. */
  id?: z.ZodType<Id>;
  /** GET /: the query's schema and the page (any JSON body: AdminPage<T>, or the list's own shape with counts). */
  list?: { query: z.ZodType<Query>; run: (deps: AppDeps, query: Query, actor: AdminActor) => Awaitable<unknown> };
  /** GET /:id: the row, or null for 404. */
  get?: (deps: AppDeps, id: Id, actor: AdminActor) => Awaitable<Row | null | undefined>;
  /** PATCH /:id: the change's schema, and the changed row (null for 404). Audited as `patch`. */
  patch?: { body: z.ZodType<Patch>; run: (deps: AppDeps, id: Id, change: Patch, actor: AdminActor) => Awaitable<Row | null | undefined> };
  /**
   * POST /bulk: the change's schema (it names the rows), the answer, and the ids it changed (for the audit). Audited
   * as `bulk`.
   */
  bulk?: {
    body: z.ZodType<Bulk>;
    run: (deps: AppDeps, change: Bulk, actor: AdminActor) => Awaitable<{ ids: ReadonlyArray<string | number>; body: unknown }>;
  };
  /** The resource's other routes, mounted after GET / and POST /bulk and before /:id (so /:id never takes their paths). */
  routes?: (router: Router, helpers: AdminRouteHelpers) => void;
  /**
   * Hears each change after it succeeded. Default: one info line in the log (`[admin] <email> patch report 12`); a
   * feature with an audit table writes its row here (inside its own run when it must be in the same transaction).
   */
  audit?: (deps: AppDeps, event: AdminAuditEvent) => Awaitable<void>;
}

export interface AdminRouteHelpers {
  /** An Express handler from an async one: its answer is sent as JSON (status 200), a throw reaches the error handler. */
  handle: (run: (req: Request, actor: AdminActor) => Awaitable<unknown>) => (req: Request, res: Response, next: NextFunction) => void;
  /** Audits a change made by one of the feature's own routes. */
  audit: (event: Omit<AdminAuditEvent, 'resource' | 'at'>) => Promise<void>;
}

/** The default audit: one log line per change. */
export function logAudit(deps: Pick<AppDeps, 'log'>, event: AdminAuditEvent): void {
  const ids = event.ids.length > 5 ? `${event.ids.slice(0, 5).join(', ')} and ${event.ids.length - 5} more` : event.ids.join(', ');
  deps.log.info(`[admin] ${event.actor.email} ${event.action} ${event.resource} ${ids}`);
}

const actorOf = (req: Request): AdminActor => {
  const user = userOf(req);
  return { id: user.id, email: user.email };
};

// v33 SHARE-1 (PLAN F9 "Always locked: admin"; SP v33 PLAN-sharing.md §4): no admin page or power is ever used on a
// shared profile. A request that names one (req.actingCandidate, live or not) is refused before requireAdmin, whatever
// the mount's acting policy says: own_profile_only. A request that names none (or `me`) is as before.
const refuseNamedProfile = (req: Request, _res: Response, next: NextFunction) =>
  next(req.actingCandidate ? ownProfileOnly() : undefined);
// end v33 SHARE-1

/** "That report", "That source": the not-found words' subject. */
const subject = (resource: string) => `That ${resource}`;

/** An admin router for one resource (see the comment at the top). */
export function adminRouter<Id = number, Row = unknown, Query = unknown, Patch = unknown, Bulk = unknown>(
  deps: AppDeps,
  spec: AdminResourceSpec<Id, Row, Query, Patch, Bulk>,
): Router {
  const router = Router();
  router.use(refuseNamedProfile, requireAdmin); // v33 SHARE-1
  const idSchema = (spec.id ?? PositiveId) as z.ZodType<Id>;
  const idOf = (req: Request) => parseInput(idSchema, req.params.id ?? '', `${spec.resource} id`);

  const audit = async (event: Omit<AdminAuditEvent, 'resource' | 'at'>) => {
    const full: AdminAuditEvent = { ...event, resource: spec.resource, at: nowIso(deps) };
    if (spec.audit) await spec.audit(deps, full);
    else logAudit(deps, full);
  };

  const handle: AdminRouteHelpers['handle'] = (run) => (req, res, next) => {
    Promise.resolve()
      .then(() => run(req, actorOf(req)))
      .then((body) => {
        if (!res.headersSent) res.json(body);
      })
      .catch(next);
  };

  const list = spec.list;
  if (list) {
    router.get('/', handle((req, actor) => list.run(deps, parseInput(list.query, req.query, 'query'), actor)));
  }

  const bulk = spec.bulk;
  if (bulk) {
    router.post(
      '/bulk',
      handle(async (req, actor) => {
        const change = parseInput(bulk.body, req.body ?? {}, 'change');
        const done = await bulk.run(deps, change, actor);
        if (done.ids.length > 0) await audit({ action: 'bulk', ids: done.ids, actor, change });
        return done.body;
      }),
    );
  }

  spec.routes?.(router, { handle, audit });

  const get = spec.get;
  if (get) {
    router.get(
      '/:id',
      handle(async (req, actor) => {
        const row = await get(deps, idOf(req), actor);
        if (row === null || row === undefined) throw notFound(subject(spec.resource));
        return row;
      }),
    );
  }

  const patch = spec.patch;
  if (patch) {
    router.patch(
      '/:id',
      handle(async (req, actor) => {
        const id = idOf(req);
        const change = parseInput(patch.body, req.body ?? {}, 'change');
        const row = await patch.run(deps, id, change, actor);
        if (row === null || row === undefined) throw notFound(subject(spec.resource));
        await audit({ action: 'patch', ids: [id as string | number], actor, change });
        return row;
      }),
    );
  }

  return router;
}
