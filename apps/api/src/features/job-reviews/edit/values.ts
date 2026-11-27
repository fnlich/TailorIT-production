import { createHash } from 'node:crypto';
import {
  EMPLOYMENT_TYPES,
  JOB_EDIT_FIELDS,
  normalizeCompanyName,
  SALARY_PERIODS,
  WORK_ARRANGEMENTS,
  type AdminJobEditor,
  type EmploymentType,
  type JobEditField,
  type JobEditMark,
  type JobEditValues,
  type JobEditVisibility,
  type SalaryPeriod,
  type WorkArrangement,
} from '@tailorit/shared';
import type { DbQueries } from '../../../core/db/types';
import { sharedAddress } from '../../jobs/add/address';
import { sanitizeDescription } from '../../jobs/html';

// v38 REVEDIT (SP v38 PLAN.md E2): a job's editable values as Admin › Review's editor shows them (packages/shared
// reviews/edit.ts JobEditValues), read from what the job holds now: its link (a "Couldn't verify" note's link when it has
// one, else its Apply link), its own Apply link (a noted job's, when it differs), title, company, description (cleaned),
// places (as given), work mode, employment type, salary, posted day. A leaf module: the ingest store's hook reads it.

/** What the editor reads of a job (one statement). */
export interface EditJobRow {
  id: number;
  owner_user_id: string | null;
  active: boolean;
  held: boolean;
  superseded_by: number | null;
  company_id: number;
  company_name: string;
  title: string;
  apply_url: string;
  note_url: string | null;
  note_user_id: string | null;
  work_arrangement: string | null;
  employment_type: string | null;
  salary_min: number | string | null;
  salary_max: number | string | null;
  salary_currency: string | null;
  salary_period: string | null;
  posted_at: string | Date | null;
  locations_text: string;
  description_html: string | null;
}

const ROW_SQL = `SELECT j.id, j.owner_user_id, j.active, j.held_since IS NOT NULL AS held, j.superseded_by, j.company_id,
    c.name AS company_name, j.title, j.apply_url, v.url AS note_url, v.user_id AS note_user_id, j.work_arrangement,
    j.employment_type, j.salary_min, j.salary_max, j.salary_currency, j.salary_period, j.posted_at, j.locations_text,
    jt.description_html
  FROM jobs j JOIN companies c ON c.id = j.company_id LEFT JOIN job_verifications v ON v.job_id = j.id
    LEFT JOIN job_texts jt ON jt.job_id = j.id
  WHERE j.id = ?`;

/** The job as the editor reads it, or undefined. */
export async function editJobRow(db: DbQueries, jobId: number): Promise<EditJobRow | undefined> {
  return db.one<EditJobRow>(ROW_SQL, [jobId]);
}

const oneOf = <T extends string>(list: readonly T[], value: string | null): T | null =>
  value !== null && (list as readonly string[]).includes(value) ? (value as T) : null;

const amount = (value: number | string | null): number | null => {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** A stored time as its UTC day ("2026-11-20"), or null. */
export function dayOf(value: string | Date | null): string | null {
  if (value === null) return null;
  const time = value instanceof Date ? value : new Date(value);
  return Number.isNaN(time.getTime()) ? null : time.toISOString().slice(0, 10);
}

/** The job's link: its note's (the link added), else its Apply link; both in their shared form. */
export function linkOf(row: Pick<EditJobRow, 'note_url' | 'apply_url'>): string {
  return sharedAddress(row.note_url ?? row.apply_url) ?? row.note_url ?? row.apply_url;
}

/** The job's values (see the top); `places` its job_locations' raw places. */
export function valuesOf(row: EditJobRow, places: readonly string[]): JobEditValues {
  const link = linkOf(row);
  const apply = sharedAddress(row.apply_url) ?? row.apply_url;
  const min = amount(row.salary_min);
  const max = amount(row.salary_max);
  const listed = places.map((place) => place.trim()).filter(Boolean);
  return {
    link,
    applyUrl: row.note_url !== null && apply !== '' && apply !== link ? apply : null,
    title: row.title,
    company: row.company_name,
    descriptionHtml: sanitizeDescription(row.description_html),
    locations: listed.length > 0 ? listed : row.locations_text.trim() ? [row.locations_text.trim()] : [],
    workArrangement: oneOf<WorkArrangement>(WORK_ARRANGEMENTS, row.work_arrangement),
    employmentType: oneOf<EmploymentType>(EMPLOYMENT_TYPES, row.employment_type),
    salary:
      min === null && max === null
        ? null
        : { min, max, currency: (row.salary_currency ?? 'USD').toUpperCase(), period: oneOf<SalaryPeriod>(SALARY_PERIODS, row.salary_period) },
    postedAt: dayOf(row.posted_at),
  };
}

/** The job's places as given (job_locations' raw text, in order). */
export async function placesOf(db: DbQueries, jobId: number): Promise<string[]> {
  const rows = await db.all<{ raw: string }>('SELECT raw FROM job_locations WHERE job_id = ? ORDER BY position', [jobId]);
  return rows.map((row) => row.raw);
}

/** The job's values now, or undefined for no job. */
export async function currentValues(db: DbQueries, jobId: number): Promise<{ row: EditJobRow; values: JobEditValues } | undefined> {
  const row = await editJobRow(db, jobId);
  if (!row) return undefined;
  return { row, values: valuesOf(row, await placesOf(db, jobId)) };
}

/** A value's stable text: object keys sorted, so two equal values read the same. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

/** Whether two values of a field are the same. */
export const sameValue = (a: unknown, b: unknown): boolean => stableJson(a) === stableJson(b);

/**
 * Whether two values of `field` are the same for the job: a company by its name key (normalizeCompanyName: "Acme" and
 * "ACME, Inc." are one company, the one the job has), any other field as its value.
 */
export function sameFieldValue(field: JobEditField, a: unknown, b: unknown): boolean {
  if (field === 'company' && typeof a === 'string' && typeof b === 'string') return companyKeyOf(a) === companyKeyOf(b);
  return sameValue(a, b);
}

/** A company name's key, as ingest files a company (ingest/normalize.ts normalizeCompany). */
export const companyKeyOf = (name: string): string => normalizeCompanyName(name) || name.toLowerCase().replace(/\s+/g, '');

/** The values' hash: an edit names it, and is refused when the job changed since. */
export function versionOfValues(values: JobEditValues): string {
  return createHash('sha256').update(stableJson(values), 'utf8').digest('hex');
}

/** Which value of JobEditValues a field holds. */
export function valueOfField(values: JobEditValues, field: JobEditField): unknown {
  return field === 'description' ? values.descriptionHtml : values[field];
}

/** Who sees the job now. */
export function visibilityOf(row: Pick<EditJobRow, 'active' | 'owner_user_id' | 'held'>): JobEditVisibility {
  if (!row.active) return 'closed';
  if (row.owner_user_id !== null) return 'private';
  return row.held ? 'waiting' : 'public';
}

/** The fields an admin edited, in the editor's order. */
export async function editMarksOf(db: DbQueries, jobId: number): Promise<JobEditMark[]> {
  const rows = await db.all<{ field: JobEditField; edited_at: string | Date; email: string | null }>(
    'SELECT e.field, e.edited_at, u.email FROM job_admin_edits e LEFT JOIN users u ON u.id = e.edited_by WHERE e.job_id = ?',
    [jobId],
  );
  return rows
    .map((row) => ({ field: row.field, editedAt: new Date(row.edited_at).toISOString(), editedBy: row.email ?? null }))
    .sort((a, b) => JOB_EDIT_FIELDS.indexOf(a.field) - JOB_EDIT_FIELDS.indexOf(b.field));
}

/** The editor of a job (GET /api/admin/reviews/jobs/:jobId), or undefined for no job. */
export async function editorOf(db: DbQueries, jobId: number): Promise<AdminJobEditor | undefined> {
  const current = await currentValues(db, jobId);
  if (!current) return undefined;
  return {
    jobId,
    values: current.values,
    version: versionOfValues(current.values),
    edited: await editMarksOf(db, jobId),
    ownApplyLink: current.row.note_url !== null,
    visibility: visibilityOf(current.row),
  };
}
