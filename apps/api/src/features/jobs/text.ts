import { htmlToText } from '@tailorit/shared';
import type { DbQueries } from '../../core/db/types';

// v3.0 PG-0 (PLAN §8, 11-database.md §5.5): the posting text. It lives in `job_texts` (one row per job, sanitised HTML
// only, range-partitioned by job id); `jobs` holds no text. The plain text is derived where it is needed, with the
// shared htmlToText and the length ingest kept in `jobs.description_text` before v3.0. Every reader and writer of a
// job's text goes through here (WAVE-BRIEF's data rules), so the storage can change in one place.
//
//   readJobText(db, id)          { html, text, chars, updatedAt } | undefined
//   readJobTexts(db, ids)        Map<id, JobText> (one statement)
//   writeJobText(db, id, html, at)  insert or replace, inside the caller's transaction when it has one
//   deleteJobText(db, id)        a purge (11 §8.5)
//   jobTextJoin('j', 'jt')       `LEFT JOIN job_texts jt ON jt.job_id = j.id`, for a query that lists jobs with their
//                                HTML (select `coalesce(jt.description_html, '') AS description_html`)
//
// It reads the baseline's shape (migrations-pg: job_texts).

/** The most plain-text characters derived from a posting (ingest's MAX_TEXT before v3.0). */
export const JOB_TEXT_MAX_CHARS = 100_000;

export interface JobText {
  /** The sanitised HTML as stored. */
  html: string;
  /** The readable text: htmlToText(html), at most JOB_TEXT_MAX_CHARS characters. */
  text: string;
  /** The stored length of `text` (job_texts.text_chars). */
  chars: number;
  updatedAt: string;
}

/** The plain text of a posting's HTML, as ingest derives it. */
export function plainTextOf(html: string): string {
  return htmlToText(html).slice(0, JOB_TEXT_MAX_CHARS);
}

interface TextRow {
  job_id: number;
  description_html: string;
  text_chars: number;
  updated_at: string;
}

function textOf(row: TextRow): JobText {
  return { html: row.description_html, text: plainTextOf(row.description_html), chars: row.text_chars, updatedAt: row.updated_at };
}

/** A job's text, or undefined when it has none (a job made without a description, or purged). */
export async function readJobText(db: DbQueries, jobId: number): Promise<JobText | undefined> {
  const row = await db.one<TextRow>(
    'SELECT job_id, description_html, text_chars, updated_at FROM job_texts WHERE job_id = ?',
    [jobId],
  );
  return row ? textOf(row) : undefined;
}

/** The texts of several jobs at once (a job without one is left out of the map). */
export async function readJobTexts(db: DbQueries, jobIds: readonly number[]): Promise<Map<number, JobText>> {
  const unique = [...new Set(jobIds)];
  const out = new Map<number, JobText>();
  if (unique.length === 0) return out;
  const rows = await db.all<TextRow>(
    `SELECT job_id, description_html, text_chars, updated_at FROM job_texts WHERE job_id IN (${db.dialect.list(unique.length)})`,
    unique,
  );
  for (const row of rows) out.set(row.job_id, textOf(row));
  return out;
}

/** Stores a job's HTML (replacing any), with its derived text's length. `at` is the change's time (ISO text). */
export async function writeJobText(db: DbQueries, jobId: number, html: string, at: string): Promise<void> {
  await db.run(
    `INSERT INTO job_texts(job_id, description_html, text_chars, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (job_id) DO UPDATE SET description_html = excluded.description_html, text_chars = excluded.text_chars,
       updated_at = excluded.updated_at`,
    [jobId, html, plainTextOf(html).length, at],
  );
}

/** Removes a job's text (a purge by source, 11 §8.5). */
export async function deleteJobText(db: DbQueries, jobId: number): Promise<void> {
  await db.run('DELETE FROM job_texts WHERE job_id = ?', [jobId]);
}

/** The join that brings a listed job's HTML: `LEFT JOIN job_texts <textAlias> ON <textAlias>.job_id = <jobAlias>.id`. */
export function jobTextJoin(jobAlias = 'j', textAlias = 'jt'): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(jobAlias) || !/^[a-z_][a-z0-9_]*$/.test(textAlias)) {
    throw new Error(`jobTextJoin takes SQL aliases: ${jobAlias}, ${textAlias}`);
  }
  return `LEFT JOIN job_texts ${textAlias} ON ${textAlias}.job_id = ${jobAlias}.id`;
}
