import { randomUUID } from 'node:crypto';
import type { CoverLetterDetail, CoverLetterSummary, LetterOrigin } from '@tailorit/shared';
import { nowIso, type AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { notFound } from '../../core/http/errors';
import { readJobText } from '../jobs/text';
import { letterText } from './sanitize';

// The cover_letters table. Every query is scoped by user_id: another account's letter is "not found".
//
// v30 DB-JOBS (D1c; docs/design/part2/11-database.md §5.8): a letter stores no copy of its job's posting.
// `job_description` (what the letter is written about) is NULL when it is the job's own text, read from job_texts
// (features/jobs/text.ts) whenever the letter is read, and for a letter of a job given no text at all; a value is a text
// of its own (typed or edited in the Generate dialog, a page's text the extension sent, or an entry's own description,
// '' for none on a letter with no job). The repository decides it
// on every write (`storedJobDescription`) and resolves it on every read of one letter, so callers see the text either
// way. And `document_revision` (11 §5.8) goes up with each change of the letter's content, so an apply record can
// tell the letter as sent from the letter edited since (the baseline's trg_letters_snapshot freezes the one sent).

interface LetterRow {
  id: string;
  user_id: string;
  title: string;
  origin: LetterOrigin;
  content_html: string;
  content_text: string;
  font_family: string;
  application_id: string | null;
  job_id: number | null;
  company_name: string;
  job_title: string;
  /** NULL in the table: the job's text. A letter the repository read has it resolved (see the head of this file). */
  job_description: string | null;
  template_id: string | null;
  resume_id: string | null;
  custom_prompt: string;
  file_id: string | null;
  created_at: string;
  updated_at: string;
  last_edited_at: string | null;
  /** Bumped by each change of the content (v30 DB-JOBS; absent from a row made in memory before its insert). */
  document_revision?: number;
}

export function toSummary(row: LetterRow): CoverLetterSummary {
  return {
    id: row.id,
    title: row.title,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEditedAt: row.last_edited_at,
    companyName: row.company_name,
    jobTitle: row.job_title,
  };
}

export function toDetail(row: LetterRow): CoverLetterDetail {
  return {
    ...toSummary(row),
    contentHtml: row.content_html,
    fontFamily: row.font_family,
    applicationId: row.application_id,
    jobId: row.job_id,
    templateId: row.template_id,
    resumeId: row.resume_id,
    jobDescription: row.job_description ?? '',
    customPrompt: row.custom_prompt,
  };
}

/** `%` and `_` are LIKE wildcards; the search is for the literal text. */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export interface NewLetter {
  title: string;
  origin: LetterOrigin;
  contentHtml?: string;
  fontFamily?: string;
  applicationId?: string | null;
  jobId?: number | null;
  companyName?: string;
  jobTitle?: string;
  jobDescription?: string;
  templateId?: string | null;
  fileId?: string | null;
}

/** Columns a PATCH or a generation may change (camelCase keys of the detail). */
export interface LetterChanges {
  title?: string;
  origin?: LetterOrigin;
  contentHtml?: string;
  fontFamily?: string;
  applicationId?: string | null;
  jobId?: number | null;
  companyName?: string;
  jobTitle?: string;
  /** The text the letter is about; stored as NULL when it is the job's own text (v30 DB-JOBS, D1c). */
  jobDescription?: string | null;
  templateId?: string | null;
  resumeId?: string | null;
  customPrompt?: string;
  fileId?: string | null;
  /** Sets last_edited_at (a content edit by the person, not a generation). */
  edited?: boolean;
}

const COLUMN: Record<Exclude<keyof LetterChanges, 'edited' | 'contentHtml'>, keyof LetterRow> = {
  title: 'title',
  origin: 'origin',
  fontFamily: 'font_family',
  applicationId: 'application_id',
  jobId: 'job_id',
  companyName: 'company_name',
  jobTitle: 'job_title',
  jobDescription: 'job_description',
  templateId: 'template_id',
  resumeId: 'resume_id',
  customPrompt: 'custom_prompt',
  fileId: 'file_id',
};

const SELECT_ROW = 'SELECT * FROM cover_letters WHERE id = ? AND user_id = ?';
const SELECT_ALL = 'SELECT * FROM cover_letters WHERE user_id = ? ORDER BY updated_at DESC, id';
const DELETE_ROW = 'DELETE FROM cover_letters WHERE id = ? AND user_id = ?';
const INSERT_LETTER = `INSERT INTO cover_letters(id, user_id, title, origin, content_html, content_text, font_family, application_id,
           job_id, company_name, job_title, job_description, template_id, resume_id, custom_prompt, file_id, created_at,
           updated_at, last_edited_at)
         VALUES (@id, @user_id, @title, @origin, @content_html, @content_text, @font_family, @application_id, @job_id,
           @company_name, @job_title, @job_description, @template_id, @resume_id, @custom_prompt, @file_id, @created_at,
           @updated_at, @last_edited_at)`;

/** The search of the list: title, company or job title holding the text (case-insensitive, its own wildcards literal). */
function searchSql(like: (expr: string, pattern: string) => string): string {
  return `SELECT * FROM cover_letters WHERE user_id = @userId
                 AND (${like('title', '@p')} OR ${like('company_name', '@p')} OR ${like('job_title', '@p')})
               ORDER BY updated_at DESC, id`;
}

/** A new letter's row. */
function newLetterRow(deps: Pick<AppDeps, 'now'>, userId: string, letter: NewLetter): LetterRow {
  const now = nowIso(deps);
  const html = letter.contentHtml ?? '';
  return {
    id: randomUUID(),
    user_id: userId,
    title: letter.title,
    origin: letter.origin,
    content_html: html,
    content_text: letterText(html),
    font_family: letter.fontFamily ?? 'Times New Roman',
    application_id: letter.applicationId ?? null,
    job_id: letter.jobId ?? null,
    company_name: letter.companyName ?? '',
    job_title: letter.jobTitle ?? '',
    job_description: letter.jobDescription ?? '',
    template_id: letter.templateId ?? null,
    resume_id: null,
    custom_prompt: '',
    file_id: letter.fileId ?? null,
    created_at: now,
    updated_at: now,
    last_edited_at: null,
  };
}

/** The UPDATE of a letter's changes and its named parameters. */
function letterUpdateOf(deps: Pick<AppDeps, 'now'>, id: string, userId: string, changes: LetterChanges) {
  const sets: string[] = [];
  const params: Record<string, string | number | null> = { id, userId, now: nowIso(deps) };
  for (const [key, column] of Object.entries(COLUMN) as Array<[keyof typeof COLUMN, keyof LetterRow]>) {
    if (changes[key] === undefined) continue;
    sets.push(`${column} = @${column}`);
    params[column] = changes[key];
  }
  if (changes.contentHtml !== undefined) {
    // v30 DB-JOBS (11 §5.8): a new revision only when the content changes (SET reads the row as it was).
    sets.push(
      'document_revision = document_revision + CASE WHEN content_html IS DISTINCT FROM @content_html THEN 1 ELSE 0 END',
      'content_html = @content_html',
      'content_text = @content_text',
    );
    params.content_html = changes.contentHtml;
    params.content_text = letterText(changes.contentHtml);
  }
  if (changes.edited) sets.push('last_edited_at = @now');
  sets.push('updated_at = @now');
  return { sql: `UPDATE cover_letters SET ${sets.join(', ')} WHERE id = @id AND user_id = @userId`, params };
}

/** Whitespace-insensitive: a text the dialog shows and sends back unchanged is the job's text. */
const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/** The job's posting as a letter reads it: its plain text ('' for a job without one). */
async function postingTextOf(db: DbQueries, jobId: number): Promise<string> {
  return (await readJobText(db, jobId))?.text ?? '';
}

/**
 * What a letter of job `jobId` stores for the text `text` (D1c): NULL when it is the job's own text, or no text at all
 * (a letter of a job is about the job's posting unless it has a text of its own), else the text. A letter with no job
 * keeps the text as given.
 */
export async function storedJobDescription(db: DbQueries, jobId: number | null, text: string): Promise<string | null> {
  if (jobId === null) return text;
  if (!text.trim()) return null;
  return sameText(text, await postingTextOf(db, jobId)) ? null : text;
}

/** A letter row as callers read it: a NULL job description is its job's text ('' with no job). */
export async function resolvedLetter<T extends LetterRow | undefined>(db: DbQueries, row: T): Promise<T> {
  if (!row || row.job_description !== null) return row;
  return { ...row, job_description: row.job_id === null ? '' : await postingTextOf(db, row.job_id) };
}

/**
 * The cover letters of an account, through the async client.
 */
export function createLetterRepository(deps: Pick<AppDeps, 'db' | 'now'>) {
  const { db } = deps;

  const getRow = async (id: string, userId: string) => resolvedLetter(db, await db.one<LetterRow>(SELECT_ROW, [id, userId]));

  return {
    getRow,

    /** The letter, or 404 "That cover letter was not found." */
    async require(id: string, userId: string): Promise<LetterRow> {
      const row = await getRow(id, userId);
      if (!row) throw notFound('That cover letter');
      return row;
    },

    async list(userId: string, query?: string): Promise<CoverLetterSummary[]> {
      const q = query?.trim();
      const rows = q
        ? await db.all<LetterRow>(searchSql(db.dialect.like), { userId, p: likePattern(q) })
        : await db.all<LetterRow>(SELECT_ALL, [userId]);
      return rows.map(toSummary);
    },

    async create(userId: string, letter: NewLetter): Promise<LetterRow> {
      const row = newLetterRow(deps, userId, letter);
      // v30 DB-JOBS (D1c): the job's own text is not copied.
      const stored = await storedJobDescription(db, row.job_id, row.job_description ?? '');
      await db.run(INSERT_LETTER, { ...row, job_description: stored });
      return { ...row, document_revision: 0 };
    },

    /** Applies the changes (HTML must already be sanitized) and returns the updated row; 404 when it is gone. */
    async update(id: string, userId: string, changes: LetterChanges): Promise<LetterRow> {
      if (changes.jobDescription !== undefined) {
        // v30 DB-JOBS (D1c): measured against the job the letter will have.
        const jobId =
          changes.jobId !== undefined
            ? changes.jobId
            : ((await db.one<{ job_id: number | null }>('SELECT job_id FROM cover_letters WHERE id = ? AND user_id = ?', [id, userId]))
                ?.job_id ?? null);
        changes = { ...changes, jobDescription: await storedJobDescription(db, jobId, changes.jobDescription ?? '') };
      }
      const { sql, params } = letterUpdateOf(deps, id, userId, changes);
      const result = await db.run(sql, params);
      if (result.changes === 0) throw notFound('That cover letter');
      return (await getRow(id, userId))!;
    },

    async remove(id: string, userId: string): Promise<LetterRow | null> {
      const row = await getRow(id, userId);
      if (!row) return null;
      await db.run(DELETE_ROW, [id, userId]);
      return row;
    },

    /** Deletes the account's letters among `ids` (others are ignored); returns the deleted rows. */
    async removeMany(ids: readonly string[], userId: string): Promise<LetterRow[]> {
      return db.tx(
        async (t) => {
          const removed: LetterRow[] = [];
          for (const id of new Set(ids)) {
            const row = await t.one<LetterRow>(SELECT_ROW, [id, userId]);
            if (!row) continue;
            await t.run(DELETE_ROW, [id, userId]);
            removed.push(row);
          }
          return removed;
        },
        { label: 'remove cover letters' },
      );
    },
  };
}

export type LetterRepository = ReturnType<typeof createLetterRepository>;

export type { LetterRow };
