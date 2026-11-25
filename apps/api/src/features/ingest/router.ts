import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import {
  AdminRunSourcesBodySchema,
  AdminRunsQuerySchema,
  AdminSourcesAllBodySchema,
  AdminSourcesBulkBodySchema,
  AdminSourcesFilterSchema,
  AdminSourcesQuerySchema,
  AdminSourcesImportJsonBodySchema, // v37 TRANSFER
  hasUnstorableText, // v37 FIX-37B (F5)
  IsoDate,
  ImportMappingInputSchema,
  JOB_SOURCE_TERMS_STATUSES,
} from '@tailorit/shared';
import { adminRouter, type AdminActor } from '../../core/admin/index';
import { nowIso, type AppDeps } from '../../core/context';
import { getFileStore } from '../../core/files/index';
import { contentDisposition } from '../../core/files/names'; // v37 TRANSFER
import { refuse } from '../../core/http/refuse';
import { conflict, notFound, validationFailed } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { ashbyBoard } from './adapters/ashby';
import { greenhouseToken } from './adapters/greenhouse';
import { ADAPTERS } from './adapters/index';
import { leverSite } from './adapters/lever';
import { importFilePath, tablePostings } from './adapters/tabular';
import { workableAccount } from './adapters/workable';
import { workdaySiteOfPage } from './adapters/workdaySite'; // v35 ADMIN
import { bamboohrCompany } from './adapters/bamboohr'; // v37 BOARDS
import { icimsBoardOf, isIcimsBoardHost } from './career/platforms'; // v37 BOARDS
import { boardNameOf } from './discovery/boards'; // v35 ADMIN
import { isLinkKeeper, sourcesOfBoard } from './discovery/offer'; // v35 ADMIN
import { waitingOfSources } from './waiting'; // v35 ADMIN
import { HimalayasConfigSchema, himalayasCountry } from './adapters/himalayas'; // v30 S4
import { JobicyConfigSchema } from './adapters/jobicy'; // v30 S4
import { UsajobsConfigSchema } from './adapters/usajobs'; // v30 S4
import { CAREER_CONFIG_LIST_MAX, careerSiteConfigOf } from './career/config'; // v30 FIX-A (REQ-5)
import { storeAndRunImport } from './imports';
import { lakeFileInfo, noLakeAt, readLake } from './lake';
import { closedNoteOf, closeOrphanJobs } from './close'; // v37 FIX-REV (D1): closedNoteOf
import { requireIngest } from './service';
import { createSheetImportRouter } from './sheets/router';
import { runnableKinds } from './scheduler'; // v30 INT-4
import { sourceOptedOut } from './opt-out-gate'; // v30 FIX-A
import { constantsOf } from '../../core/constants/index'; // v30 FIX-A
import { sourcingDailyReport } from './scheduler-report';
import { continueAllRuns, continueRun, continueSource, pauseAllRuns, pauseRun, pauseSource } from './pause'; // v31 RUNS
import { runsPausedState } from './pause-state'; // v31 RUNS
import { dismissTurnedOff, turnedOffNotice } from './turned-off'; // v36 SOURCES
import { exportSources, importSources, planImport, readSourcesFile } from './source-transfer'; // v37 TRANSFER
import {
  adminRun,
  adminRuns,
  adminSource,
  bulkSources,
  countSourcesAll,
  enableSources, // v36 SOURCES
  findSourceRecord,
  getSourceRecord,
  hostOf,
  insertSource,
  kindLabelOf,
  listAdminSources,
  runSources,
  runSourcesAll,
  runsOptionsOf,
  sourcesAll,
  termsParams, // v37 FIX-37B
  type BulkWords,
  type SourcesWaiting,
} from './sources';
import { termsRefusalOfBoards } from './terms'; // v37 FIX-37B (E2)
import {
  IMPORT_FIELD_LABEL,
  REQUIRED_IMPORT_FIELDS,
  cleanMapping,
  guessMapping,
  importFieldInfo,
  readTable,
  type ImportMapping,
} from './tabular';
import { IngestError, SOURCE_KIND_LABEL, UNRUN_KINDS } from './types';
import { importLinksNote } from '../jobs/add/imports'; // v31 LINK2

// Admin > Sources, Runs and Import jobs (docs/ARCHITECTURE.md §8). Every route is administrator-only. v30 ST4: each
// router is an adminRouter (core/admin): its guard, input checks, 404s and the audit of each change; Admin > Reports
// is reports-router.ts. v3.0 D2-C: through the async client.
//
// v30 S1-API (12-job-sourcing.md §9.8): Sources at 80,000 rows (CT's AdminSourcesQuery: filters, a keyset page, every
// match counted; sources.ts listAdminSources), bulk actions on up to 100 (POST /bulk: enable, disable, run_now = due
// now), a source's recorded terms (PATCH termsStatus, termsUrl, termsNote: terms_checked_at moves), the run history by
// source, kind and status, and the sourcing daily report (GET /api/admin/sourcing/report). Admin › Hosts is hosts.ts,
// Admin › Purges purge.ts.
//
// v31 RUNS (docs/design/v3.1/22-runs-pause.md): Pause and Continue, of every run (POST /api/admin/runs/pause,
// /continue), one run (/api/admin/runs/:id/pause, /continue) and one source (/api/admin/sources/:id/pause, /continue),
// each audited; the run history says whether every run is paused (GET /api/admin/runs: `paused`). pause.ts holds them.
//
// v35 ADMIN (PLAN H6, H7): an import is no source: Sources never lists, counts or acts on an import's csv or json record
// (sources.ts sourcesWhere, bulkSources); "Found by import" is a filter (`discoveredVia` import). Enable all / Disable all
// act on every source the filter matches (GET /api/admin/sources/all/count?<filter>, then POST /api/admin/sources/all
// {action, filter}: one result). An import's run lists the board sources it found (GET /api/admin/runs/:id/sources) and
// switches the ones it made on or off (POST /api/admin/runs/:id/sources {action}). Add source takes a Workday career
// site from any page of it (`workday_site`, config {url}); a switched-on source that cannot run says why (`waiting`,
// ingest/waiting.ts).
//
// v36 SOURCES (SP v36 PLAN S1, S4, S5, S7): a source is on only through an admin's action, recorded on its row. Every
// route that turns sources on (PATCH {enabled: true}, bulk enable, Enable all, an import run's Enable all, Add source
// with "Turn on now": `enabled` true, or absent, as the form's box is ticked by default) goes through sources.ts
// enableSources with the signed-in admin (enabled_by, enabled_at); Add source with the box unticked makes the source
// off. Run now and a run's Continue refuse a source that is off (service.ts, 409 MSG_INGEST_SOURCE_OFF). v3.6's one-time
// notice of the sources 0060 turned off: GET /api/admin/sources/turned-off, POST /api/admin/sources/turned-off/dismiss
// (turned-off.ts); the filter `turnedOff` lists them, and `enabled=waiting` the sources waiting for an admin.

const Id = z.coerce.number().int().positive();

export { BACKGROUND_IMPORT_ROWS } from './imports';

const name = z.string().trim().max(100, 'Keep the name under 100 characters.').optional();
const companyName = z.string().trim().max(200).optional();
/** v36 SOURCES (PLAN S4): Add source's "Turn on now" (true, or absent, as the form's box is ticked by default). */
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
/** v35 ADMIN (PLAN H7): a Workday career site from any page of it (its host, tenant and site are read from the address). */
const WorkdaySiteConfig = z.object({
  url: z.string().trim().min(1, 'Paste a page of the Workday career site.').max(2048, 'Paste a shorter address of the career site.'),
  companyName,
});
/**
 * v37 BOARDS (SP v37 PLAN B4): a BambooHR company, by its name or any address on its host
 * (https://acme.bamboohr.com/careers, .../careers/41).
 */
const BamboohrConfig = z.object({
  company: z.string().trim().min(1, "Enter the company's BambooHR name or careers address.").max(2048, 'Paste a shorter address.'),
  companyName,
});
/** v37 BOARDS (SP v37 PLAN I1): an iCIMS site, by its board (careers-acme), its host or any address on it. */
const IcimsConfig = z.object({
  board: z.string().trim().min(1, 'Enter the iCIMS site address (careers-acme.icims.com).').max(2048, 'Paste a shorter address.'),
  companyName,
});
/** The words of a BambooHR name or address TailorIT cannot read a company from. */
const NO_BAMBOOHR = "Enter the company's name on BambooHR, or an address on <company>.bamboohr.com.";
/** The words of an iCIMS address TailorIT cannot read a site from. */
const NO_ICIMS = "Enter the iCIMS site's address, such as careers-acme.icims.com.";

/**
 * v37 BOARDS: a BambooHR source's config as stored, or the field's refusal. v37 FIX-37B (the ux review's L1): never
 * BambooHR's own hosts (www.bamboohr.com, app.bamboohr.com): bamboohrCompany refuses their labels (v37 INT-2b: the one
 * list, adapters/bamboohr.ts BAMBOOHR_OWN_LABELS).
 */
function bamboohrConfig(input: z.infer<typeof BamboohrConfig>): Record<string, unknown> {
  const company = bamboohrCompany(input.company);
  if (!company) throw validationFailed(NO_BAMBOOHR, { 'config.company': 'Enter the name in <name>.bamboohr.com, or its address.' });
  return { company, ...(input.companyName ? { companyName: input.companyName } : {}) };
}

/** v37 BOARDS: an iCIMS source's config as stored, or the field's refusal. */
function icimsConfig(input: z.infer<typeof IcimsConfig>): Record<string, unknown> {
  const board = icimsBoardOf(input.board);
  if (!board) throw validationFailed(NO_ICIMS, { 'config.board': 'Enter an address on <name>.icims.com.' });
  return { board, ...(input.companyName ? { companyName: input.companyName } : {}) };
}

/** The words of a Workday address TailorIT cannot read a career site from. */
const NO_WORKDAY_SITE =
  'Paste a page of a Workday career site: an address on <company>.myworkdayjobs.com that names the site, or on wd<n>.myworkdaysite.com/recruiting/<company>/<site>.';
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

/**
 * A career site's config as stored (career/config.ts's reading of it), or the host field's refusal. v37 BOARDS: `kept`, a
 * career site's own host (its settings change; one an admin turned on before v3.7 may be on an iCIMS host).
 */
function careerSiteConfig(input: z.infer<typeof CareerSiteConfig>, kept: string | null = null): Record<string, unknown> {
  let checked: ReturnType<typeof careerSiteConfigOf>;
  try {
    checked = careerSiteConfigOf(input);
  } catch (error) {
    throw validationFailed((error as Error).message, { 'config.host': 'Give a host name TailorIT may read (careers.example.org).' });
  }
  // v37 BOARDS (SP v37 PLAN I1, I5): an iCIMS host is an iCIMS source's, never a career site's (one source per host).
  if (isIcimsBoardHost(checked.host) && checked.host !== kept) {
    throw validationFailed(`${checked.host} is an iCIMS site: add it as iCIMS.`, { 'config.host': 'Add this site as iCIMS.' });
  }
  return {
    host: checked.host,
    ...(checked.sitemaps.length > 0 ? { sitemaps: checked.sitemaps } : {}),
    ...(checked.postingPaths.length > 0 ? { postingPaths: checked.postingPaths } : {}),
    ...(checked.companyName ? { companyName: checked.companyName } : {}),
  };
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
  // v35 ADMIN (PLAN H7): a Workday career site; it runs by itself once BOT_USER_AGENT is set and robots.txt allows it.
  z.object({ kind: z.literal('workday_site'), name, enabled, config: WorkdaySiteConfig }),
  // v37 BOARDS (SP v37 PLAN B4, I1): a BambooHR company and an iCIMS site; each runs once BOT_USER_AGENT is set.
  z.object({ kind: z.literal('bamboohr'), name, enabled, config: BamboohrConfig }),
  z.object({ kind: z.literal('icims'), name, enabled, config: IcimsConfig }),
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
  // v37 FIX-37B (the beh review's F5): a note TailorIT can't store (a NUL, a control character) is refused with why.
  termsNote: z
    .string()
    .trim()
    .max(1000, 'Keep the note under 1,000 characters.')
    .refine((text) => !hasUnstorableText(text, true), "The note has characters that can't be stored: remove them.")
    .nullable()
    .optional(),
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

/**
 * POST /api/admin/sources: a new source of a kind an admin adds (a board, the lake, the demo jobs). v36 SOURCES (PLAN
 * S4): made off, then turned on by the admin (enableSources: `enabled_by`, `enabled_at`) unless "Turn on now" is unticked
 * (`enabled: false`); a source of a company that opted out stays off.
 */
async function createSource(deps: AppDeps, input: unknown, actor: AdminActor) {
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
    // v35 ADMIN (PLAN H7): named by its site (<host>/<site>, or <host>/recruiting/<tenant>/<site>) unless the admin names
    // it; one source per career site (a Found-by-import one is switched on in Sources instead).
    case 'workday_site': {
      const site = workdaySiteOfPage(body.config.url);
      if (!site) throw validationFailed(NO_WORKDAY_SITE, { 'config.url': 'Paste a page of the career site.' });
      config = { ...site, ...(body.config.companyName ? { companyName: body.config.companyName } : {}) };
      const board = boardNameOf('workday_site', config)!;
      const existing = (await sourcesOfBoard(db, 'workday_site', board)).find((source) => !isLinkKeeper(source));
      if (existing) {
        throw conflict(
          `TailorIT has a source of this career site already ("${existing.name}")${existing.enabled ? '' : ': switch it on in Sources'}.`,
        );
      }
      label = body.name || board;
      break;
    }
    // v37 BOARDS (SP v37 PLAN B4, I1, I5): named by the board unless the admin names it; one source per board (an iCIMS
    // site's career-site source an admin turned on counts: discovery/offer.ts sourcesOfBoards).
    case 'bamboohr':
    case 'icims': {
      config = body.kind === 'bamboohr' ? bamboohrConfig(body.config) : icimsConfig(body.config);
      const board = boardNameOf(body.kind, config)!;
      const existing = (await sourcesOfBoard(db, body.kind, board)).find((source) => !isLinkKeeper(source));
      if (existing) {
        // v37 FIX-37B (the ux review's L7): where it is and what state it is in (the admin is in Sources already).
        throw conflict(
          `TailorIT has this ${SOURCE_KIND_LABEL[body.kind]} site already: "${existing.name}", ${existing.enabled ? 'on' : 'off'}. ` +
            `Search the list for it${existing.enabled ? '' : ' to turn it on'}.`,
        );
      }
      label = body.name || board;
      break;
    }
  }
  const taken = () => conflict(`A ${SOURCE_KIND_LABEL[body.kind]} source named "${label}" already exists.`);
  if (await findSourceRecord(db, body.kind, label)) throw taken();
  // Null: the name was taken after the look (UNIQUE(kind, name)).
  const created = await insertSource(db, { kind: body.kind, name: label, config }, nowIso(deps));
  if (!created) throw taken();
  if (body.enabled !== false && !(await sourceOptedOut(db, created.id))) await enableSources(db, [created.id], actor, nowIso(deps), hostPace(deps)); // v36 SOURCES; v37 TRANSFER: its host's row
  return { body, source: (await adminSource(db, created.id, false, nowIso(deps), waitingIn(deps)))! }; // v35 ADMIN: why it waits
}

/** v35 ADMIN (PLAN H7): why each listed switched-on source waits (ingest/waiting.ts). */
const waitingIn = (deps: AppDeps): SourcesWaiting => (sources) => waitingOfSources(deps, sources);

/** v35 ADMIN: the words a bulk change gives a skipped row, from the constants. */
const bulkWords = (deps: AppDeps): BulkWords => ({
  optedOut: constantsOf(deps).message('MSG_INGEST_SOURCE_OPTED_OUT'),
  paused: constantsOf(deps).message('MSG_INGEST_SOURCE_PAUSED'),
  off: constantsOf(deps).message('MSG_INGEST_SOURCE_OFF'), // v36 SOURCES
  hostPaceMs: hostPace(deps), // v37 TRANSFER
  terms: (status) => constantsOf(deps).message('MSG_INGEST_SOURCE_TERMS', termsParams(status)), // v37 FIX-37B (E8)
});

/** v37 TRANSFER (PLAN T3): the pace of a host row an enable adds (enableSources): INGEST_HOST_MIN_INTERVAL_MS. */
const hostPace = (deps: AppDeps) => constantsOf(deps).get('INGEST_HOST_MIN_INTERVAL_MS');

/**
 * v37 TRANSFER (PLAN T2): the text of a sources file: the multipart `file` (the web; UPLOAD_MAX_MB), or a JSON body
 * {fileName?, content} (scripts, tests).
 */
function sourcesFileText(req: Request): { fileName: string; text: string } {
  const file = req.file;
  if (file) {
    const buffer = file.buffer;
    const text =
      buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.subarray(2).toString('utf16le') : buffer.toString('utf8');
    return { fileName: (file.originalname || 'sources.json').slice(0, 200), text };
  }
  const body = parseInput(AdminSourcesImportJsonBodySchema, req.body ?? {}, 'sources file');
  return { fileName: body.fileName, text: body.content };
}

/**
 * PATCH /api/admin/sources/:id: its name, whether it runs daily, whether it closes missing postings, its settings. v36
 * SOURCES (PLAN S1): turned on through enableSources, recording the admin (in the change's transaction).
 */
async function patchSource(
  deps: AppDeps,
  id: number,
  patch: z.infer<typeof PatchSourceBody>,
  running: (id: number) => boolean,
  actor: AdminActor, // v36 SOURCES
) {
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
      config = careerSiteConfig(parseInput(CareerSiteConfig, merged, 'source settings'), source.host ?? null); // v37 BOARDS: its own host kept
    } else if (source.kind === 'bamboohr') {
      // v37 BOARDS: its company (a name or an address) and employer name.
      config = { ...merged, ...bamboohrConfig(parseInput(BamboohrConfig, merged, 'source settings')) };
    } else if (source.kind === 'icims') {
      // v37 BOARDS: its site (a board, a host or an address) and employer name.
      config = { ...merged, ...icimsConfig(parseInput(IcimsConfig, merged, 'source settings')) };
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
  // v30 S1-API: its host follows its settings (a Lever site moved to the EU); a recorded terms check moves
  // terms_checked_at. v36 SOURCES: this statement only turns a source off; enableSources turns it on (due at once).
  const turnOn = patch.enabled === true && !source.enabled;
  await db.tx(
    async (t) => {
      await t.run(
        `UPDATE job_sources SET name = @name, enabled = CASE WHEN CAST(@turnOff AS boolean) THEN false ELSE enabled END,
           deactivate_missing = @deactivate, config = CAST(@config AS jsonb), host = @host, updated_at = CAST(@now AS timestamptz),
           terms_status = COALESCE(CAST(@termsStatus AS text), terms_status),
           terms_url = CASE WHEN CAST(@setUrl AS boolean) THEN CAST(@termsUrl AS text) ELSE terms_url END,
           terms_note = CASE WHEN CAST(@setNote AS boolean) THEN CAST(@termsNote AS text) ELSE terms_note END,
           terms_checked_at = CASE WHEN CAST(@terms AS boolean) THEN CAST(@now AS timestamptz) ELSE terms_checked_at END,
           priority = COALESCE(CAST(@priority AS smallint), priority)
         WHERE id = @id`,
        {
          id,
          name: nextName,
          turnOff: patch.enabled === false,
          deactivate: patch.deactivateMissing ?? source.deactivateMissing,
          config: JSON.stringify(config),
          host: hostOf(source.kind, config) ?? source.host ?? null,
          now,
          termsStatus: patch.termsStatus ?? null,
          setUrl: patch.termsUrl !== undefined,
          termsUrl: patch.termsUrl ?? null,
          setNote: patch.termsNote !== undefined,
          termsNote: patch.termsNote ?? null,
          terms,
          priority: patch.priority ?? null,
        },
      );
      if (turnOn) await enableSources(t, [id], actor, now, hostPace(deps)); // v36 SOURCES (PLAN S1); v37 TRANSFER: its host's row
    },
    { label: 'patch source' },
  );
  return adminSource(db, id, running(id), now, waitingIn(deps)); // v35 ADMIN: with why it waits
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
        closedNoteOf(deps, 'admin'), // v37 FIX-REV (D1): what waits on them in Review settles with them
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
  const upload: RequestHandler = (req, res, next) => getFileStore(deps).uploadSingle('file', { required: false })(req, res, next); // v37 TRANSFER
  return adminRouter(deps, {
    resource: 'job source',
    id: Id,
    // v35 ADMIN: each row with why it waits (a switched-on source that cannot run now).
    list: { query: AdminSourcesQuerySchema, run: (_deps, query) => listAdminSources(db, query, nowIso(deps), running, waitingIn(deps)) },
    bulk: {
      body: AdminSourcesBulkBodySchema,
      // v30 FIX-A: a source of a company that opted out is skipped with MSG_INGEST_SOURCE_OPTED_OUT's words. v31 RUNS: run
      // now skips a paused source with MSG_INGEST_SOURCE_PAUSED's. v36 SOURCES: an enable records the admin.
      run: (_deps, body, actor) => bulkSources(db, body, nowIso(deps), bulkWords(deps), actor),
    },
    get: (_deps, id) => adminSource(db, id, running(id), nowIso(deps), waitingIn(deps)),
    patch: { body: PatchSourceBody, run: (_deps, id, patch, actor) => patchSource(deps, id, patch, running, actor) },
    routes(router, { handle, audit }) {
      // v35 ADMIN (PLAN H6): Enable all / Disable all for the filter shown: its count for the confirm, then the change
      // (every match, in pages of ADMIN_BULK_MAX), audited once with its filter and counts.
      router.get(
        '/all/count',
        handle((req) => countSourcesAll(db, parseInput(AdminSourcesFilterSchema, req.query, 'query'))),
      );
      router.post(
        '/all',
        handle(async (req, actor) => {
          const body = parseInput(AdminSourcesAllBodySchema, req.body ?? {}, 'change');
          const filter = body.filter ?? AdminSourcesFilterSchema.parse({});
          const { result, changed } = await sourcesAll(db, body.action, filter, nowIso(deps), bulkWords(deps), actor); // v36 SOURCES: the admin
          await audit({ action: `${body.action}_all`, ids: ['all'], actor, change: { filter, matched: result.matched, changed } });
          return result;
        }),
      );

      // v36 SOURCES (PLAN S7): v3.6's one-time notice of the sources 0060 turned off, and its dismissal (every admin's).
      router.get(
        '/turned-off',
        handle(() => turnedOffNotice(db)),
      );
      router.post(
        '/turned-off/dismiss',
        handle(async (_req, actor) => {
          const answer = await dismissTurnedOff(db, actor.id, nowIso(deps));
          await audit({ action: 'dismiss_turned_off', ids: ['notice'], actor, change: null });
          return answer;
        }),
      );
      // end v36 SOURCES

      // v37 TRANSFER (PLAN T1, T2): the sources file. Export: the sources the filter shows, as a file to save (never
      // cached). Import: a preview of what the file would do, then the import (every source it makes is off and waits
      // for an admin; never enableSources), audited with its counts. source-transfer.ts holds the rules.
      router.get(
        '/export',
        handle(async (req) => {
          const filter = parseInput(AdminSourcesFilterSchema, req.query, 'query');
          const made = await exportSources(deps, filter, nowIso(deps));
          const res = req.res!;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Content-Disposition', contentDisposition(made.fileName));
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Sources-Left-Out', String(made.leftOut));
          res.status(200).send(`${JSON.stringify(made.file, null, 2)}
`);
          return undefined;
        }),
      );
      router.post(
        '/import/preview',
        upload,
        handle(async (req) => {
          const { fileName, text } = sourcesFileText(req);
          const file = readSourcesFile(deps, fileName, text);
          return (await planImport(db, file.fileName, file.entries)).result;
        }),
      );
      router.post(
        '/import',
        upload,
        handle(async (req, actor) => {
          const { fileName, text } = sourcesFileText(req);
          const file = readSourcesFile(deps, fileName, text);
          const { result, ids } = await importSources(deps, file.fileName, file.entries, nowIso(deps));
          await audit({ action: 'import_file', ids: ids.length > 0 ? ids : ['none'], actor, change: { fileName: result.fileName, counts: result.counts } });
          return result;
        }),
      );
      // end v37 TRANSFER

      // A route answering with its own status sets it on req.res; handle sends the JSON (or nothing once ended).
      router.post(
        '/',
        handle(async (req, actor) => {
          const { body, source } = await createSource(deps, req.body, actor);
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
          // v37 FIX-37B (SP v37 FIXES-37 E2, E8): a board a source of which has terms that don't allow automated access is
          // not read by a Test either (nothing sent): the words Run now gives.
          const board = body.kind === 'ft_lake' ? null : boardNameOf(body.kind, config);
          const refusal = board ? await termsRefusalOfBoards(db, [{ kind: body.kind, name: board }]) : null;
          if (refusal) {
            return { ok: false, message: constantsOf(deps).message('MSG_INGEST_SOURCE_TERMS', termsParams(refusal.status)), count: 0, samples: [], companyName: null };
          }
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

      // v31 RUNS: an admin pauses one source (its running run stops at its next safe point), and continues it.
      router.post(
        '/:id/pause',
        handle(async (req, actor) => {
          const id = parseInput(Id, req.params.id, 'source id');
          const source = await pauseSource(deps, id, actor);
          await audit({ action: 'pause', ids: [id], actor, change: null });
          return source;
        }),
      );
      router.post(
        '/:id/continue',
        handle(async (req, actor) => {
          const id = parseInput(Id, req.params.id, 'source id');
          const source = await continueSource(deps, id, actor);
          await audit({ action: 'continue', ids: [id], actor, change: null });
          return source;
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
    // v31 RUNS: with whether every run is paused (since when, by whom), for the Runs tab's header.
    list: {
      query: AdminRunsQuerySchema,
      run: async (_deps, query) => ({ ...(await adminRuns(deps.db, runsOptionsOf(query))), paused: await runsPausedState(deps.db) }),
    },
    get: (_deps, id) => adminRun(deps.db, id),
    // v31 RUNS: Pause and Continue, of every run and of one run (pause.ts), each audited.
    routes(router, { handle, audit }) {
      // v35 ADMIN (PLAN H6): an import run's Sources found, and Enable all / Disable all of the ones it made.
      router.get(
        '/:id/sources',
        handle(async (req) => {
          const id = parseInput(Id, req.params.id, 'run id');
          const found = await runSources(deps.db, id, waitingIn(deps));
          if (!found) throw notFound('That run');
          return found;
        }),
      );
      router.post(
        '/:id/sources',
        handle(async (req, actor) => {
          const id = parseInput(Id, req.params.id, 'run id');
          const body = parseInput(AdminRunSourcesBodySchema, req.body ?? {}, 'change');
          const done = await runSourcesAll(deps.db, id, body.action, nowIso(deps), bulkWords(deps), actor); // v36 SOURCES: the admin
          if (!done) throw notFound('That run');
          await audit({ action: `${body.action}_found_sources`, ids: [id], actor, change: { matched: done.result.matched, changed: done.changed } });
          return done.result;
        }),
      );
      router.post(
        '/pause',
        handle(async (_req, actor) => {
          const result = await pauseAllRuns(deps, actor);
          await audit({ action: 'pause', ids: ['all'], actor, change: { stopping: result.stopping } });
          return result;
        }),
      );
      router.post(
        '/continue',
        handle(async (_req, actor) => {
          const result = await continueAllRuns(deps, actor);
          await audit({ action: 'continue', ids: ['all'], actor, change: { resumed: result.resumed } });
          return result;
        }),
      );
      router.post(
        '/:id/pause',
        handle(async (req, actor) => {
          const id = parseInput(Id, req.params.id, 'run id');
          const run = await pauseRun(deps, id, actor);
          await audit({ action: 'pause', ids: [id], actor, change: null });
          return run;
        }),
      );
      router.post(
        '/:id/continue',
        handle(async (req, actor) => {
          const id = parseInput(Id, req.params.id, 'run id');
          const started = await continueRun(deps, id, actor);
          await audit({ action: 'continue', ids: [id], actor, change: started });
          req.res!.status(202);
          return started;
        }),
      );
    },
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
          return { ...result.body, links: importLinksNote(deps, table.columns, chosen.url) }; // v31 LINK2
        }),
      );
    },
  });
}
