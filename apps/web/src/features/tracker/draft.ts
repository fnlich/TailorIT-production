import {
  STATUS,
  formatMediumDate,
  isDraftEntry,
  type ApplicationSummary,
  type ApplyRecord,
  type ApplyVia,
} from '@tailorit/shared';
import type { SavedJobItem } from '@tailorit/shared/prepare';
import type { MessageRenderer } from '@/components/limits/limits';
import { savedMarker, type MarkerView } from '../auto-apply/copy';

// v20 A30: the Tracker's Draft, a Saved entry whose job has a live queue row (prepared, its kit frozen, waiting or being
// applied). v33 TRACKER (F1, the owner: "Draft lane in Job tracker is useless. remove this lane. If the job in saved
// lane is drafted, just mark only as `Draft`"): no Draft lane; the entry stays in Saved with a Draft badge on its card,
// its row and its detail. Pure, so it is unit-tested. Draft's words are the constant STATUS_DRAFT_LABEL
// (usePublicConstants().t).

/** The pre-v3.3 browser key of the Draft lane's mode: cleared once (useTrackerLanes), never read. */
export const LEGACY_DRAFT_COLUMN_STORAGE_KEY = 'tailorit.tracker.draftColumn';

/** Whether a card or a row carries the Draft mark: a Saved, active entry whose job is in the auto-apply queue. */
export const isDraft = (application: Pick<ApplicationSummary, 'currentStatus' | 'queued' | 'archivedAt'>): boolean =>
  isDraftEntry({ status: application.currentStatus, queued: application.queued, archivedAt: application.archivedAt });

/**
 * The marker a card, a row (and the detail, by isDraft) shows: Draft for a Saved entry in the queue (A30; v33 TRACKER,
 * F1: its only sign, the entry stays in Saved), else the Saved pane's marker of a Saved entry (Prepared, Preparing,
 * Filtered: …; `saved`, from GET /api/auto-apply/saved). The pane's own `queued` marker is never drawn: the entry's
 * `queued` decides Draft, so the two reads never show it twice or disagree.
 */
export function trackerMarker(
  application: Pick<ApplicationSummary, 'currentStatus' | 'queued' | 'archivedAt'>,
  saved: Pick<SavedJobItem, 'marker' | 'label' | 'reasons'> | undefined,
  t: MessageRenderer,
): MarkerView | null {
  if (isDraft(application)) return { tone: 'success', icon: 'check', label: t('STATUS_DRAFT_LABEL') };
  if (application.currentStatus !== STATUS.saved || application.archivedAt) return null;
  if (!saved || saved.marker === 'queued') return null;
  return savedMarker(saved, t);
}

/**
 * Why a Tracker entry cannot be chosen for Prepare, or null when it can: one added by hand has no job, one past
 * Saved was applied to already, an archived one is not a saved job, and a Draft is in the queue already.
 */
export function prepareBlockReason(
  application: Pick<ApplicationSummary, 'jobId' | 'currentStatus' | 'queued' | 'archivedAt'>,
): string | null {
  if (application.jobId === null) return 'Added by hand: Prepare needs a job from Jobs.';
  if (application.archivedAt) return 'Archived: restore it to Saved first.';
  if (application.currentStatus !== STATUS.saved) return 'Past Saved in your Job Tracker: applied to already.';
  if (application.queued === true) return 'A draft in your auto-apply queue already.';
  return null;
}

/** What the Draft mark means (the detail's "?" beside it), and when it goes. */
export const DRAFT_MARK_TEXT = 'In your auto-apply queue with its prepared kit; it moves to Applied once applied to.';

// "Applied with" (05: the apply records) ----------------------------------------------------------------------------

/** How an application was sent, as a sentence's middle ("Applied by auto-apply on Nov 13"). */
export const APPLY_VIA_TEXT: Record<ApplyVia, string> = {
  agent: 'by auto-apply',
  tab: "by auto-apply in the extension's Queue tab",
  manual: 'by you (Mark as applied)',
  page: 'with the extension on the job page',
  tracker: 'in your Job Tracker',
  legacy: 'before v2.0',
};

/** The parts an application was sent with: "Resume X", "Cover letter Y", "12 answers". */
export function appliedWithParts(record: Pick<ApplyRecord, 'resume' | 'coverLetter' | 'answers' | 'answerCount'>): string[] {
  const parts: string[] = [];
  if (record.resume) parts.push(`Resume “${record.resume.title}”`);
  if (record.coverLetter) parts.push(`Cover letter “${record.coverLetter.title}”`);
  if (record.answers !== 'none' && record.answerCount > 0) {
    const answers = `${record.answerCount} ${record.answerCount === 1 ? 'answer' : 'answers'}`;
    parts.push(record.answers === 'prepared' ? `${answers} prepared` : answers);
  }
  return parts;
}

/** "Applied by auto-apply on Nov 13, 2026 with Resume “X”, Cover letter “Y” and 12 answers." */
export function appliedWithText(record: ApplyRecord): string {
  const parts = appliedWithParts(record);
  const when = formatMediumDate(record.appliedAt) || record.dayKey;
  const head = `Applied ${APPLY_VIA_TEXT[record.via]} on ${when}`;
  if (parts.length === 0) return `${head}. TailorIT kept no record of the documents it used.`;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${head} with ${list}.`;
}
