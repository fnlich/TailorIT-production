import {
  DISPLAY_STATUS_DRAFT,
  STATUS,
  displayStatusOf,
  formatMediumDate,
  visibleColumns,
  type ApplicationSummary,
  type ApplyRecord,
  type ApplyVia,
  type BoardColumn,
  type ColumnMode,
  type ColumnPrefs,
  type DisplayStatus,
} from '@tailorit/shared';

// v20 A30: the Tracker's Draft, the derived status of a Saved entry whose job has a live queue row (prepared, its kit
// frozen, waiting or being applied): a Draft column between Saved and Applied on the board, Draft in the list and the
// detail. Pure, so it is unit-tested. Draft's words are the constant STATUS_DRAFT_LABEL (usePublicConstants().t).

/** localStorage key of the Draft column's mode (the stored statuses' modes are in COLUMN_PREFS_STORAGE_KEY). */
export const DRAFT_COLUMN_STORAGE_KEY = 'tailorit.tracker.draftColumn';
/** Shown by default, as Saved and Applied are: hideable with its eye, or in Lanes shown. */
export const DRAFT_COLUMN_DEFAULT: ColumnMode = 'forced';

export function readDraftColumnMode(raw: string | null): ColumnMode {
  return raw === 'forced' || raw === 'default' || raw === 'hidden' ? raw : DRAFT_COLUMN_DEFAULT;
}

/** The status a card or a row shows: Draft for a Saved entry in the queue. */
export const shownStatusOf = (application: Pick<ApplicationSummary, 'currentStatus' | 'queued'>): DisplayStatus =>
  displayStatusOf({ status: application.currentStatus, queued: application.queued });

/**
 * The board's columns with Draft between Saved and Applied. A server that answers a 'draft' column is taken as it is;
 * one that does not yet (an older API) has its Saved column split by each card's `queued` (only the cards loaded, so
 * the counts are those of the page).
 */
export function withDraftColumn(columns: readonly BoardColumn[]): BoardColumn[] {
  if (columns.some((column) => column.status === DISPLAY_STATUS_DRAFT)) return [...columns];
  const saved = columns.find((column) => column.status === STATUS.saved);
  if (!saved) return [...columns];
  const drafts = saved.items.filter((item) => item.queued === true);
  const rest = saved.items.filter((item) => item.queued !== true);
  const out: BoardColumn[] = [];
  for (const column of columns) {
    if (column.status !== STATUS.saved) {
      out.push(column);
      continue;
    }
    out.push({ ...column, items: rest, total: Math.max(0, column.total - drafts.length) });
    out.push({ status: DISPLAY_STATUS_DRAFT, total: drafts.length, items: drafts });
  }
  return out;
}

/**
 * The columns the board shows, in order: the stored statuses as visibleColumns gives them, with Draft right after
 * Saved (first, when Saved is hidden) while its mode shows it: forced always, default while it holds a card.
 */
export function boardColumnsShown(
  prefs: ColumnPrefs | null | undefined,
  draftMode: ColumnMode,
  totals: Readonly<Partial<Record<number | string, number>>>,
): DisplayStatus[] {
  const stored: DisplayStatus[] = visibleColumns(prefs, totals);
  const showDraft = draftMode === 'forced' || (draftMode === 'default' && (totals[DISPLAY_STATUS_DRAFT] ?? 0) > 0);
  if (!showDraft) return stored;
  const savedAt = stored.indexOf(STATUS.saved);
  const at = savedAt === -1 ? 0 : savedAt + 1;
  return [...stored.slice(0, at), DISPLAY_STATUS_DRAFT, ...stored.slice(at)];
}

/** The column a board card is in now (Draft cards are Saved ones in the queue). */
export const columnOf = (application: Pick<ApplicationSummary, 'currentStatus' | 'queued'>): DisplayStatus =>
  shownStatusOf(application);

/**
 * Why a Tracker entry cannot be chosen for Prepare & Queue, or null when it can: one added by hand has no job, one past
 * Saved was applied to already, an archived one is not a saved job, and a Draft is in the queue already.
 */
export function prepareBlockReason(
  application: Pick<ApplicationSummary, 'jobId' | 'currentStatus' | 'queued' | 'archivedAt'>,
): string | null {
  if (application.jobId === null) return 'Added by hand: Prepare & Queue needs a job from Jobs.';
  if (application.archivedAt) return 'Archived: restore it to Saved first.';
  if (application.currentStatus !== STATUS.saved) return 'Past Saved in your Job Tracker: applied to already.';
  if (application.queued === true) return 'A draft in your auto-apply queue already.';
  return null;
}

/** The Draft entry's line in the detail's timeline ("In your auto-apply queue since Nov 13"). */
export const DRAFT_TIMELINE_TEXT = 'In your auto-apply queue, with its prepared kit.';

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
