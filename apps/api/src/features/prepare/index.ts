import type { Feature } from '../../core/feature';
import { APPLICATION_DRAFT_ACTING, PREPARE_ACTING } from './acting'; // v33 SHARE-5
import { PREPARE_DAILY } from './housekeeping';
import { createApplicationDraftRouter, createPrepareRouter } from './router';
import { createPrepareService, endGrantPrepareStep, prepareServiceOf, registerPrepareService } from './service';
import { registerEndGrantStep } from '../sharing/end-grant'; // v33 SHARE-5

// Prepare & Queue (v2.0, docs/design/v2.0/05-prepare-flow.md; DECISIONS A29, A30): one Prepare of one saved job at a
// time (prepare_jobs, 0822), its kit in the application's draft (application_drafts): the resume by the person's resume
// mode (default, similar, tailor), the cover letter by their letter mode (required, always) and answers to the job's
// known questions, the letter and the answers written from the kit's resume. The kit is queued (insertPreparedRow) when
// it is ready, and frozen from then on. Two paths: TailorIT's AI (runner.ts, a background runner paced by
// FREE_/PAID_PREPARE_PER_HOUR) and the person's own AI through the MCP server (service.ts's saves, finishIfComplete).
// The kit reaches the extension through the lookup's `draftReady` and POST /api/autofill/forms/known's `drafts`
// (known.ts), and its documents as the application's.

// v33 SHARE-5 (PLAN F9; SP v33 PLAN-sharing.md §6 "endGrant"): ending a share (or taking away Prepare & queue's Change,
// or Their own AI) cancels the Prepares it allowed that are not over (access_ended).
registerEndGrantStep('prepares', endGrantPrepareStep);

export const prepareFeature: Feature = {
  name: 'prepare',
  services(deps) {
    registerPrepareService(deps, createPrepareService(deps));
  },
  routes: [
    { path: '/api/prepare', router: createPrepareRouter, acting: PREPARE_ACTING /* v33 SHARE-5 */ },
    { path: '/api/applications', router: createApplicationDraftRouter, acting: APPLICATION_DRAFT_ACTING /* v33 SHARE-5 */ },
  ],
  start: (deps) => prepareServiceOf(deps).start(),
  // v30 INT-0: finished Prepares pruned, abandoned MCP Prepares cancelled (housekeeping.ts).
  daily: PREPARE_DAILY,
};
