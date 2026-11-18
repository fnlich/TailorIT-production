import { boardAlias, constantDefault, type ConstantKey, type ConstantValue } from '@tailorit/shared';
import { parseAtsUrl } from '@tailorit/shared/autofill';
import { constantsOf } from '../../core/constants/index';
import type { AppDeps } from '../../core/context';
import { covered, dayOf, dayRange, JOB_POSTINGS_RAW, listPartitions } from '../../core/db/pg/maintenance/partitions';
import type { DbClient, DbTx } from '../../core/db/types';
import { jobReviews, resolveCompany } from '../../core/seams';
import { DETERMINISTIC_VERSION } from '../job-analysis/deterministic';
import { applyAiFacts, fillFacets, refreshAnalysisLinks, saveAnalysis } from '../job-analysis/store';
import { writeJobText } from '../jobs/text';
// v30 E0-API: the company through companies/resolve.ts (companies' v2.0 columns are gone: migrations-pg/0014).
import { boardAliasOfSource, companyOfAlias } from '../companies/aliases';
import { minConfidenceOf } from '../companies/profile';
import { ownCompanyKey as companiesOwnKey, resolveCompanyByName, resolveCompanyIn } from '../companies/resolve';
import { closeLinkIn, closeLinksOfSource } from './close';
import { factsAtIngest } from './facts';
import { findFuzzyMatch, logFuzzyMatch, NOT_SAME_BOARD_SQL, notSameBoardParams, placeKeyOf } from './fuzzy';
import { addJobKeys, atsBoardOf, jobOfKeys, keysOfAddress, tidyKeys, type JobKey } from './keys';
import { handOffHiringOrganization } from './career/handoff'; // v30 S5
import {
  MIN_TEXT_FOR_DEDUPE,
  normalizePosting,
  sha256,
  stableStringify,
  storedSourceJobId,
  type NormalizedPosting,
} from './normalize';
import { projectJobs } from './project-job';
import {
  isAddedPageSource,
  ROW_SOURCE_KINDS,
  SCHEDULED_KINDS,
  SOURCE_PRECEDENCE,
  type RawPosting,
  type SourceKind,
  type SourceRecord,
} from './types';

// Writes normalised postings: companies (resolveCompany), jobs, their texts (job_texts), job_locations,
// job_source_links and the postings' analyses, in the caller's transaction. A posting whose source hash has not
// changed only moves its last-seen and last-verified times. A job is live while any of its source links is not
// missing. After every write of a job, the facts Claude read from its text are put back where the write left them
// empty (`applyAiFacts`), so a rewrite (a changed listing, a NORMALIZE_VERSION bump) never loses them.
//
// v3.0 D2-C: through the async client. Every statement joins the caller's transaction (the client's async context),
// and each posting runs in a savepoint of it (`db.atomic`). The analyses (job-analysis/store.ts) are written on the
// same handle, so they join the caller's transaction too.
//
// v3.0 PG-C: the baseline's shape (11-database.md §5.5-5.6). The posting's HTML goes to job_texts (features/jobs/
// text.ts; `jobs` holds no text), and every job whose search row a change can move (a new or rewritten job, a filled
// one, a pay range, a close or reopen, a company merge or first fill) is projected (PG-SEARCH's projectJobs) in the
// same transaction: a batch's jobs with one projection at its end, a posting written outside a transaction with its
// own. A posting seen again with nothing changed projects nothing.
//
// v3.0 DB-INGEST (12-job-sourcing.md §7-§8, 11-database.md §5.3, §5.5, §5.5a):
// - The matching order on every upsert (12 §7.2): (1) the source's own id (job_source_links); (2) any identity key of
//   the posting (job_keys: its ATS posting, its link; keys.ts) names the job; (3) the company's open job of the same
//   title key and the same text (idx_jobs_dedup); (4) the fuzzy fingerprint (fuzzy.ts: same company, title key and
//   place, posted within 30 days, SimHash within JOB_FUZZY_SIMHASH_BITS; logged); (5) a new job. Never a job one
//   account made from a page (it keeps no key, and is never matched), never two postings of one board with different
//   ids (a candidate the same source, or the same ATS board, lists is another posting).
// - A shared job's keys are written with it (`ON CONFLICT DO NOTHING`); a matched job gains the posting's new keys.
//   Two writers creating one posting at once make one job: the second's keys conflict with the first's (its INSERT
//   waits for the first to commit), so it drops the job it just made and files the posting under the first's.
// - Every job's title_key and text_simhash are written with it.
// - Two misses (12 §8.2): a complete listing that lacks a live link adds one to its miss_count; at
//   INGEST_CLOSE_AFTER_MISSES the link closes through the one close function (close.ts), and the job when no live link
//   is left. A listed link's miss count goes back to 0. A listing that newly drops more than INGEST_SUSPECT_DROP_SHARE
//   of a board's open postings (when it had at least SUSPECT_MIN_OPEN) is suspect: it closes nothing (markMissing
//   answers `suspect`; the run reads it as incomplete and reads the board again soon).
//   v30 FIX-A (REV-BEH BEH-1): a suspect listing still counts its misses (it closes nothing), so the next listing
//   decides: one that lists the postings again sets their count back to 0 (a bad answer is forgotten); one that misses
//   them again is no new drop (they were missed already), so it is trusted and closes them. Before, a lasting drop (a
//   hiring freeze, a board left for another ATS) was suspect forever: read every hour, nothing ever closed.
// - A source TailorIT runs (enabled, a scheduled kind) that lists a held job (14 §5.2 step 5) clears the hold, tells
//   jobReviews (`supersede`, reason `listed`) and projects the job; a job a listing reopens tells jobReviews
//   (`reopenedBySource`, 14 §5.1 step 6).
// - Facts for every open job at ingest (11 §5.5a): the batch's new and changed jobs get their facts before its
//   projection (facts.ts), without AI.
// - v30 FIX-A (REV-REQ REQ-3, "no daily touch": 00-overview, 11 §5.3, 12 §9.5): a posting listed again unchanged writes
//   nothing unless its link's state moves (it was missed, or missing) or its seen time is older than SEEN_TOUCH_MS (one
//   day): then its link's and its job's seen (and verified) times move. A complete listing verifies its listed links at
//   once through job_sources.last_complete_at (unverified.ts), so a run of an unchanged board makes no row update per
//   posting, and no statement on `jobs` at all (0007's write mark stays quiet: the AI backlog may skip its walk).
// - Raw payloads (11 §5.3): a new or changed posting's raw answer is kept in job_postings_raw when its source kind keeps
//   any (job_source_kinds.raw_keep_days, at most JOB_RAW_KEEP_DAYS) and the day's partition exists (D5L's housekeeping
//   keeps today's and two days ahead made). v30 INT-3: the daily prune of a kind's rows past its own days is S1-API's
//   one step (purge.ts rawKeepDailyStep, `ingest.raw_keep`); the service makes the day's partition before a run.
// - The company: every posting goes through E0-API's resolveCompany (core/seams; companies/resolve.ts: its board alias,
//   a domain, its name; an account's own row for a page job). v30 INT-3: v2.0's name-key upsert is gone with 0014.

/** Postings per transaction. */
export const BATCH_SIZE = 200;

/** The open postings a board must have before a listing that drops most of them is suspect (12 §8.2's unnamed 20). */
export const SUSPECT_MIN_OPEN = 20;

/** v30 FIX-A (REQ-3): an unchanged listed posting's seen times move at most this often (no daily touch). */
export const SEEN_TOUCH_MS = 24 * 3_600_000;

export interface BatchItem {
  raw: RawPosting;
  sourceHash: string;
}

export interface UpsertCounts {
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  deactivated: number;
  reactivated: number;
}

export const emptyCounts = (): UpsertCounts => ({ created: 0, updated: 0, unchanged: 0, failed: 0, deactivated: 0, reactivated: 0 });

export interface UpsertFailure {
  sourceJobId: string;
  title: string;
  message: string;
}

/** What markMissing did with a complete listing. */
export interface MissingResult {
  /** Links that closed (their miss count reached INGEST_CLOSE_AFTER_MISSES). */
  missing: number;
  /** Jobs closed: no live link left. */
  deactivated: number;
  /** Links missed this time without closing yet (their miss count went up). */
  missed: number;
  /**
   * The listing dropped more than INGEST_SUSPECT_DROP_SHARE of the source's open postings (it had SUSPECT_MIN_OPEN or
   * more): nothing was counted; the run is not complete, and the listing is read again.
   */
  suspect: boolean;
}

interface LinkRow {
  source_job_id: string;
  job_id: number;
  source_hash: string;
  missing_since: string | null;
  miss_count: number;
  /** v30 FIX-A (REQ-3): when the link was last written as seen. */
  last_seen_at: string;
}

interface JobRow {
  id: number;
  company_id: number;
  /** The account a job made from a page belongs to; null for every shared job. */
  owner_user_id: string | null;
  title: string;
  content_hash: string;
  active: unknown;
  held_since: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_raw: string | null;
}

/** What one posting's writes did beyond its counts: the jobs whose search rows may move, the jobs whose facts are due. */
interface Effects {
  touched: Set<number>;
  facts: Set<number>;
}

const newEffects = (): Effects => ({ touched: new Set(), facts: new Set() });

/** The name_key of an account's own company row (a job it made from a page): "page:<owner>:<normalised name>". */
export const ownCompanyKey = companiesOwnKey;

export interface IngestStore {
  /**
   * Upserts one batch, in the caller's transaction (each posting in a savepoint of it: one bad posting fails alone, and
   * the jobs it wrote get their facts and are projected into search at the batch's end); outside one, each posting is
   * its own transaction.
   */
  upsertBatch(source: SourceRecord, items: BatchItem[], now: string): Promise<{ counts: UpsertCounts; failures: UpsertFailure[] }>;
  /**
   * After a complete listing: every live link of the source that the listing did not name, and that was last seen no
   * later than `listedFrom` (when the listing began; a posting Add job or the liveness check stored since is newer than
   * the listing), has missed one more listing; one that reached INGEST_CLOSE_AFTER_MISSES closes, and every job left
   * with no live link is closed. A suspect listing (see MissingResult) counts nothing. The links it named are live
   * with no miss.
   */
  markMissing(sourceId: number, seenIds: readonly string[], now: string, listedFrom: string): Promise<MissingResult>;
  /**
   * One posting its board answers 404 for, asked for by its id (liveness.ts): its link closes now (the one close
   * function, reason `gone`), and its job closes when no other link is live. Returns whether the link went missing and
   * the job closed.
   */
  markGone(sourceId: number, sourceJobId: string, now: string): Promise<{ missing: number; deactivated: number }>;
  /** Whether a posting of this source still needs its pay range checked (new, or never checked). */
  needsPayCheck(sourceId: number, sourceJobId: string): Promise<boolean>;
}

const JOB_SQL =
  'SELECT id, company_id, owner_user_id, title, content_hash, active, held_since, salary_min, salary_max, salary_raw FROM jobs WHERE id = ?';
const JOB_COLUMNS =
  'company_id, title, apply_url, title_key, content_hash, text_simhash, employment_type, ' +
  'work_arrangement, experience_levels, leadership, category_id, subcategory_ids, salary_min, salary_max, salary_currency, ' +
  'salary_period, salary_annual_usd_min, salary_annual_usd_max, salary_raw, sponsors_h1b, requires_clearance, degree, industry, ' +
  'locations_text, primary_location, location_count, posted_at, source_updated_at, last_verified_at, first_seen_at, last_seen_at, ' +
  // v30 INT-3 (S1-API edit A): ai_input, the source's (its host's ai-input content signal, 12 §9.7).
  'active, closed_at, created_at, updated_at, owner_user_id, ai_input';
const JOB_PLACEHOLDERS = JOB_COLUMNS.split(',')
  .map(() => '?')
  .join(', ');
/** The raw days of a source kind (job_source_kinds.raw_keep_days). */
interface KindKeep {
  kind: string;
  raw_keep_days: number;
}

/**
 * The ingest store. `deps` (the app's: the central constants, and the seams other packages build) is given by the
 * ingest service; a store made with a client alone (scripts, tests) reads the constants' defaults and calls no seam.
 */
export function createIngestStore(db: DbClient, deps?: AppDeps): IngestStore {
  const d = db.dialect;
  const job = (id: number) => db.one<JobRow>(JOB_SQL, [id]);
  const constant = <K extends ConstantKey>(key: K): ConstantValue<K> => (deps ? constantsOf(deps).get(key) : constantDefault(key));
  /** The raw days each source kind keeps (job_source_kinds: a reference list, read once). */
  let rawDays: Map<string, number> | null = null;
  /** The UTC days whose job_postings_raw partition is known to exist (made ahead by D5L's housekeeping). */
  const rawPartitionDays = new Set<string>();

  /**
   * The posting's company (companies/resolve.ts, 13 §5.3: its board, a domain, its name; an account's own row for a page
   * job): the resolveCompany seam with the app's deps, else resolveCompanyIn with the default minimum confidence (a store
   * made with a client alone). The jobs an own row merged into it moved, and the company's open jobs when a value the
   * search copies changed, are projected with the batch.
   */
  async function companyOf(
    t: DbTx,
    source: SourceRecord,
    posting: NormalizedPosting,
    owner: string | null,
    now: string,
    touched: Set<number>,
  ): Promise<number> {
    // v31 FIX-LINK (SEC-3, REQ-1): a page an add read (Add job's source of its host) speaks for no company but its own.
    if (!owner && isAddedPageSource(source)) return addedPageCompanyOf(t, source, posting, now, touched);
    // The board's alias: the source's own board (its config), else the board the posting's ATS address names when it is
    // of the source's kind (DB-INGEST's reading).
    const ats = owner ? null : parseAtsUrl(posting.applyUrl);
    const postingBoard = ats?.board && ats.kind === source.kind ? boardAlias(ats.kind, ats.board.toLowerCase()) : null;
    const input = {
      company: posting.company,
      boardAlias: owner ? null : (boardAliasOfSource(source) ?? postingBoard),
      // The posting's company site (resolveCompanyIn keeps only a company's own registrable domain).
      domains: posting.company.website ? [posting.company.website] : [],
      ownerUserId: owner,
      sourceId: source.id,
      at: now,
    };
    const resolved = deps ? await resolveCompany(deps, t, input) : await resolveCompanyIn(t, input, { minConfidence: minConfidenceOf() });
    for (const id of resolved.touchedJobIds) touched.add(id);
    return resolved.companyId;
  }

  /**
   * v31 FIX-LINK (SEC-3, REQ-1): the company of a page an add read (Add job's source of its host): the company an admin's
   * source of the host made its own (`site:<host>`), as it is; else, when the page names its organisation by a domain
   * that is the page's own (jobs/add/page.ts keeps the website only then), the company of that domain as any posting
   * resolves it (but the host is never bound to it as a board); else the company of the name alone, never one with a
   * board or a domain of its own, and nothing written about it (resolveCompanyByName).
   */
  async function addedPageCompanyOf(t: DbTx, source: SourceRecord, posting: NormalizedPosting, now: string, touched: Set<number>): Promise<number> {
    const site = boardAliasOfSource(source);
    const held = site ? await companyOfAlias(t, 'board', site) : undefined;
    if (held) return held.id;
    const input = { company: posting.company, boardAlias: null, ownerUserId: null, sourceId: source.id, at: now };
    const resolved = posting.company.website
      ? deps
        ? await resolveCompany(deps, t, { ...input, domains: [posting.company.website] })
        : await resolveCompanyIn(t, { ...input, domains: [posting.company.website] }, { minConfidence: minConfidenceOf() })
      : await resolveCompanyByName(t, input);
    for (const id of resolved.touchedJobIds) touched.add(id);
    return resolved.companyId;
  }

  /** The job's places, in one statement (v3.0 PG-C: each statement is a round trip on PostgreSQL); a new job has none to clear. */
  async function writeLocations(jobId: number, posting: NormalizedPosting, fresh = false): Promise<void> {
    if (!fresh) await db.run('DELETE FROM job_locations WHERE job_id = ?', [jobId]);
    const places = posting.locations.slice(0, 200);
    if (places.length === 0) return;
    await db.run(
      `INSERT INTO job_locations(job_id, position, raw, city, region, country_code, is_remote) VALUES ${places.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      places.flatMap((place, position) => [jobId, position, place.raw.slice(0, 300), place.city, place.region, place.countryCode, place.isRemote]),
    );
  }

  async function writeSalary(jobId: number, posting: NormalizedPosting, now: string): Promise<void> {
    const salary = posting.salary;
    if (salary === undefined) return;
    const sql =
      'UPDATE jobs SET salary_min = ?, salary_max = ?, salary_currency = ?, salary_period = ?, salary_annual_usd_min = ?, ' +
      'salary_annual_usd_max = ?, salary_raw = ?, updated_at = ? WHERE id = ?';
    if (salary === null) {
      // "Checked, none": '' tells the pay check not to ask again; NULL means never checked.
      await db.run(sql, [null, null, null, null, null, null, posting.payChecked ? '' : null, now, jobId]);
      return;
    }
    await db.run(sql, [
      salary.min,
      salary.max,
      salary.currency,
      salary.period,
      salary.annualUsdMin,
      salary.annualUsdMax,
      salary.raw ?? (posting.payChecked ? '' : null),
      now,
      jobId,
    ]);
  }

  /** The posting's analyses (deterministic, the lake's), then the AI facts of its text back on its jobs. */
  async function writeAnalyses(contentHash: string, posting: NormalizedPosting, now: string): Promise<void> {
    const draft = posting.deterministic;
    // An existing deterministic row is kept as it is, except for facets it was stored without (before they were
    // read), which this posting supplies when it is that text.
    const deterministicId = await saveAnalysis(db, { ...draft, contentHash, source: 'deterministic', version: DETERMINISTIC_VERSION }, now);
    if (draft.softSkills && posting.contentHash === contentHash) {
      await fillFacets(db, deterministicId, {
        softSkills: draft.softSkills,
        terms: draft.terms ?? { certifications: [], domains: [] },
        requiredYears: draft.requiredYears ?? null,
      });
    }
    const provided = posting.provided;
    if (provided) {
      // The lake has keywords but no display bullets: the posting's own sections come first, its phrases fill gaps.
      const found = posting.deterministic;
      await saveAnalysis(
        db,
        {
          contentHash,
          source: 'ft_lake',
          version: provided.version,
          model: provided.model ?? null,
          requirements: found.requirements.length ? found.requirements : (provided.requirements ?? []),
          responsibilities: found.responsibilities.length ? found.responsibilities : (provided.responsibilities ?? []),
          desired: found.desired.length ? found.desired : (provided.desired ?? []),
          keywords: provided.keywords,
          experienceLevels: provided.experienceLevels?.length ? provided.experienceLevels : posting.experienceLevels,
          leadership: provided.leadership ?? posting.leadership,
          minYears: provided.minYears ?? posting.deterministic.minYears,
          categoryId: provided.categoryId ?? posting.categoryId,
          subcategoryIds: provided.subcategoryIds ?? posting.subcategoryIds,
          extras: provided.extras ?? {},
        },
        now,
      );
    }
    await refreshAnalysisLinks(db, contentHash);
    await applyAiFacts(db, contentHash);
  }

  function jobValues(posting: NormalizedPosting, companyId: number) {
    return [
      companyId,
      posting.title,
      posting.applyUrl,
      posting.titleKey,
      posting.contentHash,
      // A signed 64-bit integer: bound as its decimal text (a JS number cannot hold it exactly).
      posting.textSimhash === null ? null : posting.textSimhash.toString(),
      posting.employmentType,
      posting.workArrangement,
      JSON.stringify(posting.experienceLevels),
      posting.leadership,
      posting.categoryId,
      JSON.stringify(posting.subcategoryIds),
    ] as const;
  }

  /**
   * A new job with its keys. `{ holder }` instead when a key was taken after the matching looked (another writer
   * created the posting's job meanwhile: its INSERT made this one wait for its commit): the job made here is dropped
   * again, and the caller files the posting under the holder rather than make a second job.
   */
  async function insertJob(
    posting: NormalizedPosting,
    companyId: number,
    now: string,
    owner: string | null,
    keys: readonly JobKey[],
    aiInput: boolean,
  ): Promise<{ id: number } | { holder: number }> {
    const salary = posting.salary ?? null;
    const created = (await db.one<{ id: number }>(`INSERT INTO jobs(${JOB_COLUMNS}) VALUES (${JOB_PLACEHOLDERS}) RETURNING id`, [
      ...jobValues(posting, companyId),
      salary?.min ?? null,
      salary?.max ?? null,
      salary?.currency ?? null,
      salary?.period ?? null,
      salary?.annualUsdMin ?? null,
      salary?.annualUsdMax ?? null,
      salary ? (salary.raw ?? (posting.payChecked ? '' : null)) : posting.payChecked ? '' : null,
      posting.sponsorsH1b,
      posting.requiresClearance,
      posting.degree,
      posting.industry,
      posting.locationsText,
      posting.primaryLocation,
      posting.locationCount,
      posting.postedAt,
      posting.sourceUpdatedAt,
      posting.verified ? now : null,
      now,
      now,
      posting.active,
      posting.active ? null : now,
      now,
      now,
      owner,
      aiInput,
    ]))!;
    // A job an account made from a page keeps no key: no posting, source or account finds it by its link.
    const holder = owner ? null : await addJobKeys(db, created.id, keys);
    if (holder !== null) {
      await db.run('DELETE FROM jobs WHERE id = ?', [created.id]);
      return { holder };
    }
    await writeJobText(db, created.id, posting.descriptionHtml, now);
    await writeLocations(created.id, posting, true);
    await writeAnalyses(posting.contentHash, posting, now);
    return { id: created.id };
  }

  async function rewriteJob(row: JobRow, posting: NormalizedPosting, companyId: number, now: string): Promise<void> {
    await db.run(
      'UPDATE jobs SET company_id = ?, title = ?, apply_url = ?, title_key = ?, content_hash = ?, text_simhash = ?, ' +
        'employment_type = ?, work_arrangement = ?, experience_levels = ?, leadership = ?, category_id = ?, ' +
        'subcategory_ids = ?, sponsors_h1b = ?, requires_clearance = ?, degree = ?, industry = ?, locations_text = ?, ' +
        'primary_location = ?, location_count = ?, posted_at = COALESCE(?, posted_at), source_updated_at = COALESCE(?, source_updated_at), ' +
        'last_verified_at = COALESCE(?, last_verified_at), last_seen_at = ?, updated_at = ? WHERE id = ?',
      [
        ...jobValues(posting, companyId),
        posting.sponsorsH1b,
        posting.requiresClearance,
        posting.degree,
        posting.industry,
        posting.locationsText,
        posting.primaryLocation,
        posting.locationCount,
        posting.postedAt,
        posting.sourceUpdatedAt,
        posting.verified ? now : null,
        now,
        now,
        row.id,
      ],
    );
    await writeJobText(db, row.id, posting.descriptionHtml, now);
    await writeSalary(row.id, posting, now);
    await writeLocations(row.id, posting);
    await writeAnalyses(posting.contentHash, posting, now);
  }

  /** A posting seen again: its last-seen time, and its last-verified time when this read verified it. */
  async function touchJob(jobId: number, verified: boolean, now: string): Promise<void> {
    await db.run('UPDATE jobs SET last_seen_at = ?, last_verified_at = COALESCE(?, last_verified_at) WHERE id = ?', [
      now,
      verified ? now : null,
      jobId,
    ]);
  }

  /** A lower-precedence source fills what the job's own source left empty, and adds its analysis. */
  async function fillJob(row: JobRow, posting: NormalizedPosting, now: string): Promise<void> {
    await db.run(
      "UPDATE jobs SET experience_levels = CASE WHEN experience_levels = '[]' THEN ? ELSE experience_levels END, " +
        'work_arrangement = COALESCE(work_arrangement, ?), leadership = COALESCE(leadership, ?), industry = COALESCE(industry, ?), ' +
        'sponsors_h1b = COALESCE(sponsors_h1b, ?), requires_clearance = COALESCE(requires_clearance, ?), degree = COALESCE(degree, ?), ' +
        "category_id = CASE WHEN category_id IS NULL OR category_id = 'other' THEN COALESCE(?, category_id) ELSE category_id END, " +
        "subcategory_ids = CASE WHEN subcategory_ids = '[]' AND (category_id IS NULL OR category_id = 'other' OR category_id = ?) THEN ? ELSE subcategory_ids END, " +
        'last_seen_at = ?, posted_at = COALESCE(posted_at, ?) WHERE id = ?',
      [
        JSON.stringify(posting.experienceLevels),
        posting.workArrangement,
        posting.leadership,
        posting.industry,
        posting.sponsorsH1b,
        posting.requiresClearance,
        posting.degree,
        posting.categoryId,
        posting.categoryId,
        JSON.stringify(posting.subcategoryIds),
        now,
        posting.postedAt,
        row.id,
      ],
    );
    if (posting.salary && row.salary_min === null && row.salary_max === null) await writeSalary(row.id, posting, now);
    if (posting.verified) await touchJob(row.id, true, now);
    // Its analysis reads the same posting (same link or same text): file it under the job's text.
    if (posting.provided) await writeAnalyses(row.content_hash, posting, now);
    else await applyAiFacts(db, row.content_hash);
  }

  async function outranks(source: SourceRecord, jobId: number): Promise<boolean> {
    const kinds = await db.all<{ kind: SourceKind }>(
      'SELECT DISTINCT s.kind FROM job_source_links l JOIN job_sources s ON s.id = l.source_id ' +
        'WHERE l.job_id = ? AND l.source_id <> ? AND l.missing_since IS NULL',
      [jobId, source.id],
    );
    // v31 FIX-LINK (SEC-1): a page an add read rewrites only a job no other source read (its own, or one stored from a
    // row or a browser's text: ROW_SOURCE_KINDS); any other job it only fills where that job is empty.
    if (isAddedPageSource(source)) return kinds.every((row) => (ROW_SOURCE_KINDS as readonly string[]).includes(row.kind));
    const others = kinds.map((row) => SOURCE_PRECEDENCE[row.kind] ?? 0);
    return others.length === 0 || SOURCE_PRECEDENCE[source.kind] >= Math.max(...others);
  }

  /**
   * Steps 2-4 of the matching order (12 §7.2) for a posting no link of this source holds: the job a key names, else the
   * company's open job of the same title key and text, else the fuzzy match (logged). Never a job one account made
   * from a page; never another posting of the same source or ATS board.
   */
  async function findDuplicate(
    source: SourceRecord,
    posting: NormalizedPosting,
    keys: readonly JobKey[],
    companyId: number,
    now: string,
  ): Promise<JobRow | null> {
    const byKey = await jobOfKeys(db, keys);
    if (byKey !== null) return (await job(byKey)) ?? null;
    // v31 FIX-LINK (SEC-1): a page an add read is found only by its own keys (career/keys.ts ownSiteOnly), never by a
    // text its owner may have copied from another job.
    if (isAddedPageSource(source)) return null;
    if (posting.descriptionText.length < MIN_TEXT_FOR_DEDUPE) return null;
    const board = atsBoardOf(posting.applyUrl);
    const sameText = await db.one<{ id: number }>(
      `SELECT j.id FROM jobs j WHERE j.company_id = ? AND j.title_key = ? AND j.active AND j.content_hash = ?
         AND j.owner_user_id IS NULL AND ${NOT_SAME_BOARD_SQL} ORDER BY j.id LIMIT 1`,
      [companyId, posting.titleKey, posting.contentHash, ...notSameBoardParams(source.id, board)],
    );
    if (sameText) return (await job(sameText.id)) ?? null;
    if (posting.textSimhash === null) return null;
    const threshold = constant('JOB_FUZZY_SIMHASH_BITS');
    const fuzzy = await findFuzzyMatch(db, {
      companyId,
      titleKey: posting.titleKey,
      simhash: posting.textSimhash,
      placeKey: placeKeyOf(posting.locations[0]),
      postedAt: posting.postedAt ?? now,
      sourceId: source.id,
      atsBoard: board,
      threshold,
    });
    if (!fuzzy) return null;
    await logFuzzyMatch(db, { jobId: fuzzy.jobId, sourceId: source.id, sourceJobId: posting.sourceJobId, distance: fuzzy.distance, threshold, at: now });
    deps?.log.info(`[ingest] posting ${posting.sourceJobId} of source ${source.id} filed under job ${fuzzy.jobId} by its text (${fuzzy.distance} bits)`);
    return (await job(fuzzy.jobId)) ?? null;
  }

  /**
   * Brings jobs.active in line with its links; counts the change. Answers 'closed' or 'reopened' when it changed it. A
   * reopened job tells jobReviews (an approved closed report's review hears its source reopened the job).
   */
  async function settleLiveness(t: DbTx, jobId: number, now: string, counts: UpsertCounts): Promise<'closed' | 'reopened' | null> {
    const state = await db.one<{ active: unknown; live: unknown }>(
      'SELECT active, EXISTS(SELECT 1 FROM job_source_links l WHERE l.job_id = jobs.id AND l.missing_since IS NULL) AS live FROM jobs WHERE id = ?',
      [jobId],
    );
    if (!state) return null;
    const active = d.isTrue(state.active);
    const live = d.isTrue(state.live);
    if (active && !live) {
      await db.run('UPDATE jobs SET active = ?, closed_at = ?, updated_at = ? WHERE id = ?', [false, now, now, jobId]);
      counts.deactivated += 1;
      return 'closed';
    }
    if (!active && live) {
      await db.run('UPDATE jobs SET active = ?, closed_at = ?, updated_at = ? WHERE id = ?', [true, null, now, jobId]);
      counts.reactivated += 1;
      if (deps) await jobReviews.reopenedBySource(deps, t, { jobId, at: now });
      return 'reopened';
    }
    return null;
  }

  /**
   * A source TailorIT runs (enabled, of a kind the schedule runs) listed the job: a hold on it clears (14 §5.2 step 5),
   * its pending reviews are superseded, and it is projected (it enters search) with the batch.
   */
  async function clearHoldIfListed(t: DbTx, source: SourceRecord, jobId: number, now: string, effects: Effects): Promise<void> {
    if (!source.enabled || !SCHEDULED_KINDS.includes(source.kind)) return;
    // v30 FIX-A (REQ-3): a read first, so a job that is not held costs no statement on `jobs` (0007's write mark).
    if (!(await db.one<{ found: number }>('SELECT 1 AS found FROM jobs WHERE id = ? AND held_since IS NOT NULL', [jobId]))) return;
    const cleared = await db.one<{ id: number }>('UPDATE jobs SET held_since = NULL WHERE id = ? AND held_since IS NOT NULL RETURNING id', [jobId]);
    if (!cleared) return;
    if (deps) await jobReviews.supersede(deps, t, { jobIds: [jobId], reason: 'listed', at: now });
    effects.touched.add(jobId);
  }

  /** The link written, live again with no miss when the posting is live (a listing names it). */
  async function updateLink(link: { sourceId: number; sourceJobId: string }, jobId: number, sourceHash: string, now: string, missingSince: string | null) {
    await db.run(
      'UPDATE job_source_links SET job_id = ?, source_hash = ?, last_seen_at = ?, missing_since = ?, ' +
        'miss_count = CASE WHEN CAST(? AS timestamptz) IS NULL THEN 0 ELSE miss_count END WHERE source_id = ? AND source_job_id = ?',
      [jobId, sourceHash, now, missingSince, missingSince, link.sourceId, link.sourceJobId],
    );
  }

  /** The days the source's kind keeps raw payloads (job_source_kinds.raw_keep_days, at most JOB_RAW_KEEP_DAYS). */
  async function rawKeepDays(kind: string): Promise<number> {
    if (!rawDays) {
      const rows = await db.all<KindKeep>('SELECT kind, raw_keep_days FROM job_source_kinds');
      rawDays = new Map(rows.map((row) => [row.kind, row.raw_keep_days]));
    }
    return Math.min(rawDays.get(kind) ?? 0, constant('JOB_RAW_KEEP_DAYS'));
  }

  /** A new or changed posting's raw answer, when its kind keeps them and the day's partition exists (11 §5.3). */
  async function keepRawPayload(source: SourceRecord, raw: RawPosting, now: string): Promise<void> {
    if ((await rawKeepDays(source.kind)) <= 0) return;
    const day = dayOf(now);
    if (!rawPartitionDays.has(day)) {
      // D5L's housekeeping keeps today's partition and two days ahead made; a day without one (a test's clock, a cluster
      // whose housekeeping has not run) keeps nothing rather than fail the posting.
      const parts = await listPartitions((sql) => db.all(sql), JOB_POSTINGS_RAW);
      if (!covered(parts, dayRange(day))) return;
      rawPartitionDays.add(day);
    }
    const payload = stableStringify(raw);
    await db.run(
      'INSERT INTO job_postings_raw(source_id, source_job_id, fetched_at, payload_hash, content_type, payload) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT DO NOTHING',
      [source.id, storedSourceJobId(raw.sourceJobId), now, Buffer.from(sha256(payload), 'hex'), 'application/json', payload],
    );
  }

  /** Writes one posting; adds the jobs whose search rows it may have moved, and whose facts are due, to `effects`. */
  async function upsertOne(t: DbTx, source: SourceRecord, item: BatchItem, now: string, counts: UpsertCounts, effects: Effects): Promise<void> {
    const { raw, sourceHash } = item;
    const { touched } = effects;
    const live = raw.active !== false;
    const link = await db.one<LinkRow>(
      'SELECT source_job_id, job_id, source_hash, missing_since, miss_count, last_seen_at FROM job_source_links WHERE source_id = ? AND source_job_id = ?',
      [source.id, storedSourceJobId(raw.sourceJobId)],
    );

    if (link && link.source_hash === sourceHash) {
      // v30 FIX-A (REQ-3): no daily touch. The link is written only when its state moves or its seen time is a day old.
      const stale = !(Date.parse(now) - Date.parse(link.last_seen_at) < SEEN_TOUCH_MS);
      if (live) {
        // A listed link is live with no miss (12 §8.2), and its seen time moves.
        if (stale || link.missing_since !== null || link.miss_count > 0) {
          await db.run('UPDATE job_source_links SET last_seen_at = ?, missing_since = NULL, miss_count = 0 WHERE source_id = ? AND source_job_id = ?', [
            now,
            source.id,
            link.source_job_id,
          ]);
        }
      } else if (stale || link.missing_since === null) {
        await db.run(
          'UPDATE job_source_links SET last_seen_at = ?, missing_since = COALESCE(missing_since, ?) WHERE source_id = ? AND source_job_id = ?',
          [now, now, source.id, link.source_job_id],
        );
      }
      if (stale) await touchJob(link.job_id, raw.verified !== false, now);
      let moved = false;
      const supplied = raw.supplement?.salary;
      if (supplied !== undefined) {
        // A pay range fetched for a posting that had none checked: store it without rewriting the rest.
        const posting = normalizePosting(raw);
        const current = await job(link.job_id);
        if (current && current.salary_min === null && current.salary_max === null && (await outranks(source, current.id))) {
          await writeSalary(current.id, posting, now);
          effects.facts.add(current.id);
          moved = true;
        }
      }
      const settled = await settleLiveness(t, link.job_id, now, counts);
      if (settled) moved = true;
      // A reopened job is an open job again: its facts are checked (kept while it was closed, or gone by retention).
      if (settled === 'reopened') effects.facts.add(link.job_id);
      if (live) await clearHoldIfListed(t, source, link.job_id, now, effects);
      // Seen again as it was: its search row stands (no projection for the run's unchanged majority).
      if (moved) touched.add(link.job_id);
      counts.unchanged += 1;
      return;
    }

    // A job made from a page stays its account's: its text is hashed and its company filed under that account.
    const linked = link ? await job(link.job_id) : undefined;
    const owner = linked ? linked.owner_user_id : (raw.ownerUserId ?? null);
    const posting = normalizePosting(owner ? { ...raw, ownerUserId: owner } : raw);
    // A job one account made from a page keeps no identity key (keys.ts). v30 S5: with the keys the adapter read beside
    // the address (a career page's `ld` and `ghjid` keys: career/keys.ts).
    const keys = owner ? [] : tidyKeys([...keysOfAddress(posting.applyUrl), ...(raw.keys ?? [])]);
    const companyId = await companyOf(t, source, posting, owner, now, touched);
    // v30 S5: a career page's JobPosting hands its hiringOrganization to the company's sources (12 §3.4 step 5).
    if (deps && !owner && raw.hiringOrganization) await handOffHiringOrganization(deps, t, { source, companyId, raw, at: now });
    const missingSince = live ? null : now;
    const linkOf = { sourceId: source.id, sourceJobId: link?.source_job_id ?? posting.sourceJobId };
    await keepRawPayload(source, raw, now);

    // Step 1: the source's own id.
    if (link && linked) {
      if (await outranks(source, linked.id)) await rewriteJob(linked, posting, companyId, now);
      else await fillJob(linked, posting, now);
      if (keys.length > 0) await addJobKeys(db, linked.id, keys);
      await updateLink(linkOf, linked.id, sourceHash, now, missingSince);
      await settleLiveness(t, linked.id, now, counts);
      if (live) await clearHoldIfListed(t, source, linked.id, now, effects);
      touched.add(linked.id);
      effects.facts.add(linked.id);
      counts.updated += 1;
      return;
    }

    // Steps 2-4, then 5: a new job. A job made from a page is never merged with another: it is its account's alone.
    let duplicate = owner ? null : await findDuplicate(source, posting, keys, companyId, now);
    let created: number | null = null;
    if (!duplicate) {
      const inserted = await insertJob(posting, companyId, now, owner, keys, source.aiInput !== false);
      if ('id' in inserted) created = inserted.id;
      else duplicate = (await job(inserted.holder)) ?? null;
      if (created === null && !duplicate) throw new Error('The job this posting matched was removed while it was saved.');
    }
    let jobId: number;
    if (duplicate) {
      jobId = duplicate.id;
      if (await outranks(source, duplicate.id)) {
        await rewriteJob(duplicate, posting, companyId, now);
        counts.updated += 1;
      } else {
        await fillJob(duplicate, posting, now);
        counts.unchanged += 1;
      }
      // The job is known by this posting's addresses too (a key another job holds stays with it).
      if (keys.length > 0) await addJobKeys(db, duplicate.id, keys);
    } else {
      jobId = created!;
      counts.created += 1;
    }
    if (link) {
      await updateLink(linkOf, jobId, sourceHash, now, missingSince);
    } else {
      await db.run(
        'INSERT INTO job_source_links(source_id, source_job_id, job_id, source_hash, first_seen_at, last_seen_at, missing_since) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
        [source.id, posting.sourceJobId, jobId, sourceHash, now, now, missingSince],
      );
    }
    await settleLiveness(t, jobId, now, counts);
    if (live && duplicate) await clearHoldIfListed(t, source, jobId, now, effects);
    touched.add(jobId);
    effects.facts.add(jobId);
  }

  /** The batch's (or the posting's) facts, then its one projection, in the caller's transaction. */
  async function settleEffects(effects: Effects, now: string): Promise<void> {
    if (effects.facts.size > 0) await factsAtIngest(db, [...effects.facts], now);
    if (effects.touched.size > 0) await projectJobs(db, [...effects.touched]);
  }

  return {
    async upsertBatch(source, items, now) {
      const counts = emptyCounts();
      const failures: UpsertFailure[] = [];
      // In the caller's transaction, the batch's jobs get their facts and are projected once at its end; outside one,
      // each posting is its own transaction and settles its own jobs in it.
      const batched = db.inTx();
      const effects = newEffects();
      for (const item of items) {
        // A savepoint per posting: one bad posting fails alone, the rest of the batch commits. Its counts and jobs join
        // the batch's only once it committed, so a rolled-back posting is counted as failed and nothing else.
        const own = emptyCounts();
        const ownEffects = newEffects();
        try {
          await db.atomic(
            async (t) => {
              await upsertOne(t, source, item, now, own, ownEffects);
              if (!batched) await settleEffects(ownEffects, now);
            },
            { label: 'ingest posting' },
          );
          for (const key of Object.keys(counts) as Array<keyof UpsertCounts>) counts[key] += own[key];
          for (const jobId of ownEffects.touched) effects.touched.add(jobId);
          for (const jobId of ownEffects.facts) effects.facts.add(jobId);
        } catch (error) {
          counts.failed += 1;
          failures.push({
            sourceJobId: String(item.raw.sourceJobId ?? ''),
            title: String(item.raw.title ?? ''),
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (batched) await settleEffects(effects, now);
      return { counts, failures };
    },

    async markMissing(sourceId, seenIds, now, listedFrom) {
      const seen = JSON.stringify(seenIds.map(storedSourceJobId));
      const live = (await db.one<{ n: number }>('SELECT count(*) AS n FROM job_source_links WHERE source_id = ? AND missing_since IS NULL', [
        sourceId,
      ]))!.n;
      // A link seen after the listing began (Add job or the liveness check stored it meanwhile) is newer than the listing.
      const notListed =
        'source_id = ? AND missing_since IS NULL AND last_seen_at <= ? ' + `AND source_job_id NOT IN (SELECT value FROM ${d.jsonEach('?')})`;
      // The links it named (v30 FIX-A: a suspect listing's too) are live with no miss (a skipped or failed posting of the listing too).
      await db.run(
        `UPDATE job_source_links SET miss_count = 0 WHERE source_id = ? AND missing_since IS NULL AND miss_count > 0
           AND source_job_id IN (SELECT value FROM ${d.jsonEach('?')})`,
        [sourceId, seen],
      );
      const drop = (await db.one<{ missed: number; fresh: number }>(
        `SELECT count(*) AS missed, count(*) FILTER (WHERE miss_count = 0) AS fresh FROM job_source_links WHERE ${notListed}`,
        [sourceId, listedFrom, seen],
      ))!;
      // 12 §8.2: a listing that newly drops most of a board's open postings is read again, not trusted (v30 FIX-A,
      // BEH-1: its misses are counted, nothing closes; the next listing that misses them again is no new drop).
      if (live >= SUSPECT_MIN_OPEN && drop.fresh > live * constant('INGEST_SUSPECT_DROP_SHARE')) {
        await db.run(`UPDATE job_source_links SET miss_count = LEAST(miss_count + 1, 32000) WHERE ${notListed}`, [sourceId, listedFrom, seen]);
        return { missing: 0, deactivated: 0, missed: drop.missed, suspect: true };
      }
      const missed = drop.missed;
      if (missed === 0) return { missing: 0, deactivated: 0, missed: 0, suspect: false };
      const counted = await db.all<{ source_job_id: string; miss_count: number }>(
        `UPDATE job_source_links SET miss_count = miss_count + 1 WHERE ${notListed} RETURNING source_job_id, miss_count`,
        [sourceId, listedFrom, seen],
      );
      const after = constant('INGEST_CLOSE_AFTER_MISSES');
      const due = counted.filter((row) => row.miss_count >= after).map((row) => row.source_job_id);
      const closed = await closeLinksOfSource(db, sourceId, due, now, after);
      return { missing: closed.linksClosed, deactivated: closed.closedJobs.length, missed: counted.length - closed.linksClosed, suspect: false };
    },

    async markGone(sourceId, sourceJobId, now) {
      const link = await db.one<{ job_id: number }>(
        'SELECT job_id FROM job_source_links WHERE source_id = ? AND source_job_id = ? AND missing_since IS NULL',
        [sourceId, storedSourceJobId(sourceJobId)],
      );
      if (!link) return { missing: 0, deactivated: 0 };
      const result = await closeLinkIn(
        db,
        { jobId: link.job_id, link: { sourceId, sourceJobId }, reason: 'gone', at: now },
        constant('INGEST_CLOSE_AFTER_MISSES'),
      );
      return { missing: result.linksClosed, deactivated: result.jobClosed ? 1 : 0 };
    },

    async needsPayCheck(sourceId, sourceJobId) {
      const state = await db.one<{ salary_min: number | null; salary_max: number | null; salary_raw: string | null }>(
        'SELECT j.salary_min, j.salary_max, j.salary_raw FROM job_source_links l JOIN jobs j ON j.id = l.job_id ' +
          'WHERE l.source_id = ? AND l.source_job_id = ?',
        [sourceId, storedSourceJobId(sourceJobId)],
      );
      if (!state) return true;
      return state.salary_min === null && state.salary_max === null && state.salary_raw === null;
    },
  };
}
