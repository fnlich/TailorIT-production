import { JOB_EDIT_FIELDS, linkKey, type JobEditField, type JobEditSalary, type JobEditValues } from '@tailorit/shared';
import type { DbQueries } from '../../../core/db/types';
import { projectJob } from '../../../core/seams';
import { writeJobText } from '../../jobs/text';
import { DETERMINISTIC_VERSION } from '../../job-analysis/deterministic';
import { applyAiFacts, fillFacets, refreshAnalysisLinks, saveAnalysis } from '../../job-analysis/store';
import { resolveCompanyByName, resolveCompanyIn } from '../../companies/resolve';
import { minConfidenceOf } from '../../companies/profile';
import { addJobKeys, keysOfAddress } from '../../ingest/keys';
import { normalizeCompany, normalizePosting, normalizeSalary } from '../../ingest/normalize';
import type { RawPosting } from '../../ingest/types';
import { currentValues, sameFieldValue, valueOfField, type EditJobRow } from './values';

// v38 REVEDIT (SP v38 PLAN.md E2, E4): what an admin's edit writes on a job, field by field, and the rule that keeps it.
//   - writeEditedField: one field's value on the job, as ingest would store it (its caps, its cleaning, its derived
//     columns: a title's key; a description's text, content hash, SimHash, deterministic analysis and facets; places
//     parsed as a posting's; a salary's yearly US-dollar range), the job's search row rebuilt (projectJob).
//   - keepAdminEdits: after ANY later write of the job from its posting (the ingest store's rewrite and fill, a pay
//     supplement, an AI reading's fill, an approval that re-files it), each field an admin edited gets the admin's value
//     back, and the posting's value it replaced is kept as the field's `original` ("Use the posting's text again"). One
//     indexed read when the job has no edit (the common case).
//   - moveAdminEdits: a person's own job an admin edited gives way to the shared job read from its link (Retry read,
//     "Read this link", an approval of a page review): its edits go with it (the newer edit of a field wins).
// Every function runs in the caller's transaction (no outside I/O); a leaf of the ingest store (it never imports it).

/** The value stored for a field (job_admin_edits.value): JobEditValues' value of it. */
export type EditValue = JobEditValues[keyof JobEditValues];

/** A posting the ingest normaliser reads for one field's derived columns (the job's other values as they are). */
function postingFor(row: EditJobRow, values: JobEditValues, extra: Partial<RawPosting>): RawPosting {
  return {
    sourceJobId: `admin-edit:${row.id}`,
    title: values.title,
    company: { name: values.company },
    url: values.link,
    ownerUserId: row.owner_user_id,
    ...extra,
  };
}

/** A salary as the store keeps it (normalizeSalary: its yearly range), or the "checked, none" of a job stating none. */
async function writeSalary(t: DbQueries, jobId: number, salary: JobEditSalary | null, country: string | null, at: string): Promise<void> {
  const sql =
    'UPDATE jobs SET salary_min = ?, salary_max = ?, salary_currency = ?, salary_period = ?, salary_annual_usd_min = ?, ' +
    'salary_annual_usd_max = ?, salary_raw = ?, updated_at = ? WHERE id = ?';
  const kept = salary ? normalizeSalary({ min: salary.min, max: salary.max, currency: salary.currency, period: salary.period, raw: null }, country) : null;
  if (!kept) {
    await t.run(sql, [null, null, null, null, null, null, '', at, jobId]);
    return;
  }
  await t.run(sql, [kept.min, kept.max, kept.currency, kept.period, kept.annualUsdMin, kept.annualUsdMax, null, at, jobId]);
}

/** The job's first source (a name-only company names it, as an approval's does). */
async function firstSource(t: DbQueries, jobId: number): Promise<number | null> {
  const row = await t.one<{ source_id: number }>('SELECT source_id FROM job_source_links WHERE job_id = ? ORDER BY seq LIMIT 1', [jobId]);
  return row ? Number(row.source_id) : null;
}

/**
 * Writes one field's value on job `row` (see the top). `values`: the job's values with this field's new value (a field's
 * derived columns read the others: a description's facets its title). The caller rebuilds the search row.
 */
export async function writeEditedField(t: DbQueries, row: EditJobRow, values: JobEditValues, field: JobEditField, at: string): Promise<void> {
  const jobId = row.id;
  switch (field) {
    case 'link': {
      const link = values.link;
      const key = linkKey(link);
      if (row.note_url !== null && key) {
        await t.run('UPDATE job_verifications SET url = ?, url_key = ?, host = ? WHERE job_id = ?', [link, key, new URL(link).hostname, jobId]);
        // Apply opens the job link unless the job keeps an Apply link of its own (values.applyUrl).
        if (values.applyUrl === null) await t.run('UPDATE jobs SET apply_url = ?, updated_at = ? WHERE id = ?', [link, at, jobId]);
      } else {
        await t.run('UPDATE jobs SET apply_url = ?, updated_at = ? WHERE id = ?', [link, at, jobId]);
      }
      // A shared job is found by its link from now on (a person's own job keeps no key: store.ts). The caller checked no
      // other job holds it; a key another job took meanwhile stays that job's.
      if (row.owner_user_id === null) await addJobKeys(t, jobId, keysOfAddress(link));
      return;
    }
    case 'applyUrl':
      if (row.note_url === null) return; // no Apply link of its own: Apply opens the job link
      await t.run('UPDATE jobs SET apply_url = ?, updated_at = ? WHERE id = ?', [values.applyUrl ?? values.link, at, jobId]);
      return;
    case 'title': {
      const posting = normalizePosting(postingFor(row, values, {}));
      await t.run('UPDATE jobs SET title = ?, title_key = ?, updated_at = ? WHERE id = ?', [posting.title, posting.titleKey, at, jobId]);
      return;
    }
    case 'company': {
      const company = normalizeCompany({ name: values.company });
      // The job's own company when the name is its (one name key), else the company of a source that lists the job
      // when the name is that one's (a board's company: "Use the posting's text again" puts it back as it was).
      const own = await t.one<{ id: number }>(
        `SELECT c.id FROM companies c WHERE c.id = ? AND c.name_key = ?
         UNION ALL SELECT c.id FROM job_source_links l JOIN job_sources s ON s.id = l.source_id JOIN companies c ON c.id = s.company_id
           WHERE l.job_id = ? AND c.name_key = ? AND c.merged_into_id IS NULL LIMIT 1`,
        [row.company_id, company.nameKey, jobId, company.nameKey],
      );
      // Else a person's own job: the shared company that fits, else their own row (as the store files a page job); a
      // shared job: the company of its name alone (v3.1 SEC-3, as an approval files a captured job): never one with a
      // board or a domain, nothing written about any company.
      const companyId = own
        ? Number(own.id)
        : row.owner_user_id !== null
          ? (await resolveCompanyIn(t, { company, boardAlias: null, domains: [], ownerUserId: row.owner_user_id, sourceId: null, at }, { minConfidence: minConfidenceOf() }))
              .companyId
          : (await resolveCompanyByName(t, { company, sourceId: await firstSource(t, jobId), at })).companyId;
      await t.run('UPDATE jobs SET company_id = ?, updated_at = ? WHERE id = ?', [companyId, at, jobId]);
      return;
    }
    case 'description': {
      const posting = normalizePosting(postingFor(row, values, { descriptionHtml: values.descriptionHtml || null }));
      await writeJobText(t, jobId, posting.descriptionHtml, at);
      await t.run(
        'UPDATE jobs SET content_hash = ?, text_simhash = ?, experience_levels = ?, leadership = ?, category_id = ?, subcategory_ids = ?, ' +
          'sponsors_h1b = ?, requires_clearance = ?, degree = ?, updated_at = ? WHERE id = ?',
        [
          posting.contentHash,
          posting.textSimhash === null ? null : posting.textSimhash.toString(),
          JSON.stringify(posting.experienceLevels),
          posting.leadership,
          posting.categoryId,
          JSON.stringify(posting.subcategoryIds),
          posting.sponsorsH1b,
          posting.requiresClearance,
          posting.degree,
          at,
          jobId,
        ],
      );
      // The text's analysis, as a rewrite writes it (ingest/store.ts writeAnalyses): its deterministic reading, then the
      // best analysis linked and the AI facts of the text put back where empty.
      const draft = posting.deterministic;
      const analysisId = await saveAnalysis(t, { ...draft, contentHash: posting.contentHash, source: 'deterministic', version: DETERMINISTIC_VERSION }, at);
      if (draft.softSkills) {
        await fillFacets(t, analysisId, { softSkills: draft.softSkills, terms: draft.terms ?? { certifications: [], domains: [] }, requiredYears: draft.requiredYears ?? null });
      }
      await refreshAnalysisLinks(t, posting.contentHash);
      await applyAiFacts(t, posting.contentHash);
      return;
    }
    case 'locations': {
      const posting = normalizePosting(postingFor(row, values, { locations: values.locations }));
      await t.run('DELETE FROM job_locations WHERE job_id = ?', [jobId]);
      const places = posting.locations.slice(0, 200);
      if (places.length > 0) {
        await t.run(
          `INSERT INTO job_locations(job_id, position, raw, city, region, country_code, is_remote) VALUES ${places.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          places.flatMap((place, position) => [jobId, position, place.raw.slice(0, 300), place.city, place.region, place.countryCode, place.isRemote]),
        );
      }
      await t.run('UPDATE jobs SET locations_text = ?, primary_location = ?, location_count = ?, updated_at = ? WHERE id = ?', [
        posting.locationsText,
        posting.primaryLocation,
        posting.locationCount,
        at,
        jobId,
      ]);
      return;
    }
    case 'workArrangement':
      await t.run('UPDATE jobs SET work_arrangement = ?, updated_at = ? WHERE id = ?', [values.workArrangement, at, jobId]);
      return;
    case 'employmentType':
      await t.run('UPDATE jobs SET employment_type = ?, updated_at = ? WHERE id = ?', [values.employmentType, at, jobId]);
      return;
    case 'salary': {
      const place = await t.one<{ country_code: string | null }>(
        'SELECT country_code FROM job_locations WHERE job_id = ? AND country_code IS NOT NULL ORDER BY position LIMIT 1',
        [jobId],
      );
      await writeSalary(t, jobId, values.salary, place?.country_code ?? null, at);
      return;
    }
    case 'postedAt':
      await t.run('UPDATE jobs SET posted_at = CAST(? AS timestamptz), updated_at = ? WHERE id = ?', [
        values.postedAt ? `${values.postedAt}T00:00:00.000Z` : null,
        at,
        jobId,
      ]);
      return;
  }
}

/** JobEditValues with one field's value replaced. */
export function withValue(values: JobEditValues, field: JobEditField, value: unknown): JobEditValues {
  const key = field === 'description' ? 'descriptionHtml' : field;
  return { ...values, [key]: value } as JobEditValues;
}

/**
 * Writes `fields` of `values` on the job, in the editor's order (a description's facets read the title written before
 * it), then rebuilds its search row. Answers whether it wrote anything.
 */
export async function writeEditedFields(
  t: DbQueries,
  jobId: number,
  next: (current: JobEditValues) => JobEditValues,
  fields: readonly JobEditField[],
  at: string,
): Promise<boolean> {
  if (fields.length === 0) return false;
  const current = await currentValues(t, jobId);
  if (!current) return false;
  const values = next(current.values);
  let row = current.row;
  for (const field of JOB_EDIT_FIELDS) {
    if (!fields.includes(field)) continue;
    await writeEditedField(t, row, values, field, at);
    // A link written on a noted job moves its note: the next field reads it from the row.
    if (field === 'link') row = { ...row, note_url: row.note_url === null ? null : values.link, apply_url: values.applyUrl ?? values.link };
  }
  await projectJob(t, jobId);
  return true;
}

/** The edits of a job: each field's admin value (job_admin_edits). */
export async function adminEditsOf(t: DbQueries, jobId: number): Promise<Map<JobEditField, unknown>> {
  const rows = await t.all<{ field: JobEditField; value: unknown }>('SELECT field, value FROM job_admin_edits WHERE job_id = ?', [jobId]);
  return new Map(rows.map((row) => [row.field, jsonbValue(row.value)]));
}

/** A jsonb value as read: the client answers json and jsonb as their text (core/db/pg/types.ts), parsed here. */
export function jsonbValue(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * Puts the admin's value back on each field of job `jobId` an admin edited that a later write changed (see the top),
 * keeping the value it replaced as the field's `original`. Answers whether it wrote. The caller's transaction.
 */
export async function keepAdminEdits(t: DbQueries, jobId: number, at: string): Promise<boolean> {
  const edits = await adminEditsOf(t, jobId);
  if (edits.size === 0) return false;
  const current = await currentValues(t, jobId);
  if (!current) return false;
  const changed = [...edits].filter(([field, value]) => !sameFieldValue(field, valueOfField(current.values, field), value)).map(([field]) => field);
  if (changed.length === 0) return false;
  for (const field of changed) {
    await t.run('UPDATE job_admin_edits SET original = CAST(? AS jsonb) WHERE job_id = ? AND field = ?', [
      JSON.stringify(valueOfField(current.values, field) ?? null),
      jobId,
      field,
    ]);
  }
  return writeEditedFields(
    t,
    jobId,
    (values) => changed.reduce((next, field) => withValue(next, field, edits.get(field)), values),
    changed,
    at,
  );
}

/** keepAdminEdits for several jobs (an AI reading's fill of one text's jobs): only those an admin edited are read. */
export async function keepAdminEditsOf(t: DbQueries, jobIds: readonly number[], at: string): Promise<void> {
  if (jobIds.length === 0) return;
  const edited = await t.all<{ job_id: number }>(
    `SELECT DISTINCT job_id FROM job_admin_edits WHERE job_id IN (SELECT CAST(value AS bigint) FROM ${t.dialect.jsonEach('?')})`,
    [JSON.stringify([...new Set(jobIds.map(Number))])],
  );
  for (const row of edited) await keepAdminEdits(t, Number(row.job_id), at);
}

/**
 * A person's own job `fromJobId` gave way to shared job `toJobId` (see the top): its edits go to the shared job (a field
 * the shared job has an edit of keeps the newer), then the shared job keeps them. The caller's transaction.
 */
export async function moveAdminEdits(t: DbQueries, fromJobId: number, toJobId: number, at: string): Promise<boolean> {
  if (fromJobId === toJobId) return false;
  const moving = await t.one<{ n: number }>('SELECT count(*)::int AS n FROM job_admin_edits WHERE job_id = ?', [fromJobId]);
  if (!moving || Number(moving.n) === 0) return false;
  // An Apply link of its own is a noted job's: a shared job without a note opens its job link.
  const noted = await t.one('SELECT 1 FROM job_verifications WHERE job_id = ?', [toJobId]);
  await t.run(
    `INSERT INTO job_admin_edits(job_id, field, value, original, edited_by, edited_at)
     SELECT ?, field, value, NULL, edited_by, edited_at FROM job_admin_edits WHERE job_id = ? ${noted ? '' : "AND field <> 'applyUrl'"}
     ON CONFLICT (job_id, field) DO UPDATE SET value = excluded.value, edited_by = excluded.edited_by, edited_at = excluded.edited_at
       WHERE job_admin_edits.edited_at <= excluded.edited_at`,
    [toJobId, fromJobId],
  );
  await t.run('DELETE FROM job_admin_edits WHERE job_id = ?', [fromJobId]);
  await keepAdminEdits(t, toJobId, at);
  return true;
}
