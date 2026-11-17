import { createHash } from 'node:crypto';
import type { AppDeps } from '../../core/context';
import { DAY_MS } from '@tailorit/shared';

// The job analyses tailoring keeps (tailor_job_analyses, migration 0813): tailor_builder0's analysisStore.ts, in the
// database instead of a folder. What is kept is the model's raw answer (both passes), not the finished analysis, so the
// keyword filtering and the skill library run on it every time it is read. The key covers everything that decides the
// answer: the posting, the two prompts and the model. A failure to read or write is logged and ignored: the store
// only saves work.
// v3.0 D2-F: on the async client.

/** How long a kept analysis is used (tailor_builder0's ANALYSIS_CACHE_DAYS default). */
export const ANALYSIS_KEEP_DAYS = 30;

export interface AnalysisKey {
  postingHash: string;
  promptHash: string;
  model: string;
}

/** Whitespace doesn't matter, so a posting pasted with different line breaks is the same posting. */
export function postingHashOf(posting: string): string {
  return createHash('sha256').update(posting.replace(/\s+/g, ' ').trim()).digest('hex');
}

export interface AnalysisStore {
  /** The raw answer kept for this key, or null when there is none or it is older than ANALYSIS_KEEP_DAYS. */
  read(key: AnalysisKey): Promise<unknown>;
  /** Keeps a raw answer (replacing one of the same key) and deletes the expired ones. */
  save(key: AnalysisKey, raw: unknown, jobTitle: string): Promise<void>;
}

/** The store's statements. */
export const ANALYSIS_STORE_SQL = {
  read: `SELECT raw FROM tailor_job_analyses
              WHERE posting_hash = ? AND prompt_hash = ? AND model = ? AND created_at >= ?`,
  save: `INSERT INTO tailor_job_analyses(posting_hash, prompt_hash, model, job_title, raw, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(posting_hash, prompt_hash, model) DO UPDATE SET
               job_title = excluded.job_title, raw = excluded.raw, created_at = excluded.created_at`,
  prune: 'DELETE FROM tailor_job_analyses WHERE created_at < ?',
} as const;

/** The oldest kept analysis still used, as of now. */
export const analysisCutoff = (deps: Pick<AppDeps, 'now'>) => new Date(deps.now().getTime() - ANALYSIS_KEEP_DAYS * DAY_MS).toISOString();

/** A kept raw answer as read: an object, else none. */
export function keptRaw(row: { raw: string } | undefined): unknown {
  if (!row) return null;
  const raw: unknown = JSON.parse(row.raw);
  return raw && typeof raw === 'object' ? raw : null;
}

export function createAnalysisStore(deps: Pick<AppDeps, 'db' | 'now' | 'log'>): AnalysisStore {
  return {
    async read(key) {
      try {
        return keptRaw(await deps.db.one<{ raw: string }>(ANALYSIS_STORE_SQL.read, [key.postingHash, key.promptHash, key.model, analysisCutoff(deps)]));
      } catch (error) {
        deps.log.warn('[tailor] could not read a kept job analysis', error instanceof Error ? error.name : 'unknown');
        return null;
      }
    },
    async save(key, raw, jobTitle) {
      try {
        await deps.db.run(ANALYSIS_STORE_SQL.save, [
          key.postingHash,
          key.promptHash,
          key.model,
          jobTitle.slice(0, 300),
          JSON.stringify(raw),
          deps.now().toISOString(),
        ]);
        await deps.db.run(ANALYSIS_STORE_SQL.prune, [analysisCutoff(deps)]);
      } catch (error) {
        deps.log.warn('[tailor] could not keep a job analysis', error instanceof Error ? error.name : 'unknown');
      }
    },
  };
}
