import type { JobImportSummary } from '@tailorit/shared';
import { readStored, writeStored } from '@/lib/storage';

// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §3): a person may close Add job while an import runs; reopening it shows
// the latest import's results. The API lists no person's imports, so the latest one is remembered in this browser, per
// account and profile (a convenience: when it is gone, Add job simply starts afresh). Only ids and times are kept.
// v35 FIX-WEB (the final review's fix list, item 9): the latest import is the API's (GET /api/jobs/imports/recent?limit=1, the
// profile's newest, on every device). This browser keeps only a hint, shown while that request runs (or when it fails),
// and which import New import put aside here (`dismissed`: Add job does not open on it again in this browser).

/** How long after an import started Add job opens on its results. */
export const LATEST_IMPORT_OPENS_FOR_MS = 60 * 60_000;

export interface LatestImport {
  /** The import's id (GET /api/jobs/imports/:id). */
  id: number;
  way: 'file' | 'sheet';
  /** When it started (ms since the epoch). */
  startedAt: number;
  /** v35 FIX-WEB: New import put it aside in this browser (Add job opens afresh). */
  dismissed?: boolean;
}

/** The storage key of an account's latest import on a profile ("me": their own). */
export function latestImportKey(accountId: string, profile: string | null): string {
  return `tailorit.jobs.import.latest.${accountId}.${profile ?? 'me'}`;
}

/** The remembered import, or null (none, or not one). */
export function parseLatestImport(text: string | null): LatestImport | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<LatestImport>;
    if (!Number.isSafeInteger(value.id) || (value.id as number) <= 0) return null;
    if (value.way !== 'file' && value.way !== 'sheet') return null;
    if (typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)) return null;
    return { id: value.id as number, way: value.way, startedAt: value.startedAt, ...(value.dismissed === true ? { dismissed: true } : {}) };
  } catch {
    return null;
  }
}

export function readLatestImport(key: string | null): LatestImport | null {
  return key ? parseLatestImport(readStored(key)) : null;
}

export function writeLatestImport(key: string | null, latest: LatestImport | null): void {
  if (key) writeStored(key, latest ? JSON.stringify(latest) : null);
}

/** The tab Add job opens on: the latest import's while it is recent, else One link. */
export function openingTab(latest: LatestImport | null, now: number): 'link' | 'file' | 'sheet' {
  return latest && !latest.dismissed && now - latest.startedAt < LATEST_IMPORT_OPENS_FOR_MS ? latest.way : 'link';
}

/** v35 FIX-WEB: the API's latest import as Add job keeps it (a file's or a sheet's; null: none, or another way). */
export function latestOfSummary(summary: Pick<JobImportSummary, 'id' | 'way' | 'createdAt'> | null): LatestImport | null {
  if (!summary || (summary.way !== 'file' && summary.way !== 'sheet')) return null;
  const startedAt = Date.parse(summary.createdAt);
  return Number.isFinite(startedAt) ? { id: summary.id, way: summary.way, startedAt } : null;
}

/**
 * v35 FIX-WEB: the latest import Add job shows: the API's (`server`; undefined while its request runs or when it failed,
 * so this browser's hint stands in), unless New import put that one aside in this browser.
 */
export function latestShown(server: LatestImport | null | undefined, hint: LatestImport | null): LatestImport | null {
  if (server === undefined) return hint && !hint.dismissed ? hint : null;
  if (server === null) return null;
  return hint && hint.id === server.id && hint.dismissed ? null : server;
}
