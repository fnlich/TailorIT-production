import type { AdminOptOut, AdminOptOutCreateBody } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import type { DbTx } from '../../core/db/types';
import { notFound } from '../../core/http/errors';
import { purgeSource } from '../../core/seams';
import { boardSourceIdsOf } from './aliases';
import { recountCompanyJobs } from './counts';
import { minConfidenceOf, recomputeProfile } from './profile';
import { refreshCompanySearchIn } from './search-refresh'; // v30 FIX-PERF (PGL-19)

// v30 E0-API: a company's opt-out (companies.do_not_fetch; docs/design/part2/11-database.md §5.4 "The opt-out",
// 13-company-enrichment.md §4 rule 6, 12-job-sourcing.md §8.5) and the list of domains neither reader reads
// (crawl_opt_outs, 11 §5.3a). Turning it on, in one transaction:
//   - the company's domains go on crawl_opt_outs (neither the company-site reader nor the career-page reader reads
//     them);
//   - every job source of the company is disabled (a terms note says why) and its boards' discovery candidates become
//     `forbidden`, so discovery never brings a board back;
//   - its enrichment queue row goes (no outside lookup);
//   - a purge of its sources is queued (purgeSource, S1-API's seam: reason opt_out, the texts deleted but what
//     applications need), which closes its jobs in batches.
// The company row, its jobs' rows and its history stay: TailorIT's own records of what people applied to. Turning it
// off takes the domains it added off the list; the sources stay disabled until an admin enables them (Admin › Sources).
//
// v30 FIX-C SEC-2 + BEH-3: "every job source of the company" includes the sources of its boards whose company_id is
// still NULL (a validated board no posting of which has resolved yet: boardSourceIdsOf), and a merge into or of an
// opted-out company applies these effects to the survivor (optOutAfterMerge): the other's boards, domains, jobs and
// enrichment come under the opt-out too. (FIX-A makes the opt-out a gate on ingest's read path as well.)

/** The terms note on an opted-out company's sources. */
const OPT_OUT_NOTE = 'The company opted out (companies.do_not_fetch).';
/** The reason a domain is listed for when it reached an opted-out company by a merge and no reason of it is kept. */
const MERGED_OPT_OUT_REASON = 'Merged with a company that opted out (companies.do_not_fetch).';

export interface OptOutResult {
  /** The purge queued (null: none was asked for, or the purge job is not built yet). */
  purgeId: number | null;
  domains: string[];
}

/** Sets or clears a company's opt-out in the caller's transaction (see the module's note). */
export async function setOptOut(
  deps: AppDeps,
  t: DbTx,
  companyId: number,
  change: { doNotFetch: boolean; reason: string; actorId: string | null },
  at: string,
): Promise<OptOutResult> {
  const company = await t.one<{ do_not_fetch: boolean; owner_user_id: string | null }>(
    'SELECT do_not_fetch, owner_user_id FROM companies WHERE id = ? FOR UPDATE',
    [companyId],
  );
  if (!company || company.owner_user_id !== null) throw notFound('That company');
  if (!change.doNotFetch) {
    if (company.do_not_fetch) {
      await t.run('UPDATE companies SET do_not_fetch = false, updated_at = ? WHERE id = ?', [at, companyId]);
      await t.run('DELETE FROM crawl_opt_outs WHERE company_id = ?', [companyId]);
    }
    return { purgeId: null, domains: [] };
  }
  if (company.do_not_fetch) return { purgeId: null, domains: await domainsOf(t, companyId) };
  await t.run('UPDATE companies SET do_not_fetch = true, updated_at = ? WHERE id = ?', [at, companyId]);
  return applyOptOut(deps, t, companyId, { reason: change.reason, actorId: change.actorId }, at);
}

/**
 * v30 FIX-C BEH-3: after `mergeCompanies(t, survivorId, …)`, when either company opted out (the survivor then has
 * do_not_fetch), the opt-out's effects reach everything the survivor now has. Answers null when neither opted out.
 */
export async function optOutAfterMerge(deps: AppDeps, t: DbTx, survivorId: number, actorId: string | null, at: string): Promise<OptOutResult | null> {
  const survivor = await t.one<{ do_not_fetch: boolean }>('SELECT do_not_fetch FROM companies WHERE id = ?', [survivorId]);
  if (!survivor?.do_not_fetch) return null;
  // The opt-out's own reason (mergeCompanies moved the other's list rows to the survivor), else the merge's.
  const kept = await t.one<{ reason: string }>('SELECT reason FROM crawl_opt_outs WHERE company_id = ? ORDER BY created_at, domain LIMIT 1', [survivorId]);
  return applyOptOut(deps, t, survivorId, { reason: kept?.reason ?? MERGED_OPT_OUT_REASON, actorId }, at);
}

/** The company's domains: its domain aliases and its profile's domain. */
async function domainsOf(t: DbTx, companyId: number): Promise<string[]> {
  return (
    await t.all<{ domain: string }>(
      `SELECT value AS domain FROM company_aliases WHERE company_id = ? AND kind = 'domain'
       UNION SELECT domain FROM company_profiles WHERE company_id = ? AND domain IS NOT NULL`,
      [companyId, companyId],
    )
  ).map((row) => row.domain);
}

/** The opt-out's effects on a company with do_not_fetch (see the module's note); each one may run again. */
async function applyOptOut(deps: AppDeps, t: DbTx, companyId: number, change: { reason: string; actorId: string | null }, at: string): Promise<OptOutResult> {
  const domains = await domainsOf(t, companyId);
  for (const domain of domains) {
    await t.run(
      `INSERT INTO crawl_opt_outs(domain, company_id, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (domain) DO NOTHING`,
      [domain, companyId, change.reason, change.actorId, at],
    );
  }
  // The company's sources and its boards' (whose company_id may still be NULL).
  const boards = await boardSourceIdsOf(t, companyId);
  const ofCompany = `company_id = ?${boards.length > 0 ? ` OR id IN (${t.dialect.list(boards.length)})` : ''}`;
  await t.run(
    `UPDATE job_source_candidates SET status = 'forbidden', next_check_at = NULL
     WHERE (kind, name) IN (SELECT kind, name FROM job_sources WHERE ${ofCompany})`,
    [companyId, ...boards],
  );
  await t.run(`UPDATE job_sources SET enabled = false, terms_note = ?, updated_at = ? WHERE enabled AND (${ofCompany})`, [OPT_OUT_NOTE, at, companyId, ...boards]);
  await t.run('DELETE FROM company_enrichment_queue WHERE company_id = ?', [companyId]);
  // v30 E2 (INT-4, 13 §4 rule 6: "removes the stored logo and description on request"): what the company's own website
  // and logo.dev gave, and the AI summary written from it, go with the opt-out; the profile falls back on its other
  // sources (an admin may still lock a field empty). The company is never read again while it opts out.
  const removed = await t.run("DELETE FROM company_sources WHERE company_id = ? AND kind IN ('company_site', 'logo_dev', 'ai')", [companyId]);
  if (removed.changes > 0) await refreshCompanySearchIn(t, companyId, await recomputeProfile(t, companyId, at, minConfidenceOf(deps)));
  // v30 INT-3: S1-API's purge job (purgeSource, wired): the worker closes the company's jobs in batches.
  const purgeId: number | null = (
    await purgeSource(deps, t, { companyId, reason: 'opt_out', deleteTexts: true, deleteAppliedTexts: false, requestedBy: null, at })
  ).purgeId;
  await recountCompanyJobs(t, [companyId], at);
  return { purgeId, domains };
}

// ── The opt-out list ───────────────────────────────────────────────────────────────────────────────────────────────

interface OptOutRow {
  domain: string;
  company_id: number | null;
  company_name: string | null;
  reason: string;
  created_by: string | null;
  created_at: string;
}

const OPT_OUT_SQL = `SELECT o.domain, o.company_id, c.name AS company_name, o.reason, u.email AS created_by, o.created_at
  FROM crawl_opt_outs o LEFT JOIN companies c ON c.id = o.company_id LEFT JOIN users u ON u.id = o.created_by`;

function toOptOut(row: OptOutRow): AdminOptOut {
  return {
    domain: row.domain,
    companyId: row.company_id,
    companyName: row.company_name,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** The opt-out list, newest first, a page at a time (the cursor: the last row's time and domain). */
export async function listOptOuts(
  deps: Pick<AppDeps, 'db'>,
  query: { cursor?: string; limit: number },
): Promise<{ items: AdminOptOut[]; nextCursor?: string }> {
  let after: [string, string] | null = null;
  if (query.cursor) {
    try {
      const value: unknown = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'string') after = [value[0], value[1]];
    } catch {
      after = null;
    }
  }
  const rows = await deps.db.all<OptOutRow>(
    `${OPT_OUT_SQL} ${after ? 'WHERE (o.created_at, o.domain) < (CAST(? AS timestamptz), ?)' : ''}
     ORDER BY o.created_at DESC, o.domain DESC LIMIT ?`,
    after ? [after[0], after[1], query.limit + 1] : [query.limit + 1],
  );
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toOptOut),
    ...(rows.length > query.limit && last
      ? { nextCursor: Buffer.from(JSON.stringify([last.created_at, last.domain])).toString('base64url') }
      : {}),
  };
}

/** Adds a domain to the opt-out list (an existing entry keeps its first reason); answers the entry. */
export async function addOptOut(deps: Pick<AppDeps, 'db'>, body: AdminOptOutCreateBody, actorId: string, at: string): Promise<AdminOptOut> {
  return deps.db.tx(async (t) => {
    if (body.companyId !== undefined) {
      const company = await t.one('SELECT 1 AS ok FROM companies WHERE id = ? AND owner_user_id IS NULL', [body.companyId]);
      if (!company) throw notFound('That company');
    }
    await t.run(
      `INSERT INTO crawl_opt_outs(domain, company_id, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (domain) DO NOTHING`,
      [body.domain, body.companyId ?? null, body.reason, actorId, at],
    );
    return toOptOut((await t.one<OptOutRow>(`${OPT_OUT_SQL} WHERE o.domain = ?`, [body.domain]))!);
  });
}

/** Takes a domain off the opt-out list; false when it was not on it. */
export async function removeOptOut(deps: Pick<AppDeps, 'db'>, domain: string): Promise<boolean> {
  return (await deps.db.run('DELETE FROM crawl_opt_outs WHERE domain = ?', [domain])).changes > 0;
}
