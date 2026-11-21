import { GENERAL_FAMILY_ID, ROLE_FAMILIES, TECHNICAL_FAMILY_ID, roleFamilyOf, type RoleFamilyId } from '@tailorit/shared';
import { adapt } from '../tailor/render';
import { SLOT_TEMPLATES, slotWords, type SlotWords } from './archetypes';
import type { FamilyPack } from './pack';
import { CARE_PACKS } from './packs/care';
import { HANDS_ON_PACKS } from './packs/hands-on';
import { PROFESSIONAL_PACKS } from './packs/professional';
import { slotsOf, type TailorPromptId } from './slots';

// v33 PROMPTS (F5): a role family's rendering of tailor_builder0's prompts. The technical family's is the original
// text, untouched (so its hashes, its stored analyses and every pinned fixture stay as they were); any other family's
// replaces each slot of the prompt (slots.ts) with its archetype's template filled from its pack (archetypes.ts),
// through adapt(). Callers lay their own adaptations (the markers, the MCP and own-AI tools) on top. Memoised: one
// rendering per prompt and family for the life of the process.

/** Every non-technical family's pack, by family id. */
export const FAMILY_PACKS: ReadonlyMap<string, FamilyPack> = new Map(
  [...PROFESSIONAL_PACKS, ...HANDS_ON_PACKS, ...CARE_PACKS].map((pack) => [pack.family, pack]),
);

/** A family id, missing read as technical (tasks queued before v3.3, and every caller that names none). */
export const familyOrTechnical = (family?: RoleFamilyId | null): RoleFamilyId => family ?? TECHNICAL_FAMILY_ID;

/** The words a family's slots are filled with; null for the technical family (it keeps tailor_builder0's). */
export function wordsOf(family?: RoleFamilyId | null): SlotWords | null {
  const id = familyOrTechnical(family);
  if (id === TECHNICAL_FAMILY_ID) return null;
  const pack = FAMILY_PACKS.get(id);
  if (!pack) throw new Error(`The role family "${id}" has no vocabulary pack.`);
  const family_ = roleFamilyOf(id);
  if (family_.archetype === 'technical') throw new Error(`The role family "${id}" is technical but not the technical family.`);
  return slotWords(pack, family_.archetype, family_.tailoring);
}

/** Each slot's [original words, the family's words] of one prompt; none for the technical family. */
export function familyChanges(prompt: TailorPromptId, family?: RoleFamilyId | null): Array<readonly [string, string]> {
  const words = wordsOf(family);
  if (!words) return [];
  return slotsOf(prompt).map((entry) => {
    const template = SLOT_TEMPLATES[entry.key];
    if (!template) throw new Error(`The slot ${entry.key} has no template.`);
    return [entry.from, template(words)] as const;
  });
}

const rendered = new Map<string, { raw: string; text: string }>();

/**
 * `raw` (one of tailor_builder0's six prompts, word for word) as `family` reads it: the technical family's is `raw`
 * itself; another family's has every slot replaced. Throws when a slot's words are not in `raw`.
 */
export function familyText(raw: string, prompt: TailorPromptId, family?: RoleFamilyId | null): string {
  const id = familyOrTechnical(family);
  if (id === TECHNICAL_FAMILY_ID) return raw;
  const key = `${prompt}\u0000${id}`;
  const kept = rendered.get(key);
  if (kept && kept.raw === raw) return kept.text;
  const text = adapt(raw, prompt, familyChanges(prompt, id));
  rendered.set(key, { raw, text });
  return text;
}

/** A value made once per family (a prompt's text for that family), missing read as technical. */
export function perFamily<T>(make: (family: RoleFamilyId) => T): (family?: RoleFamilyId | null) => T {
  const made = new Map<string, T>();
  return (family) => {
    const id = familyOrTechnical(family);
    let value = made.get(id);
    if (value === undefined) {
      value = make(id);
      made.set(id, value);
    }
    return value;
  };
}

/**
 * The one line a person-side prompt adds for a field (TailorIT's letters, the autofill drafts and answers, the entry
 * bullets): the words of the person's own work. Empty for the technical family, so those prompts stay word for word,
 * and for general (nothing is known about the person's field: nothing is said). v33 FIX-1: it names the field's people
 * as a whole and no area of theirs (the first areas were one occupation's: a truck driver's letter was told to use a
 * warehouse associate's picking and packing).
 */
export function familyVoice(family?: RoleFamilyId | null): string {
  if (family === GENERAL_FAMILY_ID) return '';
  const words = wordsOf(family);
  if (!words) return '';
  return `Use the plain words ${words.aPerson} uses about their own work, never another field's jargon.`;
}

/** What a person of the field calls the things a resume entry names ("equipment, systems and methods"); null for technical. */
export function familyToolWord(family?: RoleFamilyId | null): string | null {
  return wordsOf(family)?.toolWord ?? null;
}

/** "a nurse"; null for technical. */
export function familyPerson(family?: RoleFamilyId | null): string | null {
  return wordsOf(family)?.aPerson ?? null;
}

/** The technical family's line of the FIELDS guide (it has no pack). */
const TECHNICAL_FIELD =
  'programming languages, frameworks, cloud services, databases and engineering tools; engineering practices such as ' +
  'CI/CD, code review and incident response';

/** One line per family: its label, then what its keywords are (the job_analysis prompt's FIELDS guide). */
export function fieldLines(): string[] {
  return ROLE_FAMILIES.map((family) => {
    const words = wordsOf(family.id);
    const what = words ? `${words.toolKinds}; ${words.practice} practices such as ${words.practices.slice(0, 3).join(', ')}` : TECHNICAL_FIELD;
    return `- ${family.label}: ${what}`;
  });
}
