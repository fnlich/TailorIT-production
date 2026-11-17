import { z } from 'zod';
import type { BulletsTask } from '@tailorit/shared';
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
  system: () => SYSTEM,
  user: (input) =>
    [
      `THE PERSON:\n${JSON.stringify(input.person)}`,
      `THE ENTRY:\n${JSON.stringify(input.entry)}`,
      `THE TASK:\n${input.task}`,
      `THE PERSON'S NOTE (may be empty):\n${input.note}`,
    ].join('\n\n'),
  output: z.object({ bullets: z.array(z.string()).min(1).max(20) }),
});
