import type { z } from 'zod';
import {
  AutofillAgentClearedSchema,
  AutofillAgentEnqueueBodySchema,
  AutofillAgentEnqueueResponseSchema,
  AutofillAgentNextSchema,
  AutofillAgentOpenedSchema,
  AutofillAgentQueueListSchema,
  AutofillAgentQueueQuerySchema,
  AutofillAgentResultBodySchema,
  AutofillAgentSettingsSchema,
} from './agent';
import {
  AutofillAnswerRequestSchema,
  AutofillAnswerResultSchema,
  AutofillAnswerTaskSchema,
  AutofillClassifyRequestSchema,
  AutofillClassifyResultSchema,
  AutofillClassifyTaskSchema,
  AutofillDraftRequestSchema,
  AutofillDraftResultSchema,
  AutofillDraftTaskSchema,
  AutofillPickRequestSchema,
  AutofillPickResultSchema,
  AutofillPickTaskSchema,
  AutofillTaskAcceptedSchema,
  AutofillTaskStreamEventSchema,
  AutofillTaskViewSchema,
} from './ai';
import { AutofillSavedAnswerListSchema, AutofillSavedAnswerSchema, PutAutofillSavedAnswerBodySchema } from './answers';
import { AutofillErrorBodySchema } from './common';
import {
  AutofillCoverLetterRequestSchema,
  AutofillCoverLetterResponseSchema,
  AutofillCoverLetterStatusSchema,
  AutofillCoverLetterTextSchema,
} from './cover-letters';
import {
  AutofillCredentialQuerySchema,
  AutofillCredentialSchema,
  AutofillSignInItemSchema,
  AutofillSignInListSchema,
  PutAutofillSignInBodySchema,
} from './credentials';
import {
  AutofillConnectBodySchema,
  AutofillConnectResponseSchema,
  AutofillRedeemBodySchema,
  AutofillRedeemResponseSchema,
  AutofillSessionSchema,
  AutofillTokenListSchema,
  type ExtensionScope,
} from './connect';
import {
  AutofillAddJobRequestSchema,
  AutofillAddJobResponseSchema,
  AutofillFromPageRequestSchema,
  AutofillLookupRequestSchema,
  AutofillLookupResponseSchema,
} from './lookup';
import {
  AutofillProfileEnvelopeSchema,
  AutofillProfileSchema,
  AutofillSeedQuerySchema,
  AutofillSeedSchema,
  AutofillSensitiveEnvelopeSchema,
  AutofillSensitiveSchema,
  PutAutofillProfileBodySchema,
  PutAutofillProfileResponseSchema,
} from './profile';
import { AutofillResumeListSchema } from './resumes';
import { AutofillSiteRequestBodySchema, AutofillSiteRequestListSchema } from './sites';
// v1.4 D: tailoring.
import {
  AutofillTailorAcceptedSchema,
  AutofillTailorRequestSchema,
  AutofillTailorTaskSchema,
  AutofillTemplateListSchema,
} from './tailor';
import {
  AutofillAppliedRequestSchema,
  AutofillJobSearchQuerySchema,
  AutofillJobSearchResponseSchema,
} from './tracker';
// v1.3 A
import {
  AutofillFormsKnownRequestSchema,
  AutofillFormsKnownResponseSchema,
  AutofillSubmissionRequestSchema,
  AutofillSubmissionResponseSchema,
} from './forms';
// end v1.3 A
// v30 CT (version 9): the closed-link reports.
import { AutofillClosedReportRequestSchema, AutofillClosedReportResponseSchema } from './closed';

/**
 * Every schema of the autofill API, by name. `npm run autofill:contract` writes each one's JSON Schema into
 * packages/shared/contract/autofill/v1/contract.json, and both repositories' contract tests parse each one's examples,
 * fixtures/<name>/{valid,invalid}/<case>.json: every name has a valid/golden.json, the one the extension's mock
 * server answers with.
 */
export const AUTOFILL_CONTRACT_SCHEMAS = {
  AutofillErrorBody: AutofillErrorBodySchema,
  AutofillConnectBody: AutofillConnectBodySchema,
  AutofillConnectResponse: AutofillConnectResponseSchema,
  AutofillRedeemBody: AutofillRedeemBodySchema,
  AutofillRedeemResponse: AutofillRedeemResponseSchema,
  AutofillSession: AutofillSessionSchema,
  AutofillTokenList: AutofillTokenListSchema,
  AutofillProfile: AutofillProfileSchema,
  AutofillSensitive: AutofillSensitiveSchema,
  AutofillProfileEnvelope: AutofillProfileEnvelopeSchema,
  AutofillSensitiveEnvelope: AutofillSensitiveEnvelopeSchema,
  PutAutofillProfileBody: PutAutofillProfileBodySchema,
  PutAutofillProfileResponse: PutAutofillProfileResponseSchema,
  AutofillSeedQuery: AutofillSeedQuerySchema,
  AutofillSeed: AutofillSeedSchema,
  AutofillLookupRequest: AutofillLookupRequestSchema,
  AutofillLookupResponse: AutofillLookupResponseSchema,
  AutofillAddJobRequest: AutofillAddJobRequestSchema,
  AutofillAddJobResponse: AutofillAddJobResponseSchema,
  AutofillFromPageRequest: AutofillFromPageRequestSchema,
  AutofillResumeList: AutofillResumeListSchema,
  AutofillPickRequest: AutofillPickRequestSchema,
  AutofillPickResult: AutofillPickResultSchema,
  AutofillPickTask: AutofillPickTaskSchema,
  AutofillClassifyRequest: AutofillClassifyRequestSchema,
  AutofillClassifyResult: AutofillClassifyResultSchema,
  AutofillClassifyTask: AutofillClassifyTaskSchema,
  AutofillDraftRequest: AutofillDraftRequestSchema,
  AutofillDraftResult: AutofillDraftResultSchema,
  AutofillDraftTask: AutofillDraftTaskSchema,
  AutofillAnswerRequest: AutofillAnswerRequestSchema,
  AutofillAnswerResult: AutofillAnswerResultSchema,
  AutofillAnswerTask: AutofillAnswerTaskSchema,
  AutofillTaskAccepted: AutofillTaskAcceptedSchema,
  AutofillTaskView: AutofillTaskViewSchema,
  AutofillTaskStreamEvent: AutofillTaskStreamEventSchema,
  AutofillSavedAnswer: AutofillSavedAnswerSchema,
  AutofillSavedAnswerList: AutofillSavedAnswerListSchema,
  PutAutofillSavedAnswerBody: PutAutofillSavedAnswerBodySchema,
  AutofillCoverLetterRequest: AutofillCoverLetterRequestSchema,
  AutofillCoverLetterResponse: AutofillCoverLetterResponseSchema,
  AutofillCoverLetterStatus: AutofillCoverLetterStatusSchema,
  AutofillCoverLetterText: AutofillCoverLetterTextSchema,
  AutofillJobSearchQuery: AutofillJobSearchQuerySchema,
  AutofillJobSearchResponse: AutofillJobSearchResponseSchema,
  AutofillAppliedRequest: AutofillAppliedRequestSchema,
  AutofillSiteRequestBody: AutofillSiteRequestBodySchema,
  AutofillSiteRequestList: AutofillSiteRequestListSchema,
  AutofillAgentNext: AutofillAgentNextSchema,
  AutofillAgentResultBody: AutofillAgentResultBodySchema,
  AutofillAgentEnqueueBody: AutofillAgentEnqueueBodySchema,
  AutofillAgentEnqueueResponse: AutofillAgentEnqueueResponseSchema,
  AutofillAgentQueueList: AutofillAgentQueueListSchema,
  AutofillAgentCleared: AutofillAgentClearedSchema,
  AutofillAgentSettings: AutofillAgentSettingsSchema,
  // v1.5 Q2: the extension's Queue tab.
  AutofillAgentQueueQuery: AutofillAgentQueueQuerySchema,
  AutofillAgentOpened: AutofillAgentOpenedSchema,
  // end v1.5 Q2
  AutofillCredentialQuery: AutofillCredentialQuerySchema,
  AutofillCredential: AutofillCredentialSchema,
  AutofillSignInList: AutofillSignInListSchema,
  AutofillSignInItem: AutofillSignInItemSchema,
  PutAutofillSignInBody: PutAutofillSignInBodySchema,
  // v1.4 D: tailoring a resume and a cover letter, and the templates the profile's documents may name.
  AutofillTailorRequest: AutofillTailorRequestSchema,
  AutofillTailorAccepted: AutofillTailorAcceptedSchema,
  AutofillTailorTask: AutofillTailorTaskSchema,
  AutofillTemplateList: AutofillTemplateListSchema,
  // end v1.4 D
  // v1.3 A
  AutofillSubmissionRequest: AutofillSubmissionRequestSchema,
  AutofillSubmissionResponse: AutofillSubmissionResponseSchema,
  AutofillFormsKnownRequest: AutofillFormsKnownRequestSchema,
  AutofillFormsKnownResponse: AutofillFormsKnownResponseSchema,
  // end v1.3 A
  // v30 CT (version 9): a closed-link report and its answer.
  AutofillClosedReportRequest: AutofillClosedReportRequestSchema,
  AutofillClosedReportResponse: AutofillClosedReportResponseSchema,
  // end v30 CT
} satisfies Record<string, z.ZodType>;
export type AutofillContractName = keyof typeof AUTOFILL_CONTRACT_SCHEMAS;

/**
 * Who may call a route: the Settings page's session cookie (a mutating call also needs the app's Origin), the
 * extension's token, either, or whoever holds a connect code. The redeem exchange is sent with no cookie and no
 * Authorization header, from an extension's Origin or none: a tia_ bearer makes any request that token's, so a dead
 * or malformed one is refused (401) before the code is read, and a live one needs the version header (409).
 */
export const AUTOFILL_ROUTE_CALLERS = ['session', 'token', 'either', 'code'] as const;
export type AutofillRouteCaller = (typeof AUTOFILL_ROUTE_CALLERS)[number];

export interface AutofillRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /**
   * The whole path; ':id' is a path parameter: a UUID (an AI task's, a connection's, a resume's, a saved answer's, a
   * cover letter's, an auto-apply queue row's or a job-site sign-in's); (version 9) ':jobId' is a TailorIT job's id,
   * a positive integer.
   */
  path: string;
  caller: AutofillRouteCaller;
  /** The scope a token needs here; null where no token comes, and on /session, which any live token may call. */
  scope: ExtensionScope | null;
  /** The JSON body's schema, or a GET's query's. */
  request: AutofillContractName | null;
  status: number;
  /** The success answer's schema; null for 204 and for the files (a resume's, a cover letter's), answered as bytes. */
  response: AutofillContractName | null;
  /**
   * The 202 answer's schema, for a route that may answer before its work is done: an AI route answers `status` with
   * `response`, its finished task, when the task finishes within AUTOFILL_AI_WAIT_MS, else 202 with this. Null for
   * every other route.
   */
  accepted: AutofillContractName | null;
}

/**
 * The routes, as the design lists them (§11.1 of docs/design/tailorit.md in the extension's repository). Every answer
 * to a token request carries the X-TailorIT-Autofill-Api header; a refusal's body is an AutofillErrorBody (409
 * `conflict` for another API version, 401 for a dead token, 403 for a missing scope, 429 when rate-limited). The AI
 * routes refuse with AUTOFILL_AI_REFUSALS too; their tasks are polled and cancelled on /api/ai/tasks/:id, the one path
 * outside /api/autofill a token reaches (with, since v5, the task's stream on /api/ai/tasks/:id/stream), where a token
 * sees only the autofill kinds (404 for any other task). The
 * saved-answer routes refuse with AUTOFILL_SAVED_ANSWER_REFUSALS, adding a job (and, version 5, adding one from its page) with AUTOFILL_ADD_JOB_REFUSALS and the
 * cover-letter routes with AUTOFILL_COVER_LETTER_REFUSALS (both version 2), marking a job Applied with
 * AUTOFILL_APPLIED_REFUSALS (version 3). The extension reads the saved answers (GET /api/autofill/answers, with
 * profile:read) together with GET /api/autofill/profile, once per run. A GET's query (the job search's, the
 * credential's) is named as its request. Version 3's session-only routes (the auto-apply queue, its rule, the job-site
 * sign-ins and the site requests' list) are the Settings and Auto-apply pages'. Version 9's closed-link report refuses
 * with AUTOFILL_CLOSED_REFUSALS.
 */
export const AUTOFILL_ROUTES = [
  {
    method: 'POST',
    path: '/api/autofill/connect',
    caller: 'session',
    scope: null,
    request: 'AutofillConnectBody',
    status: 201,
    response: 'AutofillConnectResponse',
    accepted: null,
  },
  {
    method: 'POST',
    path: '/api/autofill/connect/redeem',
    caller: 'code',
    scope: null,
    request: 'AutofillRedeemBody',
    status: 200,
    response: 'AutofillRedeemResponse',
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/session',
    caller: 'token',
    scope: null,
    request: null,
    status: 200,
    response: 'AutofillSession',
    accepted: null,
  },
  {
    method: 'DELETE',
    path: '/api/autofill/session',
    caller: 'token',
    scope: null,
    request: null,
    status: 204,
    response: null,
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/tokens',
    caller: 'session',
    scope: null,
    request: null,
    status: 200,
    response: 'AutofillTokenList',
    accepted: null,
  },
  {
    method: 'DELETE',
    path: '/api/autofill/tokens/:id',
    caller: 'session',
    scope: null,
    request: null,
    status: 204,
    response: null,
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/profile',
    caller: 'either',
    scope: 'profile:read',
    request: null,
    status: 200,
    response: 'AutofillProfileEnvelope',
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/profile/sensitive',
    caller: 'either',
    scope: 'profile:sensitive',
    request: null,
    status: 200,
    response: 'AutofillSensitiveEnvelope',
    accepted: null,
  },
  {
    method: 'PUT',
    path: '/api/autofill/profile',
    caller: 'either',
    scope: 'profile:write',
    request: 'PutAutofillProfileBody',
    status: 200,
    response: 'PutAutofillProfileResponse',
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/profile/seed',
    caller: 'session',
    scope: null,
    request: 'AutofillSeedQuery',
    status: 200,
    response: 'AutofillSeed',
    accepted: null,
  },
  {
    method: 'POST',
    path: '/api/autofill/lookup',
    caller: 'either',
    scope: 'jobs:lookup',
    request: 'AutofillLookupRequest',
    status: 200,
    response: 'AutofillLookupResponse',
    accepted: null,
  },
  {
    method: 'POST',
    path: '/api/autofill/jobs',
    caller: 'either',
    scope: 'jobs:add',
    request: 'AutofillAddJobRequest',
    status: 200,
    response: 'AutofillAddJobResponse',
    accepted: null,
  },
  {
    method: 'POST',
    path: '/api/autofill/jobs/from-page',
    caller: 'either',
    scope: 'jobs:add',
    request: 'AutofillFromPageRequest',
    status: 200,
    response: 'AutofillAddJobResponse',
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/jobs/search',
    caller: 'either',
    scope: 'jobs:lookup',
    request: 'AutofillJobSearchQuery',
    status: 200,
    response: 'AutofillJobSearchResponse',
    accepted: null,
  },
  {
    method: 'POST',
    path: '/api/autofill/applied',
    caller: 'either',
    scope: 'tracker:write',
    request: 'AutofillAppliedRequest',
    status: 200,
    response: 'AutofillLookupResponse',
    accepted: null,
  },
  {
    method: 'POST',
    path: '/api/autofill/site-requests',
    caller: 'either',
    scope: 'jobs:lookup',
    request: 'AutofillSiteRequestBody',
    status: 204,
    response: null,
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/site-requests',
    caller: 'session',
    scope: null,
    request: null,
    status: 200,
    response: 'AutofillSiteRequestList',
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/resumes',
    caller: 'either',
    scope: 'resumes:read',
    request: null,
    status: 200,
    response: 'AutofillResumeList',
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/resumes/:id/file',
    caller: 'either',
    scope: 'resumes:read',
    request: null,
    status: 200,
    response: null,
    accepted: null,
  },
  {
    method: 'POST',
    path: '/api/autofill/ai/pick',
    caller: 'either',
    scope: 'ai:run',
    request: 'AutofillPickRequest',
    status: 200,
    response: 'AutofillPickTask',
    accepted: 'AutofillTaskAccepted',
  },
  {
    method: 'POST',
    path: '/api/autofill/ai/classify',
    caller: 'either',
    scope: 'ai:run',
    request: 'AutofillClassifyRequest',
    status: 200,
    response: 'AutofillClassifyTask',
    accepted: 'AutofillTaskAccepted',
  },
  {
    method: 'POST',
    path: '/api/autofill/ai/draft',
    caller: 'either',
    scope: 'ai:run',
    request: 'AutofillDraftRequest',
    status: 200,
    response: 'AutofillDraftTask',
    accepted: 'AutofillTaskAccepted',
  },
  {
    method: 'POST',
    path: '/api/autofill/ai/answer',
    caller: 'either',
    scope: 'ai:run',
    request: 'AutofillAnswerRequest',
    status: 200,
    response: 'AutofillAnswerTask',
    accepted: 'AutofillTaskAccepted',
  },
  {
    method: 'GET',
    path: '/api/ai/tasks/:id',
    caller: 'either',
    scope: 'ai:run',
    request: null,
    status: 200,
    response: 'AutofillTaskView',
    accepted: null,
  },
  {
    method: 'DELETE',
    path: '/api/ai/tasks/:id',
    caller: 'either',
    scope: 'ai:run',
    request: null,
    status: 200,
    response: 'AutofillTaskView',
    accepted: null,
  },
  // v5 (additive within API 6): the task's streamed view, `text/event-stream`; `response` names each message's JSON.
  {
    method: 'GET',
    path: '/api/ai/tasks/:id/stream',
    caller: 'either',
    scope: 'ai:run',
    request: null,
    status: 200,
    response: 'AutofillTaskStreamEvent',
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/answers',
    caller: 'either',
    scope: 'profile:read',
    request: null,
    status: 200,
    response: 'AutofillSavedAnswerList',
    accepted: null,
  },
  {
    method: 'PUT',
    path: '/api/autofill/answers',
    caller: 'either',
    scope: 'answers:write',
    request: 'PutAutofillSavedAnswerBody',
    status: 200,
    response: 'AutofillSavedAnswer',
    accepted: null,
  },
  {
    method: 'DELETE',
    path: '/api/autofill/answers/:id',
    caller: 'either',
    scope: 'answers:write',
    request: null,
    status: 204,
    response: null,
    accepted: null,
  },
  {
    method: 'POST',
    path: '/api/autofill/cover-letters',
    caller: 'either',
    scope: 'letters:write',
    request: 'AutofillCoverLetterRequest',
    status: 200,
    response: 'AutofillCoverLetterResponse',
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/cover-letters/:id',
    caller: 'either',
    scope: 'letters:write',
    request: null,
    status: 200,
    response: 'AutofillCoverLetterStatus',
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/cover-letters/:id/file',
    caller: 'either',
    scope: 'letters:write',
    request: null,
    status: 200,
    response: null,
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/cover-letters/:id/text',
    caller: 'either',
    scope: 'letters:write',
    request: null,
    status: 200,
    response: 'AutofillCoverLetterText',
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/agent/next',
    caller: 'token',
    scope: 'agent:run',
    request: null,
    status: 200,
    response: 'AutofillAgentNext',
    accepted: null,
  },
  // v1.5 Q2: the Queue tab's sequential run takes a queued row before it opens the job's tab.
  {
    method: 'POST',
    path: '/api/autofill/agent/:id/opened',
    caller: 'token',
    scope: 'agent:run',
    request: null,
    status: 200,
    response: 'AutofillAgentOpened',
    accepted: null,
  },
  {
    method: 'POST',
    path: '/api/autofill/agent/:id/result',
    caller: 'token',
    scope: 'agent:run',
    request: 'AutofillAgentResultBody',
    status: 204,
    response: null,
    accepted: null,
  },
  {
    method: 'POST',
    path: '/api/autofill/agent/queue',
    caller: 'session',
    scope: null,
    request: 'AutofillAgentEnqueueBody',
    status: 200,
    response: 'AutofillAgentEnqueueResponse',
    accepted: null,
  },
  {
    // v1.5 Q2: a token too (the Queue tab), with the paged query.
    method: 'GET',
    path: '/api/autofill/agent/queue',
    caller: 'either',
    scope: 'agent:run',
    request: 'AutofillAgentQueueQuery',
    status: 200,
    response: 'AutofillAgentQueueList',
    accepted: null,
  },
  {
    method: 'DELETE',
    path: '/api/autofill/agent/queue/:id',
    caller: 'session',
    scope: null,
    request: null,
    status: 204,
    response: null,
    accepted: null,
  },
  {
    method: 'POST',
    path: '/api/autofill/agent/queue/clear-finished',
    caller: 'session',
    scope: null,
    request: null,
    status: 200,
    response: 'AutofillAgentCleared',
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/agent/settings',
    caller: 'session',
    scope: null,
    request: null,
    status: 200,
    response: 'AutofillAgentSettings',
    accepted: null,
  },
  {
    method: 'PUT',
    path: '/api/autofill/agent/settings',
    caller: 'session',
    scope: null,
    request: 'AutofillAgentSettings',
    status: 200,
    response: 'AutofillAgentSettings',
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/credentials',
    caller: 'token',
    scope: 'credentials:read',
    request: 'AutofillCredentialQuery',
    status: 200,
    response: 'AutofillCredential',
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/sign-ins',
    caller: 'session',
    scope: null,
    request: null,
    status: 200,
    response: 'AutofillSignInList',
    accepted: null,
  },
  {
    method: 'PUT',
    path: '/api/autofill/sign-ins',
    caller: 'session',
    scope: null,
    request: 'PutAutofillSignInBody',
    status: 200,
    response: 'AutofillSignInItem',
    accepted: null,
  },
  {
    method: 'DELETE',
    path: '/api/autofill/sign-ins/:id',
    caller: 'session',
    scope: null,
    request: null,
    status: 204,
    response: null,
    accepted: null,
  },
  // v1.4 D: tailoring (AUTOFILL_TAILOR_REFUSALS), with the AI scope: the work is Claude's, started and polled like the
  // other AI routes, and every connection holds the scope. The template list with profile:read, beside the profile
  // whose documents name them.
  {
    method: 'POST',
    path: '/api/autofill/tailor',
    caller: 'either',
    scope: 'ai:run',
    request: 'AutofillTailorRequest',
    status: 202,
    response: 'AutofillTailorAccepted',
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/tailor/:id',
    caller: 'either',
    scope: 'ai:run',
    request: null,
    status: 200,
    response: 'AutofillTailorTask',
    accepted: null,
  },
  {
    method: 'GET',
    path: '/api/autofill/templates',
    caller: 'either',
    scope: 'profile:read',
    request: null,
    status: 200,
    response: 'AutofillTemplateList',
    accepted: null,
  },
  // end v1.4 D
  // v1.3 A (additive within API 6): a confirmed submission's questions and answers, and a job's known questions.
  {
    method: 'POST',
    path: '/api/autofill/submissions',
    caller: 'either',
    scope: 'tracker:write',
    request: 'AutofillSubmissionRequest',
    status: 200,
    response: 'AutofillSubmissionResponse',
    accepted: null,
  },
  {
    method: 'POST',
    path: '/api/autofill/forms/known',
    caller: 'either',
    scope: 'jobs:lookup',
    request: 'AutofillFormsKnownRequest',
    status: 200,
    response: 'AutofillFormsKnownResponse',
    accepted: null,
  },
  // end v1.3 A
  // v30 CT (version 9): the posting of a job TailorIT shows as open looks closed (14-extension-reports.md §3.2).
  {
    method: 'POST',
    path: '/api/autofill/jobs/:jobId/closed',
    caller: 'either',
    scope: 'jobs:add',
    request: 'AutofillClosedReportRequest',
    status: 200,
    response: 'AutofillClosedReportResponse',
    accepted: null,
  },
  // end v30 CT
] as const satisfies readonly AutofillRoute[];
