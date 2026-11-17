import {
  JobSourcePurgeRequestSchema,
  type AdminSourceRow,
  type JobSourcePurge,
  type JobSourcePurgeReason,
  type JobSourcePurgeRequest,
  type JobSourcePurgeState,
} from '@tailorit/shared/sourcing';
import type { BadgeTone } from '../../../../components/ui/Badge';

// v30 S1-WEB: a purge by source (11 §8.5, 12 §8.5): of one source or of every source of its company, for a reason; it
// closes the jobs only those sources list and deletes their raw payloads, and with "delete the texts" their posting
// texts, except an applied job's, which only a contract that demands it deletes (CT's JobSourcePurgeRequestSchema says
// so too). Pure.

export type PurgeScope = 'source' | 'company';

export interface PurgeDraft {
  scope: PurgeScope;
  reason: JobSourcePurgeReason;
  deleteTexts: boolean;
  deleteAppliedTexts: boolean;
}

export const EMPTY_PURGE_DRAFT: PurgeDraft = { scope: 'source', reason: 'admin', deleteTexts: false, deleteAppliedTexts: false };

/** Whether "delete applied jobs' texts" may be ticked: only with the other texts, when a contract ended. */
export function appliedTextsAllowed(draft: Pick<PurgeDraft, 'reason' | 'deleteTexts'>): boolean {
  return draft.deleteTexts && draft.reason === 'contract_end';
}

/** The request a draft makes for a source's row, checked against CT's schema; null when it is not one (it says why). */
export function purgeRequestOf(
  draft: PurgeDraft,
  row: Pick<AdminSourceRow, 'id' | 'companyId'>,
): { ok: true; request: JobSourcePurgeRequest } | { ok: false; error: string } {
  const target = draft.scope === 'company' && row.companyId !== null ? { companyId: row.companyId } : { sourceId: row.id };
  const checked = JobSourcePurgeRequestSchema.safeParse({
    ...target,
    reason: draft.reason,
    deleteTexts: draft.deleteTexts,
    deleteAppliedTexts: appliedTextsAllowed(draft) && draft.deleteAppliedTexts,
  });
  return checked.success ? { ok: true, request: checked.data } : { ok: false, error: checked.error.issues[0]?.message ?? 'Check the choices.' };
}

export const PURGE_STATE_LABEL: Record<JobSourcePurgeState, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
};

export const PURGE_STATE_TONE: Record<JobSourcePurgeState, BadgeTone> = {
  queued: 'neutral',
  running: 'sky',
  done: 'success',
  failed: 'destructive',
};

/** What a purge has done so far: "12 jobs closed · 30 texts deleted · 2 texts kept for applications · 44 raw payloads deleted". */
export function purgeCounts(purge: Pick<JobSourcePurge, 'jobsClosed' | 'textsDeleted' | 'textsKeptForApplications' | 'rawDeleted'>): string {
  const n = (count: number) => count.toLocaleString('en-US');
  const parts = [
    `${n(purge.jobsClosed)} ${purge.jobsClosed === 1 ? 'job' : 'jobs'} closed`,
    purge.textsDeleted ? `${n(purge.textsDeleted)} ${purge.textsDeleted === 1 ? 'text' : 'texts'} deleted` : '',
    purge.textsKeptForApplications ? `${n(purge.textsKeptForApplications)} kept for applications` : '',
    purge.rawDeleted ? `${n(purge.rawDeleted)} raw ${purge.rawDeleted === 1 ? 'payload' : 'payloads'} deleted` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

/** What a purge covers: "Greenhouse board acme" (the source's name) or "Every source of Acme". */
export function purgeTarget(purge: Pick<JobSourcePurge, 'sourceId' | 'sourceName' | 'companyId' | 'companyName'>): string {
  if (purge.companyId !== null) return `Every source of ${purge.companyName ?? `company #${purge.companyId}`}`;
  return purge.sourceName ?? `Source #${purge.sourceId ?? '?'}`;
}

/** Who asked: the admin's email; an opt-out's own purge or a deleted account otherwise. */
export function requestedByText(purge: Pick<JobSourcePurge, 'requestedBy' | 'reason'>): string {
  if (purge.requestedBy) return purge.requestedBy;
  return purge.reason === 'opt_out' ? 'The opt-out itself' : 'A deleted account';
}

/** Whether a list holds a purge still at work (the sheet follows it). */
export function hasOpenPurge(purges: readonly Pick<JobSourcePurge, 'state'>[]): boolean {
  return purges.some((purge) => purge.state === 'queued' || purge.state === 'running');
}
