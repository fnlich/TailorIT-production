import type { AppDeps } from '../../core/context';
import type { TailoredContent } from '../tailor/types';
import { newDataId } from './screen';

// mcp_prepare_work (made by migration 0816 as mcp_prebuild_work, renamed by v2.0's 0822): what the MCP tools keep
// between two calls about one of an account's jobs. The only module that reads or writes it. Every read and write
// names the account, so one account's AI never sees or shapes another's.

export interface Work {
  /** The job's tripwire word, handed out until v3.4 (v34 MCPDIR: never since; saves are still screened for it). */
  canary: string;
  postingHash: string | null;
  /** The AI's raw keyword analysis (analyze-job-description's answer, the review's misses added), or null. */
  analysisRaw: unknown;
  /** The last resume saved, before the finishing steps: what a revision applies to. */
  draft: TailoredContent | null;
  saves: number;
  resumeId: string | null;
  /** The resume's document_revision after the last save: a later one means the person edited it. */
  resumeRevision: number | null;
  coverLetterId: string | null;
  /** The letter's updated_at after the last save: a later one means the person edited it. */
  letterUpdatedAt: string | null;
}

interface Row {
  canary: string;
  posting_hash: string | null;
  analysis_raw: string | null;
  draft: string | null;
  saves: number;
  resume_id: string | null;
  resume_revision: number | null;
  cover_letter_id: string | null;
  letter_updated_at: string | null;
}

function parsed(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function workOf(row: Row): Work {
  const draft = parsed(row.draft);
  return {
    canary: row.canary,
    postingHash: row.posting_hash,
    analysisRaw: parsed(row.analysis_raw),
    draft: draft && typeof draft === 'object' ? (draft as TailoredContent) : null,
    saves: row.saves,
    resumeId: row.resume_id,
    resumeRevision: row.resume_revision,
    coverLetterId: row.cover_letter_id,
    letterUpdatedAt: row.letter_updated_at,
  };
}

/** The account's work on a job, made (with its tripwire) on first use. */
export async function workFor(deps: Pick<AppDeps, 'db' | 'now'>, userId: string, jobId: number): Promise<Work> {
  const select = () =>
    deps.db.one<Row>(
      `SELECT canary, posting_hash, analysis_raw, draft, saves, resume_id, resume_revision, cover_letter_id,
         letter_updated_at FROM mcp_prepare_work WHERE user_id = ? AND job_id = ?`,
      [userId, jobId],
    );
  const found = await select();
  if (found) return workOf(found);
  const now = deps.now().toISOString();
  // Two first uses at once: the key keeps one row (and one tripwire), which both then read.
  await deps.db.run(
    `INSERT INTO mcp_prepare_work(user_id, job_id, canary, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, job_id) DO NOTHING`,
    [userId, jobId, newDataId(), now, now],
  );
  return workOf((await select())!);
}

/** Keeps the AI's analysis of the posting (`postingHash`); a new analysis starts the resume's rounds again. */
export async function keepAnalysis(
  deps: Pick<AppDeps, 'db' | 'now'>,
  userId: string,
  jobId: number,
  postingHash: string,
  raw: unknown,
): Promise<void> {
  await workFor(deps, userId, jobId);
  await deps.db.run(
    `UPDATE mcp_prepare_work SET posting_hash = ?, analysis_raw = ?, draft = NULL, saves = 0, updated_at = ?
      WHERE user_id = ? AND job_id = ?`,
    [postingHash, JSON.stringify(raw), deps.now().toISOString(), userId, jobId],
  );
}

/** Keeps a saved resume's draft, counts the save, and names the resume stored for it (at its revision). */
export async function keepResume(
  deps: Pick<AppDeps, 'db' | 'now'>,
  userId: string,
  jobId: number,
  saved: { draft: TailoredContent; saves: number; resumeId: string; revision: number },
): Promise<void> {
  await deps.db.run(
    `UPDATE mcp_prepare_work SET draft = ?, saves = ?, resume_id = ?, resume_revision = ?, updated_at = ?
      WHERE user_id = ? AND job_id = ?`,
    [JSON.stringify(saved.draft), saved.saves, saved.resumeId, saved.revision, deps.now().toISOString(), userId, jobId],
  );
}

/** Names the cover letter stored for the job, as of its `updatedAt`. */
export async function keepLetter(
  deps: Pick<AppDeps, 'db' | 'now'>,
  userId: string,
  jobId: number,
  letter: { id: string; updatedAt: string },
): Promise<void> {
  await deps.db.run(
    `UPDATE mcp_prepare_work SET cover_letter_id = ?, letter_updated_at = ?, updated_at = ?
      WHERE user_id = ? AND job_id = ?`,
    [letter.id, letter.updatedAt, deps.now().toISOString(), userId, jobId],
  );
}
