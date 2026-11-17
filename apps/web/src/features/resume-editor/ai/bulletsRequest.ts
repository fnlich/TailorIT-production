import {
  achievementsFromText,
  bulletsTask,
  type BulletsRequest,
  type BulletsTask,
  type EntryBulletsKind,
  type ResumeDocument,
} from '@tailorit/shared/resume';
import { valueAt } from '../store/actions';

// Write with AI's request for an entry of the on-page editor's document: the fields that name the entry, its dates,
// description, bullets and skills, five facts about the person and the note, built from the stored entry, with
// `markupVersion: 1` because the description, the bullets and the summary hold inline markup. The server reads them
// as the words they print.

type Entry = Record<string, unknown>;

/** The five facts about the person a request carries; never their contact details. */
export interface BulletsPerson {
  name: string;
  title: string;
  /** As typed; read here. */
  totalYearsExperience: string;
  summary: string;
  skills: readonly string[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const clip = (value: string, max: number) => value.trim().slice(0, max);

/** The years as a number (at most one decimal is kept by the server), or null: blank or unreadable. */
export function parseYears(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 80 ? parsed : null;
}

/**
 * The request for one entry: the fields that name it by kind (title and company, name and role, role and
 * organisation), its dates, location, description, bullets (`achievementsText`, one per line) and skills; five facts
 * about the person, never their contact details; the task; and the note when there is one. Clipped to the contract's
 * limits.
 */
export function bulletsRequestFor(
  kind: EntryBulletsKind,
  row: object,
  person: BulletsPerson,
  task: BulletsTask,
  instructions: string,
): BulletsRequest {
  const source = row as Record<string, unknown>;
  const field = (name: string, max = 500) => clip(text(source[name]), max);
  const named =
    kind === 'experience'
      ? { title: field('title'), company: field('company') }
      : kind === 'project'
        ? { name: field('name'), role: field('role') }
        : { role: field('role'), organization: field('organization') };
  const years = parseYears(person.totalYearsExperience);
  const note = instructions.replace(/\s+/g, ' ').trim().slice(0, 300);
  return {
    kind,
    entry: {
      ...named,
      startDate: field('startDate', 50),
      endDate: field('endDate', 50),
      location: field('location'),
      description: field('description', 5000),
      achievements: achievementsFromText(text(source.achievementsText))
        .slice(0, 50)
        .map((line) => line.slice(0, 1000)),
      skills: strings(source.skills)
        .slice(0, 100)
        .map((skill) => skill.slice(0, 100)),
    },
    resume: {
      name: clip(person.name, 200),
      title: clip(person.title, 200),
      ...(years !== null ? { totalYearsExperience: years } : {}),
      summary: clip(person.summary, 5000),
      skills: person.skills.slice(0, 200).map((skill) => skill.slice(0, 100)),
    },
    task,
    ...(note ? { instructions: note } : {}),
  };
}

/** The bullets an entry holds now (markup), blanks left out. */
export function entryBullets(document: ResumeDocument, entryPath: string): string[] {
  const entry = valueAt(document, entryPath) as Entry | undefined;
  return strings(entry?.achievements).filter((line) => line.trim() !== '');
}

/** "write" for an entry with no bullets yet, "improve" once it has some. */
export function entryBulletsTask(document: ResumeDocument, entryPath: string): BulletsTask {
  return bulletsTask(entryBullets(document, entryPath));
}

/** The request for the entry at `entryPath`, or null when the document has no such entry. */
export function entryBulletsRequest(
  document: ResumeDocument,
  entryPath: string,
  kind: EntryBulletsKind,
  task: BulletsTask,
  note: string,
): BulletsRequest | null {
  const entry = valueAt(document, entryPath) as Entry | undefined;
  if (!entry || typeof entry !== 'object') return null;
  const row = { ...entry, achievementsText: entryBullets(document, entryPath).join('\n') };
  const years = document.totalYearsExperience;
  const person = {
    name: document.name ?? '',
    title: document.title ?? '',
    totalYearsExperience: typeof years === 'number' ? String(years) : '',
    summary: document.summary ?? '',
    skills: strings(document.skills),
  };
  return { ...bulletsRequestFor(kind, row, person, task, note), markupVersion: 1 };
}
