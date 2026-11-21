import {
  BulletsRequestSchema,
  BulletsResultSchema,
  detectProfileFamily,
  MAX_AI_BULLETS,
  MAX_BULLET_LENGTH,
  toPlainText,
  type BulletsRequest,
  type BulletsResult,
  type RoleFamilyId,
} from '@tailorit/shared';
import type { AiTaskContext } from '../../../ai/index';
import { entryBulletsPrompt, entryBulletsTask } from '../../../ai/prompts/resumes/entry-bullets';
import { AppError } from '../../../core/http/errors';

// Write with AI / Improve with AI: the bullets of one entry (a role, a project or a volunteering entry), from the
// facts in it and the person's optional note. Nothing is stored; the editor puts the answer into its draft. v30 ST1:
// the prompt (its rules and THE TASK's sentences) is apps/api/src/ai/prompts/resumes/entry-bullets.ts; this file builds
// its input and cleans the answer.

const clean = (value: unknown, max = 500) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()) : [];

/** The entry as the prompt reads it: what it is, what names it, and its facts. */
function entryForPrompt(request: BulletsRequest): Record<string, unknown> {
  const entry = request.entry;
  const naming =
    request.kind === 'experience'
      ? { role: clean(entry.title), organization: clean(entry.company ?? entry.organization) }
      : request.kind === 'project'
        ? { project: clean(entry.name ?? entry.title), role: clean(entry.role) }
        : { role: clean(entry.role ?? entry.title), organization: clean(entry.organization) };
  return {
    kind: request.kind,
    ...naming,
    startDate: clean(entry.startDate, 40),
    endDate: clean(entry.endDate, 40),
    location: clean(entry.location),
    description: clean(entry.description, 2000),
    bullets: strings(entry.achievements),
    skills: strings(entry.skills),
  };
}

/** THE TASK's sentence (the prompt module's words) for the request. */
function taskSentence(request: BulletsRequest): string {
  return entryBulletsTask(request.task, strings(request.entry.achievements).length);
}

/**
 * A bullet as it may print: markup and markers gone, dashes made plain ("2019–2021" keeps a hyphen, any other dash
 * becomes a comma), one line, no full stop, at most 300 characters (cut at a word).
 */
export function cleanBullet(raw: string): string {
  let bullet = raw
    .replace(/<\/?(?:b|strong|em|i)>/gi, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:[-*•·–—]+|\d{1,2}[.)])\s*/, '')
    .replace(/(?<=\d)\s*[–—]\s*(?=\d)/g, '-')
    .replace(/\s*(?:[–—]|\s--\s)\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/\s+,/g, ',')
    .replace(/,\s*$/, '')
    .trim();
  if (/[^.]\.$/.test(bullet)) bullet = bullet.slice(0, -1);
  if (bullet.length > MAX_BULLET_LENGTH) {
    const cut = bullet.slice(0, MAX_BULLET_LENGTH);
    const space = cut.lastIndexOf(' ');
    bullet = (space > MAX_BULLET_LENGTH - 60 ? cut.slice(0, space) : cut).replace(/[,;:]$/, '').trim();
  }
  return bullet;
}

/** The answer's bullets, cleaned, repeats dropped, at most eight. */
export function finishBullets(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw) {
    const bullet = cleanBullet(line);
    const key = bullet.toLowerCase();
    if (!bullet || seen.has(key)) continue;
    seen.add(key);
    out.push(bullet);
    if (out.length >= MAX_AI_BULLETS) break;
  }
  return out;
}

/** The request with marked-up text as the words it prints; text from a client that sends no markup is literal already. */
export function plainBulletsRequest(request: BulletsRequest): BulletsRequest {
  if (request.markupVersion !== 1) return request;
  const { entry, resume } = request;
  return {
    ...request,
    entry: {
      ...entry,
      ...(entry.description !== undefined ? { description: toPlainText(entry.description) } : {}),
      ...(entry.achievements ? { achievements: entry.achievements.map(toPlainText) } : {}),
    },
    ...(resume?.summary !== undefined ? { resume: { ...resume, summary: toPlainText(resume.summary) } } : {}),
  };
}

/** The `entry_bullets` task on a raw input (mcp/own-ai.ts runs it so too): the request read, then writeEntryBullets. */
export async function runEntryBullets(raw: unknown, ctx: AiTaskContext): Promise<BulletsResult> {
  return writeEntryBullets(BulletsRequestSchema.parse(raw), ctx);
}

/**
 * v33 PROMPTS (F5): the field the bullets are written in, detected from the headline and the entry's own title or role
 * (then the skills), as a resume's field is (detectProfileFamily). v33 INT-1: the editor's Field when the request names
 * it (the resume's chosen or detected field), else detected here. v33 FIX-1: general stays general (the general pack's
 * words, as the same person's tailoring uses); it was the engineer's v3.2 words.
 */
export function bulletsFamily(request: BulletsRequest): RoleFamilyId {
  const entry = request.entry;
  return request.roleFamily ?? detectProfileFamily({
    roles: [request.resume?.title ?? '', entry.title ?? entry.role ?? ''],
    hardSkills: [...(request.resume?.skills ?? []), ...(entry.skills ?? [])],
  });
}

/** The `entry_bullets` task (resumes/tasks.ts) on its read request. */
export async function writeEntryBullets(parsed: BulletsRequest, ctx: AiTaskContext): Promise<BulletsResult> {
  const request = plainBulletsRequest(parsed);
  const resume = request.resume ?? {};
  const answer = await ctx.runPrompt(entryBulletsPrompt, {
    person: {
      name: clean(resume.name),
      headline: clean(resume.title),
      ...(typeof resume.totalYearsExperience === 'number' ? { yearsOfExperience: resume.totalYearsExperience } : {}),
      summary: clean(resume.summary, 2000),
      skills: strings(resume.skills).slice(0, 60),
    },
    entry: entryForPrompt(request),
    task: taskSentence(request),
    note: clean(request.instructions, 300),
    family: bulletsFamily(request),
  });
  const bullets = finishBullets(answer.bullets);
  if (bullets.length === 0) throw new AppError('ai_failed', 'The AI answered with no usable bullets. Please try again.');
  return BulletsResultSchema.parse({ bullets });
}
