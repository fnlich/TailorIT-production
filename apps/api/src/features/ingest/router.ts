import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import {
  AdminRunsQuerySchema,
  AdminSourcesBulkBodySchema,
  AdminSourcesQuerySchema,
  IsoDate,
  ImportMappingInputSchema,
  JOB_SOURCE_TERMS_STATUSES,
} from '@tailorit/shared';
import { adminRouter } from '../../core/admin/index';
import { nowIso, type AppDeps } from '../../core/context';
import { getFileStore } from '../../core/files/index';
import { refuse } from '../../core/http/refuse';
import { conflict, notFound, validationFailed } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { ashbyBoard } from './adapters/ashby';
import { greenhouseToken } from './adapters/greenhouse';
import { ADAPTERS } from './adapters/index';
import { leverSite } from './adapters/lever';
import { importFilePath, tablePostings } from './adapters/tabular';
import { workableAccount } from './adapters/workable';
import { HimalayasConfigSchema, himalayasCountry } from './adapters/himalayas'; // v30 S4
import { JobicyConfigSchema } from './adapters/jobicy'; // v30 S4
import { UsajobsConfigSchema } from './adapters/usajobs'; // v30 S4
import { CAREER_CONFIG_LIST_MAX, careerSiteConfigOf } from './career/config'; // v30 FIX-A (REQ-5)
import { storeAndRunImport } from './imports';
import { lakeFileInfo, noLakeAt, readLake } from './lake';
import { closeOrphanJobs } from './close';
import { requireIngest } from './service';
import { createSheetImportRouter } from './sheets/router';
import { runnableKinds } from './scheduler'; // v30 INT-4
import { sourceOptedOut } from './opt-out-gate'; // v30 FIX-A
import { constantsOf } from '../../core/constants/index'; // v30 FIX-A
import { sourcingDailyReport } from './scheduler-report';
import {
  adminRun,
  adminRuns,
  adminSource,
  bulkSources,
  findSourceRecord,
  getSourceRecord,
  hostOf,
  insertSource,
  kindLabelOf,
  listAdminSources,
  runsOptionsOf,
} from './sources';
import {
  IMPORT_FIELD_LABEL,
  REQUIRED_IMPORT_FIELDS,
  cleanMapping,
  guessMapping,
  importFieldInfo,
  readTable,
  type ImportMapping,
} from './tabular';
import { IngestError, SCHEDULED_KINDS, SOURCE_KIND_LABEL, UNRUN_KINDS } from './types';

// Admin > Sources, Runs and Import jobs (docs/ARCHITECTURE.md §8). Every route is administrator-only. v30 ST4: each
// router is an adminRouter (core/admin): its guard, input checks, 404s and the audit of each change; Admin > Reports
// is reports-router.ts. v3.0 D2-C: through the async client.
//
// v30 S1-API (12-job-sourcing.md §9.8): Sources at 80,000 rows (CT's AdminSourcesQuery: filters, a keyset page, every
// match counted; sources.ts listAdminSources), bulk actions on up to 100 (POST /bulk: enable, disable, run_now = due
// now), a source's recorded terms (PATCH termsStatus, termsUrl, termsNote: terms_checked_at moves), the run history by
// source, kind and status, and the sourcing daily report (GET /api/admin/sourcing/report). Admin › Hosts is hosts.ts,
// Admin › Purges purge.ts.

const Id = z.coerce.number().int().positive();

export { BACKGROUND_IMPORT_ROWS } from './imports';

const name = z.string().trim().max(100, 'Keep the name under 100 characters.').optional();
const companyName = z.string().trim().max(200).optional();
const enabled = z.boolean().optional();

const GreenhouseConfig = z.object({ token: z.string().trim().min(1, 'Enter the Greenhouse board token.').max(300), companyName });
const LeverConfig = z.object({
  site: z.string().trim().min(1, 'Enter the Lever site name.').max(300),
  region: z.enum(['global', 'eu']).optional(),
  companyName,
});
const AshbyConfig = z.object({ board: z.string().trim().min(1, 'Enter the Ashby job board name.').max(300), companyName });
const WorkableConfig = z.object({
  account: z.string().trim().min(1, 'Enter the Workable account name.').max(300),
  companyName,
});
/** A Workable account the admin typed that names none (a /j/<shortcode> link): the field's own message. */
const noWorkableAccount = () =>
  validationFailed('Enter the Workable account name.', { 'config.account': 'Enter the account name.' });
const LakeConfig = z.object({ path: z.string().trim().max(1000).optional() });
/**
 * v30 FIX-A (REV-REQ REQ-5, S5 open item 5): an admin's career site by hand (career/config.ts): its host, and optionally
 * its sitemaps (paths, or https addresses on its domain), its posting pages' path prefixes and the employer's name.
 */
const CareerSiteConfig = z.object({
  host: z.string().trim().min(1, "Enter the career site's host (careers.example.org).").max(253),
  sitemaps: z.array(z.string().trim().min(1).max(2048)).max(CAREER_CONFIG_LIST_MAX).optional(),
  postingPaths: z
    .array(z.string().trim().min(1).max(500).startsWith('/', 'A posting path starts with "/".'))
    .max(CAREER_CONFIG_LIST_MAX)
    .optional(),
  companyName,
});

/** A career site's config as stored (career/config.ts's reading of it), or the host field's refusal. */
function careerSiteConfig(input: z.infer<typeof CareerSiteConfig>): Record<string, unknown> {
  try {
    const checked = careerSiteConfigOf(input);
    return {
      host: checked.host,
      ...(checked.sitemaps.length > 0 ? { sitemaps: checked.sitemaps } : {}),
      ...(checked.postingPaths.length > 0 ? { postingPaths: checked.postingPaths } : {}),
      ...(checked.companyName ? { companyName: checked.companyName } : {}),
    };
  } catch (error) {
    throw validationFailed((error as Error).message, { 'config.host': 'Give a host name TailorIT may read (careers.example.org).' });
  }
}

const CreateSourceBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('greenhouse'), name, enabled, config: GreenhouseConfig }),
  z.object({ kind: z.literal('lever'), name, enabled, config: LeverConfig }),
  z.object({ kind: z.literal('ashby'), name, enabled, config: AshbyConfig }),
  z.object({ kind: z.literal('workable'), name, enabled, config: WorkableConfig }),
  z.object({ kind: z.literal('ft_lake'), name, enabled, config: LakeConfig.default({}) }),
  z.object({ kind: z.literal('seed'), name, enabled, config: z.object({}).default({}) }),
  // v30 S4: the US federal feed and the remote-job APIs (12 §3.6-3.7), each source one search of its API.
  z.object({ kind: z.literal('usajobs'), name, enabled, config: UsajobsConfigSchema.default({}) }),
  z.object({ kind: z.literal('himalayas'), name, enabled, config: HimalayasConfigSchema.default({}) }),
  z.object({ kind: z.literal('jobicy'), name, enabled, config: JobicyConfigSchema.default({}) }),
  // v30 FIX-A (REQ-5): a career site by hand; it runs only while "Read career pages" is on.
  z.object({ kind: z.literal('career_site'), name, enabled, config: CareerSiteConfig }),
]);

/** v30 S4: a feed source's settings as stored (only the keys given), and the name it gets when none is typed. */
function feedSource(kind: 'usajobs' | 'himalayas' | 'jobicy', config: Record<string, unknown>, typed: string | undefined) {
  const kept = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined && value !== ''));
  if (kind === 'himalayas') {
    try {
      himalayasCountry(kept);
    } catch (error) {
      throw validationFailed((error as Error).message, { 'config.country': 'Give a country name or code, or "any".' });
    }
  }
  return { config: kept, label: typed || SOURCE_KIND_LABEL[kind] };
}

const TestSourceBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('greenhouse'), config: GreenhouseConfig }),
  z.object({ kind: z.literal('lever'), config: LeverConfig }),
  z.object({ kind: z.literal('ashby'), config: AshbyConfig }),
  z.object({ kind: z.literal('workable'), config: WorkableConfig }),
  z.object({ kind: z.literal('ft_lake'), config: LakeConfig.default({}) }),
]);

const PatchSourceBody = z.object({
  name: z.string().trim().min(1, 'A source needs a name.').max(100).optional(),
  enabled: z.boolean().optional(),
  deactivateMissing: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  // v30 S1-API: the source's recorded terms (the owner's rule: only allowed sources run) and its place in the queue.
  termsStatus: z.enum(JOB_SOURCE_TERMS_STATUSES).optional(),
  termsUrl: z.string().trim().max(2000).regex(/^https:\/\/\S+$/, 'Give the terms page as an https address.').nullable().optional(),
  termsNote: z.string().trim().max(1000, 'Keep the note under 1,000 characters.').nullable().optional(),
  priority: z.number().int().min(-100).max(100).optional(),
});

const ReportQuery = z.object({ day: IsoDate.optional() });

const MappingSchema = ImportMappingInputSchema;

const ImportJsonBody = z.object({
  fileName: z.string().trim().min(1).max(200).default('import.csv'),
  content: z.string().min(1, 'The file is empty.'),
  mapping: MappingSchema.optional(),
  name: z.string().trim().max(100).optional(),
});

/** The text of an uploaded import: the multipart `file`, or a JSON body { fileName, content } (scripts, tests). */
function importText(req: Request): { fileName: string; text: string; mapping?: Partial<ImportMapping>; name?: string } {
  const file = req.file;
  if (file) {
    const buffer = file.buffer;
    const text =
      buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
        ? buffer.subarray(2).toString('utf16le')
        : buffer.toString('utf8').replace(/^\ufeff/, '');
    let mapping: Partial<ImportMapping> | undefined;
    if (typeof req.body?.mapping === 'string' && req.body.mapping.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body.mapping);
      } catch {
        throw validationFailed('The column mapping is not valid JSON.');
      }
      mapping = parseInput(MappingSchema, parsed, 'column mapping');
    }
    const label = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : undefined;
    return { fileName: file.originalname || 'import.csv', text, mapping, name: label || undefined };
  }
  const body = parseInput(ImportJsonBody, req.body ?? {}, 'import');
  return { fileName: body.fileName, text: body.content, mapping: body.mapping, name: body.name || undefined };
}

function readImport(fileName: string, text: string) {
  try {
    return readTable(fileName, text);
  } catch (error) {
    if (error instanceof IngestError) throw validationFailed(error.message);
    throw error;
  }
}

/** POST /api/admin/sources: a new source of a kind an admin adds (a board, the lake, the demo jobs). */
async function createSource(deps: AppDeps, input: unknown) {
  const db = deps.db;
  const body = parseInput(CreateSourceBody, input ?? {}, 'job source');
  let config: Record<string, unknown>;
  let label: string;
  switch (body.kind) {
    case 'greenhouse': {
      const token = greenhouseToken(body.config.token);
      if (!token) throw validationFailed('Enter the Greenhouse board token.', { 'config.token': 'Enter the board token.' });
      config = { token, ...(body.config.companyName ? { companyName: body.config.companyName } : {}) };
      label = body.name || token;
      break;
    }
    case 'lever': {
      const site = leverSite(body.config.site);
      if (!site) throw validationFailed('Enter the Lever site name.', { 'config.site': 'Enter the site name.' });
      config = { site, region: body.config.region ?? 'global', ...(body.config.companyName ? { companyName: body.config.companyName } : {}) };
      label = body.name || site;
      break;
    }
    case 'ashby': {
      const board = ashbyBoard(body.config.board);
      if (!board) throw validationFailed('Enter the Ashby job board name.', { 'config.board': 'Enter the board name.' });
      config = { board, ...(body.config.companyName ? { companyName: body.config.companyName } : {}) };
      label = body.name || board;
      break;
    }
    case 'workable': {
      const account = workableAccount(body.config.account);
      if (!account) throw noWorkableAccount();
      config = { account, ...(body.config.companyName ? { companyName: body.config.companyName } : {}) };
      label = body.name || account;
      break;
    }
    case 'ft_lake': {
      const path = body.config.path?.trim() || null;
      const target = path ?? deps.config.ingest.ftLakeDbPath;
      if (!lakeFileInfo(target).exists) {
        throw validationFailed(`${noLakeAt(target)} Check the path.`, { 'config.path': 'No file at this path.' });
      }
      config = path ? { path } : {};
      label = body.name || 'free_tailor lake';
      break;
    }
    case 'seed':
      // v30 ST4: the demo jobs' adapter is the dev-only seam's; an install without it (the production export) has none.
      if (!ADAPTERS.seed) throw validationFailed('This server has no demo jobs.', { kind: 'This server has no demo jobs.' });
      config = { anchor: nowIso(deps) };
      label = body.name || 'Demo jobs';
      break;
    // v30 S4
    case 'usajobs':
    case 'himalayas':
    case 'jobicy':
      ({ config, label } = feedSource(body.kind, body.config, body.name));
      break;
    // v30 FIX-A (REQ-5): named by its host unless the admin names it; created even while "Read career pages" is off
    // (it is then never run).
    case 'career_site':
      config = careerSiteConfig(body.config);
      label = body.name || String(config.host);
      break;
  }
  const taken = () => conflict(`A ${SOURCE_KIND_LABEL[body.kind]} source named "${label}" already exists.`);
  if (await findSourceRecord(db, body.kind, label)) throw taken();
  // Null: the name was taken after the look (UNIQUE(kind, name)).
  const created = await insertSource(db, { kind: body.kind, name: label, config, enabled: body.enabled }, nowIso(deps));
  if (!created) throw taken();
  return { body, source: (await adminSource(db, created.id, false))! };
}

/** PATCH /api/admin/sources/:id: its name, whether it runs daily, whether it closes missing postings, its settings. */
async function patchSource(deps: AppDeps, id: number, patch: z.infer<typeof PatchSourceBody>, running: (id: number) => boolean) {
  const db = deps.db;
  const source = await getSourceRecord(db, id);
  if (!source) return null;
  // The job pages' source is found by its kind and keeps its name (from-page.ts pageSource): one source, never two.
  if (source.kind === 'page' && patch.name !== undefined && patch.name !== source.name) {
    throw validationFailed('The job pages source keeps its name.');
  }
  // A Workday or job-page source is never run: turned on, the daily check would stop asking about its postings.
  if (patch.enabled === true && !source.enabled && UNRUN_KINDS.includes(source.kind)) {
    throw validationFailed(`A ${kindLabelOf(source.kind, source.config)} source is never run, so it cannot be turned on.`);
  }
  // v30 FIX-A (SEC-2, BEH-3): a source of a company that opted out stays off (409).
  if (patch.enabled === true && (await sourceOptedOut(db, id))) throw refuse(deps, 'conflict', 'MSG_INGEST_SOURCE_OPTED_OUT');
  let config = source.config;
  if (patch.config) {
    const merged = { ...source.config, ...patch.config };
    if (source.kind === 'greenhouse') {
      const parsed = parseInput(GreenhouseConfig, merged, 'source settings');
      config = { ...merged, token: greenhouseToken(parsed.token) };
    } else if (source.kind === 'lever') {
      const parsed = parseInput(LeverConfig, merged, 'source settings');
      config = { ...merged, site: leverSite(parsed.site) };
    } else if (source.kind === 'ashby') {
      const parsed = parseInput(AshbyConfig, merged, 'source settings');
      config = { ...merged, board: ashbyBoard(parsed.board) };
    } else if (source.kind === 'workable') {
      const parsed = parseInput(WorkableConfig, merged, 'source settings');
      const account = workableAccount(parsed.account);
      if (!account) throw noWorkableAccount();
      config = { ...merged, account };
    } else if (source.kind === 'ft_lake') {
      parseInput(LakeConfig, merged, 'source settings');
      config = merged;
    } else if (source.kind === 'career_site') {
      // v30 FIX-A (REQ-5): its host, sitemaps, posting paths and employer name.
      config = careerSiteConfig(parseInput(CareerSiteConfig, merged, 'source settings'));
    } else if (source.kind === 'usajobs' || source.kind === 'himalayas' || source.kind === 'jobicy') {
      // v30 S4: the feeds' search settings.
      const schema = { usajobs: UsajobsConfigSchema, himalayas: HimalayasConfigSchema, jobicy: JobicyConfigSchema }[source.kind];
      config = feedSource(source.kind, parseInput(schema, merged, 'source settings'), source.name).config;
    } else {
      throw validationFailed(`The settings of a ${kindLabelOf(source.kind, source.config)} source cannot be changed here.`);
    }
  }
  const nextName = patch.name ?? source.name;
  if (nextName !== source.name && (await findSourceRecord(db, source.kind, nextName))) {
    throw conflict(`A ${kindLabelOf(source.kind, source.config)} source named "${nextName}" already exists.`);
  }
  const now = nowIso(deps);
  const terms = patch.termsStatus !== undefined || patch.termsUrl !== undefined || patch.termsNote !== undefined;
  // v30 S1-API: its host follows its settings (a Lever site moved to the EU); a source turned on is due at once; a
  // recorded terms check moves terms_checked_at.
  await db.run(
    `UPDATE job_sources SET name = @name, enabled = @enabled, deactivate_missing = @deactivate, config = CAST(@config AS jsonb),
       host = @host, updated_at = CAST(@now AS timestamptz),
       next_run_at = CASE WHEN CAST(@turnedOn AS boolean) THEN CAST(@now AS timestamptz) ELSE next_run_at END,
       terms_status = COALESCE(CAST(@termsStatus AS text), terms_status),
       terms_url = CASE WHEN CAST(@setUrl AS boolean) THEN CAST(@termsUrl AS text) ELSE terms_url END,
       terms_note = CASE WHEN CAST(@setNote AS boolean) THEN CAST(@termsNote AS text) ELSE terms_note END,
       terms_checked_at = CASE WHEN CAST(@terms AS boolean) THEN CAST(@now AS timestamptz) ELSE terms_checked_at END,
       priority = COALESCE(CAST(@priority AS smallint), priority)
     WHERE id = @id`,
    {
      id,
      name: nextName,
      enabled: patch.enabled ?? source.enabled,
      deactivate: patch.deactivateMissing ?? source.deactivateMissing,
      config: JSON.stringify(config),
      host: hostOf(source.kind, config) ?? source.host ?? null,
      now,
      turnedOn: patch.enabled === true && !source.enabled && SCHEDULED_KINDS.includes(source.kind),
      termsStatus: patch.termsStatus ?? null,
      setUrl: patch.termsUrl !== undefined,
      termsUrl: patch.termsUrl ?? null,
      setNote: patch.termsNote !== undefined,
      termsNote: patch.termsNote ?? null,
      terms,
      priority: patch.priority ?? null,
    },
  );
  return adminSource(db, id, running(id), now);
}

/** Deletes the source and its run history; jobs only it listed are closed (they stay for applications that link them). */
async function deleteSource(deps: AppDeps, id: number, running: (id: number) => boolean): Promise<void> {
  const db = deps.db;
  const source = await getSourceRecord(db, id);
  if (!source) throw notFound('That job source');
  // The job pages' source holds the jobs people added from pages they had open (their own): it stays.
  if (source.kind === 'page') {
    throw validationFailed('The job pages source keeps the jobs people added from job pages, so it cannot be deleted.');
  }
  if (running(id)) throw refuse(deps, 'conflict', 'MSG_INGEST_SOURCE_RUNNING_DELETE');
  const now = nowIso(deps);
  await db.tx(
    async (t) => {
      // v30 INT-3 (DB-INGEST's edit E): the source's live links go missing, then the one close function's batch form
      // closes each job no live link is left of (close.ts closeOrphanJobs), projecting it out of search in this
      // transaction.
      const listed = await t.all<{ job_id: number }>(
        'UPDATE job_source_links SET missing_since = ? WHERE source_id = ? AND missing_since IS NULL RETURNING job_id',
        [now, id],
      );
      await closeOrphanJobs(
        t,
        listed.map((row) => row.job_id),
        now,
      );
      // Never a source another process holds the lease of (service.ts): nothing is closed then either.
      const deleted = await t.run('DELETE FROM job_sources WHERE id = ? AND (lease_until IS NULL OR lease_until < CAST(? AS timestamptz))', [
        id,
        now,
      ]);
      if (deleted.changes === 0) throw refuse(deps, 'conflict', 'MSG_INGEST_SOURCE_RUNNING_DELETE');
    },
    { label: 'delete source' },
  );
  if (source.kind === 'csv' || source.kind === 'json') {
    try {
      rmSync(dirname(importFilePath(deps, source)), { recursive: true, force: true });
    } catch {
      /* no stored file */
    }
  }
}

/** POST /api/admin/sources/ft-lake/test {path?}: is free_tailor's database there, and what does it hold. */
function testLake(deps: AppDeps, input: unknown) {
  const body = parseInput(LakeConfig, input ?? {}, 'test');
  const path = body.path?.trim() || deps.config.ingest.ftLakeDbPath;
  const file = lakeFileInfo(path);
  if (!file.exists) {
    return { ...file, ok: false, message: noLakeAt(path), counts: null, newestUpdatedAt: null };
  }
  try {
    const snapshot = readLake(path);
    const now = deps.now().getTime();
    const maxAge = deps.config.ingest.ftLakeMaxAgeDays * 86_400_000;
    const fresh = snapshot.rows.filter((row) => now - Math.max(Date.parse(row.updated_at) || 0, Date.parse(row.last_seen_at ?? '') || 0) <= maxAge);
    const newest = snapshot.rows.map((row) => row.updated_at).sort().at(-1) ?? null;
    return {
      ...file,
      ok: true,
      message: `${snapshot.total} jobs, ${snapshot.withAnalysis} with an analysis, ${fresh.length} updated in the last ${deps.config.ingest.ftLakeMaxAgeDays} days.`,
      counts: { jobs: snapshot.total, withAnalysis: snapshot.withAnalysis, recent: fresh.length },
      newestUpdatedAt: newest,
    };
  } catch (error) {
    return { ...file, ok: false, message: (error as Error).message, counts: null, newestUpdatedAt: null };
  }
}

/** Mounted at /api/admin/sources. */
export function createSourcesRouter(deps: AppDeps): Router {
  const db = deps.db;
  const running = (id: number) => deps.services.ingest?.isRunning(id) ?? false;
  return adminRouter(deps, {
    resource: 'job source',
    id: Id,
    list: { query: AdminSourcesQuerySchema, run: (_deps, query) => listAdminSources(db, query, nowIso(deps), running) },
    bulk: {
      body: AdminSourcesBulkBodySchema,
      // v30 FIX-A: a source of a company that opted out is skipped with MSG_INGEST_SOURCE_OPTED_OUT's words.
      run: (_deps, body) => bulkSources(db, body, nowIso(deps), constantsOf(deps).message('MSG_INGEST_SOURCE_OPTED_OUT')),
    },
    get: (_deps, id) => adminSource(db, id, running(id), nowIso(deps)),
    patch: { body: PatchSourceBody, run: (_deps, id, patch) => patchSource(deps, id, patch, running) },
    routes(router, { handle, audit }) {
      // A route answering with its own status sets it on req.res; handle sends the JSON (or nothing once ended).
      router.post(
        '/',
        handle(async (req, actor) => {
          const { body, source } = await createSource(deps, req.body);
          await audit({ action: 'create', ids: [source.id], actor, change: body });
          req.res!.status(201);
          return source;
        }),
      );

      router.post(
        '/test',
        handle(async (req) => {
          const body = parseInput(TestSourceBody, req.body ?? {}, 'test');
          const config: Record<string, unknown> =
            body.kind === 'greenhouse'
              ? { ...body.config, token: greenhouseToken(body.config.token) }
              : body.kind === 'lever'
                ? { ...body.config, site: leverSite(body.config.site) }
                : body.kind === 'ashby'
                  ? { ...body.config, board: ashbyBoard(body.config.board) }
                  : body.kind === 'workable'
                    ? { ...body.config, account: workableAccount(body.config.account) }
                    : body.config;
          return requireIngest(deps).test(body.kind, config);
        }),
      );

      router.post('/ft-lake/test', handle((req) => testLake(deps, req.body)));

      router.delete(
        '/:id',
        handle(async (req, actor) => {
          const id = parseInput(Id, req.params.id, 'source id');
          await deleteSource(deps, id, running);
          await audit({ action: 'delete', ids: [id], actor, change: null });
          req.res!.status(204).end();
        }),
      );

      router.post(
        '/:id/run',
        handle(async (req, actor) => {
          const id = parseInput(Id, req.params.id, 'source id');
          const source = await getSourceRecord(db, id);
          if (!source) throw notFound('That job source');
          const quick = source.kind === 'seed' || source.kind === 'csv' || source.kind === 'json';
          const { runId } = await requireIngest(deps).run(id, 'manual', { bypassSlots: quick });
          await audit({ action: 'run', ids: [id], actor, change: { runId } });
          req.res!.status(202);
          return { runId, sourceId: id };
        }),
      );
    },
  });
}

/** Mounted at /api/admin/runs. */
export function createRunsRouter(deps: AppDeps): Router {
  return adminRouter(deps, {
    resource: 'run',
    id: Id,
    list: { query: AdminRunsQuerySchema, run: (_deps, query) => adminRuns(deps.db, runsOptionsOf(query)) },
    get: (_deps, id) => adminRun(deps.db, id),
  });
}

/** Mounted at /api/admin/sourcing: GET /report?day=YYYY-MM-DD, the day's sourcing (12 §9.8; today, UTC, by default). */
export function createSourcingReportRouter(deps: AppDeps): Router {
  return adminRouter(deps, {
    resource: 'sourcing report',
    routes(router, { handle }) {
      router.get(
        '/report',
        handle((req) => {
          const query = parseInput(ReportQuery, req.query, 'query');
          return sourcingDailyReport(deps.db, query.day ?? nowIso(deps).slice(0, 10), runnableKinds(deps)); // v30 INT-4
        }),
      );
    },
  });
}

/** Mounted at /api/admin/import. */
export function createImportRouter(deps: AppDeps): Router {
  // multipart/form-data with a `file` field (the console), or JSON { fileName, content } (scripts and tests).
  const upload: RequestHandler = (req, res, next) => getFileStore(deps).uploadSingle('file', { required: false })(req, res, next);
  return adminRouter(deps, {
    resource: 'import',
    routes(router, { handle, audit }) {
      // Google Sheet imports: /api/admin/import/sheets/{account,preview,jobs}.
      router.use('/sheets', createSheetImportRouter(deps));

      /** POST /api/admin/import/jobs/preview: the columns, a guessed mapping and the first rows. Saves nothing. */
      router.post('/jobs/preview', upload, (req, res) => {
        const { fileName, text, mapping } = importText(req);
        const table = readImport(fileName, text);
        const guessed = guessMapping(table.columns);
        const chosen = mapping ? cleanMapping({ ...guessed, ...mapping }, table.columns) : guessed;
        const check = tablePostings(fileName, text, chosen);
        res.json({
          fileName,
          format: table.format,
          columns: table.columns,
          mapping: chosen,
          fields: importFieldInfo(),
          rowCount: table.rows.length,
          jobCount: check.postings.length,
          sample: table.rows.slice(0, 5).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value.slice(0, 300)]))),
          missingRequired: REQUIRED_IMPORT_FIELDS.filter((field) => !chosen[field]),
          problems: check.failures.slice(0, 20).map((failure) => failure.message),
        });
      });

      /**
       * POST /api/admin/import/jobs: stores the file as a csv/json source and imports it. 201 { source, run, runId } once
       * the import finished; a file of more than BACKGROUND_IMPORT_ROWS rows answers 202 { source, run: null, runId } at
       * once and imports in the background (the console follows it under Runs). A name that a Google Sheet import holds
       * answers 409.
       */
      router.post(
        '/jobs',
        upload,
        handle(async (req, actor) => {
          const { fileName, text, mapping, name: label } = importText(req);
          const table = readImport(fileName, text);
          const chosen = cleanMapping(mapping ?? guessMapping(table.columns), table.columns);
          const missing = REQUIRED_IMPORT_FIELDS.filter((field) => !chosen[field]);
          if (missing.length) {
            throw validationFailed(`Choose the column for ${missing.map((field) => IMPORT_FIELD_LABEL[field].toLowerCase()).join(', ')}.`);
          }
          const result = await storeAndRunImport(deps, {
            kind: table.format,
            sourceName: label || fileName,
            fileName,
            text,
            mapping: chosen,
            rowCount: table.rows.length,
          });
          await audit({ action: 'import', ids: [result.body.source.id], actor, change: { fileName, rows: table.rows.length } });
          req.res!.status(result.status);
          return result.body;
        }),
      );
    },
  });
}
