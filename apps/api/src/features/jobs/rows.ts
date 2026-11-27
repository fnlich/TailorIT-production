import {
  CONSTANTS, // v36 IMPORTTIME
  DAY_MS, // v36 IMPORTTIME
  EMPLOYMENT_TYPES,
  EXPERIENCE_LEVELS,
  LEADERSHIP,
  SALARY_PERIODS,
  WORK_ARRANGEMENTS,
  formatLocation,
  type CompanyDetail,
  type EmploymentType,
  type ExperienceLevel,
  type JobAddedFrom,
  type JobDetail,
  type JobLocation,
  type JobSummary,
  type JobUserState,
  type Leadership,
  type Salary,
  type SalaryPeriod,
  type WorkArrangement,
  STATUS,
} from '@tailorit/shared';
import { agentCanApply, parseLinkedInJobUrl, queueCanOpen } from '@tailorit/shared/autofill';
import { COMPANY_DETAIL_SQL, COMPANY_LOGO_SQL, COMPANY_SPONSORS_SQL, companyDetailOf } from '../companies/detail'; // v30 E0-API
import { jobCreditOf, jobCreditSql } from './credit'; // v30 S4
import { verificationColumns, verificationOf } from './add/verification'; // v31 LINK

// Rows of the jobs tables and their DTOs. Columns other packages write (ingestion) are read defensively: a value
// outside an enum reads as null, unreadable JSON as empty, and dates are normalized to ISO timestamps.

/** One card of GET /api/jobs, plus the tracker application it belongs to (needed to un-save from the list). */
export type JobListItem = JobSummary & { applicationId: string | null };

/** The columns every job read selects (jobs `j`, companies `c`, the viewer's application `a`). */
export const SUMMARY_COLUMNS = `
  j.id, j.title, j.company_id, c.name AS company_name, ${COMPANY_LOGO_SQL('c')} AS company_logo_path,
  j.primary_location, j.location_count, j.work_arrangement, j.employment_type, j.experience_levels,
  j.salary_min, j.salary_max, j.salary_currency, j.salary_period,
  j.posted_at, j.first_seen_at, j.source_updated_at, j.reposted_at, j.active, j.apply_url, j.held_since,
  a.id AS application_id, a.current_status AS application_status, a.archived_at AS application_archived_at,
  ${appliedOnSql('a')} AS applied_on,
  ${jobCreditSql('j')} AS credit_json,
  ${verificationColumns('j')},
  (SELECT max(e.edited_at) FROM job_admin_edits e WHERE e.job_id = j.id) AS admin_edited_at`; // v30 S4: the source's credit line (jobs/credit.ts); v31 LINK: the verification; v38 REVEDIT: an admin's edit

/**
 * The viewer's application for the job (at most one: applications(user_id, job_id) is unique). Bind `@userId`.
 */
export const APPLICATION_JOIN = 'LEFT JOIN applications a ON a.user_id = @userId AND a.job_id = j.id';

/**
 * The day an application reached Applied: its Applied event, else its earliest later event, else the tracked day,
 * and null while it is only Saved.
 */
export function appliedOnSql(alias: string): string {
  return `CASE WHEN ${alias}.current_status >= ${STATUS.applied} THEN COALESCE(
    (SELECT e.occurred_on FROM application_status_events e WHERE e.application_id = ${alias}.id AND e.status = ${STATUS.applied}),
    (SELECT MIN(e.occurred_on) FROM application_status_events e WHERE e.application_id = ${alias}.id AND e.status > ${STATUS.applied}),
    ${alias}.tracked_on) END`;
}

export interface SummaryRow {
  id: number;
  title: string;
  company_id: number;
  company_name: string;
  company_logo_path: string | null;
  primary_location: string;
  location_count: number;
  work_arrangement: string | null;
  employment_type: string | null;
  experience_levels: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  posted_at: string | null;
  first_seen_at: string;
  /** v35 IMPORT (H5): when an admin's import last reposted the job. */
  reposted_at?: string | null;
  source_updated_at: string | null;
  /** A flag: true/false on PostgreSQL (1 is read as true too). */
  active: boolean | number;
  /** The posting's address: the auto-apply agent's `autoApply` reads it. */
  apply_url: string;
  /** v30 (14 §4.1): set while the job is held for review; the card's and detail's `held`. */
  held_since?: string | null;
  application_id: string | null;
  application_status: number | null;
  application_archived_at: string | null;
  applied_on: string | null;
  /** v30 S4: the job's source's credit line as JSON text (jobs/credit.ts jobCreditSql), or null. */
  credit_json?: string | null;
  /** v31 LINK: the job is its viewer's own (TailorIT could not read its link), and why (job_verifications). */
  owned_job?: boolean | null;
  verification_json?: unknown;
  /** v38 REVEDIT (PLAN E4): when an admin last edited the job (admins only: approval-view.ts). */
  admin_edited_at?: string | null;
}

export interface DetailRow extends SummaryRow {
  /** The posting's HTML (job_texts, through text.ts's join; '' for a job without a text). */
  description_html: string;
  content_hash: string;
  leadership: string | null;
  category_id: string | null;
  subcategory_ids: string;
  degree: string | null;
  sponsors_h1b: boolean | number | null;
  requires_clearance: boolean | number | null;
  industry: string | null;
  last_verified_at: string | null;
  closed_at: string | null;
  analysis_id: number | null;
  /** v30 E0-API: the company's profile, parent and sources as one JSON text (companies/detail.ts COMPANY_DETAIL_SQL). */
  c_company: string | null;
  c_sponsors_h1b: boolean | number | null;
  /**
   * The company's open jobs, as its page counts them (v30 FIX-PERF, PG-LOAD PGL-14): company_job_counts' open jobs
   * (shared, not held; kept a few seconds behind by 0033's touches) and the viewer's own open jobs there, read by
   * idx_jobs_owner, so a view never counts the company's jobs one by one (13,605 for the largest at mix B's size).
   */
  c_job_count: number;
  /** The job pages' link (its source_job_id: the page's canonical address) of a job only that source lists, else null. */
  page_link: string | null;
}

/** The detail's columns: jobs `j`, companies `c`, the viewer's application `a`, the job's text `jt` (jobTextJoin). */
export const DETAIL_COLUMNS = `${SUMMARY_COLUMNS},
  COALESCE(jt.description_html, '') AS description_html, j.content_hash, j.leadership, j.category_id, j.subcategory_ids,
  j.degree, j.sponsors_h1b, j.requires_clearance, j.industry, j.last_verified_at, j.closed_at, j.analysis_id,
  ${COMPANY_DETAIL_SQL('c')} AS c_company, ${COMPANY_SPONSORS_SQL('c')} AS c_sponsors_h1b,
  (COALESCE((SELECT cc.open_jobs FROM company_job_counts cc WHERE cc.company_id = j.company_id), 0)
     + (SELECT count(*) FROM jobs oj WHERE oj.owner_user_id = @userId AND oj.company_id = j.company_id
          AND oj.active AND oj.held_since IS NULL))::int AS c_job_count,
  (SELECT pl.source_job_id FROM job_source_links pl JOIN job_sources ps ON ps.id = pl.source_id
     WHERE pl.job_id = j.id AND ps.kind = 'page'
       AND NOT EXISTS (SELECT 1 FROM job_source_links ol JOIN job_sources os ON os.id = ol.source_id
                       WHERE ol.job_id = j.id AND os.kind <> 'page')
     LIMIT 1) AS page_link`;

export interface LocationRow {
  raw: string;
  city: string | null;
  region: string | null;
  country_code: string | null;
  /** A flag: true/false on PostgreSQL (1 is read as true too). */
  is_remote: boolean | number;
}

/** A stored flag: a boolean (v3.0 PG-SEARCH; 1 is read as true too). */
function isFlag(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null;
}

/** A stored JSON list of strings ('[]' on anything unreadable). */
export function jsonStrings(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function experienceLevelsOf(text: string | null | undefined): ExperienceLevel[] {
  const set = new Set(jsonStrings(text));
  return EXPERIENCE_LEVELS.filter((level) => set.has(level));
}

/** A stored time as an ISO-8601 UTC timestamp ("2026-10-22" becomes midnight UTC); null when unreadable. */
export function isoTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T00:00:00.000Z`;
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** A stored day as "YYYY-MM-DD"; null when unreadable. */
export function isoDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const stamp = isoTimestamp(text);
  return stamp ? stamp.slice(0, 10) : null;
}

/**
 * A logo the browser can load as it is: an absolute http(s) URL or a same-origin path. A server file path has no
 * public address, so the page shows the company's letter instead.
 */
export function logoUrlOf(path: string | null | undefined): string | null {
  if (!path) return null;
  const value = path.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  return null;
}

function amount(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function salaryOf(row: Pick<SummaryRow, 'salary_min' | 'salary_max' | 'salary_currency' | 'salary_period'>): Salary | null {
  const min = amount(row.salary_min);
  const max = amount(row.salary_max);
  if (min === null && max === null) return null;
  const currency = row.salary_currency && /^[A-Za-z]{3}$/.test(row.salary_currency) ? row.salary_currency.toUpperCase() : null;
  return { min, max, currency, period: oneOf<SalaryPeriod>(SALARY_PERIODS, row.salary_period) };
}

export function toJobLocation(row: LocationRow): JobLocation {
  return {
    raw: row.raw,
    city: row.city,
    region: row.region,
    countryCode: row.country_code,
    isRemote: isFlag(row.is_remote),
  };
}

/**
 * v36 IMPORTTIME (SP v36 PLAN.md I1 refined, the owner's addendum 2: "If admin import jobs, the job post date will be
 * import time (if it is too far, reposted, or if not, posted)"): how a job an admin's import dated (jobs.reposted_at,
 * jobs/add/import-time.ts) reads. Its time is the import's; it reads "Reposted" when its board's own date (posted_at,
 * kept for this rule only) is more than `repostedAfterDays` days before the import (ADMIN_IMPORT_REPOSTED_AFTER_DAYS),
 * else "Posted" (also when the board's date is unknown: a link TailorIT could not read).
 */
export interface PostedRule {
  repostedAfterDays: number;
}

/** The rule with the constant's default (a caller with no deps; routes pass the live value: postedRuleOf). */
export const DEFAULT_POSTED_RULE: PostedRule = { repostedAfterDays: CONSTANTS.ADMIN_IMPORT_REPOSTED_AFTER_DAYS.default };

/** The rule with the admin's current value. */
export function postedRuleOf(constants: { get(key: 'ADMIN_IMPORT_REPOSTED_AFTER_DAYS'): number }): PostedRule {
  return { repostedAfterDays: constants.get('ADMIN_IMPORT_REPOSTED_AFTER_DAYS') };
}

/**
 * v36 IMPORTTIME: a job's times as a person reads them. `postedAt`: its board's date (else when TailorIT first saw it),
 * or the admin's import's when later; `updatedAt`: its board's update, or the import's when later (the "Last updated"
 * filter's time: the search projection's updated_sort); `repostedAt` (the import's time) only when it reads "Reposted"
 * (PostedRule). A job no admin imported reads as before.
 * v38 FIX-C (SP v38 FIXES-38 D7): `postedDateKnown`, whether `postedAt` is a date a posting named (its board's
 * posted_at, or the admin's import's time, which dates the job it imports) or only when TailorIT first saw the job
 * (first_seen_at: a read of a posting that names no date, as Taleo's, Avature's and a Paylocity link's pages). The times
 * are unchanged (sorting and the Posted filter read them as before).
 */
export function postingTimesOf(
  row: Pick<SummaryRow, 'posted_at' | 'first_seen_at' | 'source_updated_at' | 'reposted_at'>,
  rule: PostedRule,
): Pick<JobSummary, 'postedAt' | 'postedDateKnown' | 'updatedAt' | 'repostedAt'> {
  const board = isoTimestamp(row.posted_at);
  const own = board ?? isoTimestamp(row.first_seen_at);
  const updated = isoTimestamp(row.source_updated_at);
  const imported = isoTimestamp(row.reposted_at);
  if (imported === null || (own !== null && Date.parse(imported) <= Date.parse(own))) {
    return { postedAt: own, postedDateKnown: board !== null, updatedAt: updated };
  }
  const reposted = board !== null && Date.parse(board) < Date.parse(imported) - rule.repostedAfterDays * DAY_MS;
  return {
    postedAt: imported,
    postedDateKnown: true, // v38 FIX-C (D7): the import's time dates the job (v36 IMPORTTIME)
    updatedAt: updated !== null && Date.parse(updated) > Date.parse(imported) ? updated : imported,
    ...(reposted ? { repostedAt: imported } : {}),
  };
}

/**
 * The viewer's tie to a job. Saved: the application is still only Saved and not archived (un-saving archives it, its
 * notes and all, so Undo and saving again bring it back). An archived application that never got past Saved ties
 * nothing to the job any more; one that did (Applied and on) still does. v36 IMPORTTIME: `rule`, how a job an admin's
 * import dated reads (postingTimesOf).
 */
export function toListItem(row: SummaryRow, rule: PostedRule = DEFAULT_POSTED_RULE): JobListItem {
  const onlySaved = row.application_status === STATUS.saved;
  const applicationId = row.application_id !== null && !(onlySaved && row.application_archived_at) ? row.application_id : null;
  return {
    id: row.id,
    title: row.title,
    company: { id: row.company_id, name: row.company_name, logoUrl: logoUrlOf(row.company_logo_path) },
    primaryLocation: row.primary_location ?? '',
    locationCount: Math.max(0, row.location_count ?? 0),
    workArrangement: oneOf<WorkArrangement>(WORK_ARRANGEMENTS, row.work_arrangement),
    employmentType: oneOf<EmploymentType>(EMPLOYMENT_TYPES, row.employment_type),
    experienceLevels: experienceLevelsOf(row.experience_levels),
    salary: salaryOf(row),
    // v35 IMPORT (H5): repostedAt; v36 IMPORTTIME: an admin's import's time, "Reposted" or "Posted" (postingTimesOf).
    ...postingTimesOf(row, rule),
    active: isFlag(row.active),
    saved: applicationId !== null && onlySaved,
    appliedOn: isoDay(row.applied_on),
    applicationId,
    autoApply: agentCanApply(row.apply_url ?? ''),
    // jr7 7a: the Queue tab opens it (every platform the extension fills; the agent's too).
    queueApply: queueCanOpen(row.apply_url ?? ''),
    // v30 DB-JOBS for X1-WEB (14 §4.1): a held job says so (the contract's "absent or false: not held").
    ...(row.held_since ? { held: true } : {}),
    // v30 S4 (12 §3.6-3.7): the credit line its source's terms ask for on its card (absent: none).
    ...creditOf(row),
    // v31 LINK (21-jobs-from-links.md §6): a job others do not see says why (absent: everyone sees it).
    ...verificationOf(row),
    // v38 REVEDIT (SP v38 PLAN.md E4): "Edited by an admin", for administrators only (approval-view.ts drops it).
    ...(row.admin_edited_at ? { adminEditedAt: new Date(row.admin_edited_at).toISOString() } : {}),
  };
}

/** v30 S4: `{ credit }` when the job's source asks for one, else nothing (the contract's optional field). */
function creditOf(row: Pick<SummaryRow, 'credit_json'>): { credit?: JobSummary['credit'] } {
  const credit = jobCreditOf(row.credit_json);
  return credit ? { credit } : {};
}

export function toSummary(row: SummaryRow, rule: PostedRule = DEFAULT_POSTED_RULE): JobSummary {
  const { applicationId: _applicationId, ...summary } = toListItem(row, rule); // v36 IMPORTTIME: rule
  return summary;
}

interface StoredLink {
  label: string;
  url: string;
}

function linkLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host.endsWith('linkedin.com')) return 'LinkedIn';
    if (host === 'twitter.com' || host === 'x.com') return 'X';
    if (host.endsWith('crunchbase.com')) return 'Crunchbase';
    if (host.endsWith('github.com')) return 'GitHub';
    return host;
  } catch {
    return url;
  }
}

/** companies.links: `[{label, url}]` or plain URL strings; only http(s) URLs are kept. */
export function companyLinksOf(text: string | null | undefined): StoredLink[] {
  if (!text) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out: StoredLink[] = [];
  for (const item of value) {
    const url = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as { url?: unknown }).url : null;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) continue;
    const given = item && typeof item === 'object' ? (item as { label?: unknown }).label : null;
    const label = typeof given === 'string' && given.trim() ? given.trim() : linkLabel(url.trim());
    out.push({ label, url: url.trim() });
  }
  return out;
}

function flag(value: boolean | number | null | undefined): boolean | null {
  return value === null || value === undefined ? null : isFlag(value);
}

export function toCompanyDetail(row: DetailRow): CompanyDetail {
  // v30 E0-API: the company's fields are its profile's (company_profiles), read by the companies feature.
  return companyDetailOf(
    { id: row.company_id, name: row.company_name, logoUrl: logoUrlOf(row.company_logo_path), jobCount: row.c_job_count },
    row.c_company,
  );
}

/** Where a job only the job pages' source lists was added from: a LinkedIn job's page, or another page. */
function addedFromOf(pageLink: string | null | undefined): JobAddedFrom | null {
  if (!pageLink) return null;
  // The link's id is "<account>|<the page's address>", and a mark after a space for a second job of one page
  // (from-page.ts pageLinkId).
  return parseLinkedInJobUrl(pageLink.slice(pageLink.indexOf('|') + 1).split(' ')[0]!) ? 'linkedin' : 'page';
}

export function toJobDetail(
  row: DetailRow,
  locations: readonly LocationRow[],
  descriptionHtml: string,
  state: Pick<JobUserState, 'hidden' | 'companyHidden'>,
  rule: PostedRule = DEFAULT_POSTED_RULE, // v36 IMPORTTIME
): JobDetail {
  const summary = toListItem(row, rule);
  const places = locations.map(toJobLocation);
  const primary = summary.primaryLocation || (places[0] ? formatLocation(places[0]) : '');
  const { applicationId, ...base } = summary;
  const company = toCompanyDetail(row);
  return {
    ...base,
    primaryLocation: primary,
    locationCount: Math.max(summary.locationCount, places.length),
    company,
    locations: places,
    leadership: oneOf<Leadership>(LEADERSHIP, row.leadership),
    categoryId: row.category_id || null,
    subcategoryIds: jsonStrings(row.subcategory_ids),
    degree: row.degree?.trim() || null,
    sponsorsH1b: flag(row.sponsors_h1b) ?? flag(row.c_sponsors_h1b),
    requiresClearance: flag(row.requires_clearance),
    industry: row.industry || company.industry || null,
    descriptionHtml,
    applyUrl: /^https?:\/\//i.test(row.apply_url ?? '') ? row.apply_url : '',
    addedFrom: addedFromOf(row.page_link),
    lastVerifiedAt: isoTimestamp(row.last_verified_at),
    closedAt: isoTimestamp(row.closed_at),
    userState: {
      saved: summary.saved,
      applicationId,
      appliedOn: summary.appliedOn,
      hidden: state.hidden,
      companyHidden: state.companyHidden,
    },
  };
}
