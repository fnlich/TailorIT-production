import { createHash } from 'node:crypto';
import {
  analyzeBuiltResume,
  analyzeResumeText,
  mergeResumeAnalyses,
  normalizeResumeDocument,
  RESUME_ANALYSIS_VERSION,
  ResumeAnalysisDataSchema,
  resumeAnalysisInput,
  yearsOf,
  type ResumeAnalysisBrief,
  type ResumeAnalysisData,
  type ResumeAnalysisSource,
  type ResumeAnalysisSubject,
  type ResumeAnalysisView,
  type SkillLists,
} from '@tailorit/shared';
import type { AppDeps } from '../../../core/context';
import { AppError } from '../../../core/http/errors';
import { getSkillLibrary } from '../../../core/skills-vocabulary';
import { storedDocumentOf } from '../evidence';
import { readableForImport } from '../upload';

// What TailorIT read from each resume (resume_analyses) and each upload's place in line for Claude's reading
// (resume_analysis_backlog). Work package WP3.
//
// Every resume gets the quick rule-based reading ('deterministic') on each write that changes what it says: create,
// upload, JSON import, an edit (PUT), duplicate, the AI's editable copy and the demo seed. There it is best effort: a
// reader that throws never fails the write; the resume is left without a reading and read later (read paths compute
// at most READ_COMPUTE_LIMIT missing readings a request, the backfill worker the rest). Claude's closer reading of an
// upload ('ai') comes from the backlog worker (./backlog.ts), and is merged over the rules' one when read.
//
// A reading is current when its version is RESUME_ANALYSIS_VERSION and its content_hash is the hash of what it read
// (`resumeAnalysisInput`, never the custom title: a rename reads nothing again). An upload itself is never changed:
// its file, file_id, extracted_text and updated_at are only ever read here; the readings live beside it.
//
// v3.0 D2 (D2-E): every reading and write goes through the async client (deps.db).

/** Readings a request may compute itself (the Resumes list, one resume's panel); the backfill worker does the rest. */
export const READ_COMPUTE_LIMIT = 5;
/** A resume whose reading failed is not read again for this long (by the backfill, or a read path). */
const FAILED_READING_PAUSE_MS = 60 * 60_000;
const UNREAD_MESSAGE = "What TailorIT read from this resume can't be shown right now. Please try again later.";

export const BACKLOG_STATES = ['waiting', 'queued', 'done', 'failed', 'skipped'] as const;
export type BacklogState = (typeof BACKLOG_STATES)[number];

/** The skill library's lists: the same arrays every call (the vocabulary and soft-skill scanners are cached by them). */
export function skillLists(): SkillLists {
  const library = getSkillLibrary();
  return { hard: library.vocabulary, soft: library.soft };
}

/** A reading's content hash: sha256 of what it read (`resumeAnalysisInput`), the first 32 hex characters. */
export function analysisHashOf(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

/**
 * Whether Claude reads uploads on this server: AI on, AI_RESUME_ANALYSIS=auto and a background slot. Only the backlog
 * worker is gated by it; the `resume_analysis` handler is always registered.
 */
export function resumeAnalysisEnabled(deps: Pick<AppDeps, 'config' | 'services'>): boolean {
  const ai = deps.config.ai;
  return ai.enabled && ai.resumeAnalysis === 'auto' && ai.backgroundSlots > 0 && Boolean(deps.services.ai);
}

/** One resume as the reading sees it: its owner, and its document (built) or extracted text (uploads). */
export interface ResumeAnalysisTarget {
  id: string;
  userId: string;
  subject: ResumeAnalysisSubject;
}

export interface StoredResumeRow {
  id: string;
  user_id: string;
  kind: 'built' | 'uploaded';
  data: string | null;
  extracted_text: string | null;
}

/** The target of a stored resume: a built resume's stored document, an upload's extracted text. */
export function targetOfRow(row: StoredResumeRow): ResumeAnalysisTarget {
  return {
    id: row.id,
    userId: row.user_id,
    subject:
      row.kind === 'uploaded'
        ? { kind: 'uploaded', text: row.extracted_text }
        : { kind: 'built', document: storedDocumentOf(row) ?? normalizeResumeDocument({}) },
  };
}

// --------------------------------------------------------------------------------------------------------- rows

export interface AnalysisRow {
  resume_id: string;
  source: ResumeAnalysisSource;
  version: number;
  content_hash: string;
  hard_skills: string;
  soft_skills: string;
  keywords: string;
  experience: string;
  years_stated: number | null;
  years_stated_basis: 'field' | 'stated' | null;
  person_name: string | null;
  model: string | null;
  prompt_hash: string | null;
  created_at: string;
}

interface BacklogInfo {
  resume_id: string;
  state: BacklogState;
  content_hash: string;
  version: number;
  /** The status of its AI task (state 'queued'), when it still exists. */
  task_status: string | null;
}

const COLUMNS =
  'resume_id, source, version, content_hash, hard_skills, soft_skills, keywords, experience, years_stated, ' +
  'years_stated_basis, person_name, model, prompt_hash, created_at';
const VALUES =
  '@resumeId, @source, @version, @contentHash, @hardSkills, @softSkills, @keywords, @experience, @yearsStated, ' +
  '@yearsStatedBasis, @personName, @model, @promptHash, @createdAt';
// An unchanged (content_hash, version) leaves the 0301 match trigger alone; a changed one marks the owner's choices due.
const ON_CONFLICT =
  'ON CONFLICT(resume_id, source) DO UPDATE SET version = excluded.version, content_hash = excluded.content_hash, ' +
  'hard_skills = excluded.hard_skills, soft_skills = excluded.soft_skills, keywords = excluded.keywords, ' +
  'experience = excluded.experience, years_stated = excluded.years_stated, ' +
  'years_stated_basis = excluded.years_stated_basis, person_name = excluded.person_name, model = excluded.model, ' +
  'prompt_hash = excluded.prompt_hash, created_at = excluded.created_at';

/** A stored reading as data, or null when the row does not read as one (it is then read again). */
export function dataOfRow(row: AnalysisRow): ResumeAnalysisData | null {
  try {
    const parsed = ResumeAnalysisDataSchema.safeParse({
      hardSkills: JSON.parse(row.hard_skills),
      softSkills: JSON.parse(row.soft_skills),
      keywords: JSON.parse(row.keywords),
      experience: JSON.parse(row.experience),
      yearsStated: row.years_stated,
      yearsStatedBasis: row.years_stated_basis,
      personName: row.person_name,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function rowValues(input: {
  resumeId: string;
  source: ResumeAnalysisSource;
  contentHash: string;
  data: ResumeAnalysisData;
  model: string | null;
  promptHash: string | null;
  createdAt: string;
}) {
  const { data } = input;
  return {
    resumeId: input.resumeId,
    source: input.source,
    version: RESUME_ANALYSIS_VERSION,
    contentHash: input.contentHash,
    hardSkills: JSON.stringify(data.hardSkills),
    softSkills: JSON.stringify(data.softSkills),
    keywords: JSON.stringify(data.keywords),
    experience: JSON.stringify(data.experience),
    yearsStated: data.yearsStated,
    yearsStatedBasis: data.yearsStatedBasis,
    personName: data.personName,
    model: input.model,
    promptHash: input.promptHash,
    createdAt: input.createdAt,
  };
}

// ------------------------------------------------------------------------------------------- failed readings

/** By database client (one per server, one per test): which resumes' readings failed lately, and until when. */
const FAILED = new WeakMap<object, Map<string, number>>();

function failuresOf(db: object): Map<string, number> {
  let failures = FAILED.get(db);
  if (!failures) {
    failures = new Map();
    FAILED.set(db, failures);
  }
  return failures;
}

/** Whether this resume's reading failed lately: it is not tried again until the pause is over. */
export function readingFailedRecently(deps: Pick<AppDeps, 'db' | 'now'>, resumeId: string): boolean {
  const until = failuresOf(deps.db).get(resumeId);
  if (until === undefined) return false;
  if (until > deps.now().getTime()) return true;
  failuresOf(deps.db).delete(resumeId);
  return false;
}

function noteReading(deps: Pick<AppDeps, 'db' | 'now'>, resumeId: string, failed: boolean): void {
  if (failed) failuresOf(deps.db).set(resumeId, deps.now().getTime() + FAILED_READING_PAUSE_MS);
  else failuresOf(deps.db).delete(resumeId);
}

// ------------------------------------------------------------------------------------------------- the reading

/** The rules' reading of a resume (throws when a reader breaks; callers decide whether that fails anything). */
function readSubject(subject: ResumeAnalysisSubject): ResumeAnalysisData {
  const lists = skillLists();
  const data =
    subject.kind === 'built' ? analyzeBuiltResume(subject.document, lists) : analyzeResumeText(subject.text ?? '', lists);
  return ResumeAnalysisDataSchema.parse(data);
}

export interface RefreshOptions {
  /** False for an upload Claude is not to read (the demo seed's): its backlog row is 'skipped'. Default true. */
  aiRefine?: boolean;
}

export interface RefreshOutcome {
  /** The rules' reading was written now: it was missing, of another version, or of other content. */
  changed: boolean;
  contentHash: string;
}

const SELECT_DETERMINISTIC = "SELECT * FROM resume_analyses WHERE resume_id = ? AND source = 'deterministic'";
const DELETE_DETERMINISTIC = "DELETE FROM resume_analyses WHERE resume_id = ? AND source = 'deterministic'";
const UPSERT_READING = `INSERT INTO resume_analyses(${COLUMNS}) VALUES (${VALUES}) ${ON_CONFLICT}`;
const SELECT_STORED_RESUME = 'SELECT id, user_id, kind, data, extracted_text FROM resumes WHERE id = ?';

/** Whether a stored rules' reading is current for this content (its version, its hash, and it reads). */
function isCurrent(stored: AnalysisRow | undefined, contentHash: string): boolean {
  return Boolean(stored && stored.version === RESUME_ANALYSIS_VERSION && stored.content_hash === contentHash && dataOfRow(stored));
}

/** The rules' reading of a target as a row's values, read now (throws when a reader breaks). */
function readingValues(deps: Pick<AppDeps, 'now'>, target: ResumeAnalysisTarget, contentHash: string) {
  return rowValues({
    resumeId: target.id,
    source: 'deterministic',
    contentHash,
    data: readSubject(target.subject),
    model: null,
    promptHash: null,
    createdAt: deps.now().toISOString(),
  });
}

/**
 * Brings one resume's rule-based reading up to date and, for an upload, its row in Claude's backlog. Nothing is
 * written when both are current. Throws when the reader breaks (the stored reading, if any, is left as it was).
 */
export async function refreshResumeAnalysis(
  deps: AppDeps,
  target: ResumeAnalysisTarget,
  options: RefreshOptions = {},
): Promise<RefreshOutcome> {
  const contentHash = analysisHashOf(resumeAnalysisInput(target.subject));
  // An upload's place in line needs only its text, so a broken reader never keeps Claude from reading it.
  if (target.subject.kind === 'uploaded') await keepBacklogRow(deps, target, contentHash, options);
  const stored = await deps.db.one<AnalysisRow>(SELECT_DETERMINISTIC, [target.id]);
  if (isCurrent(stored, contentHash)) return { changed: false, contentHash };
  // One statement: it lands whole or not at all, inside a caller's transaction too.
  await deps.db.run(UPSERT_READING, readingValues(deps, target, contentHash));
  return { changed: true, contentHash };
}

/**
 * `refreshResumeAnalysis` on a write path, best effort: a broken reader is logged and never fails the write. The
 * resume is then left without a rules' reading (an outdated one is removed), and is read again later.
 * Returns whether the reading changed.
 */
export async function analyzeAfterWrite(deps: AppDeps, target: ResumeAnalysisTarget, options: RefreshOptions = {}): Promise<boolean> {
  try {
    const { changed } = await refreshResumeAnalysis(deps, target, options);
    noteReading(deps, target.id, false);
    return changed;
  } catch (error) {
    deps.log.warn(`[resume-analysis] could not read resume ${target.id}; it will be read again later`, error);
    noteReading(deps, target.id, true);
    try {
      await deps.db.run(DELETE_DETERMINISTIC, [target.id]);
    } catch (cleanup) {
      deps.log.warn(`[resume-analysis] could not clear the outdated reading of resume ${target.id}`, cleanup);
    }
    deps.services.resumeAnalysis?.backfill.nudge();
    return false;
  }
}

/**
 * Reads one stored resume (any account's) when it needs it: the backfill worker and read paths. False when it does
 * not exist, failed lately, or its reader broke (logged).
 */
export async function refreshStoredResume(deps: AppDeps, resumeId: string): Promise<boolean> {
  if (readingFailedRecently(deps, resumeId)) return false;
  const row = await deps.db.one<StoredResumeRow>(SELECT_STORED_RESUME, [resumeId]);
  if (!row) return false;
  try {
    await refreshResumeAnalysis(deps, targetOfRow(row));
    noteReading(deps, resumeId, false);
    return true;
  } catch (error) {
    deps.log.warn(`[resume-analysis] could not read resume ${resumeId}; it will be tried again later`, error);
    noteReading(deps, resumeId, true);
    return false;
  }
}

// ------------------------------------------------------------------------------------------ Claude's backlog

/** Why an upload is not read by Claude (resume_analysis_backlog.last_error of a 'skipped' row). */
const SKIP_UNREADABLE = 'Its text could not be read.';
const SKIP_NOT_ASKED = 'Not asked for.';

interface BacklogRowState {
  state: BacklogState;
  content_hash: string;
  version: number;
  last_error: string | null;
}

const SELECT_BACKLOG_ROW = 'SELECT state, content_hash, version, last_error FROM resume_analysis_backlog WHERE resume_id = ?';
const UPSERT_BACKLOG_ROW = `INSERT INTO resume_analysis_backlog(resume_id, user_id, content_hash, version, state, attempts, task_id,
         next_attempt_at, started_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, NULL, ?, NULL, ?, ?, ?)
       ON CONFLICT(resume_id) DO UPDATE SET content_hash = excluded.content_hash, version = excluded.version,
         state = excluded.state, attempts = 0, task_id = NULL, next_attempt_at = excluded.next_attempt_at,
         last_error = excluded.last_error, updated_at = excluded.updated_at`;

/** Why the upload's row is 'skipped' (null: it waits for Claude), from its text, the ask and its row before. */
function skipReason(target: ResumeAnalysisTarget, options: RefreshOptions, existing: BacklogRowState | undefined): string | null {
  const text = target.subject.kind === 'uploaded' ? target.subject.text : null;
  if (!readableForImport(text)) return SKIP_UNREADABLE;
  if (options.aiRefine === false) return SKIP_NOT_ASKED;
  return existing?.state === 'skipped' ? (existing.last_error ?? SKIP_NOT_ASKED) : null;
}

/** Whether the backlog row is already for this content and this reading's version. */
function backlogCurrent(existing: BacklogRowState | undefined, contentHash: string): boolean {
  return Boolean(existing && existing.content_hash === contentHash && existing.version === RESUME_ANALYSIS_VERSION);
}

/**
 * An upload's row in Claude's backlog. A row of the same (content_hash, version) is left as it is; otherwise it starts
 * over: 'waiting' (or done at once, when the same account already has Claude's reading of the same text), or
 * 'skipped' for text that cannot be read and for an upload Claude is not to read. A skipped upload stays skipped.
 */
async function keepBacklogRow(
  deps: AppDeps,
  target: ResumeAnalysisTarget,
  contentHash: string,
  options: RefreshOptions,
): Promise<void> {
  const existing = await deps.db.one<BacklogRowState>(SELECT_BACKLOG_ROW, [target.id]);
  if (backlogCurrent(existing, contentHash)) return;
  const skip = skipReason(target, options, existing);
  const now = deps.now().toISOString();
  // A savepoint of the caller's transaction (or a transaction of its own): the row and a reused reading land together,
  // and a failure here leaves the caller's writes as they were.
  await deps.db.atomic(
    async (t) => {
      await t.run(UPSERT_BACKLOG_ROW, [
        target.id,
        target.userId,
        contentHash,
        RESUME_ANALYSIS_VERSION,
        skip ? 'skipped' : 'waiting',
        now,
        skip,
        now,
        now,
      ]);
      if (!skip) await reuseAiReading(deps, { resumeId: target.id, userId: target.userId, contentHash });
    },
    { label: 'resume analysis backlog row' },
  );
  if (!skip) deps.services.resumeAnalysis?.backlog.nudge();
}

export interface AiReadingInput {
  resumeId: string;
  userId: string;
  contentHash: string;
  data: ResumeAnalysisData;
  model: string | null;
  promptHash: string | null;
}

const INSERT_AI_READING = `INSERT INTO resume_analyses(${COLUMNS}) SELECT ${VALUES}
           WHERE EXISTS (SELECT 1 FROM resumes WHERE id = @resumeId AND user_id = @userId AND kind = 'uploaded')
           ${ON_CONFLICT}`;
const AI_READING_DONE = `UPDATE resume_analysis_backlog SET state = 'done', last_error = NULL, next_attempt_at = ?, updated_at = ?
           WHERE resume_id = ? AND content_hash = ? AND version = ?`;
const SELECT_REUSABLE_READING = `SELECT a.* FROM resume_analyses a JOIN resumes r ON r.id = a.resume_id
       WHERE a.content_hash = ? AND a.source = 'ai' AND a.version = ? AND r.user_id = ? AND a.resume_id <> ?
       ORDER BY a.created_at DESC LIMIT 1`;

/**
 * Stores Claude's reading of an upload and marks its backlog row done, in one transaction. The insert runs only while
 * the upload still exists (INSERT ... WHERE EXISTS): storing after a delete is a no-op, not an error. Returns whether
 * it was stored.
 */
export async function storeAiResumeAnalysis(deps: AppDeps, input: AiReadingInput): Promise<boolean> {
  const now = deps.now().toISOString();
  const values = rowValues({ ...input, source: 'ai', createdAt: now });
  return deps.db.atomic(
    async (t) => {
      const stored = (await t.run(INSERT_AI_READING, { ...values, userId: input.userId })).changes > 0;
      if (stored) await t.run(AI_READING_DONE, [now, now, input.resumeId, input.contentHash, RESUME_ANALYSIS_VERSION]);
      return stored;
    },
    { label: 'store an AI resume reading' },
  );
}

/**
 * Claude already read this text for this account (a duplicate, a re-upload of the same file): its reading is copied to
 * `resumeId` and the backlog row is done, with no new call. Returns whether one was found.
 */
export async function reuseAiReading(
  deps: AppDeps,
  target: { resumeId: string; userId: string; contentHash: string },
): Promise<boolean> {
  const source = await deps.db.one<AnalysisRow>(SELECT_REUSABLE_READING, [
    target.contentHash,
    RESUME_ANALYSIS_VERSION,
    target.userId,
    target.resumeId,
  ]);
  const data = source ? dataOfRow(source) : null;
  if (!source || !data) return false;
  return storeAiResumeAnalysis(deps, { ...target, data, model: source.model, promptHash: source.prompt_hash });
}

// --------------------------------------------------------------------------------------------------- reading it

/** One resume's reading as the app uses it: the rules' one, with Claude's merged over it when it has a current one. */
export interface StoredResumeAnalysis {
  resumeId: string;
  kind: 'built' | 'uploaded';
  contentHash: string;
  /** 'ai' when Claude's reading is merged in. */
  source: ResumeAnalysisSource;
  /** The merged reading (`mergeResumeAnalyses`); work its years out with `yearsOf(data, deps.now())`. */
  data: ResumeAnalysisData;
  deterministic: ResumeAnalysisData;
  ai: ResumeAnalysisData | null;
  /** When the reading shown was made. */
  analyzedAt: string;
  /** Claude is reading this upload now (its task is queued or running). */
  refining: boolean;
  /** In line for Claude's reading, not started yet (only while the backlog worker runs). */
  aiWaiting: boolean;
  /** Claude's reading did not work (after its attempts); the rules' reading stands. */
  aiFailed: boolean;
}

interface ReadingRows {
  deterministic?: AnalysisRow;
  ai?: AnalysisRow;
  backlog?: BacklogInfo;
}

function assemble(
  resumeId: string,
  kind: 'built' | 'uploaded',
  rows: ReadingRows,
  workerOn: boolean,
): StoredResumeAnalysis | null {
  const detRow = rows.deterministic;
  if (!detRow || detRow.version !== RESUME_ANALYSIS_VERSION) return null;
  const deterministic = dataOfRow(detRow);
  if (!deterministic) return null;
  const aiRow = rows.ai;
  const aiCurrent =
    kind === 'uploaded' && aiRow && aiRow.version === RESUME_ANALYSIS_VERSION && aiRow.content_hash === detRow.content_hash
      ? dataOfRow(aiRow)
      : null;
  const backlog = kind === 'uploaded' ? rows.backlog : undefined;
  const running = backlog?.task_status === 'queued' || backlog?.task_status === 'running';
  return {
    resumeId,
    kind,
    contentHash: detRow.content_hash,
    source: aiCurrent ? 'ai' : 'deterministic',
    data: mergeResumeAnalyses(deterministic, aiCurrent),
    deterministic,
    ai: aiCurrent,
    analyzedAt: aiCurrent && aiRow ? aiRow.created_at : detRow.created_at,
    refining: backlog?.state === 'queued' && running,
    aiWaiting: workerOn && backlog?.state === 'waiting',
    aiFailed: backlog?.state === 'failed',
  };
}

/** The SQL of an account's stored readings and backlog rows (all of them, or one resume's), with its parameters. */
function readingRowsQuery(userId: string, resumeId?: string) {
  return {
    analyses: `SELECT a.* FROM resume_analyses a JOIN resumes r ON r.id = a.resume_id WHERE r.user_id = ?${resumeId ? ' AND r.id = ?' : ''}`,
    backlog: `SELECT b.resume_id, b.state, b.content_hash, b.version, t.status AS task_status
       FROM resume_analysis_backlog b LEFT JOIN ai_tasks t ON t.id = b.task_id
       WHERE b.user_id = ?${resumeId ? ' AND b.resume_id = ?' : ''}`,
    params: resumeId ? [userId, resumeId] : [userId],
  };
}

/** The rows by resume id. */
function byResume(analyses: readonly AnalysisRow[], backlog: readonly BacklogInfo[]): Map<string, ReadingRows> {
  const rows = new Map<string, ReadingRows>();
  const entry = (id: string) => {
    let found = rows.get(id);
    if (!found) {
      found = {};
      rows.set(id, found);
    }
    return found;
  };
  for (const row of analyses) entry(row.resume_id)[row.source] = row;
  for (const row of backlog) entry(row.resume_id).backlog = row;
  return rows;
}

/** The stored readings and backlog rows of an account's resumes, by resume id (no resume text is read). */
async function readingRowsOf(deps: Pick<AppDeps, 'db'>, userId: string, resumeId?: string): Promise<Map<string, ReadingRows>> {
  const query = readingRowsQuery(userId, resumeId);
  const analyses = await deps.db.all<AnalysisRow>(query.analyses, query.params);
  const backlog = await deps.db.all<BacklogInfo>(query.backlog, query.params);
  return byResume(analyses, backlog);
}

export interface CurrentAnalysesOptions {
  /** Missing or outdated readings computed now, in order (default READ_COMPUTE_LIMIT); the backfill does the rest. */
  computeLimit?: number;
  /** Only these resumes, in this order (default: every resume of the account, most recently updated first). */
  resumeIds?: readonly string[];
}

const SELECT_ACCOUNT_RESUMES = 'SELECT id, kind FROM resumes WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC, id ASC';

/**
 * The account's current readings by resume id. A resume whose reading is missing or outdated is read now while the
 * compute limit lasts; past it, the resume is left out of the map and the backfill worker is asked to read it.
 */
export async function currentResumeAnalyses(
  deps: AppDeps,
  userId: string,
  options: CurrentAnalysesOptions = {},
): Promise<Map<string, StoredResumeAnalysis>> {
  const resumes = await deps.db.all<{ id: string; kind: 'built' | 'uploaded' }>(SELECT_ACCOUNT_RESUMES, [userId]);
  const kinds = new Map(resumes.map((row) => [row.id, row.kind]));
  const order = options.resumeIds ? options.resumeIds.filter((id) => kinds.has(id)) : resumes.map((row) => row.id);
  const workerOn = resumeAnalysisEnabled(deps);
  let budget = options.computeLimit ?? READ_COMPUTE_LIMIT;
  let left = 0;
  const rows = await readingRowsOf(deps, userId);
  const out = new Map<string, StoredResumeAnalysis>();
  for (const id of order) {
    const kind = kinds.get(id)!;
    let stored = assemble(id, kind, rows.get(id) ?? {}, workerOn);
    if (!stored) {
      if (budget > 0 && !readingFailedRecently(deps, id)) {
        budget -= 1;
        if (await refreshStoredResume(deps, id)) {
          stored = assemble(id, kind, (await readingRowsOf(deps, userId, id)).get(id) ?? {}, workerOn);
        }
      } else {
        left += 1;
      }
    }
    if (stored) out.set(id, stored);
  }
  if (left > 0) deps.services.resumeAnalysis?.backfill.nudge();
  return out;
}

/**
 * One resume's current reading. With `compute` (default), a missing or outdated reading is read now (even one that
 * failed lately: a person is looking at it); this one resume's content is checked too (its hash). Null when the resume
 * is not the account's, or it has no reading.
 */
export async function storedResumeAnalysis(
  deps: AppDeps,
  userId: string,
  resumeId: string,
  options: { compute?: boolean } = {},
): Promise<StoredResumeAnalysis | null> {
  const row = await deps.db.one<StoredResumeRow>(
    'SELECT id, user_id, kind, data, extracted_text FROM resumes WHERE id = ? AND user_id = ?',
    [resumeId, userId],
  );
  if (!row) return null;
  if (options.compute !== false) {
    try {
      await refreshResumeAnalysis(deps, targetOfRow(row));
      noteReading(deps, resumeId, false);
    } catch (error) {
      // An outdated reading still says more than none; with none, there is nothing to show.
      deps.log.warn(`[resume-analysis] could not read resume ${resumeId}`, error);
      noteReading(deps, resumeId, true);
    }
  }
  const rows = (await readingRowsOf(deps, userId, resumeId)).get(resumeId) ?? {};
  return assemble(resumeId, row.kind, rows, resumeAnalysisEnabled(deps)) ?? staleAnalysis(row.kind, resumeId, rows);
}

/** A stored rules' reading of another version or content, when no current one could be made: better than nothing. */
function staleAnalysis(kind: 'built' | 'uploaded', resumeId: string, rows: ReadingRows): StoredResumeAnalysis | null {
  const detRow = rows.deterministic;
  const data = detRow ? dataOfRow(detRow) : null;
  if (!detRow || !data) return null;
  return {
    resumeId,
    kind,
    contentHash: detRow.content_hash,
    source: 'deterministic',
    data,
    deterministic: data,
    ai: null,
    analyzedAt: detRow.created_at,
    refining: false,
    aiWaiting: false,
    aiFailed: rows.backlog?.state === 'failed',
  };
}

/**
 * GET /api/resumes/:id/analysis: "What TailorIT read from this resume". Null when it is not the account's; throws a
 * readable 500 when it could not be read at all (logged).
 */
export async function resumeAnalysisView(deps: AppDeps, userId: string, resumeId: string): Promise<ResumeAnalysisView | null> {
  const exists = await deps.db.one('SELECT 1 FROM resumes WHERE id = ? AND user_id = ?', [resumeId, userId]);
  if (!exists) return null;
  const stored = await storedResumeAnalysis(deps, userId, resumeId);
  if (!stored) throw new AppError('internal', UNREAD_MESSAGE);
  const { years, basis } = yearsOf(stored.data, deps.now());
  return {
    resumeId,
    source: stored.source,
    refining: stored.refining,
    aiWaiting: stored.aiWaiting,
    aiFailed: stored.aiFailed,
    hardSkills: stored.data.hardSkills,
    softSkills: stored.data.softSkills,
    keywords: stored.data.keywords,
    yearsExperience: years,
    yearsBasis: basis,
    analyzedAt: stored.analyzedAt,
  };
}

/** A list row's reading (GET /api/resumes): the card line "8 yrs · React, TypeScript, Node.js +9". */
export function resumeAnalysisBrief(stored: StoredResumeAnalysis, now: Date): ResumeAnalysisBrief {
  return {
    yearsExperience: yearsOf(stored.data, now).years,
    hardSkills: stored.data.hardSkills,
    softSkillCount: stored.data.softSkills.length,
    refining: stored.refining,
    aiWaiting: stored.aiWaiting,
  };
}
