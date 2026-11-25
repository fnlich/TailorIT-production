import { formatSalaryRange, UNVERIFIED_VERSIONS_MAX, type JobVerifyReason, type SalaryPeriod, type UnverifiedLinkDetail, type UnverifiedVersion } from '@tailorit/shared';
import type { AppDeps } from '../../../core/context';
import type { DbQueries } from '../../../core/db/types';
import { sanitizeDescription } from '../../jobs/html';
import { LISTED, listedSql } from './verification'; // v37 REVIEW (R5): listedSql

// v32 FIX-API (REV-SECBEH SB-1, the coordinator's decision of 2026-11-18): an admin approves only words they have read.
// Admin › Review › Couldn't verify draws, for a link, every version of its job its adders captured, in full (GET
// /api/admin/jobs/unverified/:jobId: title, company, places, pay, description, the Apply link an approval publishes),
// and the approval names the version read by its content hash (POST …/approve {version}): the job is refused (409) when
// it changed since. A version is what an approval publishes of a job, hashed in SQL (VERSION_SQL) so the list, the
// detail and the approval's check under the job's lock hash it the same way.

/**
 * The SQL of a captured job's version: a hash of what an approval publishes of job `j` (its company `c`, its text `jt`,
 * its "Couldn't verify" note `v`, whose link is the Apply link published). Fields joined by a unit separator.
 */
export const VERSION_SQL = `encode(sha256(convert_to(concat_ws(chr(31), j.title, c.name, j.locations_text,
    COALESCE(CAST(j.salary_min AS text), ''), COALESCE(CAST(j.salary_max AS text), ''), COALESCE(j.salary_currency, ''),
    COALESCE(j.salary_period, ''), COALESCE(j.salary_raw, ''), COALESCE(j.employment_type, ''), COALESCE(j.work_arrangement, ''),
    COALESCE(jt.description_html, ''), v.url), 'UTF8')), 'hex')`;

/** The joins VERSION_SQL reads beside job `j` and note `v`. */
export const VERSION_JOINS = 'JOIN companies c ON c.id = j.company_id LEFT JOIN job_texts jt ON jt.job_id = j.id';

/** A job's version now (VERSION_SQL), or null when it has no "Couldn't verify" note. Joins the caller's transaction. */
export async function versionOf(t: DbQueries, jobId: number): Promise<string | null> {
  const row = await t.one<{ version: string }>(
    `SELECT ${VERSION_SQL} AS version FROM jobs j JOIN job_verifications v ON v.job_id = j.id ${VERSION_JOINS} WHERE j.id = ?`,
    [jobId],
  );
  return row?.version ?? null;
}

/** How many versions each listed link's job has (the list's page of links). */
export async function versionCounts(db: DbQueries, urlKeys: readonly string[]): Promise<Map<string, number>> {
  if (urlKeys.length === 0) return new Map();
  const rows = await db.all<{ url_key: string; n: number }>(
    `SELECT v.url_key, count(DISTINCT ${VERSION_SQL})::int AS n
       FROM job_verifications v JOIN jobs j ON j.id = v.job_id ${VERSION_JOINS}
      WHERE v.url_key IN (SELECT value FROM ${db.dialect.jsonEach('?')}) AND ${LISTED}
      GROUP BY v.url_key`,
    [JSON.stringify(urlKeys)],
  );
  return new Map(rows.map((row) => [row.url_key, Number(row.n)]));
}

interface VersionRow {
  job_id: number;
  user_id: string | null;
  url: string;
  host: string;
  reason: string;
  created_at: string;
  title: string;
  company_name: string;
  locations_text: string;
  salary_min: number | string | null;
  salary_max: number | string | null;
  salary_currency: string | null;
  salary_period: string | null;
  salary_raw: string | null;
  description_html: string | null;
  published: boolean;
  version: string;
}

/** The most notes of one link the detail reads (a link many people added: its first captures). */
const DETAIL_ROWS = 500;

/** A pay as an admin reads it: the range, else as written; null when none. */
function payOf(row: VersionRow): string | null {
  const num = (value: number | string | null) => (value === null ? null : Number(value));
  const range = formatSalaryRange(num(row.salary_min), num(row.salary_max), row.salary_currency, row.salary_period as SalaryPeriod | null);
  return range || row.salary_raw?.trim() || null;
}

/**
 * GET /api/admin/jobs/unverified/:jobId (see the top): the listed link of job `jobId` and every version of its job, the
 * first captured first; null when the job is no row of the list (or the list is off). A version's job is its first
 * adder that is not the viewing admin (an admin approves no words they added: SB-5); `yours` when only they added it.
 */
export async function unverifiedLinkDetail(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  jobId: number,
  viewer: { id: string },
): Promise<UnverifiedLinkDetail | null> {
  // v37 REVIEW (R5): a row the list shows now (an admin import's whatever EXT_NEW_PAGE_JOBS_REVIEW says).
  const anchor = await deps.db.one<{ url_key: string }>(
    `SELECT v.url_key FROM job_verifications v JOIN jobs j ON j.id = v.job_id WHERE v.job_id = ? AND ${listedSql(deps)}`,
    [jobId],
  );
  if (!anchor) return null;
  const rows = await deps.db.all<VersionRow>(
    `SELECT j.id AS job_id, v.user_id, v.url, v.host, v.reason, v.created_at, j.title, c.name AS company_name, j.locations_text,
       j.salary_min, j.salary_max, j.salary_currency, j.salary_period, j.salary_raw, jt.description_html,
       EXISTS (SELECT 1 FROM job_admin_approvals a WHERE a.job_id = j.id) AS published, ${VERSION_SQL} AS version
     FROM job_verifications v JOIN jobs j ON j.id = v.job_id ${VERSION_JOINS}
     WHERE v.url_key = ? AND ${listedSql(deps)}
     ORDER BY v.created_at, j.id LIMIT ?`,
    [anchor.url_key, DETAIL_ROWS],
  );
  const first = rows.find((row) => Number(row.job_id) === jobId) ?? rows[0];
  if (!first) return null;
  // The versions in the order first captured; each its rows (its adders).
  const groups = new Map<string, VersionRow[]>();
  for (const row of rows) groups.set(row.version, [...(groups.get(row.version) ?? []), row]);
  const shown = [...groups.values()].slice(0, UNVERIFIED_VERSIONS_MAX);
  const versions: UnverifiedVersion[] = [];
  for (const group of shown) {
    const pick = group.find((row) => row.user_id !== viewer.id) ?? group[0]!;
    const places = await deps.db.all<{ raw: string }>('SELECT raw FROM job_locations WHERE job_id = ? ORDER BY position', [pick.job_id]);
    const locations = places.map((place) => place.raw).filter((raw) => raw.trim() !== '');
    versions.push({
      jobId: Number(pick.job_id),
      version: pick.version,
      title: pick.title,
      companyName: pick.company_name,
      locations: locations.length > 0 ? locations : pick.locations_text.trim() ? [pick.locations_text.trim()] : [],
      pay: payOf(pick),
      descriptionHtml: sanitizeDescription(pick.description_html),
      applyUrl: pick.url,
      adders: new Set(group.map((row) => row.user_id ?? `job:${row.job_id}`)).size,
      yours: group.every((row) => row.user_id === viewer.id),
      published: group.some((row) => row.published),
      addedAt: new Date(group[0]!.created_at).toISOString(),
    });
  }
  return {
    url: first.url,
    host: first.host,
    reason: first.reason as JobVerifyReason,
    versions,
    moreVersions: Math.max(0, groups.size - shown.length),
  };
}
