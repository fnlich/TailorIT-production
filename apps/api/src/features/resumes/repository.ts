import { randomUUID } from 'node:crypto';
import {
  effectiveTemplateId,
  isEditorDocument,
  normalizeResumeDocument,
  PREPARE_ACTIVE_STATES,
  RESUME_TEMPLATES,
  resolveTemplateId,
  resumeLabel,
  type ResumeAnalysisBrief,
  type ResumeDetail,
  type ResumeDocument,
  type ResumeFileKind,
  type ResumeMadeBy,
  type ResumeSource,
  type ResumeSummary,
  type Entitlements,
  UNLIMITED,
} from '@tailorit/shared';
import { entitlementsOf, resumeLimitError } from '../../core/accounts/index';
import type { Payer } from '../../core/accounts/payer'; // v33 SHARE-3
import { refuse } from '../../core/http/refuse'; // v33 SHARE-3
import { constantsOf } from '../../core/constants/service';
import { nowIso, type AppDeps } from '../../core/context';
import { kindOfMime } from '../../core/files/index';
import { AppError, conflict, notFound } from '../../core/http/errors';
import { editorDocumentOf } from '../../core/skills/index';
import { scheduleResumeAnalysis } from './analysis/deferred';
import { analyzeAfterWrite } from './analysis/store';
import { resumeCount as storedResumeCount } from './counters';
import { storedDocumentOf } from './evidence';

// The resumes table, always scoped by owner: another account's resume is "not found", never "forbidden". Every write
// that changes what a resume says also stores what TailorIT read from it (analysis/store.ts), best effort: the
// reading never fails the write. An uploaded resume is never changed after it is stored (only Rename touches its row).
// v33 LEGACY: a built resume's document is stored as the on-page editor opens it: an older or AI-made one is upgraded
// on the way in (core/skills' editorDocumentOf), so every write stores an editor document.
//
// v3.0 D2 (D2-E): every statement goes through the async client. insertResume checks the resume limit behind the
// person's lock (deps.db.atomic: a savepoint of a caller's transaction, else its own).

export interface ResumeRow {
  id: string;
  user_id: string;
  kind: 'built' | 'uploaded';
  title: string | null;
  template_id: string | null;
  data: string | null;
  file_id: string | null;
  extracted_text: string | null;
  source_resume_id: string | null;
  created_at: string;
  updated_at: string;
  last_edited_at: string | null;
  /** Bumped by each save that changes `data` (migration 0104). */
  document_revision: number;
  // v1.5 W
  /** How it came to be (migration 0815): its folder in Documents › Resumes. */
  made_by: ResumeMadeBy;
  // end v1.5 W
}

/** A resume row with its stored file's details (uploads). */
export interface ResumeWithFile extends ResumeRow {
  file_name: string | null;
  file_mime: string | null;
  file_size: number | null;
  file_pages: number | null;
  file_thumb: string | null;
}

/**
 * A list row: everything but an upload's extracted text, which the list never reads (up to 60k characters each).
 * v30 FIX-PERF (PGL-13): and its `data` is the document's list fields only (LIST_DOCUMENT_SQL), never the whole document.
 */
export type ResumeListRow = Omit<ResumeWithFile, 'extracted_text'>;

const FILE_COLUMNS = `f.original_name AS file_name, f.mime AS file_mime, f.size_bytes AS file_size,
         f.page_count AS file_pages, f.thumb_path AS file_thumb`;
const FROM_WITH_FILE = `FROM resumes r
    LEFT JOIN stored_files f ON f.id = r.file_id AND f.user_id = r.user_id`;
const SELECT_WITH_FILE = `
  SELECT r.*, ${FILE_COLUMNS}
    ${FROM_WITH_FILE}`;
/**
 * v30 FIX-PERF (PG-LOAD PGL-13): what the list reads of a built resume's document: the top-level fields its row and
 * card show (toSummary: the name, the headline, the template, the old editor's template, the markup version), as a
 * JSON object of those keys alone. The document itself (the editor's JSON, several KB) stays in the database: the list
 * sent every resume's whole document (35 MB for an account of 5,040 resumes at mix B's size) and normalized each in
 * the API. json_each reads the stored text once and never unescapes a value; a key absent or null normalizes alike;
 * a document that is not an object reads as {} (as JSON.parse's answer normalizes).
 *
 * v3.0.1 FIX-PERF2 (PG-LOAD PGL-23): json_each still parsed every document at every list (the column is json, kept as
 * written: 110 of 149 ms for 5,040 resumes at mix B's size). resumes.list_data holds the same object, written with the
 * document (migration 0038's trigger, the same expression), so the list reads it and parses nothing; a row without it
 * (a document json_each will not read) is read as before.
 */
const LIST_DOCUMENT_SQL = `CASE WHEN r.kind <> 'built' OR r.data IS NULL THEN NULL
    WHEN r.list_data IS NOT NULL THEN CAST(r.list_data AS text)
    WHEN json_typeof(r.data) <> 'object' THEN '{}'
    ELSE COALESCE((SELECT CAST(json_object_agg(e.key, e.value) AS text) FROM json_each(r.data) e
                   WHERE e.key IN ('name', 'title', 'preferredTemplate', 'templateId', 'markupVersion')), '{}') END`;

/** A list row's columns, with `data` as `document` gives it. */
const listRowSql = (document: string) => `
  SELECT r.id, r.user_id, r.kind, r.title, r.template_id, ${document} AS data, r.file_id, r.source_resume_id,
         r.created_at, r.updated_at, r.last_edited_at, r.made_by, ${FILE_COLUMNS}
    ${FROM_WITH_FILE}`;
const SELECT_LIST_ROW = listRowSql(LIST_DOCUMENT_SQL);
/** The list's rows with each document whole: for an account whose documents json_each will not read (below). */
const SELECT_LIST_ROW_WHOLE = listRowSql('r.data');

// v2.0 (A15; docs/design/v2.0/04-accounts-limits.md §3): the resume storage limit. Every row of `resumes` counts, of
// every kind and every made_by (upload, editor, copy, tailor). Two limits apply, both central constants read at the
// moment of use:
//   - the plan's limit (FREE_RESUME_LIMIT, 30 by default; PAID_RESUME_LIMIT, unlimited by default): 403
//     resume_limit_reached, MSG_LIMIT_RESUMES, with Subscribe for a Free account. At the limit, new resumes of every
//     kind and saves of a resume's document are refused; Rename and Delete never are. A lapse to Free keeps every
//     resume: above the limit, adding and saving stay refused until the count is under it.
//   - RESUME_SAFETY_CAP (5,100): a technical cap for every account, Paid included, not a plan limit: 409 conflict.
// The early checks (upload, import, duplicate, an editable copy, tailoring, Prepare) run before any file is stored or
// any AI is queued, so no AI is spent on a resume that could not be kept; insertResume checks again as it writes.

type LimitDeps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

// v30 DB-JOBS (D1d, 11 §5.7 and Q10): the count is the stored one (./counters.ts: user_counters, kept by the baseline's
// triggers in the writer's own transaction and recounted nightly), one primary-key read where count(*) read every
// index entry of the account's resumes.

/** How many resumes the account keeps, of every kind (the stored count, user_counters). */
export async function resumeCount(deps: Pick<AppDeps, 'db'>, userId: string): Promise<number> {
  return storedResumeCount(deps.db, userId);
}

/** The safety cap's refusal: adding past RESUME_SAFETY_CAP resumes (every kind together), for every account. */
function noRoomMessage(cap: number, adding: number): string {
  const limit = `You can keep up to ${cap} resumes`;
  return adding > 1
    ? `${limit}, and these ${adding} would take you past that. Delete resumes you no longer need, then try again.`
    : `${limit}. Delete resumes you no longer need, then try again.`;
}

/** The refusal of `adding` more resumes to `count`, or null when they fit (the safety cap, then the plan's limit). */
function roomRefusal(deps: LimitDeps, count: number, adding: number, entitlements: () => Entitlements): AppError | null {
  const cap = constantsOf(deps).get('RESUME_SAFETY_CAP');
  if (count + adding > cap) return conflict(noRoomMessage(cap, adding));
  const plan = entitlements();
  if (plan.resumes !== UNLIMITED && count + adding > plan.resumes) {
    return resumeLimitError(deps, plan.resumes, { free: plan.type === 'free' });
  }
  return null;
}

/**
 * Adding `adding` resumes: 409 `conflict` past RESUME_SAFETY_CAP (technical, every account); 403 `resume_limit_reached`
 * (MSG_LIMIT_RESUMES, Subscribe for a Free account) when the plan's limit is not UNLIMITED and count + adding > limit.
 * Alone it is the early check (nothing is locked); insertResume checks again behind the person's lock.
 */
export async function assertRoomForResumes(deps: LimitDeps, userId: string, adding = 1, payer?: Payer): Promise<void> {
  const count = await resumeCount(deps, userId);
  const entitlements = await entitlementsOf(deps, userId);
  const refusal = roomRefusal(deps, count, adding, () => entitlements);
  if (refusal) throw refusal;
  // v33 SHARE-3 (PLAN F9 "Who pays", PLAN-sharing §5): the room is the profile owner's (A's plan), and the work B pays
  // for on A's profile never takes A's last SHARING_RESUME_RESERVE places (of the plan's limit, or of the safety cap).
  if (payer?.grantId) {
    const reserve = constantsOf(deps).get('SHARING_RESUME_RESERVE');
    const cap = constantsOf(deps).get('RESUME_SAFETY_CAP');
    const limit = entitlements.resumes === UNLIMITED ? cap : Math.min(cap, entitlements.resumes);
    if (count + adding > limit - reserve) throw refuse(deps, 'resume_limit_reached', 'MSG_SHARING_RESUME_RESERVE', { reserve });
  }
}

const ACTIVE_PREPARES_OWN = `SELECT 1 FROM prepare_jobs WHERE id = ? AND user_id = ? AND resume_id = ? AND resume_mode = 'tailor'
           AND state IN (${PREPARE_ACTIVE_STATES.map(() => '?').join(', ')})`;

/**
 * v2.0 (INT, the coordinator's decision): whether `resumeId` is the tailored resume that the ACTIVE Prepare `prepareId`
 * made for its own kit. prepare_jobs.resume_id names it from the save that made it (the own AI's first resume save, the
 * runner's tailoring) while the Prepare is active, in the `tailor` mode only; a kit's resume kept from an earlier
 * Prepare, or a resume chosen as it is (`default`, `similar`), is named there only once the Prepare has finished, or
 * was made by no Prepare.
 */
export async function isActivePreparesOwnResume(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  prepareId: string,
  resumeId: string,
): Promise<boolean> {
  return (await deps.db.one(ACTIVE_PREPARES_OWN, [prepareId, userId, resumeId, ...PREPARE_ACTIVE_STATES])) !== undefined;
}

/**
 * Saving a resume's document (and AI that writes into one, such as Write with AI): 403 `resume_limit_reached` when the
 * plan's limit is not UNLIMITED and the account holds that many resumes or more ("at the limit, block ... edits").
 * A title is not the document: Rename is never refused.
 *
 * v2.0 (INT): `preparing` exempts exactly one save: an active Prepare's revision round of the tailored resume that the
 * same Prepare made (isActivePreparesOwnResume). That resume is what brought the count to the limit; refusing its
 * rounds as an edit would leave the job never queued. Every other save at the limit is refused, that resume's too once
 * its Prepare has ended, or from anywhere else (the editor, Write with AI).
 */
export async function assertResumeEditable(
  deps: LimitDeps,
  userId: string,
  preparing?: { prepareId: string; resumeId: string },
): Promise<void> {
  const entitlements = await entitlementsOf(deps, userId);
  if (entitlements.resumes === UNLIMITED) return;
  if ((await resumeCount(deps, userId)) >= entitlements.resumes) {
    if (preparing && (await isActivePreparesOwnResume(deps, userId, preparing.prepareId, preparing.resumeId))) return;
    throw resumeLimitError(deps, entitlements.resumes, { free: entitlements.type === 'free' });
  }
}

export const RESUME_NOT_FOUND = 'That resume';

const SELECT_ONE = `${SELECT_WITH_FILE} WHERE r.id = ? AND r.user_id = ?`;

export async function findResume(deps: Pick<AppDeps, 'db'>, userId: string, id: string): Promise<ResumeWithFile | null> {
  return (await deps.db.one<ResumeWithFile>(SELECT_ONE, [id, userId])) ?? null;
}

export async function requireResume(deps: Pick<AppDeps, 'db'>, userId: string, id: string): Promise<ResumeWithFile> {
  const row = await findResume(deps, userId, id);
  if (!row) throw notFound(RESUME_NOT_FOUND);
  return row;
}

/** The SQL and parameters of the Resumes list's rows (every kind, or one). */
function listQuery(userId: string, source: ResumeSource, select = SELECT_LIST_ROW): { sql: string; params: string[] } {
  const kind = source === 'all' ? '' : ' AND r.kind = ?';
  return {
    sql: `${select} WHERE r.user_id = ?${kind} ORDER BY r.updated_at DESC, r.created_at DESC, r.id ASC`,
    params: source === 'all' ? [userId] : [userId, source],
  };
}

/** A data exception of PostgreSQL's (class 22), such as json_each refusing to unescape a value (\u0000, a lone surrogate). */
function isDataException(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('22');
}

/**
 * The Resumes list's rows, most recently updated first. Uploads' extracted text is not read, nor built resumes' whole
 * documents (LIST_DOCUMENT_SQL). v30 FIX-PERF: a document json_each will not read (a value it cannot unescape, which
 * JSON.parse reads) sends the list back to reading the documents whole, so it shows the same.
 */
export async function listResumeRows(deps: Pick<AppDeps, 'db'>, userId: string, source: ResumeSource): Promise<ResumeListRow[]> {
  const { sql, params } = listQuery(userId, source);
  try {
    // Inside a caller's transaction, in a savepoint: a refused statement must not abort the transaction.
    return deps.db.inTx() ? await deps.db.atomic((t) => t.all<ResumeListRow>(sql, params)) : await deps.db.all<ResumeListRow>(sql, params);
  } catch (error) {
    if (!isDataException(error)) throw error;
    const whole = listQuery(userId, source, SELECT_LIST_ROW_WHOLE);
    return deps.db.all<ResumeListRow>(whole.sql, whole.params);
  }
}

// v1.5 W
/** An upload's editable copy: the newest built resume made from it (migration 0815's `copy`), or null. */
export async function newestEditableCopy(deps: Pick<AppDeps, 'db'>, userId: string, uploadId: string): Promise<string | null> {
  const row = await deps.db.one<{ id: string }>(
    `SELECT id FROM resumes WHERE user_id = ? AND kind = 'built' AND made_by = 'copy' AND source_resume_id = ?
        ORDER BY updated_at DESC, created_at DESC, id ASC LIMIT 1`,
    [userId, uploadId],
  );
  return row?.id ?? null;
}
// end v1.5 W

const SELECT_DEFAULT = 'SELECT default_resume_id FROM users WHERE id = ?';

export async function defaultResumeId(deps: Pick<AppDeps, 'db'>, userId: string): Promise<string | null> {
  return (await deps.db.one<{ default_resume_id: string | null }>(SELECT_DEFAULT, [userId]))?.default_resume_id ?? null;
}

/** The stored document of a built resume (normalised again, so an older stored shape reads as today's). */
export function documentOf(row: Pick<ResumeRow, 'kind' | 'data'>): ResumeDocument | null {
  return storedDocumentOf(row);
}

function fileKindOf(mime: string | null): ResumeFileKind | null {
  const kind = mime ? kindOfMime(mime) : null;
  return kind === 'pdf' || kind === 'docx' ? kind : null;
}

/** An upload's name without its extension ("Jane Doe CV.pdf" -> "Jane Doe CV"). */
function fileBaseName(name: string | null): string {
  return (name ?? '').replace(/\.(pdf|docx?)$/i, '').trim();
}

// v1.5 W
/** How a resume came to be: an upload is always `upload` (the kind decides it; migration 0815's triggers hold it). */
export function madeByOf(row: Pick<ResumeRow, 'kind' | 'made_by'>): ResumeMadeBy {
  return row.kind === 'uploaded' ? 'upload' : builtMadeBy(row);
}

/** How a built resume came to be: `editor`, `copy` or `tailor`. */
export function builtMadeBy(row: Pick<ResumeRow, 'made_by'>): Exclude<ResumeMadeBy, 'upload'> {
  return row.made_by === 'copy' || row.made_by === 'tailor' ? row.made_by : 'editor';
}
// end v1.5 W

/** One row or card of the Resumes tab. `analysis` (the list only) is what TailorIT read from it, null when not yet. */
export function toSummary(
  deps: AppDeps,
  row: ResumeListRow,
  defaultId: string | null,
  analysis?: ResumeAnalysisBrief | null,
): ResumeSummary {
  const document = documentOf(row);
  const custom = row.title?.trim() || null;
  if (document && isEditorDocument(document)) {
    const spec = RESUME_TEMPLATES[effectiveTemplateId(document)];
    return {
      id: row.id,
      kind: row.kind,
      label: resumeLabel(document, custom),
      title: custom,
      templateId: spec.id,
      templateName: spec.name,
      isDefault: row.id === defaultId,
      fileKind: null,
      nameOnResume: document.name,
      madeBy: madeByOf(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastEditedAt: row.last_edited_at,
      ...(analysis !== undefined ? { analysis } : {}),
      onPageEditor: true,
    };
  }
  // An older resume, not saved since the on-page editor: named by the editor template it opens on (v33 LEGACY).
  const template = row.kind === 'built' ? RESUME_TEMPLATES[resolveTemplateId(document?.preferredTemplate)] : null;
  return {
    id: row.id,
    kind: row.kind,
    label: row.kind === 'built' ? resumeLabel(document, custom) : custom || fileBaseName(row.file_name) || 'Uploaded resume',
    title: custom,
    templateId: template?.id ?? null,
    templateName: template?.name ?? null,
    isDefault: row.id === defaultId,
    fileKind: row.kind === 'uploaded' ? fileKindOf(row.file_mime) : null,
    nameOnResume: document?.name ?? '',
    madeBy: madeByOf(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEditedAt: row.last_edited_at,
    ...(analysis !== undefined ? { analysis } : {}),
  };
}

export function toDetail(deps: AppDeps, row: ResumeWithFile, defaultId: string | null): ResumeDetail {
  return {
    ...toSummary(deps, row, defaultId),
    document: documentOf(row),
    file:
      row.kind === 'uploaded' && row.file_id && row.file_mime
        ? {
            id: row.file_id,
            name: row.file_name ?? 'resume',
            mime: row.file_mime,
            sizeBytes: row.file_size ?? 0,
            pageCount: row.file_pages && row.file_pages > 0 ? row.file_pages : null,
          }
        : null,
    hasExtractedText: (row.extracted_text ?? '').trim().length > 0,
    documentRevision: row.document_revision ?? 0,
  };
}

export interface NewResume {
  kind: 'built' | 'uploaded';
  title?: string | null;
  document?: ResumeDocument | null;
  fileId?: string | null;
  extractedText?: string | null;
  sourceResumeId?: string | null;
  // v1.5 W
  /**
   * How a built resume came to be (migration 0815): `editor` (the default: made in the editor, imported, or a
   * duplicate of one), `copy` (an upload's editable copy) or `tailor` (tailoring's output). An upload is `upload`.
   */
  madeBy?: Exclude<ResumeMadeBy, 'upload'>;
  // end v1.5 W
  /** False for an upload Claude is not to read (the demo seed's). Default: every upload with readable text is read. */
  aiRefine?: boolean;
  // v33 ROLES
  /** The resume whose chosen field (role_family) the new one inherits: a duplicate's original. Default: `sourceResumeId`. */
  fieldFrom?: string | null;
  /**
   * v33 SHARE-3 (review): who pays for the work that makes it (B on A's profile): it never takes A's last
   * SHARING_RESUME_RESERVE places, checked again behind the person's lock (two of B's at once never both pass).
   */
  payer?: Payer;
}

// v33 ROLES: role_family, the person's choice of field, comes from the resume it was made from (a tailored copy, a
// Prepare or MCP save, an upload's editable copy, a duplicate: `fieldFrom`), when that resume is the same account's.
const INSERT_RESUME = `INSERT INTO resumes(id, user_id, kind, title, template_id, data, file_id, extracted_text, source_resume_id,
           created_at, updated_at, last_edited_at, made_by, role_family)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, (SELECT s.role_family FROM resumes s WHERE s.id = ? AND s.user_id = ?))`;
const SET_FIRST_DEFAULT = 'UPDATE users SET default_resume_id = ?, updated_at = ? WHERE id = ? AND default_resume_id IS NULL';

/** The new row's values, in INSERT_RESUME's order. */
function insertValues(id: string, userId: string, input: NewResume, data: string | null, now: string) {
  return [
    id,
    userId,
    input.kind,
    input.title ?? null,
    input.document?.preferredTemplate || null,
    data,
    input.fileId ?? null,
    input.extractedText ?? null,
    input.sourceResumeId ?? null,
    now,
    now,
    input.kind === 'uploaded' ? 'upload' : (input.madeBy ?? 'editor'), // v1.5 W
    input.fieldFrom ?? input.sourceResumeId ?? null, // v33 ROLES
    userId, // v33 ROLES
  ];
}

/** What the reading reads of a new resume: exactly what was stored (the stored document is normalised again on read). */
function newTarget(id: string, userId: string, input: NewResume, data: string | null) {
  return {
    id,
    userId,
    subject:
      input.kind === 'uploaded'
        ? { kind: 'uploaded' as const, text: input.extractedText ?? null }
        : { kind: 'built' as const, document: storedDocumentOf({ kind: 'built', data }) ?? normalizeResumeDocument({}) },
  };
}

/**
 * Stores a resume and, when the account has no default resume yet, makes it the default, then stores what TailorIT
 * read from it (best effort). Returns the new id. Inside a caller's transaction it is a savepoint of it; else a
 * transaction of its own. Refused as assertRoomForResumes refuses (the plan's limit, 403; the safety cap, 409), so
 * a path with no early check is still covered.
 *
 * v3.0 D2 (the concurrency audit, 11-database.md §9.3): the limit counts, then inserts. The count and the insert run
 * behind the person's lock (`lockPerson`, the first statement), so two creates at once can never both pass at the
 * limit: a no-op on SQLite, whose one writer already serialises them; the person's user_counters row FOR UPDATE on
 * PostgreSQL.
 */
export async function insertResume(deps: AppDeps, userId: string, input: NewResume): Promise<string> {
  const id = randomUUID();
  const now = nowIso(deps);
  // v33 LEGACY: stored as the editor opens it (an editor document stays as it is).
  const document = input.document ? await editorDocumentOf(deps, userId, input.document) : null;
  const data = document ? JSON.stringify(document) : null;
  await deps.db.atomic(
    async (t) => {
      await t.lockPerson(userId);
      await assertRoomForResumes(deps, userId, 1, input.payer); // v33 SHARE-3 (review): and B's reserve, behind the lock
      await t.run(INSERT_RESUME, insertValues(id, userId, input, data, now));
      await t.run(SET_FIRST_DEFAULT, [id, now, userId]);
      await analyzeAfterWrite(deps, newTarget(id, userId, input, data), { aiRefine: input.aiRefine });
    },
    { label: 'insertResume' },
  );
  return id;
}

/**
 * PUT /api/resumes/:id: a built resume's new document (and title, when given), with what TailorIT reads from it. The
 * reading is stored again only when what it reads changed. Joins the caller's transaction when there is one.
 */
export const REVISION_CONFLICT_MESSAGE =
  'This resume was saved from another tab or window since you opened it. Load the latest version to keep editing.';

const SELECT_REVISION = "SELECT data, document_revision FROM resumes WHERE id = ? AND user_id = ? AND kind = 'built'";
const UPDATE_DOCUMENT = `UPDATE resumes SET data = ?, template_id = ?, title = CASE WHEN ? THEN ? ELSE title END, updated_at = ?,
           last_edited_at = ?, document_revision = ? WHERE id = ? AND user_id = ? AND kind = 'built'`;

/** UPDATE_DOCUMENT's values. `?` of the CASE is a flag: d.bool keeps it a boolean where the engine wants one. */
function updateValues(
  deps: Pick<AppDeps, 'db'>,
  id: string,
  userId: string,
  document: ResumeDocument,
  data: string,
  title: string | null | undefined,
  now: string,
  documentRevision: number,
) {
  return [data, document.preferredTemplate || null, deps.db.dialect.bool(title !== undefined), title ?? null, now, now, documentRevision, id, userId];
}

/**
 * Stores a built resume's document. With `baseRevision` (the on-page editor's autosave) the save applies only to
 * that revision of the document (409 `revision_conflict` otherwise) and the resume is read once the saves pause;
 * without it the save always applies and the resume is read at once. The revision moves only when the document does.
 */
export async function updateResumeDocument(
  deps: AppDeps,
  userId: string,
  id: string,
  document: ResumeDocument,
  title?: string | null,
  options: { baseRevision?: number } = {},
): Promise<{ analysisChanged: boolean; documentRevision: number }> {
  const now = nowIso(deps);
  // v33 LEGACY: stored as the editor opens it (an editor document stays as it is).
  const upgraded = await editorDocumentOf(deps, userId, document);
  const data = JSON.stringify(upgraded);
  const outcome = await deps.db.atomic(
    async (t) => {
      const current = await t.one<{ data: string | null; document_revision: number }>(SELECT_REVISION, [id, userId]);
      if (!current) return { analysisChanged: false, documentRevision: 0, changedData: false };
      if (options.baseRevision !== undefined && options.baseRevision !== current.document_revision) {
        throw new AppError('revision_conflict', REVISION_CONFLICT_MESSAGE);
      }
      const changedData = current.data !== data;
      const documentRevision = current.document_revision + (changedData ? 1 : 0);
      await t.run(UPDATE_DOCUMENT, updateValues(deps, id, userId, upgraded, data, title, now, documentRevision));
      if (options.baseRevision !== undefined) return { analysisChanged: false, documentRevision, changedData };
      const stored = storedDocumentOf({ kind: 'built', data }) ?? normalizeResumeDocument({});
      const analysisChanged = await analyzeAfterWrite(deps, { id, userId, subject: { kind: 'built', document: stored } });
      return { analysisChanged, documentRevision, changedData };
    },
    { label: 'updateResumeDocument' },
  );
  // The editor's autosave: read once its saves pause (a timer, set after the write).
  if (options.baseRevision !== undefined && outcome.changedData) scheduleResumeAnalysis(deps, id);
  return { analysisChanged: outcome.analysisChanged, documentRevision: outcome.documentRevision };
}

const SELECT_FILE_OF = 'SELECT file_id FROM resumes WHERE id = ? AND user_id = ?';
const DELETE_RESUME = 'DELETE FROM resumes WHERE id = ? AND user_id = ?';
const SELECT_NEWEST = 'SELECT id FROM resumes WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC, id ASC LIMIT 1';
const SET_DEFAULT = 'UPDATE users SET default_resume_id = ?, updated_at = ? WHERE id = ?';

/**
 * Deletes one of the account's resumes. When it was the default, the newest remaining resume becomes the default
 * (none left: no default). Returns the stored file to remove and the default after, or null when it is not theirs.
 */
export async function deleteResumeRow(
  deps: AppDeps,
  userId: string,
  id: string,
): Promise<{ fileId: string | null; defaultResumeId: string | null } | null> {
  return deps.db.atomic(
    async (t) => {
      const row = await t.one<{ file_id: string | null }>(SELECT_FILE_OF, [id, userId]);
      if (!row) return null;
      const wasDefault = (await defaultResumeId(deps, userId)) === id;
      await t.run(DELETE_RESUME, [id, userId]);
      let next = await defaultResumeId(deps, userId);
      if (wasDefault) {
        next = (await t.one<{ id: string }>(SELECT_NEWEST, [userId]))?.id ?? null;
        await t.run(SET_DEFAULT, [next, nowIso(deps), userId]);
      }
      return { fileId: row.file_id, defaultResumeId: next };
    },
    { label: 'deleteResumeRow' },
  );
}
