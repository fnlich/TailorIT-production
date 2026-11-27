import { COMPANY_ENRICHMENT_STEPS, parseBoardAlias, type CompanyMatchReviewKind } from '@tailorit/shared';
import type { ResolveCompany, ResolveCompanyInput, ResolveCompanyMatch, ResolveCompanyResult } from '../../core/seams';
import type { DbQueries } from '../../core/db/types';
import { addAlias, companyOfAlias } from './aliases';
import { companyDomainsOf } from './domain';
import { mergeOwnRows } from './merge';
import { ensureProfile, minConfidenceOf, openJobIdsOf, postingFields, recomputeProfile, upsertSource, type SourceKey } from './profile';
import { refreshCompanySearchIn } from './search-refresh'; // v30 FIX-PERF (PGL-19)
import { openMatchReview } from './reviews';

// v30 E0-API: resolveCompany (core/seams.ts ResolveCompany; docs/design/part2/13-company-enrichment.md §5.3, §5.6).
// Which company a posting belongs to, in the caller's transaction:
//   1. a known board alias ('greenhouse:stripe'): that company;
//   2. a known strong domain (hiringOrganization's sameAs/url, a careers page's host): that company, and the board is
//      added as its alias;
//   3. one shared company of the name key, nothing contradicting it (no other domain of its own): that company, at
//      confidence 70; a "second board joined by name" review when it already has a board on the same platform;
//   4. several companies of the name key: a posting with a strong key of its own makes a new company (a `homonym`
//      review); one with none files under the name's company that has no strong key (made by a name before), else a
//      new one (and the review). So the name alone never merges two companies, and a feed's postings of one name
//      never make a company each;
//   5. nothing: a new company, queued for enrichment.
// Then the posting's words about its company are kept as a source row (company_sources) and the profile recomputed
// when they changed; the accounts' own rows of the name give way to the shared row (as v2.0 did).
//
// A page job's company (ownerUserId) is the shared row that fits it (by board, domain, or the one shared company of
// its name), read as it is: the page fills nothing in and renames nothing. Else it is the account's own row
// ('page:<owner>:<key>'), which is never looked up anywhere, never gets an alias or a source, and never resolves for
// another account (13 §5.6).
//
// Two calls for one board at once make one company: the board alias goes in right after the new company row, under
// the strong-alias unique index (the second writer waits, sees the key taken, removes its row and takes the winner's).
// Two calls for one new name at once take turns on an advisory lock of the name key, so they agree too.
//
// v30 FIX-C BEH-8: that lock is a transaction lock (it must hold until the new company is committed, or the next
// writer would not see it), and an ingest batch resolves 200 postings in one transaction: two batches that took two
// names' locks in opposite orders deadlocked. So (1) a posting filed under a company of its name takes no lock: only
// making a company does (the decision is made again under the lock); and (2) a batch takes the locks of the new names
// it may make up front, in one order (lockNewCompanyNames, ingest's batch calls it), so later takes are re-entrant.

/** pg_advisory_xact_lock's first key for company names (any fixed number no other code uses). */
const NAME_LOCK = 7_320_014;
/** Match confidence (13 §6.2): a board, a domain the company states about itself, a name alone, a posting's own. */
const CONFIDENCE = { board: 100, domain: 95, name: 70, new: 100 } as const;
/** The name lookups read this many companies of one name key at most. */
const NAME_CANDIDATES = 20;

/** The name_key of an account's own company row (a job it made from a page): "page:<owner>:<normalised name>". */
export const ownCompanyKey = (owner: string, nameKey: string) => `page:${owner}:${nameKey}`;

export interface ResolveOptions {
  /** COMPANY_FIELD_MIN_CONFIDENCE. */
  minConfidence: number;
}

interface NameCandidate {
  id: number;
  doNotFetch: boolean;
  boards: string[];
  domains: string[];
}

async function nameCandidates(t: DbQueries, nameKey: string): Promise<NameCandidate[]> {
  const rows = await t.all<{ id: number; do_not_fetch: boolean; keys: string | null }>(
    `SELECT c.id, c.do_not_fetch,
       (SELECT json_agg(json_build_array(a.kind, a.value)) FROM company_aliases a
         WHERE a.company_id = c.id AND a.kind IN ('board', 'domain'))::text AS keys
     FROM companies c
     WHERE c.name_key = ? AND c.owner_user_id IS NULL AND c.merged_into_id IS NULL
     ORDER BY c.id LIMIT ${NAME_CANDIDATES}`,
    [nameKey],
  );
  return rows.map((row) => {
    const keys = row.keys ? (JSON.parse(row.keys) as Array<[string, string]>) : [];
    return {
      id: row.id,
      doNotFetch: row.do_not_fetch,
      boards: keys.filter(([kind]) => kind === 'board').map(([, value]) => value),
      domains: keys.filter(([kind]) => kind === 'domain').map(([, value]) => value),
    };
  });
}

/** A new shared company row and its profile; answers its id. */
export async function newCompany(t: DbQueries, name: string, nameKey: string, at: string): Promise<number> {
  const row = await t.one<{ id: number }>('INSERT INTO companies(name, name_key, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id', [
    name,
    nameKey,
    at,
    at,
  ]);
  await ensureProfile(t, row!.id, name, at);
  return row!.id;
}

/** The enrichment steps a new company is queued for (its board's words are read at ingest). */
export const NEW_COMPANY_STEPS = COMPANY_ENRICHMENT_STEPS.filter((step) => step !== 'ats_board');

/**
 * Puts a shared company on the enrichment queue with these steps (joined to any already due); never an opted-out or own
 * row. v30 FIX-C (INT-4 open item 12): a row a worker holds (leased_until after `at`) also notes the names in
 * `requeued`, so that worker's finish keeps them due (its claim read the company before they were asked for).
 */
export async function queueEnrichment(t: DbQueries, companyId: number, at: string, steps: readonly string[] = NEW_COMPANY_STEPS): Promise<boolean> {
  const done = await t.run(
    `INSERT INTO company_enrichment_queue(company_id, steps, priority, due_at)
     SELECT c.id, CAST(? AS jsonb), 0, ? FROM companies c
     WHERE c.id = ? AND NOT c.do_not_fetch AND c.owner_user_id IS NULL AND c.merged_into_id IS NULL
     ON CONFLICT (company_id) DO UPDATE SET
       steps = (SELECT jsonb_agg(DISTINCT x.step ORDER BY x.step)
                FROM jsonb_array_elements_text(company_enrichment_queue.steps || excluded.steps) AS x(step)),
       due_at = LEAST(company_enrichment_queue.due_at, excluded.due_at),
       requeued = CASE WHEN company_enrichment_queue.leased_until > CAST(? AS timestamptz)
         THEN (SELECT jsonb_agg(DISTINCT x.step ORDER BY x.step)
               FROM jsonb_array_elements_text(company_enrichment_queue.requeued || excluded.steps) AS x(step))
         ELSE company_enrichment_queue.requeued END`,
    [JSON.stringify(steps), at, companyId, at],
  );
  return done.changes > 0;
}

/** The source row a posting's words about its company are kept under. */
function sourceKeyOf(input: ResolveCompanyInput, matchConfidence: number): { key: SourceKey; merge: 'newest' | 'first' } {
  const board = input.boardAlias ? parseBoardAlias(input.boardAlias) : null;
  if (board && board.platform !== 'site') {
    return { key: { kind: 'ats_board', ref: input.boardAlias!, licence: 'ats_public_api', matchConfidence }, merge: 'newest' };
  }
  if (board) return { key: { kind: 'job_posting', ref: input.boardAlias!, licence: 'own_site', matchConfidence }, merge: 'newest' };
  // A feed, an import, the lake, the demo jobs: postings of many employers, the first words given are kept.
  const ref = input.sourceId === null ? 'posting' : `source:${input.sourceId}`;
  return { key: { kind: 'job_posting', ref, licence: 'legacy', matchConfidence }, merge: 'first' };
}

interface Finish {
  /** Add the posting's board (and domains) as the company's keys. */
  addKeys?: boolean;
  review?: { kind: CompanyMatchReviewKind; otherId: number | null };
  /** The company is the only shared one of the name: the accounts' own rows of the name give way to it. */
  shareOwnRows?: boolean;
}

/**
 * v30 FIX-C BEH-8: the name locks a transaction resolving many postings (an ingest batch) may take, taken up front in
 * one order (the lock keys ascending), for the names no shared company has yet (only making a company takes a name's
 * lock). Two batches that meet the same new names then wait for each other in turn instead of deadlocking. Answers the
 * locks taken. Call it first in the batch's transaction with the batch's postings' name keys.
 */
export async function lockNewCompanyNames(t: DbQueries, nameKeys: readonly string[]): Promise<number> {
  const keys = [...new Set(nameKeys.filter((key) => key.length > 0))];
  if (keys.length === 0) return 0;
  const locks = await t.all<{ h: number }>(
    `SELECT DISTINCT hashtext(je.value) AS h FROM ${t.dialect.jsonEach('?')}
     WHERE NOT EXISTS (SELECT 1 FROM companies c WHERE c.name_key = je.value AND c.owner_user_id IS NULL AND c.merged_into_id IS NULL)
     ORDER BY h`,
    [JSON.stringify(keys)],
  );
  for (const lock of locks) await t.run('SELECT pg_advisory_xact_lock(?, ?)', [NAME_LOCK, lock.h]);
  return locks.length;
}

/** resolveCompany on a transaction handle alone (the seam reads COMPANY_FIELD_MIN_CONFIDENCE and calls this). */
export async function resolveCompanyIn(t: DbQueries, input: ResolveCompanyInput, options: ResolveOptions): Promise<ResolveCompanyResult> {
  const nameKey = input.company.nameKey;
  const domains = companyDomainsOf(input.domains ?? []);
  if (input.ownerUserId) return resolveForPage(t, input, input.ownerUserId, domains);

  const done = (companyId: number, doNotFetch: boolean, matchedBy: ResolveCompanyMatch, created: boolean, extra: Finish = {}) =>
    finishShared(t, input, { companyId, doNotFetch, matchedBy, created, ...extra }, domains, options);

  // 1-2. The strong keys.
  const byKey = async () => {
    if (input.boardAlias) {
      const hit = await companyOfAlias(t, 'board', input.boardAlias);
      if (hit) return done(hit.id, hit.doNotFetch, 'board', false);
    }
    for (const domain of domains) {
      const hit = await companyOfAlias(t, 'domain', domain);
      if (hit) return done(hit.id, hit.doNotFetch, 'domain', false, { addKeys: true });
    }
    return null;
  };
  const found = await byKey();
  if (found) return found;

  // 3-5. By the name.
  const strong = input.boardAlias !== null || domains.length > 0;
  const platform = input.boardAlias ? (parseBoardAlias(input.boardAlias)?.platform ?? null) : null;
  // A company with a domain of its own is contradicted by a posting that states another.
  const fits = (candidate: NameCandidate) => domains.length === 0 || candidate.domains.length === 0;
  const byName = async () => {
    const candidates = await nameCandidates(t, nameKey);
    let target: NameCandidate | null = null;
    let review: CompanyMatchReviewKind | null = null;
    if (candidates.length === 1 && fits(candidates[0]!)) {
      target = candidates[0]!;
      if (platform && target.boards.some((board) => board.startsWith(`${platform}:`))) review = 'board_by_name';
    } else if (candidates.length > 0) {
      const nameOnly = candidates.find((candidate) => candidate.boards.length === 0 && candidate.domains.length === 0);
      if (!strong && nameOnly) target = nameOnly;
      else review = 'homonym';
    }
    if (!target) return { candidates, review, filed: null };
    const filed = await done(target.id, target.doNotFetch, 'name', false, {
      addKeys: true,
      review: review ? { kind: review, otherId: null } : undefined,
      shareOwnRows: candidates.length === 1,
    });
    return { candidates, review, filed };
  };
  const first = await byName();
  if (first.filed) return first.filed;
  // A new company: one writer of a name at a time; a writer that held the turn may have made the key or the company.
  await t.run('SELECT pg_advisory_xact_lock(?, hashtext(?))', [NAME_LOCK, nameKey]);
  const foundNow = await byKey();
  if (foundNow) return foundNow;
  const { candidates, review, filed } = await byName();
  if (filed) return filed;
  const companyId = await newCompany(t, input.company.name, nameKey, input.at);
  return done(companyId, false, 'new', true, {
    addKeys: true,
    review: review ? { kind: review, otherId: candidates[0]!.id } : undefined,
    shareOwnRows: candidates.length === 0,
  });
}

async function finishShared(
  t: DbQueries,
  input: ResolveCompanyInput,
  state: { companyId: number; doNotFetch: boolean; matchedBy: ResolveCompanyMatch; created: boolean } & Finish,
  domains: readonly string[],
  options: ResolveOptions,
): Promise<ResolveCompanyResult> {
  const { companyId, matchedBy, created } = state;
  const at = input.at;
  const confidence = created ? CONFIDENCE.new : CONFIDENCE[matchedBy === 'name' ? 'name' : matchedBy === 'domain' ? 'domain' : 'board'];
  if (state.addKeys && input.boardAlias) {
    const added = await addAlias(t, companyId, 'board', input.boardAlias, confidence, at, { primary: created });
    if (!added) {
      const winner = await companyOfAlias(t, 'board', input.boardAlias);
      if (winner && winner.id !== companyId) {
        // Another writer filed the board under its company first: this posting is that company's.
        if (created) await t.run('DELETE FROM companies WHERE id = ?', [companyId]);
        return finishShared(t, input, { companyId: winner.id, doNotFetch: winner.doNotFetch, matchedBy: 'board', created: false }, domains, options);
      }
    }
  }
  if (state.addKeys) {
    for (const domain of domains) await addAlias(t, companyId, 'domain', domain, created ? CONFIDENCE.domain : confidence, at);
  }
  const touched = new Set<number>();
  if (created) await queueEnrichment(t, companyId, at);
  // The board's company (one employer per board): its source names it when it names none yet.
  if (input.boardAlias && input.sourceId !== null) {
    await t.run('UPDATE job_sources SET company_id = ? WHERE id = ? AND company_id IS NULL', [companyId, input.sourceId]);
  }
  if (state.review) {
    await openMatchReview(t, {
      kind: state.review.kind,
      companyId,
      otherCompanyId: state.review.otherId,
      candidate: { name: input.company.name, nameKey: input.company.nameKey, board: input.boardAlias, domains: [...domains], sourceId: input.sourceId },
      score: CONFIDENCE.name,
      at,
    });
  }
  const { key, merge } = sourceKeyOf(input, confidence);
  // v38 FRAME (SP v38 PLAN A6): a platform's logo address rides in its row for the logo pipeline to copy (site/step.ts),
  // as a career page's hiringOrganization.logo does (hiring-org.ts): never a profile value itself, never hot-linked.
  const logo = input.company.logoSourceUrl ? { logoSourceUrl: input.company.logoSourceUrl } : {};
  const source = await upsertSource(t, companyId, key, { ...postingFields(input.company), ...logo }, at, merge);
  if (source.changed || created) {
    const result = await recomputeProfile(t, companyId, at, options.minConfidence);
    // v30 FIX-PERF (PGL-19): a new name rewrites the open jobs' words (projected with the batch); a new industry, size or
    // sponsorship only their search rows' company columns, here.
    if (!created && result.nameChanged) for (const id of await openJobIdsOf(t, companyId)) touched.add(id);
    else if (!created) await refreshCompanySearchIn(t, companyId, result);
  }
  if (state.shareOwnRows) for (const id of await mergeOwnRows(t, companyId, input.company.nameKey)) touched.add(id);
  const row = await t.one<{ do_not_fetch: boolean }>('SELECT do_not_fetch FROM companies WHERE id = ?', [companyId]);
  return { companyId, matchedBy, created, doNotFetch: row?.do_not_fetch ?? state.doNotFetch, touchedJobIds: [...touched] };
}

/**
 * v31 FIX-LINK (SEC-3, REQ-1): the company of a posting whose page may not speak for any company it names (a page an
 * add read, its hiringOrganization not on the page's own domain: ingest/store.ts companyOf): by its name alone, and
 * never a company that has a board or a domain of its own (a stranger's page would be filed under it, beside its real
 * jobs). The one shared company of the name with neither (made by a name before), else a new company of the name, with a
 * `homonym` review when companies of the name exist. Nothing is written about a company that exists (no source row, no
 * alias, no profile, no enrichment), and a new one is not queued for enrichment either: its page claimed nothing TailorIT
 * may read about it. In the caller's transaction.
 */
export async function resolveCompanyByName(
  t: DbQueries,
  input: Pick<ResolveCompanyInput, 'company' | 'sourceId' | 'at'>,
): Promise<ResolveCompanyResult> {
  const nameKey = input.company.nameKey;
  const nameOnly = (candidates: readonly NameCandidate[]) =>
    candidates.find((candidate) => candidate.boards.length === 0 && candidate.domains.length === 0) ?? null;
  let candidates = await nameCandidates(t, nameKey);
  let target = nameOnly(candidates);
  if (!target) {
    // A new company: one writer of a name at a time (as resolveCompanyIn), then the look again.
    await t.run('SELECT pg_advisory_xact_lock(?, hashtext(?))', [NAME_LOCK, nameKey]);
    candidates = await nameCandidates(t, nameKey);
    target = nameOnly(candidates);
  }
  if (target) return { companyId: target.id, matchedBy: 'name', created: false, doNotFetch: target.doNotFetch, touchedJobIds: [] };
  const companyId = await newCompany(t, input.company.name, nameKey, input.at);
  if (candidates.length > 0) {
    await openMatchReview(t, {
      kind: 'homonym',
      companyId,
      otherCompanyId: candidates[0]!.id,
      candidate: { name: input.company.name, nameKey, board: null, domains: [], sourceId: input.sourceId },
      score: CONFIDENCE.name,
      at: input.at,
    });
  }
  return { companyId, matchedBy: 'new', created: true, doNotFetch: false, touchedJobIds: [] };
}

/** A page job's company: the shared row that fits, read as it is, else the account's own row. */
async function resolveForPage(t: DbQueries, input: ResolveCompanyInput, owner: string, domains: readonly string[]): Promise<ResolveCompanyResult> {
  const shared = (companyId: number, doNotFetch: boolean, matchedBy: ResolveCompanyMatch, touched: readonly number[] = []): ResolveCompanyResult => ({
    companyId,
    matchedBy,
    created: false,
    doNotFetch,
    touchedJobIds: touched,
  });
  if (input.boardAlias) {
    const hit = await companyOfAlias(t, 'board', input.boardAlias);
    if (hit) return shared(hit.id, hit.doNotFetch, 'board');
  }
  for (const domain of domains) {
    const hit = await companyOfAlias(t, 'domain', domain);
    if (hit) return shared(hit.id, hit.doNotFetch, 'domain');
  }
  const nameKey = input.company.nameKey;
  const candidates = nameKey ? await nameCandidates(t, nameKey) : [];
  if (candidates.length === 1) {
    const moved = await mergeOwnRows(t, candidates[0]!.id, nameKey);
    return shared(candidates[0]!.id, candidates[0]!.doNotFetch, 'name', moved);
  }
  const key = ownCompanyKey(owner, nameKey);
  const own = await t.one<{ id: number }>('SELECT id FROM companies WHERE name_key = ? AND owner_user_id = ?', [key, owner]);
  if (own) return { companyId: own.id, matchedBy: 'own', created: false, doNotFetch: false, touchedJobIds: [] };
  const made = await t.one<{ id: number }>(
    `INSERT INTO companies(name, name_key, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (name_key) WHERE owner_user_id IS NOT NULL DO NOTHING RETURNING id`,
    [input.company.name, key, owner, input.at, input.at],
  );
  if (made) {
    await ensureProfile(t, made.id, input.company.name, input.at);
    return { companyId: made.id, matchedBy: 'own', created: true, doNotFetch: false, touchedJobIds: [] };
  }
  // Another request of the account made the row after the look.
  const taken = await t.one<{ id: number }>('SELECT id FROM companies WHERE name_key = ? AND owner_user_id = ?', [key, owner]);
  if (!taken) throw new Error("The account's company row was made and then removed while this posting was saved.");
  return { companyId: taken.id, matchedBy: 'own', created: false, doNotFetch: false, touchedJobIds: [] };
}

/** The company a posting belongs to: by board, domain or name, else a new one (core/seams.ts ResolveCompany). */
export const resolveCompany: ResolveCompany = (deps, t, input) => resolveCompanyIn(t, input, { minConfidence: minConfidenceOf(deps) });
