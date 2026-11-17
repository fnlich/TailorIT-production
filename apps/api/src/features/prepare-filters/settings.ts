import { PrepareFiltersSchema, type PrepareFilters } from '@tailorit/shared';
import { constantsOf } from '../../core/constants/index';
import { nowIso, type AppDeps } from '../../core/context';
import { validationFailed } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';

// v2.0 P4: the person's saved prepare filters (user_settings.prepare_filters, 0824) and their revision. The table's
// other columns are P2's (skip_prepare_confirm, prepare_resume_mode); a row made here writes the resume mode's constant
// (PREPARE_RESUME_MODE_DEFAULT), as 0827's column default is the fixed 'tailor' (W0-C's open item).
// v3.0 D2-F: on the async client.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** A user_settings row's filter columns. */
export interface FilterSettingsRow {
  prepare_filters: string;
  filters_revision: number;
}

/** The person's filters and their revision; `{}` (nothing filtered) and 0 before the first save. */
export async function readFilterSettings(
  deps: Pick<AppDeps, 'db' | 'log'>,
  userId: string,
): Promise<{ filters: PrepareFilters; revision: number }> {
  const row = await deps.db.one<FilterSettingsRow>('SELECT prepare_filters, filters_revision FROM user_settings WHERE user_id = ?', [userId]);
  return filterSettingsOf(deps, row);
}

/** A stored row read. */
export function filterSettingsOf(deps: Pick<AppDeps, 'log'>, row: FilterSettingsRow | undefined): { filters: PrepareFilters; revision: number } {
  if (!row) return { filters: PrepareFiltersSchema.parse({}), revision: 0 };
  let stored: unknown = {};
  try {
    stored = JSON.parse(row.prepare_filters);
  } catch {
    stored = {};
  }
  const parsed = PrepareFiltersSchema.safeParse(stored);
  if (!parsed.success) {
    // A stored value that no longer reads (edited by hand, a schema tightened) filters nothing until the next save.
    deps.log.warn(`[prepare-filters] the saved filters of an account do not read; nothing is filtered until they are saved again`);
    return { filters: PrepareFiltersSchema.parse({}), revision: row.filters_revision };
  }
  return { filters: parsed.data, revision: row.filters_revision };
}

/**
 * The checks the schema cannot make (06, "The filter settings"): a Custom filter that is on needs a prompt, of at most
 * CUSTOM_FILTER_PROMPT_MAX_CHARS characters. Throws a validation_failed AppError naming the field.
 */
export function checkFilters(deps: Deps, filters: PrepareFilters): void {
  const max = constantsOf(deps).get('CUSTOM_FILTER_PROMPT_MAX_CHARS');
  if (filters.custom.prompt.length > max) {
    // v20 FIX-A (REQ-3): the length limit's words are the constant MSG_TEXT_TOO_LONG (v30 ST2: through refuse()).
    const tooLong = constantsOf(deps).message('MSG_TEXT_TOO_LONG', { max });
    throw refuse(deps, 'validation_failed', 'MSG_TEXT_TOO_LONG', { max }, { fields: { 'filters.custom.prompt': tooLong } });
  }
  if (filters.custom.enabled && !filters.custom.prompt.trim()) {
    throw validationFailed('Write the custom filter, or turn it off.', { 'filters.custom.prompt': 'Required while the custom filter is on' });
  }
}

/**
 * Inserts the person's user_settings row when there is none, with prepare_resume_mode set to PREPARE_RESUME_MODE_DEFAULT
 * (the constant, not the column's fixed default). An existing row is left as it is.
 */
export async function ensureUserSettingsRow(deps: Deps, userId: string): Promise<void> {
  await deps.db.run(deps.db.dialect.insertOrIgnore('user_settings(user_id, prepare_resume_mode, updated_at) VALUES (?, ?, ?)'), [
    userId,
    constantsOf(deps).get('PREPARE_RESUME_MODE_DEFAULT'),
    nowIso(deps),
  ]);
}

/** touchFilterRevision's upsert. */
export const TOUCH_REVISION_SQL = `INSERT INTO user_settings(user_id, filters_revision, prepare_resume_mode, updated_at) VALUES (?, 1, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET filters_revision = user_settings.filters_revision + 1, updated_at = excluded.updated_at`;

/**
 * Bumps the person's filters revision without changing the filters, so every stored verdict is stale and computed again
 * at the next read: for a change of what the filters compare with, such as the person's location or time zone (INT
 * calls it from features/me's preferences PUT). Creates the row (with PREPARE_RESUME_MODE_DEFAULT) when there is none.
 * Answers the new revision.
 */
export async function touchFilterRevision(deps: Deps, userId: string): Promise<number> {
  await deps.db.run(TOUCH_REVISION_SQL, [userId, constantsOf(deps).get('PREPARE_RESUME_MODE_DEFAULT'), nowIso(deps)]);
  return (await readFilterSettings(deps, userId)).revision;
}

/** Saves the person's filters (checked) and bumps their revision: a verdict of an older revision is stale. */
export async function saveFilterSettings(
  deps: Deps,
  userId: string,
  filters: PrepareFilters,
): Promise<{ filters: PrepareFilters; revision: number }> {
  checkFilters(deps, filters);
  const now = nowIso(deps);
  await deps.db.run(
    `INSERT INTO user_settings(user_id, prepare_filters, filters_revision, prepare_resume_mode, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET prepare_filters = excluded.prepare_filters,
         filters_revision = user_settings.filters_revision + 1, updated_at = excluded.updated_at`,
    [userId, JSON.stringify(filters), constantsOf(deps).get('PREPARE_RESUME_MODE_DEFAULT'), now],
  );
  return readFilterSettings(deps, userId);
}
