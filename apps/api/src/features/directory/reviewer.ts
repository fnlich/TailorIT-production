import { DAY_MS, normalizeResumeDocument, STATUS, UNLIMITED, type ApplicationStatus, type PrepareSettingsBody } from '@tailorit/shared';
import { aiBudgetOverride, changeEntitlement } from '../../core/accounts/entitlements';
import { findOrCreateUser, getUserByEmail, isConfiguredAdmin, isEmailAddress, normalizeEmail } from '../../core/auth/users';
import { constantsOf } from '../../core/constants/service';
import { localDateIso, nowIso, type AppDeps } from '../../core/context';
import { resumeChooser } from '../applications/resume-choice';
import { changeStatus, saveJobs, setStatusDate } from '../applications/service';
import { loadEvents } from '../applications/store';
import { searchRowShared } from '../jobs/visibility';
import { readFilterSettings, saveFilterSettings } from '../prepare-filters/settings';
import { prepareSettingsOf, savePrepareSettings } from '../prepare/settings';
import { insertResume, updateResumeDocument } from '../resumes/repository';
import {
  SAMPLE_APPLIED_DAYS_AGO,
  SAMPLE_FILTERS,
  SAMPLE_INTERVIEW_APPLIED_DAYS_AGO,
  SAMPLE_INTERVIEW_DAYS_AGO,
  SAMPLE_JOBS_MIN,
  SAMPLE_MOVED_JOBS,
  SAMPLE_PERSON,
  SAMPLE_PREPARE_SETTINGS,
  SAMPLE_REMOTE_JOBS,
  SAMPLE_RESUME_TITLE,
  SAMPLE_SAVED_DAYS_AGO,
  SAMPLE_SAVED_JOBS,
  sampleResumeDocument,
} from './sample';

// v34 DIRKIT (PLAN G8; docs/directory/CHECKLIST.md): `npm run directory:reviewer -- --email <address>` makes, or brings
// back to its sample state, the account a reviewer of Claude's Connectors Directory signs in with, on the server it runs
// on (production too: it reads and writes through the app's own services, as a person's own actions would):
// - Paid (one PAID_TERM, renewed when it has lapsed), so every tool works for valid input (ai_search_jobs is Paid);
//   TailorIT's AI on for it (the server's AI on, no daily AI budget override below Paid's);
// - the sample resume of a made-up person (sample.ts), the default resume;
// - the prepare filters on (two job types and the Custom filter) and Prepare's settings (tailored resume, a
//   letter for every job);
// - saved jobs from the shared job lake (open, newest first, one per company; remote ones first when the lake has
//   them), two of them moved on in the current week (Applied, one to an interview), dated again on each run.
// It never queues a kit (the jobs are real postings and the person is made up: nothing of it may be applied to).
// It changes nothing until every check passed: an address that is valid, not an administrator's, and new or an
// account this command made (its marker, below); TailorIT's AI on; enough open lake jobs. The account, its Paid plan
// and the marker are made in one transaction (a failure leaves nothing behind); run again, it adds only what is
// missing. It prints the account's address and nothing else (stdout); a refusal goes to stderr with exit code 1. As
// every command, it takes up none of the running API's background work (AppDeps.commandProcess): the API's Prepare
// runner sees the new plan at its next pass. Account deletion removes the account like any other, and its marker.

/** The note on the account's Paid change (the admin's history of the account says who made it). */
export const REVIEWER_NOTE = 'Directory reviewer account (npm run directory:reviewer)';

/**
 * The marker that an account is this command's: an app_settings row `directory:reviewer:<user id>` whose value names
 * the account ({"userId": <id>}), written with the account in one transaction and matched on the id. Only this command
 * writes these keys (an administrator's Paid change or note never makes one). Account deletion removes it.
 */
export const REVIEWER_MARKER_PREFIX = 'directory:reviewer:';
export const reviewerMarkerKey = (userId: string): string => `${REVIEWER_MARKER_PREFIX}${userId}`;

/** A refusal: the command says it and changes nothing. */
export class ReviewerRefusal extends Error {}

/** `--email <address>` (or `--email=<address>`). */
export function reviewerEmailOf(args: readonly string[]): string {
  let email: string | undefined;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (arg === '--email') email = args[++at];
    else if (arg.startsWith('--email=')) email = arg.slice('--email='.length);
    else throw new ReviewerRefusal(`Unknown argument ${arg}. Usage: npm run directory:reviewer -- --email <address>`);
  }
  if (!email) throw new ReviewerRefusal('Give the reviewer\'s address: npm run directory:reviewer -- --email <address>');
  const normalized = normalizeEmail(email);
  if (!isEmailAddress(normalized)) throw new ReviewerRefusal(`"${email}" is not an email address.`);
  return normalized;
}

/** Whether the account `userId` is one this command made (its marker). */
export async function isReviewerAccount(deps: Pick<AppDeps, 'db'>, userId: string): Promise<boolean> {
  const row = await deps.db.one(
    "SELECT 1 AS one FROM app_settings WHERE key = ? AND value->>'userId' = ?",
    [reviewerMarkerKey(userId), userId],
  );
  return Boolean(row);
}

interface LakeRow {
  job_id: number;
  company_id: number;
}

/** The job types the sample filters keep (a job with none stated passes them too). */
const KEPT_TYPES = SAMPLE_FILTERS.jobTypes;

/**
 * The open shared lake jobs to save, none the account tracks already: up to `remote` remote ones the sample filters
 * keep (when the lake has them), then the newest up to `count` in all; one per company while there are enough
 * companies. Answers the ids and which are remote.
 */
async function lakeJobs(deps: AppDeps, userId: string | null, count: number, remote: number): Promise<{ ids: number[]; remote: Set<number> }> {
  const picked: number[] = [];
  const remoteIds = new Set<number>();
  if (count <= 0 && remote <= 0) return { ids: picked, remote: remoteIds };
  const untracked = 'NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = s.job_id AND a.user_id = ?)';
  const types = KEPT_TYPES.map(() => '?').join(', ');
  const remoteRows = remote > 0
    ? await deps.db.all<LakeRow>(
        `SELECT s.job_id, s.company_id FROM job_search s
          WHERE ${searchRowShared('s')} AND ${untracked} AND s.work_arrangement = 'remote'
            AND (s.employment_type IS NULL${KEPT_TYPES.length > 0 ? ` OR s.employment_type IN (${types})` : ''})
          ORDER BY s.posted_sort DESC, s.job_id DESC LIMIT ?`,
        [userId ?? '', ...KEPT_TYPES, Math.max(remote * 20, 100)],
      )
    : [];
  const newest = await deps.db.all<LakeRow>(
    `SELECT s.job_id, s.company_id FROM job_search s WHERE ${searchRowShared('s')} AND ${untracked}
      ORDER BY s.posted_sort DESC, s.job_id DESC LIMIT ?`,
    [userId ?? '', Math.max(count * 20, 100)],
  );
  const companies = new Set<number>();
  const take = (row: LakeRow, oneEach: boolean, most: number): boolean => {
    const job = Number(row.job_id);
    if (picked.length >= most || picked.includes(job) || (oneEach && companies.has(Number(row.company_id)))) return false;
    companies.add(Number(row.company_id));
    picked.push(job);
    return true;
  };
  for (const row of remoteRows) {
    if (remoteIds.size >= remote) break;
    if (take(row, true, remote)) remoteIds.add(Number(row.job_id));
  }
  for (const row of newest) take(row, true, count);
  // Fewer companies than jobs wanted: the rest from companies already picked.
  for (const row of newest) take(row, false, count);
  return { ids: picked, remote: remoteIds };
}

interface TrackerEntry {
  id: string;
  job_id: number;
  current_status: number;
  remote: boolean;
}

/** The account's live Tracker entries with a job, oldest first, each with whether its job is remote. */
async function trackerEntries(deps: AppDeps, userId: string): Promise<TrackerEntry[]> {
  const rows = await deps.db.all<Omit<TrackerEntry, 'remote'> & { arrangement: string | null }>(
    `SELECT a.id, a.job_id, a.current_status, s.work_arrangement AS arrangement FROM applications a
       LEFT JOIN job_search s ON s.job_id = a.job_id
      WHERE a.user_id = ? AND a.archived_at IS NULL AND a.job_id IS NOT NULL ORDER BY a.created_at, a.id`,
    [userId],
  );
  return rows.map(({ arrangement, ...row }) => ({ ...row, remote: arrangement === 'remote' }));
}

/** Refuses (before any change) what the command must not do. */
async function refusalsFor(deps: AppDeps, email: string): Promise<{ existingId: string | null }> {
  if (!(await deps.db.one('SELECT 1 AS one FROM users LIMIT 1'))) {
    throw new ReviewerRefusal(
      'This database has no TailorIT accounts yet: run this on the server TailorIT runs on (its .env and database), after its operator has signed in once.',
    );
  }
  if (isConfiguredAdmin(deps, email)) throw new ReviewerRefusal('That address is in ADMIN_EMAILS: give the reviewer an address of their own.');
  const existing = await getUserByEmail(deps, email);
  if (existing) {
    if (existing.role === 'admin') throw new ReviewerRefusal("That address is an administrator's account: give the reviewer an address of their own.");
    if (!(await isReviewerAccount(deps, existing.id))) {
      throw new ReviewerRefusal(
        'That address already has an account this command did not make: give the reviewer a new address, or delete that account first.',
      );
    }
    if (existing.disabled_at) throw new ReviewerRefusal('That reviewer account is disabled: turn it back on in Admin › Users, then run this again.');
  }
  if (!deps.config.ai.enabled || !deps.services.ai) {
    throw new ReviewerRefusal(
      "TailorIT's AI is off on this server (AI_ENABLED): the reviewer's AI tools would refuse. Turn it on, then run this again.",
    );
  }
  return { existingId: existing?.id ?? null };
}

/**
 * The account, its Paid plan (and no daily AI budget override below Paid's) and the marker, in one transaction: a
 * failure leaves nothing behind, and the next run starts again. The plan's wake-up of the Prepare runner waits for the
 * commit (changeEntitlement would kick inside this transaction); in a command's process it does nothing.
 */
async function accountWithPlan(deps: AppDeps, email: string): Promise<string> {
  const inside: AppDeps = { ...deps, services: { ...deps.services, prepare: undefined } };
  const userId = await deps.db.atomic(
    async (t) => {
      const { user } = await findOrCreateUser(deps, { email, name: SAMPLE_PERSON.name });
      await changeEntitlement(inside, { userId: user.id, source: 'system', accountType: 'paid', note: REVIEWER_NOTE });
      const override = await aiBudgetOverride(deps, user.id);
      const paidBudget = constantsOf(deps).get('PAID_AI_DAILY_BUDGET_USD');
      if (override && override.micros !== UNLIMITED && paidBudget !== UNLIMITED && override.micros < paidBudget) {
        await changeEntitlement(inside, { userId: user.id, source: 'system', aiDailyBudget: 'clear', note: REVIEWER_NOTE });
      }
      await t.run(
        `INSERT INTO app_settings(key, value, updated_at) VALUES (?, CAST(? AS json), CAST(? AS timestamptz))
         ON CONFLICT (key) DO NOTHING`,
        [reviewerMarkerKey(user.id), JSON.stringify({ userId: user.id }), nowIso(deps)],
      );
      return user.id;
    },
    { label: 'directory:reviewer' },
  );
  deps.services.prepare?.kick();
  return userId;
}

/** Dates a step again when its day differs (setStatusDate writes only then). */
async function dateStep(deps: AppDeps, userId: string, entryId: string, status: ApplicationStatus, day: string): Promise<void> {
  const events = await loadEvents(deps.db, entryId);
  if (events.find((event) => event.status === status)?.occurredOn === day) return;
  await setStatusDate(deps, userId, entryId, status, day);
}

/**
 * Makes or refreshes the reviewer account for `email` (normalized). Answers the account's address. Throws
 * ReviewerRefusal, having changed nothing, when one of the checks above fails or the lake has too few open jobs.
 */
export async function ensureReviewerAccount(deps: AppDeps, email: string): Promise<string> {
  const { existingId } = await refusalsFor(deps, email);
  const tracked = existingId ? await trackerEntries(deps, existingId) : [];
  const atSaved = tracked.filter((entry) => entry.current_status === STATUS.saved);
  const movedOn = tracked.filter((entry) => entry.current_status >= STATUS.applied).length;
  const moveCount = Math.max(0, SAMPLE_MOVED_JOBS - movedOn);
  const remoteWanted = Math.max(0, SAMPLE_REMOTE_JOBS - atSaved.filter((entry) => entry.remote).length);
  // The jobs to save; remote ones first, one more each when only a remote one is missing and the lake has it.
  const saveCount = Math.max(0, SAMPLE_SAVED_JOBS - atSaved.length) + moveCount;
  const picks = await lakeJobs(deps, existingId, saveCount, remoteWanted);
  if (tracked.length + picks.ids.length < SAMPLE_JOBS_MIN) {
    throw new ReviewerRefusal(
      `The job lake has too few open jobs to save (${picks.ids.length}): add a source in Admin › Sources and let it run, then run this again.`,
    );
  }

  // The account (named after the made-up person on its first run), its plan and its marker.
  const userId = await accountWithPlan(deps, email);

  // The sample resume, as the sample has it; the default resume while there is none.
  const document = normalizeResumeDocument(sampleResumeDocument(email));
  const resume = await deps.db.one<{ id: string }>(
    "SELECT id FROM resumes WHERE user_id = ? AND kind = 'built' AND title = ? ORDER BY created_at LIMIT 1",
    [userId, SAMPLE_RESUME_TITLE],
  );
  const resumeId = resume
    ? (await updateResumeDocument(deps, userId, resume.id, document, SAMPLE_RESUME_TITLE), resume.id)
    : await insertResume(deps, userId, { kind: 'built', title: SAMPLE_RESUME_TITLE, document });
  await deps.db.run('UPDATE users SET default_resume_id = ? WHERE id = ? AND default_resume_id IS NULL', [resumeId, userId]);

  // The prepare filters and Prepare's settings, written only where they differ.
  const filters = await readFilterSettings(deps, userId);
  if (JSON.stringify(filters.filters) !== JSON.stringify(SAMPLE_FILTERS)) await saveFilterSettings(deps, userId, SAMPLE_FILTERS);
  const settings = await prepareSettingsOf(deps, userId);
  const changes: PrepareSettingsBody = {};
  if (settings.resumeMode !== SAMPLE_PREPARE_SETTINGS.resumeMode) changes.resumeMode = SAMPLE_PREPARE_SETTINGS.resumeMode;
  if (settings.letterMode !== SAMPLE_PREPARE_SETTINGS.letterMode) changes.letterMode = SAMPLE_PREPARE_SETTINGS.letterMode;
  if (Object.keys(changes).length > 0) await savePrepareSettings(deps, userId, changes);

  // Saved jobs from the lake, then the ones moved on: Applied, the first of them to an interview. A remote job stays
  // at Saved (the remote prompt prepares Saved jobs).
  const daysAgo = (days: number) => localDateIso(new Date(deps.now().getTime() - days * DAY_MS));
  if (picks.ids.length > 0) {
    await saveJobs(deps, userId, picks.ids, { occurredOn: daysAgo(SAMPLE_SAVED_DAYS_AGO), chooseResumes: resumeChooser(deps, userId) });
  }
  if (moveCount > 0) {
    const saved = (await trackerEntries(deps, userId)).filter((entry) => entry.current_status === STATUS.saved);
    // The newest jobs that are not remote; a remote one only beyond the SAMPLE_REMOTE_JOBS kept at Saved.
    const movable = [...saved.filter((entry) => entry.remote).slice(SAMPLE_REMOTE_JOBS), ...saved.filter((entry) => !entry.remote)];
    const interviewing = tracked.some((entry) => entry.current_status >= STATUS.screen && entry.current_status < STATUS.withdrawn);
    for (const [at, entry] of movable.slice(-moveCount).entries()) {
      const toInterview = at === 0 && !interviewing;
      await changeStatus(deps, userId, entry.id, STATUS.applied, daysAgo(toInterview ? SAMPLE_INTERVIEW_APPLIED_DAYS_AGO : SAMPLE_APPLIED_DAYS_AGO));
      if (toInterview) await changeStatus(deps, userId, entry.id, STATUS.interviewing, daysAgo(SAMPLE_INTERVIEW_DAYS_AGO));
    }
  }

  // The moved-on steps in the current week on every run (a run before a later review dates them again).
  for (const entry of await trackerEntries(deps, userId)) {
    if (entry.current_status === STATUS.applied) {
      await dateStep(deps, userId, entry.id, STATUS.applied, daysAgo(SAMPLE_APPLIED_DAYS_AGO));
    } else if (entry.current_status === STATUS.interviewing) {
      await dateStep(deps, userId, entry.id, STATUS.interviewing, daysAgo(SAMPLE_INTERVIEW_DAYS_AGO));
      await dateStep(deps, userId, entry.id, STATUS.applied, daysAgo(SAMPLE_INTERVIEW_APPLIED_DAYS_AGO));
    }
  }
  return email;
}

/** The command: `directory:reviewer --email <address>`. Prints the address alone; a refusal goes to stderr. */
export async function runReviewerCommand(deps: AppDeps, args: string[]): Promise<void> {
  try {
    const email = await ensureReviewerAccount(deps, reviewerEmailOf(args));
    console.log(email);
  } catch (error) {
    if (!(error instanceof ReviewerRefusal)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
