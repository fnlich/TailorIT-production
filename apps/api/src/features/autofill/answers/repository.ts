import { randomUUID } from 'node:crypto';
import {
  AUTOFILL_SAVED_ANSWER_LIMITS,
  AutofillSavedAnswerSchema,
  type AutofillSavedAnswer,
  type PutAutofillSavedAnswerBody,
} from '@tailorit/shared/autofill';
import { nowIso, type AppDeps } from '../../../core/context';
import { notFound } from '../../../core/http/errors';
import { refuse } from '../../../core/http/refuse';

// The saved answers' rows (autofill_saved_answers, 0803): one per account and key (question key, option set, scope).
// No other file touches the table. Reads drop a row that no longer passes the contract (an older or newer TailorIT
// wrote it), so the list always parses; every write passed the contract's PUT schema in the router first. v3.0 D2: a
// save counts the account's answers, then inserts one, so its transaction starts with the person's lock (11 §9.3).

const LIMIT = AUTOFILL_SAVED_ANSWER_LIMITS.perAccount;
const NOT_FOUND = 'That saved answer';

interface AnswerRow {
  id: string;
  question_key: string;
  option_set_hash: string;
  scope: string;
  field_kind: string;
  question_label: string;
  platform: string | null;
  answer: string;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  'id, question_key, option_set_hash, scope, field_kind, question_label, platform, answer, created_at, updated_at';

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A row as the contract has it, or null when it no longer reads. */
function answerOf(row: AnswerRow): AutofillSavedAnswer | null {
  const parsed = AutofillSavedAnswerSchema.safeParse({
    id: row.id,
    questionKey: row.question_key,
    optionSetHash: row.option_set_hash,
    scope: row.scope,
    fieldKind: row.field_kind,
    questionLabel: row.question_label,
    platform: row.platform,
    answer: parseJson(row.answer),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return parsed.success ? parsed.data : null;
}

/** The account's saved answers, the latest saved first, and how many rows did not read (dropped). */
export async function listSavedAnswers(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
): Promise<{ items: AutofillSavedAnswer[]; unreadable: number }> {
  const rows = await deps.db.all<AnswerRow>(
    `SELECT ${COLUMNS} FROM autofill_saved_answers WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC, id`,
    [userId],
  );
  const items = rows.map(answerOf).filter((answer): answer is AutofillSavedAnswer => answer !== null);
  return { items, unreadable: rows.length - items.length };
}

/**
 * Saves `body` under its key for the account: a new row, or the one saved there before replaced (its id and
 * created_at kept). A new key past the account's limit is 409 `conflict`. Returns the answer as saved and whether it
 * was new.
 */
export async function saveSavedAnswer(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  userId: string,
  body: PutAutofillSavedAnswerBody,
): Promise<{ answer: AutofillSavedAnswer; created: boolean; total: number }> {
  const now = nowIso(deps);
  return deps.db.tx(
    async (t) => {
      await t.lockPerson(userId);
      const existing = await t.one<{ id: string }>(
        `SELECT id FROM autofill_saved_answers
         WHERE user_id = ? AND question_key = ? AND option_set_hash = ? AND scope = ?`,
        [userId, body.questionKey, body.optionSetHash, body.scope],
      );
      const count = async () =>
        (await t.one<{ n: number }>('SELECT count(*) AS n FROM autofill_saved_answers WHERE user_id = ?', [userId]))!.n;
      // v30 ST3: the refusal is the constant MSG_SAVED_ANSWERS_MAX.
      if (!existing && (await count()) >= LIMIT) throw refuse(deps, 'conflict', 'MSG_SAVED_ANSWERS_MAX', { max: LIMIT });
      const row = (await t.one<AnswerRow>(
        `INSERT INTO autofill_saved_answers(id, user_id, question_key, option_set_hash, scope, field_kind,
           question_label, platform, answer, created_at, updated_at)
         VALUES (@id, @userId, @questionKey, @optionSetHash, @scope, @fieldKind, @questionLabel, @platform, @answer,
           @now, @now)
         ON CONFLICT(user_id, question_key, option_set_hash, scope) DO UPDATE SET field_kind = excluded.field_kind,
           question_label = excluded.question_label, platform = excluded.platform, answer = excluded.answer,
           updated_at = excluded.updated_at
         RETURNING ${COLUMNS}`,
        {
          id: existing?.id ?? randomUUID(),
          userId,
          questionKey: body.questionKey,
          optionSetHash: body.optionSetHash,
          scope: body.scope,
          fieldKind: body.fieldKind,
          questionLabel: body.questionLabel,
          platform: body.platform,
          answer: JSON.stringify(body.answer),
          now,
        },
      ))!;
      // The body passed the same contract, so the row reads back.
      return { answer: answerOf(row)!, created: !existing, total: await count() };
    },
    { label: 'saveSavedAnswer' },
  );
}

/** Deletes one of the account's saved answers; another account's, or none, is 404. */
export async function deleteSavedAnswer(deps: Pick<AppDeps, 'db'>, userId: string, id: string): Promise<void> {
  const { changes } = await deps.db.run('DELETE FROM autofill_saved_answers WHERE id = ? AND user_id = ?', [id, userId]);
  if (changes === 0) throw notFound(NOT_FOUND);
}
