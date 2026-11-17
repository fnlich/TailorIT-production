import type { AutofillSensitive } from '@tailorit/shared/autofill';
import { COUNTRIES } from '@tailorit/shared/jobs';
import type { AppDeps } from '../../../core/context';
import { untrustedText } from '../ai/untrusted';
import { readSensitiveAnswers } from './repository';

// The value screen of the extension's AI steps (work package AF, Phase 4): is a text one of the person's own
// sensitive answers? The one module under profile/ the AI modules may import (autofill-ai.test.ts checks it). It
// answers yes or no and nothing else: no answer leaves this module, none is logged, and a caller learns only that some
// text it already holds equals one. The tiebreak's route asks it about a pick's intended value and aliases, and such
// an item is answered null (reason `sensitive`) without asking Claude.
//
// Compared: the answers that are words or figures (a gender, its self-description, each race, pronouns, a work
// status, the expected salary's figures), each as its stored value and as forms commonly write it; since the extension's
// snapshot round 2 (the review fix P2) also the Asian subgroups, the race and the sexual orientation in the person's own
// words, each sexual orientation, a clearance's level, each citizenship's country by its name, and the companies
// where a relative works. Not compared: the yes-or-no answers (every "Yes" would match), the work status `other`, a
// clearance of none, and a country's code or short alias ("US": any country question would match it).

/** The text as a prompt would quote it (the same cleaning), then folded: lower case, accents and punctuation gone. */
function fold(text: string): string {
  return untrustedText(text, 1000)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** How forms write each listed answer, besides its own id. */
const SPELLINGS: Record<string, readonly string[]> = {
  female: ['Female', 'Woman'],
  male: ['Male', 'Man'],
  'non-binary': ['Non-binary', 'Nonbinary', 'Non binary'],
  'american-indian-alaska-native': ['American Indian or Alaska Native', 'American Indian', 'Alaska Native'],
  asian: ['Asian'],
  'black-african-american': ['Black or African American', 'Black', 'African American'],
  'middle-eastern-north-african': ['Middle Eastern or North African', 'Middle Eastern', 'North African'],
  'native-hawaiian-pacific-islander': [
    'Native Hawaiian or Other Pacific Islander',
    'Native Hawaiian or Pacific Islander',
    'Native Hawaiian',
    'Pacific Islander',
  ],
  white: ['White'],
  citizen: ['Citizen'],
  'permanent-resident': ['Permanent resident', 'Green card holder'],
  'work-visa': ['Work visa'],
  'student-visa': ['Student visa'],
  // Snapshot round 2: the Asian subgroups, the sexual orientations and the clearance levels.
  'east-asian': ['East Asian'],
  'south-asian': ['South Asian'],
  'southeast-asian': ['Southeast Asian', 'South East Asian'],
  asexual: ['Asexual'],
  'bisexual-pansexual': ['Bisexual', 'Pansexual', 'Bisexual and/or pansexual', 'Bisexual or pansexual'],
  gay: ['Gay'],
  heterosexual: ['Heterosexual', 'Straight'],
  lesbian: ['Lesbian'],
  queer: ['Queer'],
  'public-trust': ['Public Trust'],
  confidential: ['Confidential'],
  secret: ['Secret'],
  'top-secret': ['Top Secret'],
  'ts-sci': ['TS/SCI', 'Top Secret/SCI', 'Top Secret SCI'],
};

const listed = (id: string) => [id, ...(SPELLINGS[id] ?? [])];

/** A salary figure as forms and profiles write it: 150000, 150,000 and 150k all fold to one of these. */
function figures(amount: number): string[] {
  const out = [String(amount)];
  if (amount >= 1000 && amount % 1000 === 0) out.push(`${amount / 1000}k`);
  return out;
}

/** Every answer of the account that a text could equal, folded. */
function answerTexts(answers: AutofillSensitive): Set<string> {
  const texts: string[] = [];
  for (const country of answers.workAuthorization) {
    const status = country.status;
    if (status.state === 'value' && status.value !== 'other') texts.push(...listed(status.value));
  }
  const { gender, races, pronouns, raceSubgroups, raceSelfDescribed, sexualOrientation } = answers.eeo;
  if (gender.state === 'value') {
    if (gender.value.identity === 'self-describe') texts.push(gender.value.selfDescribed);
    else texts.push(...listed(gender.value.identity));
  }
  if (races.state === 'value') for (const race of races.value) texts.push(...listed(race));
  if (pronouns.state === 'value') texts.push(pronouns.value);
  // Snapshot round 2 (the review fix P2).
  for (const subgroup of raceSubgroups) texts.push(...listed(subgroup));
  texts.push(raceSelfDescribed);
  if (sexualOrientation.state === 'value') {
    for (const value of sexualOrientation.value.values) if (value !== 'self-describe') texts.push(...listed(value));
    texts.push(sexualOrientation.value.selfDescribed);
  }
  const { clearance, citizenships, relativesAt } = answers.legal;
  if (clearance.state === 'value' && clearance.value.level !== 'none') texts.push(...listed(clearance.value.level));
  if (citizenships.state === 'value') {
    for (const code of citizenships.value) {
      const country = Object.hasOwn(COUNTRIES, code) ? COUNTRIES[code] : undefined;
      if (country) texts.push(country.name);
    }
  }
  if (relativesAt.state === 'value') texts.push(...relativesAt.value);
  const salary = answers.compensation.expectedSalary;
  if (salary.state === 'value') {
    texts.push(...figures(salary.value.min));
    if (salary.value.max !== null) texts.push(...figures(salary.value.max));
  }
  return new Set(texts.map(fold).filter((text) => text.length >= 2));
}

/** The texts as they are compared: folded, those too short to compare left out. */
const askedTexts = (texts: readonly string[]): string[] => texts.map(fold).filter((text) => text.length >= 2);

/** Whether any of the texts asked (askedTexts) equals one of these answers. */
function holdsAnswer(asked: readonly string[], answers: AutofillSensitive): boolean {
  const known = answerTexts(answers);
  return asked.some((text) => known.has(text));
}

/**
 * True when any of `texts` equals one of the account's sensitive answers (after the prompts' cleaning, in any case,
 * punctuation and spacing aside); false when none does, or the account has none. Never returns or logs an answer.
 */
export async function isSensitiveAnswer(deps: Pick<AppDeps, 'db'>, userId: string, texts: readonly string[]): Promise<boolean> {
  const asked = askedTexts(texts);
  if (asked.length === 0) return false;
  return holdsAnswer(asked, (await readSensitiveAnswers(deps, userId)).value);
}

/**
 * v3.0 D2: isSensitiveAnswer for every text one request asks about (the tiebreak's and the answers' screens run item by
 * item, synchronously): the account's answers are read once, now, and the screen answers yes or no from them.
 */
export async function sensitiveAnswerScreen(deps: Pick<AppDeps, 'db'>, userId: string): Promise<(texts: readonly string[]) => boolean> {
  const answers = (await readSensitiveAnswers(deps, userId)).value;
  return (texts) => {
    const asked = askedTexts(texts);
    return asked.length > 0 && holdsAnswer(asked, answers);
  };
}
