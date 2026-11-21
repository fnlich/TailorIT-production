import type { AppDeps } from '../context';
import type { Dialect } from '../db/index';
import { getSkillLibrary, type SkillLibrary } from '../skills-vocabulary';
import { createSkillIndex, withExtraSkills, type SkillIndex } from './library';

// The skill library as the API's resume code uses it: skills.json's hard skills as an index (./library.ts), with each
// user's own hard skills (`user_skills`) laid under it. v33 LEGACY: what the retired resume render engine
// (features/resumes/engine.ts) kept besides its 26 templates; the picker, Group skills and the upgrade of an older
// resume (./editor-document.ts) read it.

export interface UserSkillRow {
  skill: string;
  category: string;
  created_at: string;
}

// The order they were added in: the insert order (`seq`, v3.0 PG-E: SQLite's rowid) breaks a tie of created_at.
const SELECT_USER_SKILLS = (d: Dialect) =>
  `SELECT skill, category, created_at FROM user_skills WHERE user_id = ? AND type = ? ORDER BY created_at, ${d.seq()}`;

const SELECT_SKILLS_STAMP = "SELECT count(*) AS n, max(created_at) AS latest FROM user_skills WHERE user_id = ? AND type = 'hard'";

/** A user's own skills (`user_skills`), as the skill library reads them. */
export async function userSkillRows(deps: Pick<AppDeps, 'db'>, userId: string, type: 'hard' | 'soft'): Promise<UserSkillRow[]> {
  return deps.db.all<UserSkillRow>(SELECT_USER_SKILLS(deps.db.dialect), [userId, type]);
}

const indexes = new WeakMap<SkillLibrary, SkillIndex>();

/**
 * skills.json's hard skills as an index, built once per library: every spelling, aliases included, so a resume that
 * writes "Kafka" is filed under the heading of "Apache Kafka".
 */
export function skillLibraryIndex(): SkillIndex {
  const library = getSkillLibrary();
  let index = indexes.get(library);
  if (!index) {
    index = createSkillIndex(library.spellings);
    indexes.set(library, index);
  }
  return index;
}

/** The library with this user's own hard skills laid under it (a name the library has keeps the library's record). */
export async function skillsFor(deps: Pick<AppDeps, 'db'>, userId: string): Promise<SkillIndex> {
  const library = skillLibraryIndex();
  const own = await userSkillRows(deps, userId, 'hard');
  return own.length === 0 ? library : withExtraSkills(library, own);
}

/** Changes whenever the user's own hard skills do (a cache key over `skillsFor`). */
export async function skillsStamp(deps: Pick<AppDeps, 'db'>, userId: string): Promise<string> {
  const row = await deps.db.one<{ n: number; latest: string | null }>(SELECT_SKILLS_STAMP, [userId]);
  return `${row?.n ?? 0}:${row?.latest ?? ''}`;
}
