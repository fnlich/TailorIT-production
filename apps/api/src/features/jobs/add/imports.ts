import type { QueuedLinks } from '@tailorit/shared';
import { constantsOf } from '../../../core/constants/service';
import type { AppDeps } from '../../../core/context';
import type { RawPosting, SourceRecord } from '../../ingest/types';
import { queueLinks, type LinkQueueOrigin } from './queue';

// v31 LINK (21-jobs-from-links.md §5): an import is a list of links. A run of a CSV or JSON import (a file, or a Google
// Sheet's copy) or of the free_tailor lake reads its rows as before, but stores none of them: each row's link is queued
// for TailorIT's own read (queue.ts), and its title, company, place and text are ignored. The run says so in its log
// (MSG_JOB_ADD_IMPORT_LINKS); its links' progress is the batch `run:<run id>` (GET /api/admin/jobs/add/run:<id>).

/** The source kinds whose rows are links only. */
export const LINK_LIST_KINDS: ReadonlySet<string> = new Set(['csv', 'json', 'ft_lake']);

/** Whether a source's run queues its rows' links instead of storing them. */
export function isLinkListKind(kind: string): boolean {
  return LINK_LIST_KINDS.has(kind);
}

/** v31 LINK2: what an import's answer says of its columns: the link column read, the others ignored. */
export interface ImportLinksNote {
  column: string | null;
  ignoredColumns: string[];
  message: string;
}

/** The import's note (see ImportLinksNote): MSG_JOB_IMPORT_ONLY_LINKS with the link column and the ignored count. */
export function importLinksNote(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  columns: readonly string[],
  linkColumn: string | null | undefined,
): ImportLinksNote {
  const column = linkColumn ?? null;
  const ignoredColumns = columns.filter((name) => name !== column);
  return {
    column,
    ignoredColumns,
    message: constantsOf(deps).message('MSG_JOB_IMPORT_ONLY_LINKS', { column: column ?? '', ignored: ignoredColumns.length }),
  };
}

/** The queue origin of a link-list source: a Google Sheet's copy, a file, or the lake. */
function originOf(source: SourceRecord): LinkQueueOrigin {
  if (source.kind === 'ft_lake') return 'ft_lake';
  return source.config.sheet ? 'sheets' : 'import';
}

/**
 * Queues the links of a link-list run's rows (see the top), and logs what was queued. Answers what was queued (the
 * run stores nothing).
 */
export async function queueLinksOfRun(
  deps: AppDeps,
  source: SourceRecord,
  runId: number,
  postings: readonly RawPosting[],
  log: (line: string) => void,
): Promise<QueuedLinks> {
  const queued = await queueLinks(deps, {
    urls: postings.map((posting) => posting.url),
    origin: originOf(source),
    addedBy: null,
    sourceId: source.id,
    batchId: `run:${runId}`,
  });
  log(constantsOf(deps).message('MSG_JOB_ADD_IMPORT_LINKS', { queued: queued.queued }));
  return queued;
}
