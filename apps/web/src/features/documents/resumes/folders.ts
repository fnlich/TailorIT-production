import { editedAgo } from '@tailorit/shared/format';
import type { ResumeSummary } from '@tailorit/shared/resume';
import { sortResumes } from './list';

/*
 * v1.5 W (decision 6): Documents › Resumes as folders, free of React. Three folders by how a resume came to be
 * (`madeBy`): Uploaded resumes, Edited resumes (built in the editor, imported, duplicated, or an upload's editable
 * copy) and Tailored resumes, which shows them all (Total) or by the local day each was made (By date). Where the
 * person is lives in the address: `?tab=resumes&folder=tailored&mode=date&date=2026-11-09`.
 */

export const RESUME_FOLDERS = ['uploaded', 'edited', 'tailored'] as const;
export type ResumeFolder = (typeof RESUME_FOLDERS)[number];

export const FOLDER_NAME: Record<ResumeFolder, string> = {
  uploaded: 'Uploaded resumes',
  edited: 'Edited resumes',
  tailored: 'Tailored resumes',
};

/** The line under a folder's name. */
export const FOLDER_HINT: Record<ResumeFolder, string> = {
  uploaded: 'Your files, kept exactly as uploaded',
  edited: 'Resumes you built, and editable copies of uploads',
  tailored: 'Resumes tailored for a job',
};

export const TAILORED_MODES = ['total', 'date'] as const;
export type TailoredMode = (typeof TAILORED_MODES)[number];
export const TAILORED_MODE_LABEL: Record<TailoredMode, string> = { total: 'Total', date: 'By date' };

/** Where the person is: the folders (folder null), a folder, and in Tailored resumes the mode and the day open. */
export interface FolderLocation {
  folder: ResumeFolder | null;
  /** Tailored resumes only ('total' elsewhere). */
  mode: TailoredMode;
  /** A local day, YYYY-MM-DD: Tailored resumes by date only. */
  date: string | null;
}

export const TOP_LEVEL: FolderLocation = { folder: null, mode: 'total', date: null };

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day written YYYY-MM-DD ("2026-02-30" is not one). */
export function isDateKey(value: string | null | undefined): value is string {
  const match = value ? DATE_KEY.exec(value) : null;
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/** The address's folder, mode and day; anything that does not read is left out (a typo opens the folders). */
export function readLocation(params: { get(name: string): string | null }): FolderLocation {
  const raw = params.get('folder');
  const folder = (RESUME_FOLDERS as readonly string[]).includes(raw ?? '') ? (raw as ResumeFolder) : null;
  if (folder !== 'tailored') return { folder, mode: 'total', date: null };
  const mode: TailoredMode = params.get('mode') === 'date' ? 'date' : 'total';
  const date = params.get('date');
  return { folder, mode, date: mode === 'date' && isDateKey(date) ? date : null };
}

/** The Resumes tab's address at a place: `/documents?tab=resumes&folder=tailored&mode=date&date=2026-11-09`. */
export function folderHref(location: FolderLocation): string {
  const params = new URLSearchParams({ tab: 'resumes' });
  if (location.folder) params.set('folder', location.folder);
  if (location.folder === 'tailored' && location.mode === 'date') {
    params.set('mode', 'date');
    if (location.date) params.set('date', location.date);
  }
  return `/documents?${params.toString()}`;
}

/** The same address with every other parameter of the page kept (the folder's own ones replaced). */
export function withLocation(current: string, location: FolderLocation): string {
  const params = new URLSearchParams(current);
  for (const name of ['folder', 'mode', 'date']) params.delete(name);
  params.set('tab', 'resumes');
  for (const [name, value] of new URLSearchParams(folderHref(location).split('?')[1])) params.set(name, value);
  return `/documents?${params.toString()}`;
}

export function sameLocation(a: FolderLocation, b: FolderLocation): boolean {
  return a.folder === b.folder && a.mode === b.mode && a.date === b.date;
}

/** The folder a resume is kept in, by how it came to be (an upload is always Uploaded resumes). */
export function folderOf(resume: Pick<ResumeSummary, 'kind' | 'madeBy'>): ResumeFolder {
  if (resume.kind === 'uploaded' || resume.madeBy === 'upload') return 'uploaded';
  return resume.madeBy === 'tailor' ? 'tailored' : 'edited';
}

/** The local calendar day of a time, YYYY-MM-DD (the browser's time zone); null when it does not read. */
export function localDateKey(iso: string): string | null {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const timeOf = (iso: string) => {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
};

/** Newest made first (a tailored resume's day is the day it was made), ties by id. */
export function newestMadeFirst<T extends Pick<ResumeSummary, 'id' | 'createdAt'>>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The latest change among some resumes (null for none). */
function latestUpdate(items: readonly Pick<ResumeSummary, 'updatedAt'>[]): string | null {
  let latest: string | null = null;
  for (const item of items) if (latest === null || timeOf(item.updatedAt) > timeOf(latest)) latest = item.updatedAt;
  return latest;
}

export interface FolderTile {
  /** A folder, or a day of Tailored resumes. */
  key: string;
  name: string;
  hint: string;
  count: number;
  /** The latest change of a resume in it; null when it is empty. */
  updatedAt: string | null;
  location: FolderLocation;
}

/** The three folders, each with how many resumes it holds and when one of them last changed. */
export function folderTiles(items: readonly ResumeSummary[], tailoredMode: TailoredMode = 'total'): FolderTile[] {
  return RESUME_FOLDERS.map((folder) => {
    const inside = items.filter((item) => folderOf(item) === folder);
    return {
      key: folder,
      name: FOLDER_NAME[folder],
      hint: FOLDER_HINT[folder],
      count: inside.length,
      updatedAt: latestUpdate(inside),
      location: { folder, mode: folder === 'tailored' ? tailoredMode : 'total', date: null },
    };
  });
}

/** Tailored resumes by the local day each was made, newest day first. */
export function dateTiles(items: readonly ResumeSummary[], now: number): FolderTile[] {
  const days = new Map<string, ResumeSummary[]>();
  for (const item of items) {
    if (folderOf(item) !== 'tailored') continue;
    const day = localDateKey(item.createdAt);
    if (!day) continue;
    days.set(day, [...(days.get(day) ?? []), item]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, inside]) => ({
      key: day,
      name: day,
      hint: dayHint(day, now),
      count: inside.length,
      updatedAt: latestUpdate(inside),
      location: { folder: 'tailored', mode: 'date', date: day },
    }));
}

/** "Today", "Yesterday", the weekday within the week, else the month and day ("Oct 15", "Oct 15, 2025"). */
export function dayHint(day: string, now: number): string {
  if (!isDateKey(day)) return '';
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const then = new Date(year, month - 1, date);
  const today = new Date(now);
  const days = Math.round(
    (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(year, month - 1, date)) / 86_400_000,
  );
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return then.toLocaleDateString('en-US', { weekday: 'long' });
  return then.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(year === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** Whether the place shows folders (the top level, and Tailored resumes by date before a day is open). */
export function showsFolders(location: FolderLocation): boolean {
  return location.folder === null || (location.folder === 'tailored' && location.mode === 'date' && location.date === null);
}

/**
 * The resumes shown at a place: a folder's own (Uploaded and Edited: the default first, then the newest change;
 * Tailored: the newest made first), one day's tailored resumes, or every tailored one while the days are listed.
 * The top level holds every resume (search spans them all).
 */
export function itemsAt(items: readonly ResumeSummary[], location: FolderLocation): ResumeSummary[] {
  if (location.folder === null) return sortResumes(items);
  const inside = items.filter((item) => folderOf(item) === location.folder);
  if (location.folder !== 'tailored') return sortResumes(inside);
  const newest = newestMadeFirst(inside);
  return location.mode === 'date' && location.date ? newest.filter((item) => localDateKey(item.createdAt) === location.date) : newest;
}

/** What the list holds: while a search runs, every resume (search spans every folder); else the place's own. */
export function itemsShown(items: readonly ResumeSummary[], location: FolderLocation, searching: boolean): ResumeSummary[] {
  return searching ? sortResumes(items) : itemsAt(items, location);
}

export interface Crumb {
  label: string;
  location: FolderLocation;
  /** The place itself (the last crumb). */
  current: boolean;
}

/** "Resumes › Tailored resumes › 2026-11-09": each step up is a link, the place itself the last. */
export function breadcrumbs(location: FolderLocation): Crumb[] {
  const crumbs: Crumb[] = [{ label: 'Resumes', location: TOP_LEVEL, current: false }];
  if (location.folder) {
    crumbs.push({
      label: FOLDER_NAME[location.folder],
      location: { folder: location.folder, mode: location.mode, date: null },
      current: false,
    });
  }
  if (location.folder === 'tailored' && location.mode === 'date' && location.date) {
    crumbs.push({ label: location.date, location, current: false });
  }
  crumbs[crumbs.length - 1]!.current = true;
  return crumbs;
}

/** One step up (Back): a day to its days, a folder to the folders; null at the top. */
export function parentOf(location: FolderLocation): FolderLocation | null {
  if (location.folder === null) return null;
  if (location.folder === 'tailored' && location.mode === 'date' && location.date) {
    return { folder: 'tailored', mode: 'date', date: null };
  }
  return TOP_LEVEL;
}

/** The place's own name: the folder's, or the day's. */
export function locationTitle(location: FolderLocation): string {
  if (location.folder === null) return 'Resumes';
  if (location.folder === 'tailored' && location.date) return location.date;
  return FOLDER_NAME[location.folder];
}

/** Where a resume lives, for a search result: its folder, and in Tailored resumes its day. */
export function locationOf(resume: Pick<ResumeSummary, 'kind' | 'madeBy' | 'createdAt'>): FolderLocation {
  const folder = folderOf(resume);
  if (folder !== 'tailored') return { folder, mode: 'total', date: null };
  const date = localDateKey(resume.createdAt);
  return date ? { folder, mode: 'date', date } : { folder, mode: 'total', date: null };
}

/** "Tailored resumes › 2026-11-09", "Uploaded resumes". */
export function locationPath(location: FolderLocation): string {
  return breadcrumbs(location)
    .slice(1)
    .map((crumb) => crumb.label)
    .join(' › ');
}

/** "3 resumes", "1 resume", "Empty". */
export function countText(count: number): string {
  if (count === 0) return 'Empty';
  return `${count} ${count === 1 ? 'resume' : 'resumes'}`;
}

/** "Updated 2 hours ago", "Updated 10/15/2026"; null for an empty folder. */
export function updatedText(updatedAt: string | null, now: number): string | null {
  if (!updatedAt) return null;
  return editedAgo(updatedAt, now)?.replace(/^Edited /, 'Updated ') ?? null;
}

/** A folder tile's line: "3 resumes · Updated 2 hours ago", or "Empty". */
export function tileMeta(tile: Pick<FolderTile, 'count' | 'updatedAt'>, now: number): string {
  const updated = updatedText(tile.updatedAt, now);
  return updated ? `${countText(tile.count)} · ${updated}` : countText(tile.count);
}

/**
 * The line under a place's title: "3 resumes · Updated 2 hours ago"; Tailored resumes by date, "12 resumes on 4 days";
 * a day, named first ("Today · 2 resumes · Updated 3 hours ago").
 */
export function folderSummary(location: FolderLocation, here: readonly ResumeSummary[], now: number): string {
  if (showsFolders(location) && location.folder === 'tailored') {
    const days = new Set(here.map((item) => localDateKey(item.createdAt)).filter(Boolean)).size;
    return days > 0 ? `${countText(here.length)} on ${days} ${days === 1 ? 'day' : 'days'}` : countText(0);
  }
  const meta = tileMeta({ count: here.length, updatedAt: latestUpdate(here) }, now);
  const day = location.folder === 'tailored' && location.date ? dayHint(location.date, now) : '';
  return day ? `${day} · ${meta}` : meta;
}

/**
 * The place a move left, when the move went up from it (Back, a breadcrumb): the tile to focus there (a folder's key,
 * or a day). Null for any other move.
 */
export function tileLeftBehind(from: FolderLocation, to: FolderLocation): string | null {
  if (from.folder === null) return null;
  if (to.folder === null) return from.folder;
  if (from.folder === 'tailored' && to.folder === 'tailored' && from.date && to.mode === 'date' && to.date === null) return from.date;
  return null;
}

/** A folder with nothing in it while other resumes exist: what to say, and what to offer. */
export function emptyFolderCopy(location: FolderLocation): { title: string; description: string; action: 'upload' | 'new' | 'jobs' | 'dates' } {
  if (location.folder === 'uploaded') {
    return { title: 'No uploaded resumes yet', description: 'Uploads are kept here exactly as they are.', action: 'upload' };
  }
  if (location.folder === 'edited') {
    return {
      title: 'No edited resumes yet',
      description: 'Resumes you build or copy from an upload land here.',
      action: 'new',
    };
  }
  if (location.date) {
    return { title: `No tailored resumes on ${location.date}`, description: 'They may have been deleted. Choose another day.', action: 'dates' };
  }
  return {
    title: 'No tailored resumes yet',
    description: 'Resumes you tailor for a job are kept here by day.',
    action: 'jobs',
  };
}
