import { readFileSync } from 'node:fs';
import type { ResumeDocument } from '@tailorit/shared';
import {
  createSkillIndex,
  createTemplateStore,
  loadTemplateDirectory,
  readSampleResume,
  setRenderWarningSink,
  withExtraSkills,
  type SkillIndex,
  type TemplateStore,
} from '@tailorit/render';
import type { AppDeps } from '../../core/context';
import type { Dialect } from '../../core/db/index';
import { AppError } from '../../core/http/errors';
import { staticDir } from '../../core/paths';
import { getSkillLibrary } from '../../core/skills-vocabulary';

// The resume render engine as the API uses it: the 26 templates (static/resume-templates, read once), TailorIT's
// sample person (static/sample-resume.json) and the skill library with each user's own skills laid over it.
// Shared by the resumes, resume-templates and skills features; created on first use.

export interface ResumeEngine {
  templates: TemplateStore;
  /** The sample person the editor's preview and the template gallery show. */
  sample: ResumeDocument;
  /** skills.json's hard skills. */
  library: SkillIndex;
  /** The library with this user's own hard skills laid under it. */
  skillsFor(userId: string): Promise<SkillIndex>;
  /** Changes whenever the user's own hard skills do (cache keys). */
  skillsStamp(userId: string): Promise<string>;
}

declare module '../../core/context' {
  interface AppServices {
    /** The resume render engine (work package R1). */
    resumeEngine?: ResumeEngine;
  }
}

export interface UserSkillRow {
  skill: string;
  category: string;
  created_at: string;
}

// The order they were added in: the insert order (`seq`, v3.0 PG-E: SQLite's rowid) breaks a tie of created_at.
const SELECT_USER_SKILLS = (d: Dialect) =>
  `SELECT skill, category, created_at FROM user_skills WHERE user_id = ? AND type = ? ORDER BY created_at, ${d.seq()}`;

/** A user's own skills (`user_skills`), as the skill library reads them. */
export async function userSkillRows(deps: Pick<AppDeps, 'db'>, userId: string, type: 'hard' | 'soft'): Promise<UserSkillRow[]> {
  return deps.db.all<UserSkillRow>(SELECT_USER_SKILLS(deps.db.dialect), [userId, type]);
}

export function createResumeEngine(deps: Pick<AppDeps, 'db' | 'log'>): ResumeEngine {
  setRenderWarningSink((message) => deps.log.warn(`[render] ${message}`));
  const templates = createTemplateStore(
    loadTemplateDirectory(staticDir('resume-templates'), (file, reason) =>
      deps.log.warn(`[render] skipped template file ${file}: ${reason}`),
    ),
  );
  if (templates.list().length === 0) deps.log.error('[render] no resume template could be loaded');
  const sample = readSampleResume(JSON.parse(readFileSync(staticDir('sample-resume.json'), 'utf8')));
  // Every spelling, aliases included: a resume that writes "Kafka" is filed under the heading of "Apache Kafka".
  const library = createSkillIndex(getSkillLibrary().spellings);
  return {
    templates,
    sample,
    library,
    async skillsFor(userId) {
      const own = await userSkillRows(deps, userId, 'hard');
      return own.length === 0 ? library : withExtraSkills(library, own);
    },
    async skillsStamp(userId) {
      const row = await deps.db.one<{ n: number; latest: string | null }>(
        "SELECT count(*) AS n, max(created_at) AS latest FROM user_skills WHERE user_id = ? AND type = 'hard'",
        [userId],
      );
      return `${row?.n ?? 0}:${row?.latest ?? ''}`;
    },
  };
}

/** The engine, created on first use (the three resume features share one). */
export function getResumeEngine(deps: AppDeps): ResumeEngine {
  deps.services.resumeEngine ??= createResumeEngine(deps);
  return deps.services.resumeEngine;
}

/** The template a request names, or 404. */
export function requireTemplate(deps: AppDeps, id: string) {
  const template = getResumeEngine(deps).templates.get(id);
  if (!template) throw new AppError('not_found', 'That resume template was not found. Choose another template.');
  return template;
}
