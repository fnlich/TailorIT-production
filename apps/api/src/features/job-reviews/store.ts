import type {
  JobReviewCheckState,
  JobReviewDecider,
  JobReviewKind,
  JobReviewOrigin,
  JobReviewSignal,
  JobReviewState,
  JobReviewStrength,
  JobReviewVia,
} from '@tailorit/shared';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import type { DbQueries } from '../../core/db/types';
import { trustedSql, trustParams } from './trust';
import { DAY_MS } from '@tailorit/shared';

// v30 X1-API: the review tables' reads and writes (docs/design/part2/14-extension-reports.md §5, §9): one pending review
// per subject (ux_job_reviews_open: a second report bumps it), one report row per account and review (a second report
// from the same account updates its row), and the review's counts kept from its rows. Every write here runs in the
// caller's transaction; the review row's lock (the ON CONFLICT's, or reviewById's FOR UPDATE) orders two reports of one
// subject, so the second one's count sees the first's row.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

/** A job_reviews row as read. */
export interface ReviewRow {
  id: number;
  kind: JobReviewKind;
  subject_key: string;
  job_id: number;
  origin: JobReviewOrigin | null;
  page_host: string | null;
  link_source_id: number | null;
  link_source_job_id: string | null;
  state: JobReviewState;
  reporters: number;
  trusted_reporters: number;
  strongest: JobReviewStrength | null;
  check_state: JobReviewCheckState;
  checked_at: string | null;
  decided_by: JobReviewDecider | null;
  decided_by_user: string | null;
  decided_at: string | null;
  note: string | null;
  first_reported_at: string;
  last_reported_at: string;
  reopened_at: string | null;
  /** v35 ADMIN (migration 0058): a held new job an admin's import read, and that import's run (null once gone). */
  imported: boolean;
  import_run_id: number | null;
}

export const REVIEW_COLUMNS =
  'id, kind, subject_key, job_id, origin, page_host, link_source_id, link_source_job_id, state, reporters, ' +
  'trusted_reporters, strongest, check_state, checked_at, decided_by, decided_by_user, decided_at, note, ' +
  'first_reported_at, last_reported_at, reopened_at, imported, import_run_id';

/** The review, or undefined; with `lock`, its row locked for the rest of the transaction. */
export async function reviewById(db: DbQueries, id: number, lock = false): Promise<ReviewRow | undefined> {
  return db.one<ReviewRow>(`SELECT ${REVIEW_COLUMNS} FROM job_reviews WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
}

/** The subject's pending review, or undefined. */
export async function pendingReview(db: DbQueries, kind: JobReviewKind, subjectKey: string): Promise<ReviewRow | undefined> {
  return db.one<ReviewRow>(`SELECT ${REVIEW_COLUMNS} FROM job_reviews WHERE kind = ? AND subject_key = ? AND state = 'pending'`, [
    kind,
    subjectKey,
  ]);
}

export interface OpenReviewInput {
  kind: JobReviewKind;
  subjectKey: string;
  jobId: number;
  origin?: JobReviewOrigin | null;
  pageHost?: string | null;
  at: string;
}

/**
 * The subject's pending review, opened now or bumped (its last report time), in one statement: two reports of one
 * subject at once make one review (the second waits for the first's row, then updates it). Answers its id, row locked.
 */
export async function openReview(t: DbQueries, input: OpenReviewInput): Promise<number> {
  const row = await t.one<{ id: number }>(
    `INSERT INTO job_reviews(kind, subject_key, job_id, origin, page_host, first_reported_at, last_reported_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, subject_key) WHERE state = 'pending'
     DO UPDATE SET last_reported_at = GREATEST(job_reviews.last_reported_at, excluded.last_reported_at), updated_at = excluded.updated_at
     RETURNING id`,
    [input.kind, input.subjectKey, input.jobId, input.origin ?? null, input.pageHost ?? null, input.at, input.at, input.at, input.at],
  );
  return row!.id;
}

export interface ReportInput {
  via: JobReviewVia;
  signal?: JobReviewSignal | null;
  marker?: string | null;
  strength?: JobReviewStrength | null;
  pageJobId?: number | null;
  textHash?: Buffer | null;
  details?: string | null;
  seenAt: string;
  dayKey: string;
  at: string;
}

/** A strength's rank: a stronger report from the same account wins its row (strong > person > weak > none). */
const RANK_SQL = (strength: string) => `CASE ${strength} WHEN 'strong' THEN 3 WHEN 'person' THEN 2 WHEN 'weak' THEN 1 ELSE 0 END`;
export const STRENGTH_RANK: Record<JobReviewStrength, number> = { weak: 1, person: 2, strong: 3 };

/**
 * The account's report row on the review: added, or updated (a second report from the same account keeps one row: its
 * newest time and day key; its strongest signal, so a later automatic weak report never hides the person's own button;
 * the newest details, page job and text hash given). Answers whether the row is new.
 */
export async function upsertReport(t: DbQueries, reviewId: number, userId: string, input: ReportInput): Promise<boolean> {
  const stronger = `${RANK_SQL('excluded.strength')} >= ${RANK_SQL('job_review_reports.strength')}`;
  const row = await t.one<{ added: boolean }>(
    `INSERT INTO job_review_reports(review_id, user_id, via, signal, marker, strength, page_job_id, text_hash, details, seen_at,
       day_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (review_id, user_id) DO UPDATE SET
       via = CASE WHEN ${stronger} THEN excluded.via ELSE job_review_reports.via END,
       signal = CASE WHEN ${stronger} THEN excluded.signal ELSE job_review_reports.signal END,
       marker = CASE WHEN ${stronger} THEN excluded.marker ELSE job_review_reports.marker END,
       strength = CASE WHEN ${stronger} THEN excluded.strength ELSE job_review_reports.strength END,
       page_job_id = COALESCE(excluded.page_job_id, job_review_reports.page_job_id),
       text_hash = COALESCE(excluded.text_hash, job_review_reports.text_hash),
       details = COALESCE(excluded.details, job_review_reports.details),
       seen_at = GREATEST(job_review_reports.seen_at, excluded.seen_at),
       day_key = excluded.day_key,
       updated_at = excluded.updated_at
     RETURNING (xmax = 0) AS added`,
    [
      reviewId,
      userId,
      input.via,
      input.signal ?? null,
      input.marker ?? null,
      input.strength ?? null,
      input.pageJobId ?? null,
      input.textHash ?? null,
      input.details ?? null,
      input.seenAt,
      input.dayKey,
      input.at,
      input.at,
    ],
  );
  return row!.added === true;
}

/** What the auto rules read of a review's reports (recountReview). */
export interface ReviewTally {
  reporters: number;
  /** Trusted accounts (for a closed link: whose report is within EXT_REPORT_WINDOW_DAYS). */
  trustedReporters: number;
  strongest: JobReviewStrength | null;
  /** A counted report is strong or a person's own word (a closed link's reporters' rule needs one). */
  trustedStrongOrPerson: boolean;
  /** A page job's agreement: the most trusted accounts that captured one normalised text, and that text's hash. */
  agreeing: number;
  agreedHash: string | null;
}

/**
 * Counts the review's report rows again and stores the counts on the review (reporters, trusted_reporters, strongest),
 * in the caller's transaction. A closed link's trusted reporters are those within EXT_REPORT_WINDOW_DAYS; a new job's
 * are every trusted adder (text agreement does not age).
 */
export async function recountReview(deps: Deps, t: DbQueries, reviewId: number, now: Date): Promise<ReviewTally> {
  const review = await t.one<{ kind: JobReviewKind }>('SELECT kind FROM job_reviews WHERE id = ?', [reviewId]);
  const rows = await t.all<{ strength: JobReviewStrength | null; seen_at: string; text_hash: Buffer | null; trusted: boolean }>(
    `SELECT r.strength, r.seen_at, r.text_hash, ${trustedSql('u')} AS trusted
     FROM job_review_reports r JOIN users u ON u.id = r.user_id WHERE r.review_id = @reviewId`,
    { reviewId, ...trustParams(deps, now) },
  );
  const windowStart = now.getTime() - constantsOf(deps).get('EXT_REPORT_WINDOW_DAYS') * DAY_MS;
  const counted = rows.filter((row) => row.trusted === true && (review?.kind !== 'closed' || Date.parse(row.seen_at) >= windowStart));
  let strongest: JobReviewStrength | null = null;
  for (const row of rows) {
    if (row.strength && (strongest === null || STRENGTH_RANK[row.strength] > STRENGTH_RANK[strongest])) strongest = row.strength;
  }
  const byHash = new Map<string, number>();
  for (const row of counted) {
    if (!row.text_hash) continue;
    const key = Buffer.from(row.text_hash).toString('hex');
    byHash.set(key, (byHash.get(key) ?? 0) + 1);
  }
  let agreeing = 0;
  let agreedHash: string | null = null;
  for (const [hash, count] of byHash) {
    if (count > agreeing) {
      agreeing = count;
      agreedHash = hash;
    }
  }
  await t.run('UPDATE job_reviews SET reporters = ?, trusted_reporters = ?, strongest = ?, updated_at = ? WHERE id = ?', [
    rows.length,
    counted.length,
    strongest,
    now.toISOString(),
    reviewId,
  ]);
  return {
    reporters: rows.length,
    trustedReporters: counted.length,
    strongest,
    trustedStrongOrPerson: counted.some((row) => row.strength === 'strong' || row.strength === 'person'),
    agreeing,
    agreedHash,
  };
}
