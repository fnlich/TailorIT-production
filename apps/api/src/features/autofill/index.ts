import { pruneExtensionTokens } from '../../core/auth/extension-tokens';
import type { AppDeps } from '../../core/context';
import type { Feature } from '../../core/feature';
import { createAutofillAiRouter } from './ai/router';
import { pruneAutofillTasks } from './ai/tasks';
import { createAutofillAnswersRouter } from './answers/router';
import { pruneConnectCodes } from './connect';
import { createAutofillAgentRouter } from './agent/router';
import { AUTOFILL_AI_TASKS } from './ai-tasks'; // v30 ST3
import { createAutofillConnectRouter } from './connect-router';
import { createAutofillCoverLettersRouter } from './cover-letters-router';
import { createAutofillCredentialsRouter } from './credentials/router';
import { createAutofillFormsRouter } from './forms/router';
import { createAutofillJobsRouter } from './jobs-router';
import { createAutofillLookupRouter } from './lookup-router';
import { createAutofillProfileRouter } from './profile/router';
import { createAutofillResumesRouter } from './resumes-router';
import { createAutofillSiteRequestsRouter } from './site-requests';
import { createAutofillClosedRouter } from './closed-router'; // v30 X1-API

const PRUNE_EVERY_MS = 60 * 60_000;
/** Finished autofill AI tasks go an hour after they finish (AUTOFILL_TASK_RETENTION_MS), checked this often. */
const PRUNE_TASKS_EVERY_MS = 10 * 60_000;

/**
 * Startup, then hourly: drop tokens 30 days after they were revoked or expired, and codes a day after they expired.
 * Startup, then every 10 minutes: drop the autofill AI tasks that finished more than an hour ago.
 */
export async function startAutofill(deps: AppDeps): Promise<() => void> {
  const prune = async () => {
    try {
      const tokens = await pruneExtensionTokens(deps);
      const codes = await pruneConnectCodes(deps);
      if (tokens || codes) {
        deps.log.debug(`[autofill] pruned ${tokens} ended token(s), ${codes} expired connect code(s)`);
      }
    } catch (error) {
      deps.log.warn('[autofill] could not prune extension tokens and connect codes', error);
    }
  };
  const pruneTasks = async () => {
    try {
      const tasks = await pruneAutofillTasks(deps);
      if (tasks) deps.log.debug(`[autofill] deleted ${tasks} finished autofill AI task(s)`);
    } catch (error) {
      deps.log.warn('[autofill] could not delete finished autofill AI tasks', error);
    }
  };
  await prune();
  await pruneTasks();
  const timer = setInterval(() => void prune(), PRUNE_EVERY_MS);
  const tasksTimer = setInterval(() => void pruneTasks(), PRUNE_TASKS_EVERY_MS);
  timer.unref();
  tasksTimer.unref();
  return () => {
    clearInterval(timer);
    clearInterval(tasksTimer);
  };
}

// The TailorIT Autofill extension's side of TailorIT (work package AF; its design is docs/design/tailorit.md in the
// extension's repository). The extension's worker connects with a one-time code from Settings › Autofill and then
// calls /api/autofill/* with its token (core/auth/extension-tokens.ts); the Settings page calls the same routes with
// its session. Each route says who may call it with allow() (auth.ts) and has a per-account rate limit. The routers:
// connecting (connect-router.ts), the profile and its seed (profile/), the job lookup (lookup-router.ts), adding a
// job to TailorIT and the tracker (jobs-router.ts), the resumes to attach (resumes-router.ts), the saved answers
// (answers/), the AI steps (ai/: the tiebreak, the classification, the drafts and the answers, tasks of the AI
// queue defined in ai-tasks.ts), the cover letter a form uploads (cover-letters-router.ts, written by
// the cover-letter feature's own generation) and, since autofill API version 3, the requests to support a site
// (site-requests.ts), the auto-apply agent's queue (agent/) and the job-site sign-ins (credentials/). Finding another
// of the person's jobs and marking one Applied are jobs-router.ts's (tracker.ts).
export const autofillFeature: Feature = {
  name: 'autofill',
  // v30 ST3: the AI task kinds (pick, classify, draft, answer), registered on the AI queue by setupServices.
  aiTasks: AUTOFILL_AI_TASKS,
  routes: [
    { path: '/api/autofill', router: createAutofillConnectRouter },
    { path: '/api/autofill', router: createAutofillProfileRouter },
    { path: '/api/autofill', router: createAutofillLookupRouter },
    { path: '/api/autofill', router: createAutofillJobsRouter },
    { path: '/api/autofill', router: createAutofillResumesRouter },
    { path: '/api/autofill', router: createAutofillAiRouter },
    { path: '/api/autofill', router: createAutofillAnswersRouter },
    { path: '/api/autofill', router: createAutofillCoverLettersRouter },
    { path: '/api/autofill', router: createAutofillSiteRequestsRouter },
    { path: '/api/autofill', router: createAutofillAgentRouter },
    { path: '/api/autofill', router: createAutofillCredentialsRouter },
    // v1.3 A: a job's known form (POST /forms/known); POST /submissions is the jobs router's.
    { path: '/api/autofill', router: createAutofillFormsRouter },
    // v30 X1-API: autofill API 9's closed-link report (POST /jobs/:jobId/closed).
    { path: '/api/autofill', router: createAutofillClosedRouter },
  ],
  start: startAutofill,
};
