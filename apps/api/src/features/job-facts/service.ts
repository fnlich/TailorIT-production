import {
  buildJobFacts,
  extractDeterministicFacts,
  JobFactsDetailsSchema,
  type BuiltJobFacts,
  type DegreeLevelV2,
  type EmploymentTypeV2,
  type ExperienceLevel,
  type FactsAnalysisInput,
  type FactsJobInput,
  type JobAutoApplySupport,
  type JobCertification,
  type JobFactsView,
  type SponsorshipState,
  type AuthorizationRequirement,
  type WorkArrangement,
  autoApplySupportOf,
} from '@tailorit/shared';
import { nowIso, type AppDeps } from '../../core/context';
import type { Dialect } from '../../core/db/dialect';
import type { DbClient, DbQueries } from '../../core/db/types';
import {
  findForm,
  formKeyOfJob,
  formPlace,
  keyFormFits,
  placeOfOwn,
  placeOfShared,
  type FormPlace,
  type FormRow,
  type JobOfForm,
} from '../autofill/forms/store';
import { analysisById, type AnalysisRecord } from '../job-analysis/store';
import { readJobText, readJobTexts } from '../jobs/text';
import { projectJobs } from '../ingest/project-job';

// v2.0 P4 (06-filters-analysis.md, "job_facts: what each filter reads"; 01's 0825): each job's facts, computed on demand
// (a saved job filtered or prepared, an MCP filter run, a job whose analysis changed) and never for the whole lake. They
// come from the job's columns and locations, its best analysis (jobs.analysis_id: the v2 answer when Claude read it at
// version 2) and the deterministic rules over the full description. No AI is ever called here.
//
// A row is stale when it was computed by an older JOB_FACTS_VERSION, from another text (content_hash) or analysis
// (analysis_id), when the count of the job's known questions changed, or when its apply address's support did.
// v3.0 D2-C: through the async client.
// v3.0 PG-C: on the baseline's shape. The description is read through features/jobs/text.ts (job_texts; jobs holds no
// text); flags are booleans; the `"authorization"` column is quoted (a
// PostgreSQL reserved word); and a stored facts row is projected into the job's search row (job_search copies the
// facts) in its transaction.
// v3.0 DB-INGEST (11-database.md §5.5a, D1b): facts are no longer on demand only. Ingest computes them for every open
// job it creates or changes, in the batch's transaction before the batch's projection (storeFactsIn, through
// ingest/facts.ts), and a daily backfill sweep (ingest/facts.ts, registered in index.ts) fills the open jobs that lack
// them. Still never AI: the AI analysis refines them when it lands (refreshFactsOfText).

/** Bump whenever the facts' computation changes: every older row is then stale and computed again when read. */
export const JOB_FACTS_VERSION = 1;
/** Jobs computed in one transaction. */
export const JOB_FACTS_CHUNK = 200;

interface StateRow {
  id: number;
  content_hash: string;
  analysis_id: number | null;
  apply_url: string;
  facts_version: number | null;
  facts_hash: string | null;
  facts_analysis: number | null;
  facts_questions: number | null;
  facts_auto: JobAutoApplySupport | null;
}

interface JobRow {
  id: number;
  content_hash: string;
  analysis_id: number | null;
  apply_url: string;
  work_arrangement: string | null;
  employment_type: string | null;
  industry: string | null;
  experience_levels: string;
  sponsors_h1b: Flag | null;
  requires_clearance: Flag | null;
  degree: string | null;
  salary_annual_usd_min: number | null;
  salary_annual_usd_max: number | null;
  locations_text: string;
}

interface LocationRow {
  region: string | null;
  country_code: string | null;
  is_remote: Flag;
}

interface FactsRow {
  job_id: number;
  work_arrangement: WorkArrangement | null;
  employment_type: EmploymentTypeV2 | null;
  industry: string | null;
  degree_level: DegreeLevelV2 | null;
  min_years: number | null;
  experience_levels: string;
  clearance_required: Flag | null;
  sponsorship: SponsorshipState | null;
  authorization: AuthorizationRequirement | null;
  salary_min_usd: number | null;
  salary_max_usd: number | null;
  cover_letter_required: Flag | null;
  auto_apply: JobAutoApplySupport;
  questions_known: number;
  details: string;
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** A flag column as read (a boolean; 1 is read as true too). */
type Flag = boolean | number;
const isSet = (value: Flag) => value === true || value === 1;
const bool = (value: Flag | null) => (value === null ? null : isSet(value));
/** A flag as the shared facts builder reads it (1 set, 0 not, null unknown). */
const flagNumber = (value: Flag | null) => (value === null ? null : isSet(value) ? 1 : 0);

/** Unique positive ids, in their first order. */
function idsOf(jobIds: readonly number[]): number[] {
  return [...new Set(jobIds.filter((id) => Number.isInteger(id) && id > 0))];
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
  return out;
}

/** The analysis input of an analysis record; null when there is none. */
function analysisInputOf(record: AnalysisRecord | null): FactsAnalysisInput | null {
  if (!record) return null;
  return {
    source: record.source,
    version: record.version,
    minYears: record.minYears,
    requiredYears: record.requiredYears,
    experienceLevels: record.experienceLevels,
    extras: record.extras,
    domains: record.terms?.domains ?? [],
    v2: record.source === 'ai' ? (record.facts ?? null) : null,
  };
}

/** One job's facts from its columns, places, analysis and description (no AI). */
function buildFacts(
  job: JobRow,
  locationRows: readonly LocationRow[],
  analysis: FactsAnalysisInput | null,
  questionsKnown: number,
  description: string,
): BuiltJobFacts {
  const locations = locationRows.map((row) => ({ region: row.region, countryCode: row.country_code, isRemote: isSet(row.is_remote) }));
  const input: FactsJobInput = {
    applyUrl: job.apply_url,
    workArrangement: job.work_arrangement,
    employmentType: job.employment_type,
    industry: job.industry,
    experienceLevels: parseJson<unknown[]>(job.experience_levels, []).filter((level): level is string => typeof level === 'string'),
    sponsorsH1b: flagNumber(job.sponsors_h1b),
    requiresClearance: flagNumber(job.requires_clearance),
    degree: job.degree,
    salaryAnnualUsdMin: job.salary_annual_usd_min,
    salaryAnnualUsdMax: job.salary_annual_usd_max,
    locations,
  };
  const deterministic = extractDeterministicFacts({ description, locationsText: job.locations_text, locations });
  return buildJobFacts(input, analysis, deterministic, questionsKnown);
}

/** The job_facts row's values, as the upsert binds them. */
function factsValues(job: JobRow, analysis: FactsAnalysisInput | null, built: BuiltJobFacts, computedAt: string) {
  return {
    jobId: job.id,
    factsVersion: JOB_FACTS_VERSION,
    contentHash: job.content_hash,
    analysisId: job.analysis_id,
    analysisVersion: analysis?.source === 'ai' ? analysis.version : null,
    workArrangement: built.workArrangement,
    employmentType: built.employmentType,
    industry: built.industry && built.industry.length <= 40 ? built.industry : null,
    degreeLevel: built.degreeLevel,
    minYears: built.minYears,
    experienceLevels: JSON.stringify(built.experienceLevels),
    clearanceRequired: built.clearanceRequired,
    sponsorship: built.sponsorship,
    authorization: built.authorization,
    salaryMinUsd: built.salaryMinUsd,
    salaryMaxUsd: built.salaryMaxUsd,
    coverLetterRequired: built.coverLetterRequired,
    eligibilityRules: built.eligibility.length > 0,
    autoApply: built.autoApply,
    questionsKnown: built.questionsKnown,
    details: JSON.stringify(built.details),
    computedAt,
  };
}

/** Whether a job's stored facts are stale (see the top of the file). */
function isStale(row: StateRow, questions: number): boolean {
  return (
    row.facts_version === null ||
    row.facts_version < JOB_FACTS_VERSION ||
    row.facts_hash !== row.content_hash ||
    row.facts_analysis !== row.analysis_id ||
    row.facts_questions !== questions ||
    row.facts_auto !== autoApplySupportOf(row.apply_url)
  );
}

/** The filters' view of each job's facts row and its child rows. */
function viewsOf(
  facts: readonly FactsRow[],
  eligibilityRows: ReadonlyArray<{ job_id: number; kind: string; value: string }>,
  certificationRows: ReadonlyArray<{ job_id: number; cert_key: string; name: string; required: Flag }>,
  out: Map<number, JobFactsView>,
): void {
  const eligibility = new Map<number, JobFactsView['eligibility']>();
  for (const row of eligibilityRows) {
    const entry = eligibility.get(row.job_id) ?? { countries: [], regions: [], utcOffsets: [] };
    if (row.kind === 'country') entry.countries.push(row.value);
    else if (row.kind === 'region') entry.regions.push(row.value);
    else if (row.kind === 'utc_offset') entry.utcOffsets.push(row.value);
    eligibility.set(row.job_id, entry);
  }
  const certifications = new Map<number, JobCertification[]>();
  for (const row of certificationRows) {
    const list = certifications.get(row.job_id) ?? [];
    list.push({ key: row.cert_key, name: row.name, required: isSet(row.required) });
    certifications.set(row.job_id, list);
  }
  for (const row of facts) {
    const details = JobFactsDetailsSchema.safeParse(parseJson<unknown>(row.details, {}));
    out.set(row.job_id, {
      jobId: row.job_id,
      workArrangement: row.work_arrangement,
      employmentType: row.employment_type,
      industry: row.industry,
      degreeLevel: row.degree_level,
      degreeOrEquivalent: details.success ? details.data.degreeOrEquivalent : false,
      minYears: row.min_years,
      experienceLevels: parseJson<unknown[]>(row.experience_levels, []).filter(
        (level): level is ExperienceLevel => typeof level === 'string',
      ),
      clearanceRequired: bool(row.clearance_required),
      sponsorship: row.sponsorship,
      authorization: row.authorization,
      citizenshipCountry: details.success ? details.data.citizenshipCountry : null,
      salaryMinUsd: row.salary_min_usd,
      salaryMaxUsd: row.salary_max_usd,
      coverLetterRequired: bool(row.cover_letter_required),
      autoApply: row.auto_apply,
      questionsKnown: row.questions_known,
      eligibility: eligibility.get(row.job_id) ?? { countries: [], regions: [], utcOffsets: [] },
      certifications: certifications.get(row.job_id) ?? [],
    });
  }
}

// ------------------------------------------------------------------------------------------------------------ SQL

const JOB_SQL = `SELECT id, content_hash, analysis_id, apply_url, work_arrangement, employment_type, industry, experience_levels,
         sponsors_h1b, requires_clearance, degree, salary_annual_usd_min, salary_annual_usd_max, locations_text
       FROM jobs WHERE id = ?`;
const LOCATIONS_SQL = 'SELECT region, country_code, is_remote FROM job_locations WHERE job_id = ? ORDER BY position';
const QUESTIONS_SQL = 'SELECT count(*) AS n FROM job_form_questions WHERE form_id = ?';
const OF_TEXT_SQL = 'SELECT f.job_id FROM jobs j JOIN job_facts f ON f.job_id = j.id WHERE j.content_hash = ?';
const UPSERT_SQL = `INSERT INTO job_facts(job_id, facts_version, content_hash, analysis_id, analysis_version, work_arrangement,
         employment_type, industry, degree_level, min_years, experience_levels, clearance_required, sponsorship,
         "authorization", salary_min_usd, salary_max_usd, cover_letter_required, eligibility_rules, auto_apply,
         questions_known, details, computed_at)
       VALUES (@jobId, @factsVersion, @contentHash, @analysisId, @analysisVersion, @workArrangement, @employmentType,
         @industry, @degreeLevel, @minYears, @experienceLevels, @clearanceRequired, @sponsorship, @authorization,
         @salaryMinUsd, @salaryMaxUsd, @coverLetterRequired, @eligibilityRules, @autoApply, @questionsKnown, @details,
         @computedAt)
       ON CONFLICT(job_id) DO UPDATE SET facts_version = excluded.facts_version, content_hash = excluded.content_hash,
         analysis_id = excluded.analysis_id, analysis_version = excluded.analysis_version,
         work_arrangement = excluded.work_arrangement, employment_type = excluded.employment_type,
         industry = excluded.industry, degree_level = excluded.degree_level, min_years = excluded.min_years,
         experience_levels = excluded.experience_levels, clearance_required = excluded.clearance_required,
         sponsorship = excluded.sponsorship, "authorization" = excluded."authorization",
         salary_min_usd = excluded.salary_min_usd, salary_max_usd = excluded.salary_max_usd,
         cover_letter_required = excluded.cover_letter_required, eligibility_rules = excluded.eligibility_rules,
         auto_apply = excluded.auto_apply, questions_known = excluded.questions_known, details = excluded.details,
         computed_at = excluded.computed_at`;

/** The statements that read a JSON list of job ids, in the engine's spelling of a JSON array's elements. */
function listSql(d: Dialect) {
  const ids = `(SELECT CAST(value AS INTEGER) FROM ${d.jsonEach('?')})`;
  return {
    state: `SELECT j.id, j.content_hash, j.analysis_id, j.apply_url, f.facts_version, f.content_hash AS facts_hash,
         f.analysis_id AS facts_analysis, f.questions_known AS facts_questions, f.auto_apply AS facts_auto
       FROM jobs j LEFT JOIN job_facts f ON f.job_id = j.id WHERE j.id IN ${ids}`,
    // v3.0 DB-INGEST: the open jobs alone (facts at ingest and the backfill: 11 §5.5a, "every open job").
    openState: `SELECT j.id, j.content_hash, j.analysis_id, j.apply_url, f.facts_version, f.content_hash AS facts_hash,
         f.analysis_id AS facts_analysis, f.questions_known AS facts_questions, f.auto_apply AS facts_auto
       FROM jobs j LEFT JOIN job_facts f ON f.job_id = j.id WHERE j.active AND j.id IN ${ids}`,
    // v3.0 DB-INGEST: an ingest batch's jobs, places and child rows in one statement each (storeFactsIn).
    jobs: `SELECT id, content_hash, analysis_id, apply_url, work_arrangement, employment_type, industry, experience_levels,
         sponsors_h1b, requires_clearance, degree, salary_annual_usd_min, salary_annual_usd_max, locations_text
       FROM jobs WHERE id IN ${ids}`,
    locations: `SELECT job_id, region, country_code, is_remote FROM job_locations WHERE job_id IN ${ids} ORDER BY job_id, position`,
    clearEligibility: `DELETE FROM job_facts_eligibility WHERE job_id IN ${ids}`,
    clearCertifications: `DELETE FROM job_facts_certifications WHERE job_id IN ${ids}`,
    facts: `SELECT * FROM job_facts WHERE job_id IN ${ids}`,
    eligibility: `SELECT job_id, kind, value FROM job_facts_eligibility WHERE job_id IN ${ids} ORDER BY job_id, kind, value`,
    certifications:
      `SELECT job_id, cert_key, name, required FROM job_facts_certifications WHERE job_id IN ${ids} ` +
      'ORDER BY job_id, required DESC, cert_key',
  };
}

// ------------------------------------------------------------------------------------------------- async reads/writes

/**
 * How many questions TailorIT knows of a job's form (job_form_questions), read-only. Joins the caller's transaction.
 */
export async function knownQuestionCount(db: DbClient, jobId: number): Promise<number> {
  const place = await formPlace(db, jobId, null);
  const form = place ? await findForm(db, place) : null;
  if (!form) return 0;
  return (await db.one<{ n: number }>(QUESTIONS_SQL, [form.id]))!.n;
}

/** One job's facts from its sources (no AI): what ensure stores. Joins the caller's transaction. */
export async function computeJobFacts(
  db: DbClient,
  jobId: number,
  questionsKnown?: number,
): Promise<{ built: BuiltJobFacts; job: JobRow; analysis: FactsAnalysisInput | null } | null> {
  const job = await db.one<JobRow>(JOB_SQL, [jobId]);
  if (!job) return null;
  const locations = await db.all<LocationRow>(LOCATIONS_SQL, [jobId]);
  const analysis = analysisInputOf(job.analysis_id === null ? null : await analysisById(db, job.analysis_id));
  const description = (await readJobText(db, jobId))?.text ?? '';
  const built = buildFacts(job, locations, analysis, questionsKnown ?? (await knownQuestionCount(db, jobId)), description);
  return { built, job, analysis };
}

async function storeFacts(t: DbQueries, job: JobRow, analysis: FactsAnalysisInput | null, built: BuiltJobFacts, computedAt: string): Promise<void> {
  await t.run(UPSERT_SQL, factsValues(job, analysis, built, computedAt));
  // v3.0 DB-INGEST: the child rows in one statement each (facts are built for every job ingest writes; each statement is
  // a round trip on PostgreSQL).
  await t.run('DELETE FROM job_facts_eligibility WHERE job_id = ?', [job.id]);
  if (built.eligibility.length > 0) {
    await t.run(
      `INSERT INTO job_facts_eligibility(job_id, kind, value, source) VALUES ${built.eligibility.map(() => '(?, ?, ?, ?)').join(', ')} ON CONFLICT DO NOTHING`,
      built.eligibility.flatMap((row) => [job.id, row.kind, row.value, row.source]),
    );
  }
  await t.run('DELETE FROM job_facts_certifications WHERE job_id = ?', [job.id]);
  if (built.certifications.length > 0) {
    await t.run(
      `INSERT INTO job_facts_certifications(job_id, cert_key, name, required) VALUES ${built.certifications.map(() => '(?, ?, ?, ?)').join(', ')} ON CONFLICT DO NOTHING`,
      built.certifications.flatMap((entry) => [job.id, entry.key, entry.name, entry.required]),
    );
  }
}

/**
 * v3.0 DB-INGEST: knownQuestionCount for many jobs in three statements (an ingest batch's jobs: four statements a job
 * otherwise). The same reading as formPlace + findForm with no page: a shared job's form by its job, else by its
 * posting's key unless another job holds that form; an own page job's form by its posting's key only. Joins the
 * caller's transaction.
 */
export async function knownQuestionCounts(db: DbQueries, jobIds: readonly number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const ids = idsOf(jobIds);
  if (ids.length === 0) return out;
  const list = `(SELECT CAST(value AS INTEGER) FROM ${db.dialect.jsonEach('?')})`;
  const jobs = await db.all<JobOfForm & { id: number; shared: boolean }>(
    `SELECT id, owner_user_id IS NULL AS shared, made_from, apply_url,
       (SELECT k.key FROM job_keys k WHERE k.job_id = jobs.id AND k.key_kind = 'link' ORDER BY k.key LIMIT 1) AS link_key
     FROM jobs WHERE id IN ${list}`,
    [JSON.stringify(ids)],
  );
  const places = new Map<number, FormPlace | null>();
  for (const job of jobs) {
    const own = formKeyOfJob(job, job.id);
    places.set(job.id, job.shared ? placeOfShared(job.id, null, own) : placeOfOwn(null, own));
  }
  const keys = [...new Set([...places.values()].filter((place): place is FormPlace => place !== null).map((place) => place.key))];
  const forms =
    places.size === 0
      ? []
      : await db.all<FormRow>(
          `SELECT id, form_key, job_id FROM job_forms WHERE job_id IN ${list}
             OR form_key IN (SELECT value FROM ${db.dialect.jsonEach('?')})`,
          [JSON.stringify(ids), JSON.stringify(keys)],
        );
  const formOf = new Map<number, number>();
  for (const [jobId, place] of places) {
    if (!place) continue;
    const byJob = place.jobId !== null ? forms.find((form) => form.job_id === place.jobId) : undefined;
    const byKey = byJob ? undefined : forms.find((form) => form.form_key === place.key);
    const form = byJob ?? (keyFormFits(place, byKey) ? byKey : undefined);
    if (form) formOf.set(jobId, form.id);
  }
  const formIds = [...new Set(formOf.values())];
  const counts = new Map<number, number>();
  if (formIds.length > 0) {
    for (const row of await db.all<{ form_id: number; n: number }>(
      `SELECT form_id, count(*) AS n FROM job_form_questions WHERE form_id IN ${list} GROUP BY form_id`,
      [JSON.stringify(formIds)],
    )) {
      counts.set(row.form_id, row.n);
    }
  }
  for (const job of jobs) out.set(job.id, formOf.has(job.id) ? (counts.get(formOf.get(job.id)!) ?? 0) : 0);
  return out;
}

/** The jobs among `ids` whose facts are stale or missing, with their known question counts. */
async function staleOf(db: DbClient, ids: readonly number[], options: { openOnly?: boolean } = {}): Promise<Array<{ id: number; questions: number }>> {
  const sql = listSql(db.dialect);
  const stale: Array<{ id: number; questions: number }> = [];
  const rows = await db.all<StateRow>(options.openOnly ? sql.openState : sql.state, [JSON.stringify(ids)]);
  const questions = await knownQuestionCounts(
    db,
    rows.map((row) => row.id),
  );
  for (const row of rows) {
    const known = questions.get(row.id) ?? 0;
    if (isStale(row, known)) stale.push({ id: row.id, questions: known });
  }
  return stale;
}

/**
 * v3.0 DB-INGEST (11-database.md §5.5a, D1b): facts for every open job at ingest, without AI. In the caller's
 * transaction (the ingest batch's): the open jobs among `jobIds` whose facts are stale or missing are computed and
 * stored; nothing is projected (the caller projects the batch's jobs after it). Answers the ids it stored.
 */
export async function storeFactsIn(db: DbClient, jobIds: readonly number[], computedAt: string): Promise<number[]> {
  const stored: number[] = [];
  const sql = listSql(db.dialect);
  for (const chunk of chunks(idsOf(jobIds), JOB_FACTS_CHUNK)) {
    const stale = await staleOf(db, chunk, { openOnly: true });
    if (stale.length === 0) continue;
    // The chunk's rows, places and texts in one read each (an ingest batch's jobs: each statement is a round trip).
    const ids = [JSON.stringify(stale.map((entry) => entry.id))];
    const jobs = new Map((await db.all<JobRow>(sql.jobs, ids)).map((row) => [row.id, row]));
    const places = new Map<number, LocationRow[]>();
    for (const row of await db.all<LocationRow & { job_id: number }>(sql.locations, ids)) {
      const list = places.get(row.job_id) ?? [];
      list.push(row);
      places.set(row.job_id, list);
    }
    const texts = await readJobTexts(db, stale.map((entry) => entry.id));
    const done: Array<{ job: JobRow; analysis: FactsAnalysisInput | null; built: BuiltJobFacts }> = [];
    for (const { id, questions } of stale) {
      const job = jobs.get(id);
      if (!job) continue;
      const analysis = analysisInputOf(job.analysis_id === null ? null : await analysisById(db, job.analysis_id));
      done.push({ job, analysis, built: buildFacts(job, places.get(id) ?? [], analysis, questions, texts.get(id)?.text ?? '') });
    }
    if (done.length === 0) continue;
    for (const entry of done) await db.run(UPSERT_SQL, factsValues(entry.job, entry.analysis, entry.built, computedAt));
    const doneIds = [JSON.stringify(done.map((entry) => entry.job.id))];
    await db.run(sql.clearEligibility, doneIds);
    const eligibility = done.flatMap((entry) => entry.built.eligibility.map((row) => [entry.job.id, row.kind, row.value, row.source]));
    if (eligibility.length > 0) {
      await db.run(
        `INSERT INTO job_facts_eligibility(job_id, kind, value, source) VALUES ${eligibility.map(() => '(?, ?, ?, ?)').join(', ')} ON CONFLICT DO NOTHING`,
        eligibility.flat(),
      );
    }
    await db.run(sql.clearCertifications, doneIds);
    const certifications = done.flatMap((entry) => entry.built.certifications.map((cert) => [entry.job.id, cert.key, cert.name, cert.required]));
    if (certifications.length > 0) {
      await db.run(
        `INSERT INTO job_facts_certifications(job_id, cert_key, name, required) VALUES ${certifications.map(() => '(?, ?, ?, ?)').join(', ')} ON CONFLICT DO NOTHING`,
        certifications.flat(),
      );
    }
    stored.push(...done.map((entry) => entry.job.id));
  }
  return stored;
}

/**
 * Computes the stale and missing facts of these jobs, one transaction per JOB_FACTS_CHUNK jobs. Never calls AI.
 * Answers how many it computed. (Two passes at once may both compute a job: the upsert keeps the last, which is the
 * same facts.)
 */
export async function ensureJobFacts(deps: Pick<AppDeps, 'db' | 'now'>, jobIds: readonly number[]): Promise<number> {
  const db = deps.db;
  let computed = 0;
  for (const chunk of chunks(idsOf(jobIds), JOB_FACTS_CHUNK)) {
    const stale = await staleOf(db, chunk);
    if (stale.length === 0) continue;
    const computedAt = nowIso(deps);
    await db.tx(
      async (t) => {
        const stored: number[] = [];
        for (const { id, questions } of stale) {
          const result = await computeJobFacts(db, id, questions);
          if (!result) continue;
          await storeFacts(t, result.job, result.analysis, result.built, computedAt);
          stored.push(id);
          computed += 1;
        }
        // job_search copies the facts (11 §5.6): the chunk's search rows follow in its transaction, in one projection.
        if (stored.length > 0) await projectJobs(t, stored);
      },
      { label: 'ensureJobFacts' },
    );
  }
  return computed;
}

/** The stored facts of these jobs as the filters read them; a job without a row is left out. */
export async function readJobFacts(deps: Pick<AppDeps, 'db'>, jobIds: readonly number[]): Promise<Map<number, JobFactsView>> {
  const sql = listSql(deps.db.dialect);
  const out = new Map<number, JobFactsView>();
  for (const chunk of chunks(idsOf(jobIds), 500)) {
    const ids = [JSON.stringify(chunk)];
    viewsOf(
      await deps.db.all<FactsRow>(sql.facts, ids),
      await deps.db.all<{ job_id: number; kind: string; value: string }>(sql.eligibility, ids),
      await deps.db.all<{ job_id: number; cert_key: string; name: string; required: Flag }>(sql.certifications, ids),
      out,
    );
  }
  return out;
}

/** The jobs of a text whose facts were computed, computed again when stale (their analysis changed). */
export async function refreshFactsOfText(deps: Pick<AppDeps, 'db' | 'now'>, contentHash: string): Promise<number> {
  const ids = (await deps.db.all<{ job_id: number }>(OF_TEXT_SQL, [contentHash])).map((row) => row.job_id);
  return ids.length > 0 ? ensureJobFacts(deps, ids) : 0;
}

/** deps.services.jobFacts once INT-1 makes the service async (JobFactsService's methods, awaited). */
export interface JobFactsService {
  ensure(jobIds: readonly number[]): Promise<number>;
  read(jobIds: readonly number[]): Promise<Map<number, JobFactsView>>;
  ensureAndRead(jobIds: readonly number[]): Promise<Map<number, JobFactsView>>;
  refreshText(contentHash: string): Promise<number>;
}

export function createJobFactsService(deps: Pick<AppDeps, 'db' | 'now'>): JobFactsService {
  return {
    ensure: (jobIds) => ensureJobFacts(deps, jobIds),
    read: (jobIds) => readJobFacts(deps, jobIds),
    async ensureAndRead(jobIds) {
      await ensureJobFacts(deps, jobIds);
      return readJobFacts(deps, jobIds);
    },
    refreshText: (contentHash) => refreshFactsOfText(deps, contentHash),
  };
}

declare module '../../core/context' {
  interface AppServices {
    /** v2.0 P4: each job's facts for the prepare filters (features/job-facts). */
    jobFacts?: JobFactsService;
  }
}
