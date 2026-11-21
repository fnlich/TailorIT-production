import { z } from 'zod';
import type { BulletsTask, RoleFamilyId } from '@tailorit/shared';
import { familyVoice, wordsOf } from '../roles/variants';
import { definePrompt } from '../types';

// v30 ST1: moved word for word from features/resumes/ai/entryBullets.ts (which builds the input and cleans the
// answer). Write with AI / Improve with AI: the bullets of one entry (a role, a project or a volunteering entry), from
// the facts in it and the person's optional note. Nothing is stored; the editor puts the answer into its draft.

const BANNED_WORDS = [
  'leveraged',
  'utilized',
  'spearheaded',
  'orchestrated',
  'streamlined',
  'seamless',
  'robust',
  'scalable',
  'maximized',
  'synergy',
  'cross-functional',
  'end-to-end',
  'innovative',
  'dynamic',
  'cutting-edge',
  'world-class',
  'best-in-class',
  'state-of-the-art',
  'holistic',
  'comprehensive',
  'extensive',
  'proven',
  'strategic',
  'mission-critical',
];

const WEAK_OPENERS = ['Designed', 'Architected', 'Led', 'Delivered', 'Drove', 'Integrated', 'Partnered', 'Supported', 'Contributed', 'Managed', 'Helped'];

const SYSTEM = `You write the achievement bullets for ONE entry on a person's resume: a job, a project or a volunteering
role. The bullets are printed under that entry exactly as you return them.

Rules:
- Use only facts that are in the entry or in the person's note. Never invent an employer, product, team size, figure,
  percentage, date or technology. When the entry has few facts, write fewer bullets rather than pad them.
- Keep every figure the entry already has, exactly as written.
- Each bullet is one line of 8 to 28 words: a single sentence fragment, no full stop at the end, no sub-bullets.
- Start each bullet with a verb: past tense for an entry that has ended, present tense for a current one (its end
  date is empty or "Present"). Never start two bullets with the same word.
- Say what was done and what it changed, in plain words, the way an engineer describes their own work. No
  pronouns: no "I", "we", "our" or "the team".
- Never use these words in any form: ${BANNED_WORDS.join(', ')}.
- Do not start a bullet with ${WEAK_OPENERS.join(', ')}. Verbs like built, wrote, shipped, cut, rewrote, fixed,
  migrated, ran, owned, taught and launched are the kind wanted.
- No em dashes or en dashes, no "--", no bold, no markdown, no emoji, no bullet characters at the start.
- Name the technologies the entry lists where a bullet is really about them, in the entry's own spelling.

The answer is {"bullets": ["first bullet", "second bullet"]}.`;

export interface BulletsPromptInput {
  person: Record<string, unknown>;
  entry: Record<string, unknown>;
  /** THE TASK: entryBulletsTask's sentence. */
  task: string;
  note: string;
  /**
   * v33 PROMPTS (F5): the person's field (missing or technical: the rules above, word for word). Another field's rules
   * (general's too) say how a person of that field describes their work, with its verbs, name its tools instead of
   * technologies, and add its voice line (general has none).
   */
  family?: RoleFamilyId | null;
}

/** The technical family's verbs line, as SYSTEM writes it. */
const TECHNICAL_VERBS =
  'Verbs like built, wrote, shipped, cut, rewrote, fixed,\n  migrated, ran, owned, taught and launched are the kind wanted.';

/**
 * v33 PROMPTS: the system text in a field's words (the technical family's is SYSTEM): how a person of the field
 * describes their work, its tools instead of technologies, and its voice line. v33 FIX-1: the verbs and the "never
 * invent" list are the field's too (every field had kept "shipped" and "migrated"), and the general field gets the
 * general pack's words (it had the engineer's), with no voice line.
 */
function systemFor(family?: RoleFamilyId | null): string {
  const words = wordsOf(family);
  if (!words) return SYSTEM;
  const verbs = words.verbs.slice(0, 11);
  const voice = familyVoice(family);
  return SYSTEM.replace('the way an engineer describes their own work', () => `the way ${words.aPerson} describes their own work`)
    .replace('percentage, date or technology.', () => 'percentage, date, tool or system.')
    .replace(TECHNICAL_VERBS, () => `Verbs like ${verbs.slice(0, -1).join(', ')} and ${verbs[verbs.length - 1]} are the kind wanted.`)
    .replace('- Name the technologies the entry lists', () => `- Name the ${words.toolWord} the entry lists`)
    .replace('\n\nThe answer is', () => (voice ? `\n- ${voice}\n\nThe answer is` : '\n\nThe answer is'));
}

/**
 * THE TASK's sentence for a request: write new bullets (`existingBullets`: how many the entry has, non-empty), or
 * improve the existing ones.
 */
export function entryBulletsTask(task: BulletsTask, existingBullets: number): string {
  if (task === 'write') {
    return (
      'Write 3 to 8 new bullets for this entry from the facts in it.' +
      (existingBullets > 0 ? ' Its current bullets are notes you may take facts from, but write every bullet afresh.' : '')
    );
  }
  return (
    "Improve the entry's existing bullets: keep every fact and figure, tighten the wording, open each with a strong " +
    'verb and add nothing that is not in the entry. Return one improved bullet for each existing bullet, in the same ' +
    'order, merging two only when they say the same thing.'
  );
}

export const entryBulletsPrompt = definePrompt<BulletsPromptInput, { bullets: string[] }>({
  area: 'resumes',
  name: 'entry-bullets',
  version: 1,
  description: "Writes (or improves) the achievement bullets of one resume entry from its own facts (Write with AI).",
  kind: 'entry_bullets',
  system: (input) => systemFor(input.family),
  user: (input) =>
    [
      `THE PERSON:\n${JSON.stringify(input.person)}`,
      `THE ENTRY:\n${JSON.stringify(input.entry)}`,
      `THE TASK:\n${input.task}`,
      `THE PERSON'S NOTE (may be empty):\n${input.note}`,
    ].join('\n\n'),
  output: z.object({ bullets: z.array(z.string()).min(1).max(20) }),
});
