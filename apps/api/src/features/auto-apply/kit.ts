import { htmlToText, resumeLabel, type PreparedKit, type PrepareResumeMode } from '@tailorit/shared';
import { AutofillSubmittedAnswerValueSchema, type AutofillSubmittedAnswerValue } from '@tailorit/shared/autofill';
import type { AppDeps } from '../../core/context';
import { notFound } from '../../core/http/errors';
import { textIsSensitive } from '../autofill/ai/statements';
import { screenAnswer } from '../autofill/answers/screen';
import { documentOf } from '../resumes/repository';

// v2.0: the manual flow's copy-ready kit (GET /api/auto-apply/items/:queueId/kit; 05-prepare-flow.md, "Read models for
// the web"; 08-ui.md, "The manual flow: the kit sheet"). The queued kit is frozen (A30): the row's resume, the draft's
// letter and the draft's ready answers, written from that resume (A29). A row queued before v2.0 (no Prepare) shows the
// Tracker entry's resume and letter. Never a sensitive answer: a file question, and any question or answer the saved
// answers' screens call sensitive, consent or an attention check, is left out (the profile fills those).

interface KitRow {
  id: string;
  job_id: number;
  application_id: string | null;
  prepare_id: string | null;
  resume_id: string | null;
  apply_url: string;
  resume_mode: PrepareResumeMode | null;
}

interface AnswerRow {
  label: string;
  question_key: string;
  field_kind: string;
  /** A flag: 0/1 on SQLite, a boolean on PostgreSQL. */
  required: number | boolean;
  answer: string;
}

function parsed(text: string): AutofillSubmittedAnswerValue | null {
  try {
    const value = AutofillSubmittedAnswerValueSchema.safeParse(JSON.parse(text));
    return value.success ? value.data : null;
  } catch {
    return null;
  }
}

/** An answer as the person copies it: its text, the options chosen, or Yes / No. */
function answerTextOf(value: AutofillSubmittedAnswerValue): string | null {
  switch (value.kind) {
    case 'text':
      return value.text;
    case 'options':
      return value.labels.join(', ');
    case 'checked':
      return value.checked ? 'Yes' : 'No';
    case 'file':
      return null;
  }
}

/** True when the kit may show this answer: never a file, nor anything a screen calls sensitive. */
function shown(row: AnswerRow, value: AutofillSubmittedAnswerValue): boolean {
  if (row.field_kind === 'file' || value.kind === 'file') return false;
  if (screenAnswer({ category: null, questionKey: row.question_key, questionLabel: row.label, answer: value }) !== null) {
    return false;
  }
  const words = value.kind === 'text' ? [value.text] : value.kind === 'options' ? value.labels : [];
  return !words.some((word) => textIsSensitive(word));
}

interface ResumeRow {
  id: string;
  title: string | null;
  kind: 'built' | 'uploaded';
  data: string | null;
  file_name: string | null;
}

/**
 * The kit's resume as the Resumes tab names it (v2.0 FIX-B): its custom title, else a built resume's own label or an
 * upload's file name. A resume never renamed has no stored title, and the kit's contract needs words.
 */
function resumeTitleOf(row: ResumeRow): string {
  const custom = row.title?.trim() || null;
  if (row.kind === 'built') return resumeLabel(documentOf(row), custom);
  return custom || (row.file_name ?? '').replace(/\.(pdf|docx?)$/i, '').trim() || 'Uploaded resume';
}

/** GET /api/auto-apply/items/:queueId/kit (v3.0 D2: async on deps.db). */
export async function preparedKit(deps: Pick<AppDeps, 'db'>, userId: string, queueId: string): Promise<PreparedKit> {
  const db = deps.db;
  const row = await db.one<KitRow>(
    `SELECT q.id, q.job_id, q.application_id, q.prepare_id, q.resume_id, j.apply_url, p.resume_mode
     FROM autofill_agent_queue q JOIN jobs j ON j.id = q.job_id LEFT JOIN prepare_jobs p ON p.id = q.prepare_id
     WHERE q.id = ? AND q.user_id = ?`,
    [queueId, userId],
  );
  if (!row) throw notFound('That auto-apply job');
  // The row's entry (its application_id), or for a row queued before v2.0 (none), the entry of its job. Chosen here,
  // not by a NULL test of a bound value in SQL (PostgreSQL cannot type one).
  type Entry = { id: string; resume_id: string | null; cover_letter_id: string | null };
  const entry =
    row.application_id !== null
      ? await db.one<Entry>('SELECT id, resume_id, cover_letter_id FROM applications WHERE user_id = ? AND id = ?', [
          userId,
          row.application_id,
        ])
      : await db.one<Entry>('SELECT id, resume_id, cover_letter_id FROM applications WHERE user_id = ? AND job_id = ?', [
          userId,
          row.job_id,
        ]);
  const draft = entry
    ? await db.one<{ id: string; cover_letter_id: string | null }>(
        'SELECT id, cover_letter_id FROM application_drafts WHERE application_id = ? AND user_id = ?',
        [entry.id, userId],
      )
    : undefined;
  const kit = row.prepare_id !== null;

  const resumeId = (kit ? row.resume_id : null) ?? entry?.resume_id ?? row.resume_id;
  const resume = resumeId
    ? await db.one<ResumeRow>(
        `SELECT r.id, r.title, r.kind, r.data, f.original_name AS file_name
         FROM resumes r LEFT JOIN stored_files f ON f.id = r.file_id AND f.user_id = r.user_id
         WHERE r.id = ? AND r.user_id = ?`,
        [resumeId, userId],
      )
    : undefined;

  // v2.0 FIX-B (BEH-2): a kit with no letter shows none, never the entry's (an earlier kit's, from another resume).
  const letterId = kit ? (draft?.cover_letter_id ?? null) : (entry?.cover_letter_id ?? null);
  const letter = letterId
    ? await db.one<{ id: string; title: string; content_html: string }>(
        'SELECT id, title, content_html FROM cover_letters WHERE id = ? AND user_id = ?',
        [letterId, userId],
      )
    : undefined;

  const answers = draft
    ? await db.all<AnswerRow>(
        `SELECT q.label, q.question_key, q.field_kind, q.required, a.answer
         FROM application_draft_answers a JOIN job_form_questions q ON q.id = a.question_id
         WHERE a.draft_id = ? AND a.status = 'ready' AND a.answer IS NOT NULL
         ORDER BY q.step, q.position, q.ordinal, q.id`,
        [draft.id],
      )
    : [];

  return {
    queueId: row.id,
    postingUrl: row.apply_url,
    resume: resume
      ? {
          id: resume.id,
          title: resumeTitleOf(resume),
          downloadUrl:
            resume.kind === 'uploaded'
              ? `/api/resumes/${encodeURIComponent(resume.id)}/file`
              : `/api/resumes/${encodeURIComponent(resume.id)}/export?format=pdf`,
          resumeMode: row.resume_mode,
        }
      : null,
    letter: letter
      ? {
          id: letter.id,
          title: letter.title,
          text: htmlToText(letter.content_html),
          downloadUrl: `/api/cover-letters/${encodeURIComponent(letter.id)}/export?format=pdf`,
        }
      : null,
    answers: answers.flatMap((answer) => {
      const value = parsed(answer.answer);
      const text = value && shown(answer, value) ? answerTextOf(value) : null;
      return text === null ? [] : [{ label: answer.label, answerText: text, required: Boolean(answer.required) }];
    }),
  };
}
