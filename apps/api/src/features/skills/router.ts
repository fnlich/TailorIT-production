import { Router } from 'express';
import {
  AddSkillBodySchema,
  GroupSkillsBodySchema,
  HARD_SKILL_CATEGORIES,
  SkillsQuerySchema,
  type AddSkillResponse,
  type GroupSkillsResponse,
  type SkillsResponse,
} from '@tailorit/shared';
import { inferSkillCategory, libraryCategory, renderSkillCategory, skillIndexKey, type SkillIndex } from '@tailorit/render';
import { requireUser, userOf } from '../../core/auth/guards';
import { nowIso, type AppDeps } from '../../core/context';
import { parseInput } from '../../core/http/validate';
import { getSkillLibrary } from '../../core/skills-vocabulary';
import { getResumeEngine, userSkillRows } from '../resumes/engine';

// The skill library (static/skills/skills.json, shared, never written) with each user's own skills laid over it
// (`user_skills`). Owned by work package R1. A skill a person adds is theirs alone: it never reaches anyone else's
// library, and Grouped files it under the heading inferred for it.

/** Skills under the library's headings: its order first, then headings of the person's own, each skill once. */
export function groupSkills(skills: readonly string[], library: SkillIndex): GroupSkillsResponse['groups'] {
  const groups = new Map<string, string[]>(HARD_SKILL_CATEGORIES.map((category) => [category, []]));
  const seen = new Set<string>();
  for (const raw of skills) {
    const skill = raw.replace(/\s+/g, ' ').trim();
    const key = skillIndexKey(skill);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const category = library.get(skill)?.category ?? renderSkillCategory(skill, library);
    groups.set(category, [...(groups.get(category) ?? []), skill]);
  }
  return [...groups].filter(([, members]) => members.length > 0).map(([category, members]) => ({ category, skills: members }));
}

/** Mounted at /api/skills. */
export function createSkillsRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);

  router.get('/', async (req, res) => {
    const { type } = parseInput(SkillsQuerySchema, req.query, 'query');
    const library = getSkillLibrary();
    // Main skills only: an alias is the same skill ("ASP.NET Core" of ".NET"), and offering both invites a resume to
    // list both. `aliases` lets the picker find a main skill by another spelling; a typed alias is still known (POST).
    const names = type === 'hard' ? library.hard.map((record) => record.skill) : [...library.soft];
    const known = type === 'hard' ? library.spellings.map((record) => record.skill) : names;
    const seen = new Set(known.map((name) => skillIndexKey(name)));
    for (const row of await userSkillRows(deps, userOf(req).id, type)) {
      const key = skillIndexKey(row.skill);
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(row.skill);
    }
    const body: SkillsResponse =
      type === 'hard'
        ? {
            type,
            skills: names,
            aliases: Object.fromEntries(library.hard.filter((entry) => entry.aliases.length > 0).map((entry) => [entry.skill, [...entry.aliases]])),
          }
        : { type, skills: names };
    res.json(body);
  });

  router.post('/', async (req, res) => {
    const { type, skill, category } = parseInput(AddSkillBodySchema, req.body);
    const userId = userOf(req).id;
    const name = skill.replace(/\s+/g, ' ').trim();
    const key = skillIndexKey(name);
    const library = getSkillLibrary();

    if (type === 'hard') {
      const known = library.byKey.get(name.toLowerCase()) ?? library.spellings.find((record) => skillIndexKey(record.skill) === key);
      if (known) {
        const body: AddSkillResponse = { added: false, skill: known.skill, type, category: known.category || null };
        res.json(body);
        return;
      }
    } else {
      const known = library.soft.find((entry) => skillIndexKey(entry) === key);
      if (known) {
        const body: AddSkillResponse = { added: false, skill: known, type, category: null };
        res.json(body);
        return;
      }
    }

    const own = await deps.db.one<{ skill: string; category: string }>(
      'SELECT skill, category FROM user_skills WHERE user_id = ? AND type = ? AND skill_key = ?',
      [userId, type, key],
    );
    if (own) {
      const body: AddSkillResponse = { added: false, skill: own.skill, type, category: type === 'hard' ? own.category || null : null };
      res.json(body);
      return;
    }

    const heading = type === 'hard' ? (libraryCategory(category) ?? inferSkillCategory(name)) : '';
    // Two adds of the same skill at once: the second finds the key taken (the table's primary key) and answers as the
    // look-up above would have, instead of failing.
    const inserted = await deps.db.run(
      deps.db.dialect.insertOrIgnore('user_skills(user_id, skill_key, skill, type, category, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
      [userId, key, name, type, heading, nowIso(deps)],
    );
    if (inserted.changes === 0) {
      const taken = await deps.db.one<{ skill: string; category: string }>(
        'SELECT skill, category FROM user_skills WHERE user_id = ? AND type = ? AND skill_key = ?',
        [userId, type, key],
      );
      const body: AddSkillResponse = { added: false, skill: taken?.skill ?? name, type, category: type === 'hard' ? taken?.category || null : null };
      res.json(body);
      return;
    }
    const body: AddSkillResponse = { added: true, skill: name, type, category: type === 'hard' ? heading : null };
    res.status(201).json(body);
  });

  router.post('/group', async (req, res) => {
    const { skills } = parseInput(GroupSkillsBodySchema, req.body);
    const body: GroupSkillsResponse = { groups: groupSkills(skills, await getResumeEngine(deps).skillsFor(userOf(req).id)) };
    res.json(body);
  });

  return router;
}
