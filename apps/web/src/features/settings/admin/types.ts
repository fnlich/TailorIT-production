import type { AiHealth } from '@tailorit/shared';

/*
 * The admin console's view of the API where @tailorit/shared has no contract: the Add source dialog's bodies and tests,
 * and an import's answer (apps/api/src/features/ingest/router.ts); keep them in step. The import contracts (the file
 * preview and the Google Sheet import) live in @tailorit/shared/ingest. v30 INT-3: Sources, Runs and Hosts read
 * @tailorit/shared/sourcing (S1-WEB), Review @tailorit/shared/reviews (X1-WEB); Reports is retired.
 */

export {
  IMPORT_FIELDS,
  type ImportField,
  type ImportMapping,
  type ImportPreview,
  type SheetAccount,
  type SheetImportBody,
  type SheetPreview,
  type SheetPreviewBody,
  type SheetSourceConfig,
  type SheetTab,
} from '@tailorit/shared/ingest';

export const SOURCE_KINDS = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'workday',
  'page',
  'csv',
  'json',
  'ft_lake',
  'seed',
  // v30 X1-API: the published page jobs' one source ("Published page jobs", never run).
  'ext_page',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Kinds an admin adds from the "Add source" dialog (files and sheets are imports: Admin › Import, v3.5). */
export const ADDABLE_KINDS = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'usajobs', // v30 S4
  'himalayas', // v30 S4
  'jobicy', // v30 S4
  'career_site', // v30 FIX-WEB (REQ-5): an employer's own career site, added by hand
  'workday_site', // v35 OPSWEB (PLAN H7): a Workday career site, from any page of it
  'bamboohr', // v37 BOARDS (PLAN B4): a BambooHR company, by its name or careers address
  'icims', // v37 BOARDS (PLAN I1): an employer's iCIMS site, by its address
  'ft_lake',
  'seed',
] as const;
export type AddableKind = (typeof ADDABLE_KINDS)[number];

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'partial' | 'not_modified' | 'paused'; // v31 RUNS: paused
export type RunTrigger = 'schedule' | 'manual' | 'upload' | 'startup';

export interface RunSummary {
  id: number;
  status: RunStatus;
  trigger: RunTrigger;
  startedAt: string;
  finishedAt: string | null;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  failed: number;
  error: string | null;
}

export interface AdminSource {
  id: number;
  kind: SourceKind;
  kindLabel: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  schedule: string;
  deactivateMissing: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  jobCount: number;
  activeJobCount: number;
  running: boolean;
  lastRun: RunSummary | null;
}

export interface AdminRun extends RunSummary {
  sourceId: number;
  sourceKind: SourceKind;
  /** "Greenhouse", "CSV import", "Google Sheet"... */
  sourceKindLabel: string;
  sourceName: string;
}

export interface AdminRunDetail extends AdminRun {
  log: string[];
}

export interface SourceTestResult {
  ok: boolean;
  message: string;
  count: number;
  samples: string[];
  companyName: string | null;
}

export interface LakeTestResult {
  ok: boolean;
  message: string;
  path: string;
  exists: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
  counts: { jobs: number; withAnalysis: number; recent: number } | null;
  newestUpdatedAt: string | null;
}

export interface NewSourceBody {
  kind: AddableKind;
  name?: string;
  config: Record<string, string>;
  /** v36 SOURCES (PLAN S4): Add source's "Turn on now" (ticked by default); unticked, the source is added off. */
  enabled?: boolean;
}

export interface ImportResult {
  source: AdminSource;
  /** Null when a large file (or a slow sheet tab) is still importing in the background (follow `runId` under Runs). */
  run: AdminRunDetail | null;
  runId: number;
  /**
   * v31 ADMINWEB: LINK2's note on an import of links (optional: a server before LINK2 leaves it out): the link column
   * read, the columns ignored, and its words (MSG_JOB_IMPORT_ONLY_LINKS).
   */
  links?: ImportLinksNote;
}

/** v31 ADMINWEB: an import answer's `links` (apps/api/src/features/jobs/add/imports.ts ImportLinksNote, LINK2). */
export interface ImportLinksNote {
  column: string | null;
  ignoredColumns: string[];
  message: string;
}

export type { AiHealth };

export interface AiTestResult {
  ok: boolean;
  model: string;
  ms: number;
  answer: string | null;
  error?: { code: string; message: string; detail: string };
}

// v2.0: Admin › Users' rows come from the shared contract (AdminUserSchema moved to @tailorit/shared/accounts).
export type { AdminUser, AdminUserPatchResponse as AdminUserPatchAnswer } from '@tailorit/shared/accounts';
