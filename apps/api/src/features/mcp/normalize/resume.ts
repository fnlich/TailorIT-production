import type { Profile, TailoredContent } from '../../tailor/types';
import { firstOf, isRecord, linesOf, optionalText, refuse, refuseWith, textList } from './refuse';
import { matchRole, matchRoles, type DropReason } from './roles';

// v1.5 Q1: a tailored resume the person's AI saved (prepare_save_resume), normalized strictly to tailor-resume's
// answer, the object TailorIT's own tailoring reads: {summary, experience: [{title, company, description,
// achievements}], hardSkills, softSkills, strengths: [{title, description}]}, one experience entry per role of the
// source resume, in its order, each with that role's own company and title. Common other shapes are read too: bullets
// or highlights for achievements, skills for hardSkills, roles, work or positions for experience, employer for company,
// position for title, a summary given as sentences, a list given as lines. Each entry is matched to a role of the
// resume (roles.ts); an entry that matches none is dropped and reported. After this, the save runs v1.4's own steps on
// it, as on TailorIT's prompt's answer: mergeExperience (the resume's employers, titles, dates and places; bullets
// capped per role and in all, figure bullets kept), the summary's sentence limit, the skill lists sized, humanize, the
// finishing, the profile's figures and the facts check. Anything that cannot be read is refused with the field and the
// shape expected.

export const RESUME_SHAPE =
  'an object {"summary", "experience": [{"title", "company", "description", "achievements": [...]}], "hardSkills": [...], ' +
  '"softSkills": [...], "strengths": [{"title", "description"}]}';
const ROLE_SHAPE = 'a role {"title", "company", "description", "achievements": [...]}';
const STRENGTH_SHAPE = '{"title", "description"} or "Title: one sentence"';
export const REVISION_SHAPE =
  'revise-resume-ats\'s object {"summary", "edits": [{"company", "title", "bullet", "text"} or {"company", "title", ' +
  '"description"}]}, or the whole resume again (' +
  'the same object as "resume")';
const EDIT_SHAPE =
  '{"company", "title", "bullet": <1 for the first bullet, 0 to add one>, "text"} or {"company", "title", "description"}';

/** A role TailorIT's tailoring reads from the answer (the dates and place come from the resume itself). */
export interface NormalizedRole {
  title: string;
  company: string;
  description?: string;
  achievements?: string[];
}

/** tailor-resume's answer as TailorIT's prompt asks for it. */
export interface NormalizedResume {
  summary: string;
  experience: NormalizedRole[];
  hardSkills: string[];
  softSkills: string[];
  strengths: Array<{ title: string; description: string }>;
}

/** An entry or an edit the save left out, as its answer reports it (the AI's own words for the role, cut short). */
export interface DroppedRole {
  entry: number;
  company: string;
  title: string;
  reason: DropReason;
}

const EXPERIENCE_KEYS = ['experience', 'roles', 'work', 'positions', 'workExperience', 'work_experience', 'jobs'];
const COMPANY_KEYS = ['company', 'employer', 'organization', 'organisation'];
const TITLE_KEYS = ['title', 'position', 'role', 'jobTitle', 'job_title'];
const BULLET_KEYS = ['achievements', 'bullets', 'highlights', 'accomplishments'];
const HARD_KEYS = ['hardSkills', 'hard_skills', 'skills', 'technicalSkills', 'technical_skills'];
const SOFT_KEYS = ['softSkills', 'soft_skills'];
const RESUME_KEYS = ['summary', ...EXPERIENCE_KEYS, ...HARD_KEYS, ...SOFT_KEYS, 'strengths'];

const short = (text: string) => [...text].slice(0, 120).join('');

/** A text given as one string or as sentences (joined with spaces). */
function prose(value: unknown, field: string, expected: string): string {
  if (Array.isArray(value)) {
    return value
      .map((item, index) => {
        if (typeof item !== 'string') throw refuse(`${field}[${index}]`, 'a string', item);
        return item.trim();
      })
      .filter(Boolean)
      .join(' ');
  }
  return optionalText(value, field, expected);
}

/** A skills list: an array, a list in one string (commas, lines), or groups ({"Cloud": [...]}), flattened. */
function skillList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return value.split(/[,;|•\n]+/).map((skill) => skill.trim()).filter(Boolean);
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([group, items]) => skillList(items, `${field}.${group}`));
  }
  return textList(value, field, 'an array of skill names');
}

function strengthsOf(value: unknown, field: string): NormalizedResume['strengths'] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw refuse(field, `an array of ${STRENGTH_SHAPE}`, value);
  return value.map((item, index) => {
    const at = `${field}[${index}]`;
    if (typeof item === 'string') {
      const split = /^(.{2,60}?)\s*(?::|\s[-–—]\s)\s*(.+)$/.exec(item.trim());
      if (!split) throw refuse(at, STRENGTH_SHAPE, item);
      return { title: split[1]!.trim(), description: split[2]!.trim() };
    }
    if (!isRecord(item)) throw refuse(at, STRENGTH_SHAPE, item);
    return {
      title: optionalText(firstOf(item, ['title', 'name'])?.[1], `${at}.title`),
      description: optionalText(firstOf(item, ['description', 'text'])?.[1], `${at}.description`),
    };
  });
}

/** One written role: its company and title as written, its description and bullets. */
function roleOf(item: unknown, field: string): NormalizedRole {
  if (!isRecord(item)) throw refuse(field, ROLE_SHAPE, item);
  const company = firstOf(item, COMPANY_KEYS);
  const title = firstOf(item, TITLE_KEYS);
  const bullets = firstOf(item, BULLET_KEYS);
  return {
    company: optionalText(company?.[1], `${field}.${company?.[0] ?? 'company'}`),
    title: optionalText(title?.[1], `${field}.${title?.[0] ?? 'title'}`),
    description: prose(item.description, `${field}.description`, 'a string'),
    achievements: textList(bullets?.[1], `${field}.${bullets?.[0] ?? 'achievements'}`, 'an array of bullets (strings)'),
  };
}

/** Whether a value is a resume (rather than revise-resume-ats's edits). */
export const looksLikeResume = (value: Record<string, unknown>) => RESUME_KEYS.some((key) => key in value);

/** Whether a revision is the whole resume again (it has roles, or wraps a resume) rather than edits. */
export const isWholeResume = (value: Record<string, unknown>) =>
  !('edits' in value) && (EXPERIENCE_KEYS.some((key) => key in value) || isRecord(value.resume));

/** The object itself, or the resume it wraps ({"resume": {...}}). */
function unwrapped(value: unknown): unknown {
  return isRecord(value) && isRecord(value.resume) && !looksLikeResume(value) ? value.resume : value;
}

/**
 * tailor-resume's answer, normalized: every field read strictly, every entry matched to a role of `profile` (one
 * entry per role, in its order; a role with no entry keeps its own text, as TailorIT's tailoring keeps it).
 */
export function normalizeResume(
  value: unknown,
  profile: Profile,
  field = 'resume',
): { resume: NormalizedResume; dropped: DroppedRole[] } {
  const input = unwrapped(value);
  if (!isRecord(input)) throw refuse(field, RESUME_SHAPE, input);
  const summary = prose(input.summary, `${field}.summary`, 'the summary as a string (or an array of sentences)');
  if (!summary) throw refuse(`${field}.summary`, 'the summary as a non-empty string (or an array of sentences)', input.summary ?? undefined);

  const listed = firstOf(input, EXPERIENCE_KEYS);
  const experienceField = `${field}.${listed?.[0] ?? 'experience'}`;
  if (listed && !Array.isArray(listed[1])) throw refuse(experienceField, `an array, each ${ROLE_SHAPE}`, listed[1]);
  const written = ((listed?.[1] as unknown[] | undefined) ?? []).map((item, index) => roleOf(item, `${experienceField}[${index}]`));

  const roles = profile.experience ?? [];
  const matches = matchRoles(written, roles.map((role) => ({ company: role.company ?? '', title: role.title ?? '' })));
  const dropped: DroppedRole[] = [];
  const byRole = new Map<number, NormalizedRole>();
  matches.forEach((match, index) => {
    const entry = written[index]!;
    if (match.role === null) dropped.push({ entry: index, company: short(entry.company), title: short(entry.title), reason: match.reason });
    else byRole.set(match.role, entry);
  });
  const experience = roles.map((role, index): NormalizedRole => {
    const entry = byRole.get(index);
    const own = { title: role.title ?? '', company: role.company ?? '' };
    return entry ? { ...own, description: entry.description, achievements: entry.achievements } : own;
  });
  if (roles.length > 0 && !experience.some((role) => (role.achievements ?? []).length > 0)) {
    throw refuseWith(
      experienceField,
      `no entry with bullets is about a role of the resume. Write one entry per role, with its "company" and "title" as ` +
        `the resume has them and its "achievements": ${roles.map((role) => `${role.company} / ${role.title}`).join('; ')}.`,
    );
  }

  const hard = firstOf(input, HARD_KEYS);
  const soft = firstOf(input, SOFT_KEYS);
  return {
    resume: {
      summary,
      experience,
      hardSkills: skillList(hard?.[1], `${field}.${hard?.[0] ?? 'hardSkills'}`),
      softSkills: skillList(soft?.[1], `${field}.${soft?.[0] ?? 'softSkills'}`),
      strengths: strengthsOf(input.strengths, `${field}.strengths`).filter((item) => item.title && item.description),
    },
    dropped,
  };
}

/** revise-resume-ats's object, each edit naming a role of the draft in its own words. */
export interface NormalizedRevision {
  summary: string;
  edits: Array<{ company: string; title: string; bullet?: number; text?: string; description?: string }>;
}

/** A bullet's number: 1 for the first, 0 (or "new", "add") for a new one. */
function bulletNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value)) return Number(value);
  if (typeof value === 'string' && /^\s*(new|add)\s*$/i.test(value)) return 0;
  throw refuse(field, '1 for the first bullet, 2 for the second..., or 0 to add one', value);
}

/**
 * revise-resume-ats's answer for `draft` (the resume the last save kept), normalized: the summary, and each edit with
 * the company and title of the draft's role it names (matched as entries are); an edit that names no role, or two,
 * is dropped and reported. Refused when it holds neither a summary nor an edit TailorIT can apply.
 */
export function normalizeRevisionEdits(
  value: Record<string, unknown>,
  draft: TailoredContent,
): { revision: NormalizedRevision; dropped: DroppedRole[] } {
  const summary = prose(value.summary, 'revision.summary', 'the new summary as a string, or "" to keep it');
  const edits = value.edits ?? [];
  if (!Array.isArray(edits)) throw refuse('revision.edits', `an array of edits, each ${EDIT_SHAPE}`, edits);
  const roles = draft.experience.map((role) => ({ company: role.company, title: role.title }));
  const dropped: DroppedRole[] = [];
  const kept: NormalizedRevision['edits'] = [];
  edits.forEach((item, index) => {
    const at = `revision.edits[${index}]`;
    if (!isRecord(item)) throw refuse(at, EDIT_SHAPE, item);
    const company = optionalText(firstOf(item, COMPANY_KEYS)?.[1], `${at}.company`);
    const title = optionalText(firstOf(item, TITLE_KEYS)?.[1], `${at}.title`);
    const description = prose(item.description, `${at}.description`, 'a string');
    let text = optionalText(firstOf(item, ['text', 'newText', 'new_text'])?.[1], `${at}.text`);
    let bullet: number | null;
    if (!text && typeof item.bullet === 'string' && !/^\s*(\d{1,3}|new|add)\s*$/i.test(item.bullet) && item.bullet.trim()) {
      // {"bullet": "Built the ..."}: the bullet's words, added.
      text = item.bullet.trim();
      bullet = 0;
    } else {
      bullet = bulletNumber(firstOf(item, ['bullet', 'index', 'number'])?.[1], `${at}.bullet`);
    }
    if (!description && !(text && bullet !== null)) throw refuse(at, EDIT_SHAPE, item);
    const match = matchRole({ company, title }, roles);
    if (match.role === null) {
      dropped.push({ entry: index, company: short(company), title: short(title), reason: match.reason });
      return;
    }
    const own = roles[match.role]!;
    kept.push({
      company: own.company,
      title: own.title,
      ...(text && bullet !== null ? { bullet, text: linesOf(text).join(' ') } : {}),
      ...(description ? { description } : {}),
    });
  });
  if (!summary && kept.length === 0) {
    throw refuseWith(
      'revision',
      dropped.length
        ? `no edit names a role of the resume. Name each role by its "company" and "title": ${roles.map((role) => `${role.company} / ${role.title}`).join('; ')}.`
        : `nothing to apply: send a new "summary" or at least one edit, each ${EDIT_SHAPE}.`,
    );
  }
  return { revision: { summary, edits: kept }, dropped };
}
