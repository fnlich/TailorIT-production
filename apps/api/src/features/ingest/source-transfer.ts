import {
  ADMIN_SOURCES_IMPORT_OUTCOMES,
  hasUnstorableText, // v37 FIX-37B (F5)
  JOB_SOURCE_KIND_LABEL,
  SOURCES_FILE_FORMAT,
  SOURCES_FILE_UNSTORABLE, // v37 FIX-37B (F5)
  SOURCES_FILE_VERSION,
  SourcesFileEntrySchema,
  type AdminSourcesFilter,
  type AdminSourcesImportEntry,
  type AdminSourcesImportOutcome,
  type AdminSourcesImportResult,
  type JobSourceTermsStatus, // v37 FIX-37B (E3)
  type SourcesFile,
  type SourcesFileEntry,
} from '@tailorit/shared';
import { constantsOf } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
import type { DbQueries, SqlParams } from '../../core/db/types';
import { refuse } from '../../core/http/refuse';
import { HimalayasConfigSchema, himalayasCountry } from './adapters/himalayas';
import { JobicyConfigSchema } from './adapters/jobicy';
import { UsajobsConfigSchema } from './adapters/usajobs';
import { workdaySiteOf } from './adapters/workdaySite';
import { careerSiteConfigOf } from './career/config';
import { icimsBoardOf, isIcimsBoardHost } from './career/platforms'; // v37 INT-B (BOARDS I5)
import { careerSiteRefusalOfHost } from './career/platforms'; // v38 FIX-C (D3)
import { isOracleHost, oracleBoardOf, teamtailorCompany } from '@tailorit/shared/sourcing'; // v38 ATS-A; v38 FIX-A: Oracle
import { BOARD_KINDS, boardNameOf } from './discovery/boards';
import { BOARD_TRANSFER_KEYS } from './boards/index'; // v38 FRAME: the board registry
import { isLinkKeeper, sourcesOfBoards, type BoardRef } from './discovery/offer';
import { KIND_TERMS, newSourceValues, sourcesWhere } from './sources'; // v37 FIX-37B (E3): KIND_TERMS
import { SOURCE_KIND_LABEL, type SourceKind } from './types';

// v37 TRANSFER (SP v37 PLAN T1, T2, T4): Admin › Sources' sources file. Export writes the sources a filter shows (the
// list's own filter: sources.ts sourcesWhere) as a JSON file; Import reads one, previews what it would do, and makes the
// sources it names. The rules:
//   - A file carries a source's kind, name, board settings (TRANSFER_CONFIG_KEYS: an allow-list per kind), company name,
//     priority, close-missing and terms (status, link, note). Never an id, on or off, runs, counts, an admin's email, a
//     path on a server, or an internal mark (Add job's `addedBy`, the lake's `path`, the demo jobs' `anchor`, an import's
//     `sheet`, `mapping`, `fileName`). A kind that is never run (workday, page, ext_page), the lake, the demo jobs and an
//     import's records are left out: they are no board another TailorIT could read.
//   - Each entry is checked as Add source and discovery check a board: the same normalisers (discovery/boards.ts
//     BOARD_KINDS, which Add source's routes call too), Add source's schemas for the feeds (the adapters') and its
//     career-site check (career/config.ts), with Add source's caps on a name and a company name.
//   - The board is the key: a source that reads it already (any source but Add job's link keeper, discovery/offer.ts
//     isLinkKeeper) is left exactly as it is (`exists`); Add job's keeper of it is adopted (its mark goes, it stays off),
//     as an admin's import adopts one (import-sources.ts rememberImportBoard); a feed's key is its search settings. A name
//     another source of the kind holds (in any case) gets " (2)", " (3)"... (`renamed`).
//   - Every source made is OFF and waits for an admin: found via `file` ("Imported from a file", migration 0064), never
//     due, never turned on here (only an admin's action does: sources.ts enableSources). Its host is worked out from its
//     settings (newSourceValues: never the file's), and no host row is added (that comes when an admin turns it on).
//   - The preview and the import answer alike (planImport, the same reads); the import plans again inside its
//     transaction, under its own lock (one import at a time), and answers what it did.
//   - At most ADMIN_SOURCES_IMPORT_MAX entries a file; an export that would hold more is refused (an export always fits
//     an import).

/**
 * The kinds a sources file carries, each with the settings it keeps (its allow-list). A kind not here is never exported,
 * and an import answers its entries invalid. Every value kept is the board's own (a token, a site, a company's name on a
 * feed host, a career site's host and sitemaps, a feed's search): nothing secret (the feeds' keys live in .env).
 */
export const TRANSFER_CONFIG_KEYS: Readonly<Partial<Record<SourceKind, readonly string[]>>> = {
  // v38 FRAME (SP v38 PLAN A9): each board kind's are its board descriptor's `transferKeys` (Greenhouse's token, Lever's
  // site and region, a Workday career site's host, tenant and site, a feed ATS's company, iCIMS's board: its company name
  // travels at the entry level, as every kind's; a career site's host, sitemaps and posting paths), in the registry's
  // order; Workday's one-posting kind has none (never run).
  ...BOARD_TRANSFER_KEYS,
  usajobs: ['params'],
  himalayas: ['country'],
  jobicy: ['geo', 'industry', 'tag'],
};

/** The kinds a sources file carries (TRANSFER_CONFIG_KEYS' keys). */
export const TRANSFER_KINDS = Object.keys(TRANSFER_CONFIG_KEYS) as SourceKind[];

/** The feeds of many employers: no board names them, so their key is their search settings. */
const FEED_KINDS: readonly SourceKind[] = ['usajobs', 'himalayas', 'jobicy'];

const isTransferKind = (kind: string): kind is SourceKind => Object.hasOwn(TRANSFER_CONFIG_KEYS, kind);

/**
 * A kind's name in words ("Greenhouse"), or the kind as written when TailorIT knows none. v37 FIX-37B (the beh review's
 * F6): the labels' own kinds only ("constructor" and "__proto__" are no kind: never a label read off an object's prototype).
 */
function kindLabel(kind: string): string {
  if (Object.hasOwn(SOURCE_KIND_LABEL, kind)) return SOURCE_KIND_LABEL[kind as SourceKind];
  if (Object.hasOwn(JOB_SOURCE_KIND_LABEL, kind)) return JOB_SOURCE_KIND_LABEL[kind as keyof typeof JOB_SOURCE_KIND_LABEL];
  return kind;
}

/** v37 FIX-37B (F6): whether TailorIT knows the kind (an own key of the labels, never a prototype's). */
const isKnownKind = (kind: string): boolean => Object.hasOwn(JOB_SOURCE_KIND_LABEL, kind) || Object.hasOwn(SOURCE_KIND_LABEL, kind);

/**
 * v37 FIX-37B (the beh review's F5): whether a stored config holds a text TailorIT can't store (hasUnstorableText), in any
 * key or value, at most a few levels down (a stored config is a kind's allow-listed settings: shallow).
 */
function configUnstorable(config: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: config, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (typeof value === 'string') {
      if (hasUnstorableText(value)) return true;
    } else if (value && typeof value === 'object') {
      if (depth > 8) return true;
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (hasUnstorableText(key)) return true;
        stack.push({ value: inner, depth: depth + 1 });
      }
    }
  }
  return false;
}

/** Only the kind's own settings, those with a value. */
function allowed(kind: SourceKind, config: Record<string, unknown>): Record<string, unknown> {
  const keys = TRANSFER_CONFIG_KEYS[kind] ?? [];
  return Object.fromEntries(keys.filter((key) => config[key] !== undefined && config[key] !== null && config[key] !== '').map((key) => [key, config[key]]));
}

/** A JSON value with its objects' keys in order: two feeds' settings compare as text. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** A source's config column as an object ({} when it is not one). */
function configOfText(text: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

// ------------------------------------------------------------------------------------------------- export

/** An export: the file, its name, and how many sources the filter shows that a file does not carry. */
export interface SourcesExport {
  file: SourcesFile;
  fileName: string;
  leftOut: number;
}

interface ExportRow {
  kind: SourceKind;
  name: string;
  config: string;
  priority: number;
  deactivate_missing: boolean;
  terms_status: SourcesFile['sources'][number]['terms']['status'];
  terms_url: string | null;
  terms_note: string | null;
}

/** One source as a file carries it. */
function fileEntryOf(row: ExportRow): SourcesFile['sources'][number] {
  const config = configOfText(row.config);
  return {
    kind: row.kind,
    name: row.name,
    config: allowed(row.kind, config),
    companyName: textOf(config.companyName),
    priority: Number(row.priority ?? 0),
    deactivateMissing: row.deactivate_missing === true,
    terms: { status: row.terms_status, url: row.terms_url ?? null, note: row.terms_note ?? null },
  };
}

/** The file name of an export: tailorit-sources-YYYY-MM-DD.json (the day, UTC). */
export const exportFileName = (now: string) => `tailorit-sources-${now.slice(0, 10)}.json`;

/**
 * GET /api/admin/sources/export?<filter>: the sources the filter shows (Admin › Sources' list's own condition) that a
 * file carries, by kind and name. Refused (400, MSG_ADMIN_SOURCES_EXPORT_TOO_MANY) past ADMIN_SOURCES_IMPORT_MAX.
 */
export async function exportSources(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  filter: AdminSourcesFilter,
  now: string,
): Promise<SourcesExport> {
  const max = constantsOf(deps).get('ADMIN_SOURCES_IMPORT_MAX');
  const where = sourcesWhere(filter);
  const params = { ...where.params, transferKinds: TRANSFER_KINDS.join(',') } as SqlParams;
  const carried = "s.kind = ANY(string_to_array(@transferKinds, ','))";
  const counts = await deps.db.one<{ total: number; carried: number }>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE ${carried}) AS carried FROM job_sources s ${where.sql()}`,
    params,
  );
  const total = Number(counts?.total ?? 0);
  const count = Number(counts?.carried ?? 0);
  if (count > max) {
    throw refuse(deps, 'validation_failed', 'MSG_ADMIN_SOURCES_EXPORT_TOO_MANY', { count: count.toLocaleString('en-US'), max: max.toLocaleString('en-US') });
  }
  where.add(carried);
  const rows = await deps.db.all<ExportRow>(
    `SELECT s.kind, s.name, s.config::text AS config, s.priority, s.deactivate_missing, s.terms_status, s.terms_url, s.terms_note
     FROM job_sources s ${where.sql()} ORDER BY s.kind, lower(s.name), s.id LIMIT @limit`,
    { ...params, limit: max } as SqlParams,
  );
  return {
    file: { format: SOURCES_FILE_FORMAT, version: SOURCES_FILE_VERSION, exportedAt: now, sources: rows.map(fileEntryOf) },
    fileName: exportFileName(now),
    leftOut: total - rows.length,
  };
}

// ------------------------------------------------------------------------------------------------- reading a file

/** A file's entries, unchecked (each is checked on its own: a bad one is one invalid row). */
export interface SourcesFileRead {
  fileName: string;
  entries: unknown[];
}

/**
 * The entries of a sources file's text, or a refusal (400): MSG_ADMIN_SOURCES_FILE_INVALID for anything but a TailorIT
 * sources file (its format and version), MSG_ADMIN_SOURCES_FILE_TOO_MANY past ADMIN_SOURCES_IMPORT_MAX entries.
 */
export function readSourcesFile(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>, fileName: string, text: string): SourcesFileRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); // a byte order mark first
  } catch {
    parsed = null;
  }
  const file = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  if (!file || file.format !== SOURCES_FILE_FORMAT || file.version !== SOURCES_FILE_VERSION || !Array.isArray(file.sources)) {
    throw refuse(deps, 'validation_failed', 'MSG_ADMIN_SOURCES_FILE_INVALID');
  }
  const max = constantsOf(deps).get('ADMIN_SOURCES_IMPORT_MAX');
  if (file.sources.length > max) {
    throw refuse(deps, 'validation_failed', 'MSG_ADMIN_SOURCES_FILE_TOO_MANY', {
      count: file.sources.length.toLocaleString('en-US'),
      max: max.toLocaleString('en-US'),
    });
  }
  return { fileName, entries: file.sources };
}

// ------------------------------------------------------------------------------------------------- checking an entry

/** An entry that cannot be imported, and why (its words go to the preview's row). */
class EntryProblem extends Error {}

/** The words of a field's problem in an entry (the schema's own words where it has them). */
function issueWords(issue: { code: string; path: readonly PropertyKey[]; message: string }): string {
  const field = String(issue.path[0] ?? '');
  if (issue.code === 'custom' || (issue.message && !/^Invalid|^Too (big|small)|^Expected/i.test(issue.message))) return issue.message;
  switch (field) {
    case 'kind':
      return 'It names no kind of source.';
    case 'name':
      return 'Its name must be text.';
    case 'config':
      return 'Its settings must be an object.';
    case 'companyName':
      return 'Its company name must be text.';
    case 'priority':
      return 'Its priority must be a whole number from -100 to 100.';
    case 'deactivateMissing':
      return 'Its close-missing setting must be true or false.';
    case 'terms':
      return issue.path[1] === 'status' ? 'Its terms status is not one TailorIT knows.' : 'Its terms are not valid.';
    default:
      return 'It is not a source TailorIT can read.';
  }
}

/** A checked entry: what its source would be. */
interface CheckedEntry {
  kind: SourceKind;
  /** Its name (the file's, else the board's). */
  name: string;
  /** Its settings as stored (the board's own, a company name). */
  config: Record<string, unknown>;
  /** The board as discovery keeps it (boards), or a feed's settings as text: the key a source is looked up by. */
  board: string;
  priority: number;
  deactivateMissing: boolean;
  terms: SourcesFileEntry['terms'];
}

/** The board's settings, checked and as stored, and its key; or EntryProblem. */
function boardOf(kind: SourceKind, given: Record<string, unknown>): { config: Record<string, unknown>; board: string; label: string } {
  const config = allowed(kind, given);
  if (FEED_KINDS.includes(kind)) {
    // Add source's schemas for the feeds (the adapters'), and its rule: only the settings given are kept.
    const schema = { usajobs: UsajobsConfigSchema, himalayas: HimalayasConfigSchema, jobicy: JobicyConfigSchema }[kind as 'usajobs' | 'himalayas' | 'jobicy'];
    const parsed = schema.safeParse(config);
    if (!parsed.success) throw new EntryProblem(parsed.error.issues[0]?.message ?? `Its ${kindLabel(kind)} settings are not valid.`);
    const kept = Object.fromEntries(Object.entries(parsed.data as Record<string, unknown>).filter(([, value]) => value !== undefined && value !== ''));
    if (kind === 'himalayas') {
      try {
        himalayasCountry(kept);
      } catch (error) {
        throw new EntryProblem((error as Error).message);
      }
    }
    return { config: kept, board: JSON.stringify(canonical(kept)), label: SOURCE_KIND_LABEL[kind] };
  }
  if (kind === 'career_site') {
    // Add source's check of a career site (its host, sitemaps on its domain, posting paths).
    let checked: ReturnType<typeof careerSiteConfigOf>;
    try {
      checked = careerSiteConfigOf(config);
    } catch (error) {
      throw new EntryProblem((error as Error).message);
    }
    // v38 FIX-C (SP v38 FIXES-38 D3): a host TailorIT never reads (SuccessFactors, Phenom, JobDiva) is no career site.
    const neverRead = careerSiteRefusalOfHost(checked.host);
    if (neverRead) throw new EntryProblem(neverRead);
    const stored = {
      host: checked.host,
      ...(checked.sitemaps.length > 0 ? { sitemaps: checked.sitemaps } : {}),
      ...(checked.postingPaths.length > 0 ? { postingPaths: checked.postingPaths } : {}),
    };
    const board = boardNameOf('career_site', stored);
    if (!board) throw new EntryProblem('This career site names no host TailorIT may read.');
    return { config: stored, board, label: board };
  }
  const kindOf = BOARD_KINDS[kind];
  const board = kindOf ? boardNameOf(kind, config) : null;
  if (!kindOf || !board) throw new EntryProblem(`It names no ${kindLabel(kind)} board TailorIT reads.`);
  const stored: Record<string, unknown> = kindOf.configOf(board);
  if (kind === 'lever') {
    const region = config.region === undefined ? 'global' : String(config.region).toLowerCase();
    if (region !== 'global' && region !== 'eu') throw new EntryProblem('Its Lever region must be global or eu.');
    stored.region = region;
  }
  if (kind === 'workday_site') {
    try {
      workdaySiteOf(stored);
    } catch (error) {
      throw new EntryProblem((error as Error).message);
    }
  }
  return { config: stored, board, label: board };
}

/** One entry of a file, checked; or EntryProblem with why. */
/**
 * v37 INT-B (BOARDS B2, I3, I5; LAND re-imports the owner's v3.6 sources): terms a file brings that the owner's decision
 * of 2026-11-24 replaces, as migration 0063 does on a server updated in place: a BambooHR source's still unchecked with
 * no note, and an iCIMS site's that came as a career site with none recorded (no note, no link, unchecked or the career
 * sites' "allowed with conditions"). Such an entry takes its kind's terms (newSourceValues: the dated note); any other
 * keeps the file's.
 */
function decidedTerms(kind: SourceKind, given: SourcesFileEntry['kind'], terms: SourcesFileEntry['terms']): SourcesFileEntry['terms'] | null {
  if (!terms) return null;
  if (kind === 'bamboohr' && terms.status === 'unchecked' && !terms.note) return null;
  if (kind === 'icims' && given === 'career_site' && !terms.note && !terms.url && ['unchecked', 'allowed_with_conditions'].includes(terms.status)) return null;
  // v38 ATS-A: a Teamtailor company's that came as a career site, as migration 0065 converts them.
  if (kind === 'teamtailor' && given === 'career_site' && !terms.note && !terms.url && ['unchecked', 'allowed_with_conditions'].includes(terms.status)) return null;
  // v38 FIX-A (L15): an Oracle career site's that came as a career site, as migration 0066 converts them.
  if (kind === 'oracle' && given === 'career_site' && !terms.note && !terms.url && ['unchecked', 'allowed_with_conditions'].includes(terms.status)) return null;
  return terms;
}

/** v38 FIX-A (L15): a path or address naming an Oracle career site (/hcmUI/CandidateExperience/<lang>/sites/<site>). */
const ORACLE_SITE_PATH = /\/hcmUI\/CandidateExperience\/[A-Za-z0-9-]{2,12}\/sites\/([A-Za-z0-9_-]{1,40})(?:[/?#]|$)/;

/**
 * v38 FIX-A (SP v38 FIXES-38 item 12, REVIEW38-beh L15): the Oracle career site (<host>/<site>, its site as the file
 * writes it) a v3.7 file's career site on an Oracle Recruiting Cloud tenant's host reads, as migration 0066 converts
 * them: its sitemaps and posting paths name exactly one site; else the entry is refused with what to do.
 */
function oracleSiteOfCareerSite(host: string, config: Record<string, unknown>): string {
  const texts = [config.sitemaps, config.postingPaths].flatMap((value) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []));
  const sites = new Map<string, string>();
  for (const text of texts) {
    const site = ORACLE_SITE_PATH.exec(text)?.[1];
    if (site && !sites.has(site.toLowerCase())) sites.set(site.toLowerCase(), site);
  }
  const board = sites.size === 1 ? oracleBoardOf(`${host}/${[...sites.values()][0]!}`) : '';
  if (!board) {
    throw new EntryProblem(
      'This career site is on Oracle Recruiting Cloud: add it as Oracle Recruiting Cloud instead, with a page of the career site (its address has /sites/<site> in it).',
    );
  }
  return board;
}

function checkEntry(raw: unknown): CheckedEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new EntryProblem('It is not a source TailorIT can read.');
  const parsed = SourcesFileEntrySchema.safeParse(raw);
  if (!parsed.success) throw new EntryProblem(issueWords(parsed.error.issues[0]!));
  const entry = parsed.data;
  if (!isTransferKind(entry.kind)) {
    const known = isKnownKind(entry.kind); // v37 FIX-37B (F6)
    throw new EntryProblem(
      known ? `A ${kindLabel(entry.kind)} source can't be imported from a file.` : `It names a kind of source TailorIT doesn't know (${entry.kind.slice(0, 40)}).`,
    );
  }
  // v37 INT-B (BOARDS I5): a career site on an employer's iCIMS host is that iCIMS board now (as migration 0063 converts
  // them, and Add source refuses one): a v3.6 file (LAND re-imports the owner's) imports it as an iCIMS source.
  const host = entry.kind === 'career_site' ? String(entry.config.host ?? '') : '';
  const icims = host && isIcimsBoardHost(host) ? icimsBoardOf(host) : '';
  // v38 ATS-A (SP v38 WAVE2 item 7): a career site on a company's Teamtailor host is that Teamtailor company now (as
  // migration 0065 converts them, and Add source refuses one): a v3.7 file imports it as a Teamtailor source.
  const teamtailor = !icims && host ? teamtailorCompany(host) : '';
  // v38 FIX-A (L15): a career site on an Oracle Recruiting Cloud tenant's host is that Oracle career site now (as
  // migration 0066 converts them, and Add source refuses one): imported as an Oracle source, or refused with what to do.
  const oracle = !icims && !teamtailor && host && isOracleHost(host) ? oracleSiteOfCareerSite(host.toLowerCase(), entry.config) : '';
  const kind: SourceKind = icims ? 'icims' : teamtailor ? 'teamtailor' : oracle ? 'oracle' : entry.kind;
  const { config, board, label } = boardOf(kind, icims ? { board: icims } : teamtailor ? { company: teamtailor } : oracle ? { site: oracle } : entry.config);
  // v37 FIX-37B (F5): a setting that can't be stored (a NUL, a control character) refuses the entry, never the file.
  if (configUnstorable(config)) throw new EntryProblem(SOURCES_FILE_UNSTORABLE);
  const company = textOf(entry.companyName);
  return {
    kind,
    name: entry.name || label,
    config: company ? { ...config, companyName: company } : config,
    board,
    priority: entry.priority,
    deactivateMissing: entry.deactivateMissing,
    terms: decidedTerms(kind, entry.kind, entry.terms), // v37 INT-B
  };
}

// ------------------------------------------------------------------------------------------------- the plan

/** One entry's plan: its answer, and what an import writes for it. */
interface PlannedEntry {
  answer: AdminSourcesImportEntry;
  /** A new source (new, renamed). */
  make?: CheckedEntry & { finalName: string };
  /** Add job's keeper of the board, adopted. */
  adopt?: CheckedEntry & { id: number; config: Record<string, unknown> };
  /** `exists` because an earlier entry of this file makes (or adopts) the board: that entry. */
  sameAs?: PlannedEntry;
}

/** A board's key in this file (kind and board, in lower case: lookups compare boards in any case). */
const keyOf = (kind: string, board: string) => `${kind}\n${board.toLowerCase()}`;

/** How many " (n)" names are looked up at once for one name another source holds. */
const SUFFIX_BATCH = 10;

/**
 * Of `wanted` (kind and name), those some source of the kind holds, in any case: `<kind>\n<name in lower case>`. One
 * statement for the whole list (idx_job_sources_name_ci).
 */
async function namesTaken(db: DbQueries, wanted: ReadonlyArray<{ kind: string; name: string }>): Promise<Set<string>> {
  if (wanted.length === 0) return new Set();
  const rows = await db.all<{ kind: string; name: string }>(
    `SELECT DISTINCT s.kind, lower(s.name) AS name
     FROM json_to_recordset(CAST(? AS json)) AS b(kind text, name text)
     JOIN job_sources s ON s.kind = b.kind AND lower(s.name) = lower(b.name)`,
    [JSON.stringify(wanted)],
  );
  return new Set(rows.map((row) => `${row.kind}\n${row.name}`));
}

/** The feeds' sources there now, by their key (their settings as text). */
async function feedSources(db: DbQueries, kinds: readonly SourceKind[]): Promise<Map<string, { id: number; name: string }>> {
  const found = new Map<string, { id: number; name: string }>();
  if (kinds.length === 0) return found;
  const rows = await db.all<{ id: number; kind: SourceKind; name: string; config: string }>(
    "SELECT id, kind, name, config::text AS config FROM job_sources WHERE kind = ANY(string_to_array(?, ',')) ORDER BY id",
    [kinds.join(',')],
  );
  for (const row of rows) {
    let key: string;
    try {
      key = keyOf(row.kind, boardOf(row.kind, configOfText(row.config)).board);
    } catch {
      continue;
    }
    if (!found.has(key)) found.set(key, { id: Number(row.id), name: row.name });
  }
  return found;
}

/**
 * What an import of these entries does now (the preview's answer, and the import's plan): each entry checked, looked up
 * by its board (one statement for every board, one for the feeds), named. Reads only.
 */
export async function planImport(db: DbQueries, fileName: string, raws: readonly unknown[]): Promise<{ result: AdminSourcesImportResult; plan: PlannedEntry[] }> {
  const checked = raws.map((raw) => {
    try {
      return { entry: checkEntry(raw) };
    } catch (error) {
      if (error instanceof EntryProblem) return { problem: error.message };
      throw error;
    }
  });
  const nameOfRaw = (raw: unknown, entry?: CheckedEntry) => {
    if (entry) return entry.name;
    const name = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).name : null;
    return typeof name === 'string' ? name.trim().slice(0, 200) : '';
  };
  const kindOfRaw = (raw: unknown) => {
    const kind = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).kind : null;
    return typeof kind === 'string' ? kind.trim().slice(0, 40) : '';
  };

  // The sources that read each board now (boards), and the feeds' sources.
  const boards: BoardRef[] = [];
  const boardAt = new Map<string, number>();
  for (const { entry } of checked) {
    if (!entry || FEED_KINDS.includes(entry.kind)) continue;
    const key = keyOf(entry.kind, entry.board);
    if (!boardAt.has(key)) {
      boardAt.set(key, boards.length);
      boards.push({ kind: entry.kind as BoardRef['kind'], name: entry.board });
    }
  }
  const sources = await sourcesOfBoards(db, boards);
  const feeds = await feedSources(db, [...new Set(checked.flatMap(({ entry }) => (entry && FEED_KINDS.includes(entry.kind) ? [entry.kind] : [])))]);

  const plan: PlannedEntry[] = [];
  /** Each board an entry of this file named, by key: that entry's plan. */
  const seen = new Map<string, PlannedEntry>();
  for (const [at, item] of checked.entries()) {
    const index = at + 1;
    const raw = raws[at];
    const base = { index, kind: item.entry?.kind ?? kindOfRaw(raw), kindLabel: kindLabel(item.entry?.kind ?? kindOfRaw(raw)), name: nameOfRaw(raw, item.entry) };
    if (!item.entry) {
      plan.push({ answer: { ...base, outcome: 'invalid', sourceName: null, sourceId: null, reason: item.problem ?? null, terms: null } });
      continue;
    }
    const entry = item.entry;
    const key = keyOf(entry.kind, entry.board);
    const earlier = seen.get(key);
    if (earlier) {
      // The board again: the source the earlier entry found there, or the one it makes or adopts.
      const there = earlier.answer.outcome === 'exists';
      plan.push({
        answer: {
          ...base,
          outcome: 'exists',
          sourceName: earlier.answer.sourceName,
          sourceId: there ? earlier.answer.sourceId : null,
          reason: there ? null : `Entry ${earlier.answer.index} of this file adds it.`,
          terms: null,
        },
        ...(there ? {} : { sameAs: earlier }),
      });
      continue;
    }
    const feed = FEED_KINDS.includes(entry.kind);
    const list = feed ? [] : (sources.get(`${entry.kind}\n${entry.board}`) ?? []);
    const reading = feed ? feeds.get(key) : list.find((source) => !isLinkKeeper(source));
    const keeper = reading ? undefined : list.find(isLinkKeeper);
    let planned: PlannedEntry;
    if (reading) {
      planned = { answer: { ...base, outcome: 'exists', sourceName: reading.name, sourceId: reading.id, reason: null, terms: null } };
    } else if (keeper) {
      // Add job's mark goes; the board's own settings and the file's company name are written; it stays off.
      const kept = Object.fromEntries(Object.entries(keeper.config).filter(([name]) => name !== 'addedBy'));
      planned = {
        answer: { ...base, outcome: 'new', sourceName: keeper.name, sourceId: null, reason: null, terms: termsOf(entry, keeper.termsStatus) },
        adopt: { ...entry, id: keeper.id, config: { ...entry.config, ...kept, ...allowed(entry.kind, entry.config) } },
      };
    } else {
      planned = {
        answer: { ...base, outcome: 'new', sourceName: entry.name, sourceId: null, reason: null, terms: termsOf(entry, null) },
        make: { ...entry, finalName: entry.name },
      };
    }
    seen.set(key, planned);
    plan.push(planned);
  }

  await nameNewSources(db, plan);
  return { result: resultOf(fileName, plan, false), plan };
}

/**
 * v37 FIX-37B (SP v37 FIXES-37 E3): the terms a new source of an entry gets, as the preview shows them: the file's, kept
 * as written (`fromFile`); else an adopted keeper's own (`kept`), or its kind's record (KIND_TERMS: the owner's decided
 * BambooHR and iCIMS terms among them; a kind with none starts Not checked).
 */
function termsOf(entry: CheckedEntry, kept: string | null | undefined): { status: JobSourceTermsStatus; fromFile: boolean } {
  if (entry.terms) return { status: entry.terms.status, fromFile: true };
  const status = (kept ?? KIND_TERMS[entry.kind]?.status ?? 'unchecked') as JobSourceTermsStatus;
  return { status, fromFile: false };
}

/** The answer of a plan: its entries' answers, counted (an entry pointing at an earlier one takes its name). */
function resultOf(fileName: string, plan: readonly PlannedEntry[], imported: boolean): AdminSourcesImportResult {
  for (const item of plan) if (item.sameAs) item.answer.sourceName = item.sameAs.answer.sourceName;
  const counts = Object.fromEntries(ADMIN_SOURCES_IMPORT_OUTCOMES.map((outcome) => [outcome, 0])) as Record<AdminSourcesImportOutcome, number>;
  for (const item of plan) counts[item.answer.outcome] += 1;
  return { fileName, total: plan.length, counts, entries: plan.map((item) => ({ ...item.answer })), imported };
}

/**
 * Names the new sources: the name they ask for, unless a source of the kind holds it (in any case) or an earlier entry
 * of this file takes it; then the first free " (n)" from 2 on (renamed). Entries of this file that point at a renamed
 * one (`exists`, "Entry 3 of this file adds it") get its name too.
 */
async function nameNewSources(db: DbQueries, plan: PlannedEntry[]): Promise<void> {
  const making = plan.filter((item) => item.make);
  const planned = new Set<string>();
  // The names the adopted keepers keep are taken too.
  for (const item of plan) if (item.adopt) planned.add(`${item.adopt.kind}\n${item.answer.sourceName!.toLowerCase()}`);
  const taken = await namesTaken(
    db,
    making.map((item) => ({ kind: item.make!.kind, name: item.make!.name })),
  );
  let waiting: PlannedEntry[] = [];
  for (const item of making) {
    const key = `${item.make!.kind}\n${item.make!.name.toLowerCase()}`;
    if (taken.has(key) || planned.has(key)) waiting.push(item);
    else planned.add(key);
  }
  for (let from = 2; waiting.length > 0; from += SUFFIX_BATCH) {
    const tries = waiting.flatMap((item) =>
      Array.from({ length: SUFFIX_BATCH }, (_, n) => ({ kind: item.make!.kind, name: `${item.make!.name} (${from + n})` })),
    );
    const held = await namesTaken(db, tries);
    const still: PlannedEntry[] = [];
    for (const item of waiting) {
      const free = Array.from({ length: SUFFIX_BATCH }, (_, n) => `${item.make!.name} (${from + n})`).find((name) => {
        const key = `${item.make!.kind}\n${name.toLowerCase()}`;
        return !held.has(key) && !planned.has(key);
      });
      if (!free) {
        still.push(item);
        continue;
      }
      planned.add(`${item.make!.kind}\n${free.toLowerCase()}`);
      item.make!.finalName = free;
      item.answer.outcome = 'renamed';
      item.answer.sourceName = free;
    }
    waiting = still;
  }
}

// ------------------------------------------------------------------------------------------------- the import

/** The lock one import holds for its transaction (two imports of one file never make one board twice). */
const IMPORT_LOCK_KEY = 'tailorit:sources-file-import';

/** The row values of a new source from a file, past newSourceValues' (found via `file`, its priority, its terms). */
function newRowOf(made: CheckedEntry & { finalName: string }, index: number, now: string) {
  // v37 INT-B (BOARDS): newSourceValues' 12th value is the kind's dated terms note (BambooHR's, iCIMS's), for an entry
  // that brings no terms of its own.
  const [kind, name, config, deactivate, host, termsStatus, termsUrl, termsCheckedAt, robots, , , kindNote] = newSourceValues(
    { kind: made.kind, name: made.finalName, config: made.config, deactivateMissing: made.deactivateMissing },
    now,
  );
  const terms = made.terms;
  return {
    i: index,
    kind,
    name,
    config: JSON.parse(String(config)) as Record<string, unknown>,
    deactivate_missing: deactivate,
    host,
    terms_status: terms ? terms.status : termsStatus,
    terms_url: terms ? (terms.url ?? null) : termsUrl,
    terms_note: terms ? (terms.note ?? null) : typeof kindNote === 'string' ? kindNote : null, // v37 INT-B
    terms_checked_at: terms ? now : termsCheckedAt,
    robots_status: robots,
    priority: made.priority,
  };
}

/** Inserts the rows (each off: the column's default); answers the ones made, by `<kind>\n<name>`. */
async function insertRows(t: DbQueries, rows: ReadonlyArray<ReturnType<typeof newRowOf>>, now: string): Promise<Map<string, number>> {
  const made = new Map<string, number>();
  if (rows.length === 0) return made;
  const inserted = await t.all<{ id: number; kind: string; name: string }>(
    `INSERT INTO job_sources(kind, name, config, deactivate_missing, host, terms_status, terms_url, terms_note, terms_checked_at,
       robots_status, priority, discovered_via, created_at, updated_at)
     SELECT r.kind, r.name, r.config, r.deactivate_missing, r.host, r.terms_status, r.terms_url, r.terms_note,
       CAST(r.terms_checked_at AS timestamptz), r.robots_status, r.priority, 'file', CAST(@now AS timestamptz), CAST(@now AS timestamptz)
     FROM json_to_recordset(CAST(@rows AS json)) AS r(i integer, kind text, name text, config jsonb, deactivate_missing boolean, host text,
       terms_status text, terms_url text, terms_note text, terms_checked_at text, robots_status text, priority smallint)
     ORDER BY r.i
     ON CONFLICT (kind, name) DO NOTHING
     RETURNING id, kind, name`,
    { rows: JSON.stringify(rows), now },
  );
  for (const row of inserted) made.set(`${row.kind}\n${row.name}`, Number(row.id));
  return made;
}

/**
 * POST /api/admin/sources/import: plans the entries again inside one transaction, under the import's lock, and makes the
 * new sources (off, waiting for an admin, found via `file`), adopts Add job's keepers, and leaves every other source as
 * it is. Answers what it did (the preview's answer, `imported` true) and the ids it made or adopted (for the audit).
 */
export async function importSources(
  deps: Pick<AppDeps, 'db'>,
  fileName: string,
  raws: readonly unknown[],
  now: string,
): Promise<{ result: AdminSourcesImportResult; ids: number[] }> {
  return deps.db.tx(
    async (t) => {
      await t.run('SELECT pg_advisory_xact_lock(hashtext(?))', [IMPORT_LOCK_KEY]);
      const { result, plan } = await planImport(t, fileName, raws);
      const ids: number[] = [];
      for (const item of plan) {
        if (!item.adopt) continue;
        const adopted = await t.one<{ id: number }>(
          `UPDATE job_sources SET config = CAST(@config AS jsonb), discovered_via = 'file', priority = @priority,
             deactivate_missing = @deactivate, updated_at = CAST(@now AS timestamptz),
             terms_status = COALESCE(CAST(@termsStatus AS text), terms_status),
             terms_url = CASE WHEN CAST(@terms AS boolean) THEN CAST(@termsUrl AS text) ELSE terms_url END,
             terms_note = CASE WHEN CAST(@terms AS boolean) THEN CAST(@termsNote AS text) ELSE terms_note END,
             terms_checked_at = CASE WHEN CAST(@terms AS boolean) THEN CAST(@now AS timestamptz) ELSE terms_checked_at END
           WHERE id = @id AND NOT enabled AND enabled_at IS NULL AND discovered_via IS NULL AND config->>'addedBy' = 'autofill'
           RETURNING id`,
          {
            id: item.adopt.id,
            config: JSON.stringify(item.adopt.config),
            priority: item.adopt.priority,
            deactivate: item.adopt.deactivateMissing,
            now,
            terms: item.adopt.terms !== null && item.adopt.terms !== undefined,
            termsStatus: item.adopt.terms?.status ?? null,
            termsUrl: item.adopt.terms?.url ?? null,
            termsNote: item.adopt.terms?.note ?? null,
          },
        );
        // An admin turned it on meanwhile: it reads the board now, and is left as it is.
        if (adopted) ids.push(Number(adopted.id));
        else Object.assign(item.answer, { outcome: 'exists', sourceId: item.adopt.id, reason: null });
      }
      const rows = plan.flatMap((item) => (item.make ? [newRowOf(item.make, item.answer.index, now)] : []));
      const made = await insertRows(t, rows, now);
      for (const item of plan) {
        if (!item.make) continue;
        let id = made.get(`${item.make.kind}\n${item.make.finalName}`);
        // A source took the name since the plan (another way of adding sources): the next free " (n)".
        for (let n = 2; id === undefined; n += 1) {
          const name = `${item.make.name} (${n})`;
          if ((await namesTaken(t, [{ kind: item.make.kind, name }])).size > 0) continue;
          id = (await insertRows(t, [newRowOf({ ...item.make, finalName: name }, item.answer.index, now)], now)).get(`${item.make.kind}\n${name}`);
          if (id !== undefined) Object.assign(item.answer, { outcome: 'renamed', sourceName: name });
        }
        ids.push(id);
      }
      return { result: resultOf(result.fileName, plan, true), ids };
    },
    { label: 'import sources file' },
  );
}
