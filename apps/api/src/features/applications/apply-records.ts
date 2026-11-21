import type {
  ApplyRecord,
  ApplyRecordAnswers,
  ApplyRecordDocumentRef,
  ApplyRecordDocuments,
  ApplyRecordList,
  ApplyRecordSentLetter,
  ApplyRecordSentResume,
  ApplyVia,
} from '@tailorit/shared';
import { dayKeyAt } from '../../core/constants/day';
import { nowIso, type AppDeps } from '../../core/context';
import { notFound } from '../../core/http/errors';
import { storedDocumentOf } from '../resumes/evidence';
import { loadOwnedRow } from './store';
import type { AutofillFieldCategory } from '@tailorit/shared/autofill'; // v33 SHARE-6
import { isSensitiveAnswerRow } from '../autofill/answers/screen'; // v33 SHARE-6

// v2.0 (docs/design/v2.0/05-prepare-flow.md, "The Saved Jobs list and the history"; DECISIONS A30): the application
// history's "what was used". One application_apply_records row (0823) each time an application becomes Applied, naming
// how (`via`) and exactly the resume, the cover letter and the answers that went with it:
// - agent, tab: an auto-apply run of the extension (its queue row's frozen kit: the row's resume, the draft's letter);
// - manual: Mark as applied on the Auto-apply page (the row's kit as well; never counted toward the daily limit);
// - page: the person's own submission from a page (the extension's POST /applied or /submissions), the resume the form
//   was sent with; a submission while an auto-apply run holds the job is that run's (agent or tab);
// - tracker: the Tracker (status menu, drag, bulk, a step's date, "Applied to this job?");
// - legacy: 0823's backfill of the applications applied before v2.0.
// The record is written inside the transaction that moves the entry, and kept when the documents go (SET NULL).
// v3.0 D2: async on deps.db (inside the mover's transaction, deps.db joins it).
//
// v30 DB-JOBS (docs/design/part2/11-database.md §5.8): the record is exact. At apply time it also records
// - resume_revision / letter_revision: the documents' revisions as sent (resumes.document_revision, bumped by each
//   change of a built resume's document; cover_letters.document_revision, bumped by each change of a letter's content).
//   The baseline's triggers (trg_resumes_snapshot, trg_letters_snapshot) freeze a document a record names at its
//   revision into application_document_snapshots the moment it would change or go, and set the record's snapshot id;
//   so a record shows the live document while its revision still matches, else its snapshot (recordDocuments);
// - posting_hash: the posting text's version applied to (jobs.content_hash then);
// - answers_used: the prepared answers (answers = 'prepared'), copied as [{label, answer}], because the draft they live
//   in is pruned (DRAFT_ANSWERS_KEEP_DAYS_AFTER_APPLY). Submitted answers stay per application
//   (application_form_answers); a second submission replacing them first freezes the earlier set into the earlier
//   record's answers_used (migration 0011's trigger trg_form_answers_freeze).
//   v33 SHARE-6 (the SHARE-6 review; migration 0052): each kept answer also carries its question's key and the answer's
//   category (a submission's as the extension sent it; none for a prepared answer), which screen it for a reader without
//   Sensitive answers' See exactly as the submitted answers are screened; they are never answered.

/** How an application became Applied, and what the caller knows of what was used. */
export interface ApplyContext {
  via: ApplyVia;
  /** The queue row the application went through (an auto-apply run, Mark as applied). */
  queueId?: string | null;
  /** The resume the form was sent with, when the caller knows it (the run's task, the extension's request). */
  resumeId?: string | null;
}

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

interface QueueFacts {
  id: string;
  prepare_id: string | null;
  resume_id: string | null;
  run: 'agent' | 'tab' | 'manual' | null;
}

interface EntryFacts {
  id: string;
  user_id: string;
  job_id: number | null;
  resume_id: string | null;
  cover_letter_id: string | null;
  /** jobs.content_hash of the entry's job (the posting's version), null without a job. */
  posting_hash: string | null;
}

/**
 * The ready answers of a draft as the record keeps them: [{label, questionKey, category, answer}] in the form's order
 * (null for none). A draft's answer has no category (v33 SHARE-6: null, so its question's words screen it).
 */
const PREPARED_ANSWERS = `SELECT jsonb_agg(jsonb_build_object('label', q.label, 'questionKey', q.question_key,
           'category', NULL::text, 'answer', da.answer::jsonb)
         ORDER BY q.step, q.position, q.id) AS used
       FROM application_draft_answers da JOIN job_form_questions q ON q.id = da.question_id
       WHERE da.draft_id = ? AND da.status = 'ready'`;

async function ownResume(deps: Deps, userId: string, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const row = await deps.db.one('SELECT 1 AS found FROM resumes WHERE id = ? AND user_id = ?', [id, userId]);
  return row ? id : null;
}

/** The queue row the record names: the one asked for, or, for a page's submission, the run holding the job now. */
async function queueFor(deps: Deps, entry: EntryFacts, context: ApplyContext): Promise<QueueFacts | null> {
  if (context.queueId) {
    const asked = await deps.db.one<QueueFacts>(
      'SELECT id, prepare_id, resume_id, run FROM autofill_agent_queue WHERE id = ? AND user_id = ?',
      [context.queueId, entry.user_id],
    );
    return asked ?? null;
  }
  if (context.via !== 'page' || entry.job_id === null) return null;
  const holding = await deps.db.one<QueueFacts>(
    `SELECT id, prepare_id, resume_id, run FROM autofill_agent_queue
      WHERE user_id = ? AND job_id = ? AND state = 'running' AND run IN ('agent', 'tab')`,
    [entry.user_id, entry.job_id],
  );
  return holding ?? null;
}

/**
 * Writes the apply record of `applicationId` (the caller's transaction: changeStatus's, when the entry's events gain
 * Applied). Answers its id.
 */
export async function recordApplied(deps: Deps, userId: string, applicationId: string, context: ApplyContext): Promise<number> {
  const entry = await deps.db.one<EntryFacts>(
    `SELECT a.id, a.user_id, a.job_id, a.resume_id, a.cover_letter_id, j.content_hash AS posting_hash
       FROM applications a LEFT JOIN jobs j ON j.id = a.job_id WHERE a.id = ? AND a.user_id = ?`,
    [applicationId, userId],
  );
  if (!entry) throw new Error('recordApplied: no such application');
  const queue = await queueFor(deps, entry, context);
  // A page's submission while a run holds the job is that run's.
  const via: ApplyVia = context.via === 'page' && queue && !context.queueId && queue.run ? queue.run : context.via;
  const draft = await deps.db.one<{ id: string; cover_letter_id: string | null; answers_status: string }>(
    'SELECT id, cover_letter_id, answers_status FROM application_drafts WHERE application_id = ?',
    [applicationId],
  );
  // The kit's documents when the application went through a prepared queue row: the row's resume (frozen when it was
  // queued) and the draft's letter, or none (v2.0 FIX-B, BEH-2: never the entry's, which may be an earlier kit's
  // written from another resume); otherwise the resume the form was sent with, else the entry's, and the entry's letter.
  const kit = queue !== null && queue.prepare_id !== null;
  const resumeId =
    (await ownResume(deps, userId, context.resumeId)) ??
    (queue ? await ownResume(deps, userId, queue.resume_id) : null) ??
    entry.resume_id;
  const coverLetterId = kit ? (draft?.cover_letter_id ?? null) : entry.cover_letter_id;
  const submitted = await deps.db.one(
    'SELECT 1 AS found FROM application_form_answers WHERE user_id = ? AND application_id = ? LIMIT 1',
    [userId, applicationId],
  );
  const answers: ApplyRecordAnswers = submitted ? 'submitted' : draft?.answers_status === 'ready' ? 'prepared' : 'none';
  // v30 DB-JOBS: the revisions as sent, and the prepared answers copied (the draft is pruned later).
  const resumeRevision = resumeId
    ? ((await deps.db.one<{ n: number }>('SELECT document_revision AS n FROM resumes WHERE id = ? AND user_id = ?', [resumeId, userId]))?.n ?? null)
    : null;
  const letterRevision = coverLetterId
    ? ((await deps.db.one<{ n: number }>('SELECT document_revision AS n FROM cover_letters WHERE id = ? AND user_id = ?', [coverLetterId, userId]))
        ?.n ?? null)
    : null;
  const answersUsed =
    answers === 'prepared' && draft ? ((await deps.db.one<{ used: string | null }>(PREPARED_ANSWERS, [draft.id]))?.used ?? null) : null;
  const inserted = await deps.db.one<{ id: number }>(
    `INSERT INTO application_apply_records(user_id, application_id, job_id, via, queue_id, prepare_id, draft_id,
       resume_id, cover_letter_id, answers, day_key, applied_at, resume_revision, letter_revision, answers_used, posting_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS jsonb), ?)
     RETURNING id`,
    [
      userId,
      applicationId,
      entry.job_id,
      via,
      queue?.id ?? context.queueId ?? null,
      queue?.prepare_id ?? null,
      draft?.id ?? null,
      resumeId,
      coverLetterId,
      answers,
      dayKeyAt(deps),
      nowIso(deps),
      resumeRevision,
      letterRevision,
      answersUsed,
      entry.posting_hash,
    ],
  );
  return Number(inserted!.id);
}

interface RecordRow {
  id: number;
  via: ApplyVia;
  applied_at: string;
  day_key: string;
  prepare_id: string | null;
  draft_id: string | null;
  answers: ApplyRecordAnswers;
  answers_used: string | null;
  posting_hash: string | null;
  resume_id: string | null;
  resume_revision: number | null;
  resume_snapshot_id: number | null;
  cover_letter_id: string | null;
  letter_revision: number | null;
  letter_snapshot_id: number | null;
  /** The live resume and letter, joined (the account's own). */
  live_resume_title: string | null;
  live_resume_revision: number | null;
  live_letter_title: string | null;
  live_letter_revision: number | null;
  /** The snapshots, joined (the account's own). */
  resume_snapshot_title: string | null;
  resume_snapshot_source: string | null;
  letter_snapshot_title: string | null;
  letter_snapshot_source: string | null;
}

/** The records' columns with their documents, live and frozen (alias r; every join the account's own rows). */
const RECORD_SQL = `SELECT r.id, r.via, r.applied_at, r.day_key, r.prepare_id, r.draft_id, r.answers, r.answers_used, r.posting_hash,
       r.resume_id, r.resume_revision, r.resume_snapshot_id, r.cover_letter_id, r.letter_revision, r.letter_snapshot_id,
       rs.title AS live_resume_title, rs.document_revision AS live_resume_revision,
       cl.title AS live_letter_title, cl.document_revision AS live_letter_revision,
       sr.title AS resume_snapshot_title, sr.source_id AS resume_snapshot_source,
       sl.title AS letter_snapshot_title, sl.source_id AS letter_snapshot_source
     FROM application_apply_records r
     LEFT JOIN resumes rs ON rs.id = r.resume_id AND rs.user_id = r.user_id
     LEFT JOIN cover_letters cl ON cl.id = r.cover_letter_id AND cl.user_id = r.user_id
     LEFT JOIN application_document_snapshots sr ON sr.id = r.resume_snapshot_id AND sr.user_id = r.user_id
     LEFT JOIN application_document_snapshots sl ON sl.id = r.letter_snapshot_id AND sl.user_id = r.user_id`;

/** Which of a record's documents it shows: the live one while it is as sent, else the snapshot frozen when it changed. */
type Shown =
  | { source: 'live'; id: string; title: string | null }
  | { source: 'snapshot'; id: string | null; title: string; snapshotId: number }
  | null;

function shown(
  id: string | null,
  live: { title: string | null; revision: number | null },
  snapshot: { id: number | null; title: string | null; source: string | null },
): Shown {
  if (snapshot.id !== null) {
    return { source: 'snapshot', id: id ?? snapshot.source, title: snapshot.title ?? '', snapshotId: snapshot.id };
  }
  // No snapshot: the live document is as it was sent (its revision moved on only through a snapshot), or it is gone.
  if (id === null || live.revision === null) return null;
  return { source: 'live', id, title: live.title };
}

const shownResume = (row: RecordRow) =>
  shown(
    row.resume_id,
    { title: row.live_resume_title, revision: row.live_resume_revision },
    { id: row.resume_snapshot_id, title: row.resume_snapshot_title, source: row.resume_snapshot_source },
  );

const shownLetter = (row: RecordRow) =>
  shown(
    row.cover_letter_id,
    { title: row.live_letter_title, revision: row.live_letter_revision },
    { id: row.letter_snapshot_id, title: row.letter_snapshot_title, source: row.letter_snapshot_source },
  );

/**
 * The list's reference to a shown document. As in v2.0, a document with no title of its own (a built resume named by its
 * contents) is not named: live, or frozen (its snapshot's title is then '').
 */
function refOf(document: Shown): ApplyRecordDocumentRef | null {
  if (!document || document.id === null || !document.title) return null;
  return document.source === 'snapshot'
    ? { id: document.id, title: document.title, snapshotId: document.snapshotId }
    : { id: document.id, title: document.title };
}

/**
 * One answer a record keeps, as stored: v3.0's {label, answer}; v33 SHARE-6 (migration 0052) adds its question's key and
 * the answer's category (null: none known), read by keptIsSensitive and never answered.
 */
type KeptAnswer = { label: string; answer: unknown; questionKey?: string; category?: string | null };

/** The answers a record keeps itself (answers_used), parsed; null when it keeps none. */
function answersUsedOf(row: Pick<RecordRow, 'answers_used'>): KeptAnswer[] | null {
  if (row.answers_used === null) return null;
  try {
    const value: unknown = JSON.parse(row.answers_used);
    return Array.isArray(value) ? (value as KeptAnswer[]) : null;
  } catch {
    return null;
  }
}

/**
 * v33 SHARE-6 (PLAN-sharing §4 "Sensitive facts"; SHARE-9's edit 1): what the reader of a record may see of it. On a
 * shared profile: the kept answers without the sensitive ones unless `sensitive` (Sensitive answers' See), the resume and
 * the letter only with `documents` (Documents' See). The person's own reads see everything (OWN_READER).
 */
export interface RecordReader {
  sensitive: boolean;
  documents: boolean;
}

const OWN_READER: RecordReader = { sensitive: true, documents: true };

/**
 * v33 SHARE-6 (the SHARE-6 review): whether a kept answer is left out for a reader without Sensitive answers' See, judged
 * as the submitted answers are (isSensitiveAnswerRow: the category, the question's key and label, then the answer). A
 * submission frozen before migration 0052 kept no category, and the extension may have known its question as sensitive
 * by that alone (a label such as "Details"): such a row is left out (fail closed). A prepared answer never had one.
 */
function keptIsSensitive(kept: KeptAnswer, answers: ApplyRecordAnswers): boolean {
  if (!kept || typeof kept !== 'object' || typeof kept.label !== 'string') return true;
  if (!Object.hasOwn(kept, 'category') && answers === 'submitted') return true;
  const category = typeof kept.category === 'string' ? (kept.category as AutofillFieldCategory) : null;
  const questionKey = typeof kept.questionKey === 'string' && kept.questionKey !== '' ? kept.questionKey : kept.label;
  return isSensitiveAnswerRow({ category, questionKey, questionLabel: kept.label, answer: kept.answer });
}

/** The kept answers as answered (the contract's {label, answer}), the sensitive ones left out unless `sensitive`. */
function keptAsSeen(kept: readonly KeptAnswer[], answers: ApplyRecordAnswers, sensitive: boolean): ApplyRecordDocuments['answersUsed'] {
  const shown = sensitive ? kept : kept.filter((answer) => !keptIsSensitive(answer, answers));
  return shown.map((answer) => ({ label: answer.label, answer: answer.answer }));
}

/** GET /api/applications/:id/apply-records: the account's application's records, newest first (404: not theirs). */
export async function listApplyRecords(deps: Pick<AppDeps, 'db'>, userId: string, applicationId: string): Promise<ApplyRecordList> {
  await loadOwnedRow(deps.db, userId, applicationId);
  const rows = await deps.db.all<RecordRow>(`${RECORD_SQL} WHERE r.application_id = ? AND r.user_id = ? ORDER BY r.id DESC`, [
    applicationId,
    userId,
  ]);
  const submitted = await deps.db.one<{ n: number }>(
    'SELECT count(*) AS n FROM application_form_answers WHERE user_id = ? AND application_id = ?',
    [userId, applicationId],
  );
  const readyDraftAnswers = async (draftId: string | null): Promise<number> => {
    if (draftId === null) return 0;
    const ready = await deps.db.one<{ n: number }>(
      "SELECT count(*) AS n FROM application_draft_answers WHERE draft_id = ? AND status = 'ready'",
      [draftId],
    );
    return ready!.n;
  };
  const items: ApplyRecord[] = [];
  for (const row of rows) {
    // v30 DB-JOBS: the answers a record keeps itself count first (copied prepared answers, a replaced submission).
    const kept = answersUsedOf(row);
    let answerCount = 0;
    if (row.answers !== 'none') {
      if (kept !== null) answerCount = kept.length;
      else answerCount = row.answers === 'submitted' ? submitted!.n : await readyDraftAnswers(row.draft_id);
    }
    items.push({
      id: row.id,
      via: row.via,
      appliedAt: row.applied_at,
      dayKey: row.day_key,
      prepareId: row.prepare_id,
      resume: refOf(shownResume(row)),
      coverLetter: refOf(shownLetter(row)),
      answers: row.answers,
      answerCount,
    });
  }
  return { items };
}

interface SnapshotRow {
  source_id: string | null;
  source_revision: number | null;
  title: string;
  body: string;
  file_id: string | null;
}

interface LiveResumeRow {
  id: string;
  kind: 'built' | 'uploaded';
  title: string | null;
  data: string | null;
  file_id: string | null;
  extracted_text: string | null;
  document_revision: number;
}

/** A snapshot's body as an object (the trigger wrote json_build_object(...) or the document's own JSON). */
function bodyOf(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const textOr = (value: unknown, fallback: string | null) => (typeof value === 'string' ? value : fallback);

const SNAPSHOT_SQL = 'SELECT source_id, source_revision, title, body, file_id FROM application_document_snapshots WHERE id = ? AND user_id = ?';

async function sentResume(deps: Pick<AppDeps, 'db'>, userId: string, row: RecordRow): Promise<ApplyRecordSentResume | null> {
  const document = shownResume(row);
  if (!document) return null;
  if (document.source === 'snapshot') {
    const snap = await deps.db.one<SnapshotRow>(SNAPSHOT_SQL, [document.snapshotId, userId]);
    if (!snap) return null;
    const body = bodyOf(snap.body);
    // An upload's snapshot names its stored file ({fileId, extractedText, name}); a built one is the document itself.
    const upload = snap.file_id !== null || (body !== null && 'fileId' in body && 'extractedText' in body);
    return {
      source: 'snapshot',
      resumeId: snap.source_id,
      revision: snap.source_revision,
      title: snap.title,
      kind: upload ? 'uploaded' : 'built',
      document: upload ? null : storedDocumentOf({ kind: 'built', data: snap.body }),
      fileId: upload ? (snap.file_id ?? textOr(body?.fileId, null)) : null,
      extractedText: upload ? textOr(body?.extractedText, null) : null,
    };
  }
  const live = await deps.db.one<LiveResumeRow>(
    'SELECT id, kind, title, data, file_id, extracted_text, document_revision FROM resumes WHERE id = ? AND user_id = ?',
    [document.id, userId],
  );
  if (!live) return null;
  return {
    source: 'live',
    resumeId: live.id,
    revision: live.document_revision,
    title: live.title ?? '',
    kind: live.kind,
    document: live.kind === 'built' ? storedDocumentOf({ kind: 'built', data: live.data }) : null,
    fileId: live.kind === 'uploaded' ? live.file_id : null,
    extractedText: live.kind === 'uploaded' ? live.extracted_text : null,
  };
}

async function sentLetter(deps: Pick<AppDeps, 'db'>, userId: string, row: RecordRow): Promise<ApplyRecordSentLetter | null> {
  const document = shownLetter(row);
  if (!document) return null;
  if (document.source === 'snapshot') {
    const snap = await deps.db.one<SnapshotRow>(SNAPSHOT_SQL, [document.snapshotId, userId]);
    if (!snap) return null;
    const body = bodyOf(snap.body);
    return {
      source: 'snapshot',
      letterId: snap.source_id,
      revision: snap.source_revision,
      title: snap.title,
      html: textOr(body?.html, '')!,
      text: textOr(body?.text, '')!,
    };
  }
  const live = await deps.db.one<{ id: string; title: string; content_html: string; content_text: string; document_revision: number }>(
    'SELECT id, title, content_html, content_text, document_revision FROM cover_letters WHERE id = ? AND user_id = ?',
    [document.id, userId],
  );
  if (!live) return null;
  return {
    source: 'live',
    letterId: live.id,
    revision: live.document_revision,
    title: live.title,
    html: live.content_html,
    text: live.content_text,
  };
}

/**
 * GET /api/applications/:id/apply-records/:recordId/documents (v30 DB-JOBS): exactly what one record was sent with:
 * the resume and the letter, each live while unchanged since, else the snapshot frozen when it changed or went; the
 * answers the record keeps; the posting's version. 404 for a record that is not of the account's application.
 */
export async function recordDocuments(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  applicationId: string,
  recordId: number,
  reader: RecordReader = OWN_READER, // v33 SHARE-6
): Promise<ApplyRecordDocuments> {
  await loadOwnedRow(deps.db, userId, applicationId);
  const row = await deps.db.one<RecordRow>(`${RECORD_SQL} WHERE r.id = ? AND r.application_id = ? AND r.user_id = ?`, [
    recordId,
    applicationId,
    userId,
  ]);
  if (!row) throw notFound('That apply record');
  const kept = answersUsedOf(row);
  return {
    recordId: row.id,
    // v33 SHARE-6: the resume and the letter are Documents' (none without its See on a shared profile).
    resume: reader.documents ? await sentResume(deps, userId, row) : null,
    coverLetter: reader.documents ? await sentLetter(deps, userId, row) : null,
    answers: row.answers,
    answersUsed: kept === null ? null : keptAsSeen(kept, row.answers, reader.sensitive), // v33 SHARE-6
    postingHash: row.posting_hash,
  };
}
