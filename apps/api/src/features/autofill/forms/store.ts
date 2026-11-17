import {
  AUTOFILL_FORM_LIMITS,
  AutofillKnownAnswerSchema,
  AutofillKnownQuestionSchema,
  AutofillSubmittedAnswerValueSchema,
  parseLinkedInJobUrl,
  type AutofillFieldCategory,
  type AutofillFieldKind,
  type AutofillFormFieldKey,
  type AutofillFormQuestion,
  type AutofillKnownAnswer,
  type AutofillKnownQuestion,
  type AutofillQuestionSource,
  type AutofillSubmissionAnswer,
  type AutofillSubmittedAnswerValue,
} from '@tailorit/shared/autofill';
import type { Dialect } from '../../../core/db/dialect';
import type { DbQueries, SqlParam } from '../../../core/db/types';
import { screenAnswer } from '../answers/screen';
import { postingIdentityOf, type PageReading } from '../lookup';

// The application forms' questions and the answers people submitted (TailorIT v1.3, migration 0811). The only module
// that touches job_forms, job_form_questions and application_form_answers. Questions are shared by every account and
// read by no Jobs route; answers are read for their own account only (every read below takes it). No value is logged.
//
// v3.0 D2: each function takes a handle of the async client (`deps.db`, or a transaction's `t`).

/** How a form is named (job_forms.form_key): the posting it is the form of, else the shared job it belongs to. */
export interface FormPlace {
  /** 'posting:<identity>', 'linkedin:<id>' or 'job:<id>'. */
  key: string;
  /** The shared job, when there is one (job_forms.job_id). */
  jobId: number | null;
  /** The ATS the form is on (lower case), when the page or the job names one. */
  platform: string | null;
}

export interface FormRow {
  id: number;
  form_key: string;
  job_id: number | null;
}

/**
 * The key a page names a form by: the employer's ATS posting, else the page's own, else its LinkedIn job; null for a
 * page that names no posting (a careers page's own address, which two jobs may share).
 */
export function pageFormKey(page: PageReading): { key: string; platform: string | null } | null {
  const ats = page.employer?.ats ?? page.ats;
  const posting = postingIdentityOf(ats?.canonical[0]);
  if (ats && posting) return { key: `posting:${posting}`, platform: ats.kind };
  if (page.linkedIn) return { key: `linkedin:${page.linkedIn.jobId}`, platform: null };
  return null;
}

/** The statements of this module. */
export const FORM_SQL = {
  // v3.0 DB-INGEST: a job's stored link is one of its `link` keys (job_keys) where v2.0 read jobs.link_key.
  jobOfForm: `SELECT made_from, apply_url,
       (SELECT k.key FROM job_keys k WHERE k.job_id = jobs.id AND k.key_kind = 'link' ORDER BY k.key LIMIT 1) AS link_key
     FROM jobs WHERE id = ?`,
  shared: 'SELECT 1 FROM jobs WHERE id = ? AND owner_user_id IS NULL',
  formByJob: 'SELECT id, form_key, job_id FROM job_forms WHERE job_id = ?',
  formByKey: 'SELECT id, form_key, job_id FROM job_forms WHERE form_key = ?',
  attach: 'UPDATE job_forms SET job_id = ?, updated_at = ? WHERE id = ?',
  keyTaken: 'SELECT 1 FROM job_forms WHERE form_key = ?',
  insertForm: `INSERT INTO job_forms(form_key, job_id, platform, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     RETURNING id`,
  questionCount: 'SELECT count(*) AS n FROM job_form_questions WHERE form_id = ?',
  touchForm: 'UPDATE job_forms SET updated_at = ? WHERE id = ?',
  questions: `SELECT id, question_key, option_set_hash, label, field_kind, options, section, required, step, position, source,
         first_seen_at, last_seen_at
       FROM job_form_questions WHERE form_id = ? ORDER BY step, position, id LIMIT ?`,
  submitted: `SELECT q.id, q.label, q.section, q.step, q.position, q.required, q.field_kind, a.answer, a.submitted_at
       FROM application_form_answers a JOIN job_form_questions q ON q.id = a.question_id
       WHERE a.user_id = ? AND a.application_id = ? ORDER BY q.step, q.position, q.id`,
} as const;

/** A job's row as jobFormKey reads it. */
export type JobOfForm = { made_from: string | null; apply_url: string; link_key: string | null };

/** jobFormKey's answer from the job's row (or none). */
export function formKeyOfJob(job: JobOfForm | undefined, jobId: number): { key: string; platform: string | null } {
  const posting = job ? (job.made_from ?? postingIdentityOf(job.apply_url) ?? postingIdentityOf(job.link_key)) : null;
  if (posting) return { key: `posting:${posting}`, platform: posting.slice(0, posting.indexOf('|')) || null };
  const linkedIn = job ? parseLinkedInJobUrl(job.apply_url) : null;
  if (linkedIn) return { key: `linkedin:${linkedIn.jobId}`, platform: null };
  return { key: `job:${jobId}`, platform: null };
}

/** The key a job names its form by: the ATS posting it was made from or links to, its LinkedIn job, else its id. */
export async function jobFormKey(db: DbQueries, jobId: number): Promise<{ key: string; platform: string | null }> {
  return formKeyOfJob(await db.one<JobOfForm>(FORM_SQL.jobOfForm, [jobId]), jobId);
}

/** Whether a job is shared (in the lake): only a shared job is a form's job. */
async function isShared(db: DbQueries, jobId: number): Promise<boolean> {
  return (await db.one(FORM_SQL.shared, [jobId])) !== undefined;
}

/**
 * Where a form of this job and page is kept. A shared job's form is the one it has, else the one its posting names
 * (the job named by its id: its own posting; else the page's, then the job's): a form kept under the posting before
 * TailorIT shared a job of it (an entry added by hand, Greenhouse's questions) joins the job. With no shared job, the
 * page's posting, else the posting the person's own page job names (never its id: such a job keeps no form); null
 * when none names one.
 */
export async function formPlace(db: DbQueries, jobId: number | null, page: PageReading | null): Promise<FormPlace | null> {
  const shared = jobId !== null && (await isShared(db, jobId)) ? jobId : null;
  const named = page ? pageFormKey(page) : null;
  if (shared === null) {
    const ownPosting = named === null && jobId !== null ? await jobFormKey(db, jobId) : null;
    return placeOfOwn(named, ownPosting);
  }
  return placeOfShared(shared, named, await jobFormKey(db, shared));
}

type FormKey = { key: string; platform: string | null };

/** formPlace's answer with no shared job: the page's posting, else the person's own page job's posting. */
export function placeOfOwn(named: FormKey | null, ownPosting: FormKey | null): FormPlace | null {
  const key = named ?? (ownPosting && !ownPosting.key.startsWith('job:') ? ownPosting : null);
  return key ? { ...key, jobId: null } : null;
}

/** formPlace's answer for a shared job. */
export function placeOfShared(shared: number, named: FormKey | null, own: FormKey): FormPlace {
  const chosen = named ?? own;
  return { key: chosen.key, jobId: shared, platform: chosen.platform ?? own.platform };
}

/** Whether the form a place's key found may be that place's: not when another job already holds it. */
export const keyFormFits = (place: FormPlace, byKey: FormRow | undefined): byKey is FormRow =>
  byKey !== undefined && !(place.jobId !== null && byKey.job_id !== null && byKey.job_id !== place.jobId);

/** The form kept for a job (by its job, else its posting), or null. Read-only. */
export async function findForm(db: DbQueries, place: FormPlace): Promise<FormRow | null> {
  if (place.jobId !== null) {
    const byJob = await db.one<FormRow>(FORM_SQL.formByJob, [place.jobId]);
    if (byJob) return byJob;
  }
  const byKey = await db.one<FormRow>(FORM_SQL.formByKey, [place.key]);
  // A posting's form that another job already holds is that job's, not this one's.
  return keyFormFits(place, byKey) ? byKey : null;
}

/**
 * The form to keep questions in: the one there is (attached to the shared job when it had none), else a new one,
 * named by the place's key, or by the job's id when another job holds that key.
 */
export async function openForm(db: DbQueries, place: FormPlace, source: AutofillQuestionSource, now: string): Promise<FormRow> {
  const found = await findForm(db, place);
  if (found) {
    if (found.job_id === null && place.jobId !== null) {
      await db.run(FORM_SQL.attach, [place.jobId, now, found.id]);
      return { ...found, job_id: place.jobId };
    }
    return found;
  }
  const taken = (await db.one(FORM_SQL.keyTaken, [place.key])) !== undefined;
  const key = taken && place.jobId !== null ? `job:${place.jobId}` : place.key;
  const { id } = (await db.one<{ id: number }>(FORM_SQL.insertForm, [key, place.jobId, place.platform, source, now, now]))!;
  return { id, form_key: key, job_id: place.jobId };
}

/** How many questions a form keeps. */
export async function questionCount(db: DbQueries, formId: number): Promise<number> {
  return (await db.one<{ n: number }>(FORM_SQL.questionCount, [formId]))!.n;
}

/** Whether TailorIT keeps questions for the place's form (the lookup's `formKnown`). */
export async function formKnown(db: DbQueries, place: FormPlace | null): Promise<boolean> {
  const form = place ? await findForm(db, place) : null;
  return form !== null && (await questionCount(db, form.id)) > 0;
}

/**
 * TailorIT's own folding of a label (job_form_questions.label_key): compatibility forms folded, lower case, its
 * parentheticals and its punctuation as spaces. It only pairs a question an ATS API gave with the same question a
 * submission names; the extension's own key (its normalizeLabel) is the question's key.
 */
export function labelKeyOf(label: string): string {
  return label
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\([^()]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 500);
}

/** The kinds a question an ATS API names may be seen as on the page, by family. */
const KIND_FAMILY: Record<AutofillFieldKind, string> = {
  text: 'typed',
  textarea: 'typed',
  date: 'date',
  select: 'choice',
  radio: 'choice',
  combobox: 'choice',
  'typeahead-remote': 'choice',
  'checkbox-group': 'choices',
  multiselect: 'choices',
  checkbox: 'checkbox',
  file: 'file',
};

/** A question as the form asked it, with its ordinal among the questions it asks alike in one section. */
interface Asked {
  question: AutofillFormQuestion;
  ordinal: number;
}

/** The body's questions in form order (step, then position), each with its ordinal. */
function inFormOrder(questions: readonly AutofillFormQuestion[]): Asked[] {
  const counts = new Map<string, number>();
  return [...questions]
    .sort((a, b) => a.step - b.step || a.position - b.position)
    .map((question) => {
      const alike = `${question.section}\n${question.questionKey}\n${question.optionSetHash}`;
      const ordinal = counts.get(alike) ?? 0;
      counts.set(alike, ordinal + 1);
      return { question, ordinal };
    });
}

/**
 * Keeps a submission's questions in the form: a question it asked before is refreshed (label, options, place, required
 * mark, last_seen_at); one an ATS API gave (the same label folded, the same family of field) is taken over with the
 * extension's key and option set; any other is added, while the form keeps fewer than AUTOFILL_FORM_LIMITS
 * .storedQuestions. Nothing is deleted. Answers each kept question's id by its `ref`, and how many were added.
 */
export async function keepQuestions(
  db: DbQueries,
  formId: number,
  questions: readonly AutofillFormQuestion[],
  now: string,
): Promise<{ ids: Map<string, number>; added: number }> {
  const ids = new Map<string, number>();
  let added = 0;
  let stored = await questionCount(db, formId);
  const same = `SELECT id FROM job_form_questions
     WHERE form_id = ? AND section = ? AND question_key = ? AND option_set_hash = ? AND ordinal = ?`;
  const fromApi = `SELECT id, field_kind FROM job_form_questions WHERE form_id = ? AND source = 'ats-api' AND label_key = ?
     ORDER BY step, position, id`;
  const refresh = `UPDATE job_form_questions SET question_key = ?, option_set_hash = ?, ordinal = ?, section = ?, label_key = ?,
       field_kind = ?, label = ?, options = ?, required = ?, step = ?, position = ?, source = 'submission', last_seen_at = ?
     WHERE id = ?`;
  const insert = `INSERT INTO job_form_questions(form_id, question_key, option_set_hash, ordinal, section, label_key, field_kind, label,
       options, required, step, position, source, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submission', ?, ?) RETURNING id`;
  for (const { question, ordinal } of inFormOrder(questions)) {
    const labelKey = labelKeyOf(question.label);
    const values = [
      question.questionKey,
      question.optionSetHash,
      ordinal,
      question.section,
      labelKey,
      question.kind,
      question.label,
      JSON.stringify(question.options),
      db.dialect.bool(question.required),
      question.step,
      question.position,
    ] as const;
    const existing = await db.one<{ id: number }>(same, [
      formId,
      question.section,
      question.questionKey,
      question.optionSetHash,
      ordinal,
    ]);
    const taken = new Set(ids.values());
    const apiRow = existing
      ? undefined
      : (await db.all<{ id: number; field_kind: AutofillFieldKind }>(fromApi, [formId, labelKey])).find(
          (row) => !taken.has(row.id) && KIND_FAMILY[row.field_kind] === KIND_FAMILY[question.kind],
        );
    const target = existing?.id ?? apiRow?.id;
    if (target !== undefined) {
      await db.run(refresh, [...values, now, target]);
      ids.set(question.ref, target);
    } else if (stored < AUTOFILL_FORM_LIMITS.storedQuestions) {
      const { id } = (await db.one<{ id: number }>(insert, [formId, ...values, now, now]))!;
      ids.set(question.ref, id);
      added += 1;
      stored += 1;
    }
  }
  if (questions.length > 0) await db.run(FORM_SQL.touchForm, [now, formId]);
  return { ids, added };
}

/** A question an ATS API names (Greenhouse's board API), as forms/greenhouse.ts reads it. */
export interface ApiQuestion {
  label: string;
  kind: AutofillFieldKind;
  options: string[];
  section: string;
  required: boolean;
}

/**
 * Keeps the questions an ATS API gave for a form that has none yet (source 'ats-api'): TailorIT's folding of the label
 * as the key, no option set (the extension never saw the options), in the API's order. A form with questions is left
 * as it is. Answers how many were kept.
 */
/**
 * keepApiQuestions' insert: a question a row of the form holds already is skipped
 * (insert-or-ignore; every value fits the table's checks, clipped below).
 */
export function apiQuestionInsertSql(d: Dialect): string {
  return d.insertOrIgnore(`job_form_questions(form_id, question_key, option_set_hash, ordinal, label_key, field_kind,
       label, options, section, required, step, position, source, first_seen_at, last_seen_at)
     VALUES (?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, 0, ?, 'ats-api', ?, ?)`);
}

/** The values keepApiQuestions binds for each question (in the API's order, at most storedQuestions). */
export function apiQuestionRows(d: Dialect, formId: number, questions: readonly ApiQuestion[], now: string): SqlParam[][] {
  return questions.slice(0, AUTOFILL_FORM_LIMITS.storedQuestions).map((question, position) => {
    const labelKey = labelKeyOf(question.label);
    const key = (labelKey || question.label.toLowerCase()).slice(0, 300);
    const label = question.label.slice(0, AUTOFILL_FORM_LIMITS.label);
    const options = question.options
      .map((option) => option.slice(0, AUTOFILL_FORM_LIMITS.optionLabel))
      .filter((option) => option !== '')
      .slice(0, AUTOFILL_FORM_LIMITS.options);
    return [
      formId,
      key,
      labelKey,
      question.kind,
      label,
      JSON.stringify(options),
      question.section.slice(0, AUTOFILL_FORM_LIMITS.section),
      d.bool(question.required),
      Math.min(position, AUTOFILL_FORM_LIMITS.position),
      now,
      now,
    ];
  });
}

export async function keepApiQuestions(
  db: DbQueries,
  formId: number,
  questions: readonly ApiQuestion[],
  now: string,
): Promise<number> {
  if ((await questionCount(db, formId)) > 0) return 0;
  const insert = apiQuestionInsertSql(db.dialect);
  let kept = 0;
  for (const values of apiQuestionRows(db.dialect, formId, questions, now)) kept += (await db.run(insert, values)).changes;
  await db.run(FORM_SQL.touchForm, [now, formId]);
  return kept;
}

/** A file's name alone: anything up to its last folder separator dropped. */
function bareName(answer: AutofillSubmittedAnswerValue): AutofillSubmittedAnswerValue {
  if (answer.kind !== 'file') return answer;
  return { kind: 'file', fileName: answer.fileName.split(/[/\\]/).pop()!.trim() || answer.fileName };
}

/**
 * Replaces the account's answers kept for one application by a submission's: a row for each question kept from the
 * body (`ids`), with its answer, or none (NULL) for a question left empty. Answers how many answers were kept.
 */
export async function replaceAnswers(
  db: DbQueries,
  userId: string,
  applicationId: string,
  questions: readonly AutofillFormQuestion[],
  ids: ReadonlyMap<string, number>,
  answers: readonly AutofillSubmissionAnswer[],
  now: string,
): Promise<number> {
  await db.run('DELETE FROM application_form_answers WHERE user_id = ? AND application_id = ?', [userId, applicationId]);
  const byRef = new Map(answers.map((item) => [item.ref, item]));
  // Two of the body's questions kept as one row answer once (insert-or-ignore); every value fits the table's checks.
  const insert = db.dialect.insertOrIgnore(
    `application_form_answers(user_id, application_id, question_id, answer, category, provenance,
       submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let kept = 0;
  for (const question of questions) {
    const id = ids.get(question.ref);
    if (id === undefined) continue;
    const item = byRef.get(question.ref);
    const answer = item ? JSON.stringify(bareName(item.answer)) : null;
    const { changes } = await db.run(insert, [userId, applicationId, id, answer, question.category, item?.provenance ?? null, now]);
    if (changes > 0 && answer !== null) kept += 1;
  }
  return kept;
}

export interface QuestionRow {
  id: number;
  question_key: string;
  option_set_hash: string | null;
  label: string;
  field_kind: AutofillFieldKind;
  options: string;
  section: string;
  required: number | boolean;
  step: number;
  position: number;
  source: AutofillQuestionSource;
  first_seen_at: string;
  last_seen_at: string;
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function questionOf(d: Dialect, row: QuestionRow): AutofillKnownQuestion | null {
  const parsed = AutofillKnownQuestionSchema.safeParse({
    id: row.id,
    questionKey: row.question_key,
    label: row.label,
    kind: row.field_kind,
    options: parseJson(row.options),
    optionSetHash: row.option_set_hash,
    section: row.section,
    required: d.isTrue(row.required),
    step: row.step,
    position: row.position,
    source: row.source,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  });
  return parsed.success ? parsed.data : null;
}

/** A form's question rows as the contract has them (a row that no longer reads is dropped). */
export function questionsOfRows(d: Dialect, rows: readonly QuestionRow[]): AutofillKnownQuestion[] {
  return rows.map((row) => questionOf(d, row)).filter((question): question is AutofillKnownQuestion => question !== null);
}

/** A form's questions in form order (step, position), each as the contract has it (a row that no longer reads is dropped). */
export async function formQuestions(db: DbQueries, formId: number): Promise<AutofillKnownQuestion[]> {
  return questionsOfRows(db.dialect, await db.all<QuestionRow>(FORM_SQL.questions, [formId, AUTOFILL_FORM_LIMITS.storedQuestions]));
}

interface AnswerRow {
  question_id: number;
  question_key: string;
  option_set_hash: string | null;
  label: string;
  field_kind: AutofillFieldKind;
  answer: string;
  category: string | null;
  submitted_at: string;
}

/** What the known-form answer may hold of the account's answers: any (`answers`), and the sensitive same-job ones. */
export interface AnswerReach {
  answers: boolean;
  sensitive: boolean;
}

/** An answer row as the contract has it, or null when it no longer reads. */
function knownAnswerOf(row: AnswerRow, match: AutofillKnownAnswer['match']): AutofillKnownAnswer | null {
  const parsed = AutofillKnownAnswerSchema.safeParse({
    match,
    questionId: match === 'sameJob' ? row.question_id : null,
    questionKey: row.question_key,
    optionSetHash: row.option_set_hash ?? '',
    questionLabel: row.label,
    fieldKind: row.field_kind,
    answer: parseJson(row.answer),
    submittedAt: row.submitted_at,
  });
  return parsed.success ? parsed.data : null;
}

/** What the screen finds for an answer row (ai/screen's terms, the stored category). */
function screenOf(row: AnswerRow, answer: AutofillSubmittedAnswerValue) {
  const category = (row.category ?? null) as AutofillFieldCategory | null;
  return screenAnswer({ category, questionKey: row.question_key, questionLabel: row.label, answer });
}

const ANSWER_COLUMNS = `a.question_id, q.question_key, q.option_set_hash, q.label, q.field_kind, a.answer, a.category,
  a.submitted_at`;

/**
 * The account's earlier answers for a form (POST /api/autofill/forms/known):
 * - `sameJob`: their latest answer to each of the form's questions (any of their applications kept under it), but never
 *   to an attention check or a consent question (the person's own each time), and to a self-identification, legal or
 *   pay question only when `reach.sensitive`;
 * - `otherJob`: for each question key and option set the form asks (as the extension keys it) or `fields` names, and
 *   the form's questions answered no other way, their latest answer on another form, never a file and never one the
 *   screen finds anything in.
 * None without `reach.answers`. Only ever the account's own rows.
 */
export async function knownAnswers(
  db: DbQueries,
  userId: string,
  formId: number | null,
  questions: readonly AutofillKnownQuestion[],
  fields: readonly AutofillFormFieldKey[],
  reach: AnswerReach,
): Promise<AutofillKnownAnswer[]> {
  if (!reach.answers) return [];
  const answers: AutofillKnownAnswer[] = [];
  const answeredKeys = new Set<string>();
  const keyOf = (questionKey: string, optionSetHash: string) => `${questionKey}\n${optionSetHash}`;
  if (formId !== null) {
    const rows = await db.all<AnswerRow>(
      `SELECT ${ANSWER_COLUMNS} FROM application_form_answers a JOIN job_form_questions q ON q.id = a.question_id
       WHERE a.user_id = ? AND q.form_id = ? AND a.answer IS NOT NULL
       ORDER BY q.step, q.position, q.id, a.submitted_at DESC, a.id DESC`,
      [userId, formId],
    );
    const seen = new Set<number>();
    for (const row of rows) {
      if (seen.has(row.question_id)) continue;
      seen.add(row.question_id);
      const known = knownAnswerOf(row, 'sameJob');
      if (!known) continue;
      const screen = screenOf(row, known.answer);
      if (screen === 'attention_check' || screen === 'consent' || (screen === 'sensitive' && !reach.sensitive)) continue;
      answers.push(known);
      if (row.option_set_hash !== null) answeredKeys.add(keyOf(row.question_key, row.option_set_hash));
    }
  }
  const wanted = new Map<string, AutofillFormFieldKey>();
  for (const question of questions) {
    if (question.source === 'submission' && question.optionSetHash !== null) {
      wanted.set(keyOf(question.questionKey, question.optionSetHash), {
        questionKey: question.questionKey,
        optionSetHash: question.optionSetHash,
      });
    }
  }
  for (const field of fields) wanted.set(keyOf(field.questionKey, field.optionSetHash), field);
  const elsewhere = `SELECT ${ANSWER_COLUMNS} FROM application_form_answers a JOIN job_form_questions q ON q.id = a.question_id
     WHERE a.user_id = ? AND q.question_key = ? AND q.option_set_hash = ? AND q.form_id <> ? AND a.answer IS NOT NULL
     ORDER BY a.submitted_at DESC, a.id DESC LIMIT 5`;
  for (const [key, field] of wanted) {
    if (answeredKeys.has(key)) continue;
    const rows = await db.all<AnswerRow>(elsewhere, [userId, field.questionKey, field.optionSetHash, formId ?? -1]);
    for (const row of rows) {
      const known = knownAnswerOf(row, 'otherJob');
      if (!known || known.answer.kind === 'file' || screenOf(row, known.answer) !== null) continue;
      answers.push(known);
      break;
    }
  }
  return answers;
}

/** One question of an application's latest submission, with the account's answer (null: left empty). */
export interface SubmittedRow {
  questionId: number;
  label: string;
  section: string;
  step: number;
  position: number;
  required: boolean;
  kind: AutofillFieldKind;
  answer: AutofillSubmittedAnswerValue | null;
  submittedAt: string;
}

/**
 * The account's kept answers for one of its applications, in form order (step, position): the Tracker's "Submitted
 * answers" tab. The caller has checked the application is the account's.
 */
export async function submittedRows(db: DbQueries, userId: string, applicationId: string): Promise<SubmittedRow[]> {
  return submittedOfRows(db.dialect, await db.all<SubmittedDbRow>(FORM_SQL.submitted, [userId, applicationId]));
}

/** A row of the submitted answers' statement. */
export interface SubmittedDbRow {
  id: number;
  label: string;
  section: string;
  step: number;
  position: number;
  required: number | boolean;
  field_kind: AutofillFieldKind;
  answer: string | null;
  submitted_at: string;
}

/** The submitted answers' rows as the Tracker's tab has them. */
export function submittedOfRows(d: Dialect, rows: readonly SubmittedDbRow[]): SubmittedRow[] {
  return rows.map((row) => {
    const parsed = row.answer === null ? null : AutofillSubmittedAnswerValueSchema.safeParse(parseJson(row.answer));
    return {
      questionId: row.id,
      label: row.label,
      section: row.section,
      step: row.step,
      position: row.position,
      required: d.isTrue(row.required),
      kind: row.field_kind,
      answer: parsed?.success ? parsed.data : null,
      submittedAt: row.submitted_at,
    };
  });
}
