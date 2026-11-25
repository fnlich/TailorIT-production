import type { AddablePosting } from '@tailorit/shared/autofill';
import { nowIso, type AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { ashbyBoard } from './adapters/ashby';
import { greenhouseToken } from './adapters/greenhouse';
import { leverSite } from './adapters/lever';
import { workableAccount } from './adapters/workable';
import { workdaySiteOf } from './adapters/workdaySite';
import { boardNameOf, boardOfUrl, candidateName } from './discovery/boards';
import { bamboohrCompany } from './adapters/bamboohr'; // v37 BOARDS
import { icimsBoardOf } from './career/platforms'; // v37 BOARDS
import { isLinkKeeper, sourcesOfBoard } from './discovery/offer';
import { NEW_SOURCE_COLUMNS, NEW_SOURCE_PLACEHOLDERS, newSourceValues } from './sources';
import { IngestError } from './types';

// v3.5 ADMIN (PLAN H6, the contract with IMPORT): the boards an admin's import found. A link an admin import read names
// a board TailorIT reads in full (a Greenhouse, Lever, Ashby or Workable board, or a Workday career site): IMPORT calls
// rememberImportBoard for it, in its own transaction, once the row was read.
//   - No source reads that board: it becomes one, switched OFF (enabled = false, no next run) and marked Found by import
//     (discovered_via `import`, migration 0058), named as discovery names a board ("acme", "acme (2)" when another
//     source holds the name). A disabled source Add job made only to keep that board's links (isLinkKeeper: config
//     addedBy 'autofill') is adopted instead: its mark goes, it is marked Found by import, and it stays off. Either way
//     `created` is true.
//   - A source reads it already (on, or off by an admin's hand or after failures): it is left exactly as it is (never
//     switched off, never renamed, never marked), and `created` is false.
// Either way the run and the source are noted (job_source_import_finds): Admin › Runs lists the run's Sources found,
// and its Enable all / Disable all act on the ones it made. A Found-by-import source runs only once an admin switches it
// on (PATCH /api/admin/sources/:id, the selection's or the filter's Enable, or the run's Enable all): discovery's
// validation never switches it on (it is no link keeper: discovery/offer.ts), and v3.6 made that true of every source
// (SP v36 PLAN S1: only an admin's action turns a source on, through sources.ts enableSources).
// A board of a company that opted out still becomes a source, off: the opt-out gate keeps it off and unread.

/**
 * The kinds of board an import may find (a board TailorIT reads in full). v37 BOARDS (SP v37 PLAN B4, I4): a BambooHR
 * company and an iCIMS site too (importBoardOfUrl names them from a link).
 */
export const IMPORT_BOARD_KINDS = ['greenhouse', 'lever', 'ashby', 'workable', 'workday_site', 'bamboohr', 'icims'] as const;
/** v37 BOARDS: the refusal of a board kind an import does not find. */
const NO_IMPORT_KIND =
  'An import finds only Greenhouse, Lever, Ashby and Workable boards, Workday career sites, BambooHR companies and iCIMS sites.';
export type ImportBoardKind = (typeof IMPORT_BOARD_KINDS)[number];

/** A board an import found, as rememberImportBoard takes it. */
export interface ImportBoardInput {
  kind: ImportBoardKind;
  /** The board as its address names it (a token, site, board, account; a Workday site's <host>/<site>). */
  name: string;
  /** Its source config (the board's key, Lever's region, a Workday site's host, tenant and careerSite). */
  config: Record<string, unknown>;
  /** The company the import's row or read named, kept as the source's companyName when its config names none. */
  companyName?: string | null;
  /** The import's run (job_source_runs.id of its csv or json record): its Sources found. */
  runId: number | null;
}

/** What rememberImportBoard did: the board's source, and whether this import made it (or adopted Add job's keeper). */
export interface ImportBoardResult {
  sourceId: number;
  created: boolean;
}

/** The longest company name a source's config keeps (the admin's Add source takes the same). */
const COMPANY_NAME_MAX = 200;

/** The config a board's source reads, from what the import gave (only the kind's own keys), or IngestError. */
function boardConfigOf(input: ImportBoardInput): Record<string, unknown> {
  const config = input.config ?? {};
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const named = (value: string, what: string) => {
    if (!value) throw new IngestError(`The import named no ${what}.`);
    return value;
  };
  switch (input.kind) {
    case 'greenhouse':
      return { token: named(greenhouseToken(text(config.token) || input.name), 'Greenhouse board') };
    case 'lever':
      return {
        site: named(leverSite(text(config.site) || input.name), 'Lever site'),
        region: text(config.region).toLowerCase() === 'eu' ? 'eu' : 'global',
      };
    case 'ashby':
      return { board: named(ashbyBoard(text(config.board) || input.name), 'Ashby board') };
    case 'workable':
      return { account: named(workableAccount(text(config.account) || input.name), 'Workable account') };
    case 'workday_site': {
      const site = workdaySiteOf(config);
      return { host: site.host, tenant: site.tenant, careerSite: site.careerSite };
    }
    // v37 BOARDS
    case 'bamboohr':
      return { company: named(bamboohrCompany(text(config.company) || input.name), 'BambooHR company') };
    case 'icims':
      return { board: named(icimsBoardOf(text(config.board) || input.name), 'iCIMS site') };
    default:
      throw new IngestError(NO_IMPORT_KIND);
  }
}

/** The import's company name, trimmed and capped; null for none. */
function companyNameOf(value: string | null | undefined): string | null {
  const name = (value ?? '').replace(/\s+/g, ' ').trim().slice(0, COMPANY_NAME_MAX);
  return name || null;
}

/** Notes that the run found the source (made by it or not); a later note of the same pair keeps `created` if either said so. */
async function noteFind(t: DbQueries, runId: number | null, sourceId: number, created: boolean, at: string): Promise<void> {
  if (runId === null || runId === undefined) return;
  await t.run(
    `INSERT INTO job_source_import_finds(run_id, source_id, created, found_at) VALUES (?, ?, ?, CAST(? AS timestamptz))
     ON CONFLICT (run_id, source_id) DO UPDATE SET created = job_source_import_finds.created OR excluded.created`,
    [runId, sourceId, created, at],
  );
}

/**
 * The board's source for an admin's import, in the caller's transaction (see the top): made switched off and marked
 * Found by import when no source reads it (Add job's link keeper adopted), else the source that reads it, untouched.
 * Throws IngestError for a board it cannot name.
 */
export async function rememberImportBoard(
  deps: Pick<AppDeps, 'now'>,
  t: DbQueries,
  input: ImportBoardInput,
): Promise<ImportBoardResult> {
  if (!(IMPORT_BOARD_KINDS as readonly string[]).includes(input.kind)) throw new IngestError(NO_IMPORT_KIND); // v37 BOARDS
  const board = boardConfigOf(input);
  const name = boardNameOf(input.kind, board) ?? candidateName(input.kind, input.name);
  if (!name) throw new IngestError('The import named no board TailorIT reads.');
  const company = companyNameOf(input.companyName ?? (typeof input.config?.companyName === 'string' ? input.config.companyName : null));
  const config = company ? { ...board, companyName: company } : board;
  const at = nowIso(deps);
  for (let n = 1; ; n += 1) {
    const sources = await sourcesOfBoard(t, input.kind, name);
    const reading = sources.find((source) => !isLinkKeeper(source));
    if (reading) {
      await noteFind(t, input.runId, reading.id, false, at);
      return { sourceId: reading.id, created: false };
    }
    const keeper = sources.find(isLinkKeeper);
    if (keeper) {
      // Add job's mark goes (it is no keeper any more: discovery leaves it alone); its board's own keys and a company
      // name it lacked are written; it stays off, and is due only once an admin switches it on.
      const kept = Object.fromEntries(Object.entries(keeper.config).filter(([key]) => key !== 'addedBy'));
      const merged = { ...config, ...kept, ...board };
      const adopted = await t.one<{ id: number }>(
        `UPDATE job_sources SET config = CAST(? AS jsonb), discovered_via = 'import', updated_at = CAST(? AS timestamptz)
         WHERE id = ? AND NOT enabled RETURNING id`,
        [JSON.stringify(merged), at, keeper.id],
      );
      // Switched on meanwhile (by an admin: v36 SOURCES, nothing else turns a source on): it reads the board now; look
      // again.
      if (!adopted) continue;
      await noteFind(t, input.runId, keeper.id, true, at);
      return { sourceId: keeper.id, created: true };
    }
    const label = n === 1 ? name : `${name} (${n})`;
    const made = await t.one<{ id: number }>(
      `INSERT INTO ${NEW_SOURCE_COLUMNS} VALUES (${NEW_SOURCE_PLACEHOLDERS}) ON CONFLICT(kind, name) DO NOTHING RETURNING id`,
      newSourceValues({ kind: input.kind, name: label, config }, at),
    );
    // Null: another source holds the name (another board's, or this board's made by an import at the same moment: the
    // next look finds it).
    if (!made) continue;
    await t.run("UPDATE job_sources SET discovered_via = 'import' WHERE id = ?", [made.id]);
    await noteFind(t, input.runId, made.id, true, at);
    return { sourceId: made.id, created: true };
  }
}

/**
 * The board a read posting's link names, as rememberImportBoard takes it (its run left to the caller), or null: a
 * Greenhouse, Lever, Ashby or Workable board, or a Workday posting's career site (its host, tenant and site).
 */
export function importBoardOfPosting(posting: AddablePosting | null): Omit<ImportBoardInput, 'runId' | 'companyName'> | null {
  if (!posting) return null;
  switch (posting.kind) {
    case 'greenhouse':
      return { kind: 'greenhouse', name: posting.board, config: { token: posting.board } };
    case 'lever':
      return { kind: 'lever', name: posting.board, config: { site: posting.board, region: posting.region } };
    case 'ashby':
      return { kind: 'ashby', name: posting.board, config: { board: posting.board } };
    case 'workable':
      return { kind: 'workable', name: posting.board, config: { account: posting.board } };
    case 'workday': {
      if (!posting.workday) return null;
      const { host, site } = posting.workday;
      const shared = host.endsWith('.myworkdaysite.com');
      return {
        kind: 'workday_site',
        name: shared ? `${host}/recruiting/${posting.board}/${site}` : `${host}/${site}`,
        config: { host, tenant: posting.board, careerSite: site },
      };
    }
    default:
      return null;
  }
}

/**
 * v37 BOARDS (SP v37 PLAN B4, I4): the BambooHR company or iCIMS site a link names (any page on its host that names it:
 * a BambooHR careers page, any iCIMS page), as rememberImportBoard takes it, or null (the other boards come from
 * importBoardOfPosting). For an admin import's link, whatever its read gave (C7).
 */
export function importBoardOfUrl(address: string): Omit<ImportBoardInput, 'runId' | 'companyName'> | null {
  const board = boardOfUrl(address);
  if (board?.kind === 'bamboohr') return { kind: 'bamboohr', name: board.name, config: { company: board.name } };
  if (board?.kind === 'icims') return { kind: 'icims', name: board.name, config: { board: board.name } };
  return null;
}
