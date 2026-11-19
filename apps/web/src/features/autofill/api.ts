import {
  AutofillConnectResponseSchema,
  AutofillProfileEnvelopeSchema,
  AutofillResumeListSchema,
  AutofillSavedAnswerListSchema,
  AutofillSavedAnswerSchema,
  AutofillSensitiveEnvelopeSchema,
  AutofillSignInItemSchema,
  AutofillSignInListSchema,
  AutofillSiteRequestListSchema,
  AutofillTokenListSchema,
  PutAutofillProfileResponseSchema,
  type AutofillConnectBody,
  type AutofillConnectResponse,
  type AutofillProfileEnvelope,
  type AutofillResumeList,
  type AutofillSavedAnswer,
  type AutofillSavedAnswerList,
  type AutofillSensitiveEnvelope,
  type AutofillSignInItem,
  type AutofillSignInList,
  type AutofillSiteRequestList,
  type AutofillTokenList,
  type PutAutofillProfileBody,
  type PutAutofillProfileResponse,
  type PutAutofillSavedAnswerBody,
  type PutAutofillSignInBody,
} from '@tailorit/shared/autofill';
import { ProfileSeedStartSchema, ProfileSeedViewSchema, type ProfileSeedStart, type ProfileSeedView } from '@tailorit/shared';
import { api } from '@/lib/api';

/** React Query keys of Settings › Autofill. */
export const autofillKeys = {
  profile: ['autofill', 'profile'] as const,
  sensitive: ['autofill', 'sensitive'] as const,
  tokens: ['autofill', 'tokens'] as const,
  /** The Saved answers tab's list. */
  answers: ['autofill', 'answers'] as const,
  /** The resumes the extension may attach: the Profile tab's two resume choices. */
  resumes: ['autofill', 'resumes'] as const,
  seed: (resumeId: string | null) => ['autofill', 'seed', resumeId ?? 'default'] as const,
  /** The Job-site sign-in tab's list (never a password). */
  signIns: ['autofill', 'sign-ins'] as const,
  /** The Extension tab's "Sites you asked to support". */
  siteRequests: ['autofill', 'site-requests'] as const,
};

/** GET /api/autofill/profile: everything but the sensitive part (revision 0 before the first save). */
export function fetchAutofillProfile(signal?: AbortSignal) {
  return api.get<AutofillProfileEnvelope>('/api/autofill/profile', { signal, schema: AutofillProfileEnvelopeSchema });
}

/** GET /api/autofill/profile/sensitive: work authorization, self-identification, age and pay. */
export function fetchAutofillSensitive(signal?: AbortSignal) {
  return api.get<AutofillSensitiveEnvelope>('/api/autofill/profile/sensitive', {
    signal,
    schema: AutofillSensitiveEnvelopeSchema,
  });
}

/** PUT /api/autofill/profile: both parts, from the revision the page loaded (409 `revision_conflict` when stale). */
export function saveAutofillProfile(body: PutAutofillProfileBody) {
  return api.put<PutAutofillProfileResponse>('/api/autofill/profile', body, { schema: PutAutofillProfileResponseSchema });
}

/** GET /api/autofill/profile/seed: what that resume (else the default, else the latest) says. Writes nothing. */
export function fetchAutofillSeed(resumeId: string | null, signal?: AbortSignal) {
  return api.get<ProfileSeedView>('/api/autofill/profile/seed', { query: { resumeId }, signal, schema: ProfileSeedViewSchema });
}

/**
 * v32 FILL: POST /api/autofill/profile/seed, "Fill from my resume": the seed, or `{ taskId }` while the AI reads an
 * uploaded file (then GET /api/ai/tasks/:id until it ends, then fetchAutofillSeed).
 */
export function startAutofillSeed(resumeId: string | null) {
  return api.post<ProfileSeedStart>('/api/autofill/profile/seed', resumeId ? { resumeId } : {}, { schema: ProfileSeedStartSchema });
}

/** GET /api/autofill/resumes */
export function fetchAutofillResumes(signal?: AbortSignal) {
  return api.get<AutofillResumeList>('/api/autofill/resumes', { signal, schema: AutofillResumeListSchema });
}

/** GET /api/autofill/tokens: the browsers the extension is connected in. */
export function fetchExtensionConnections(signal?: AbortSignal) {
  return api.get<AutofillTokenList>('/api/autofill/tokens', { signal, schema: AutofillTokenListSchema });
}

/** DELETE /api/autofill/tokens/:id: that browser's extension stops at once. */
export function disconnectExtension(id: string) {
  return api.delete<void>(`/api/autofill/tokens/${encodeURIComponent(id)}`);
}

/**
 * POST /api/autofill/connect: a one-time connect code (10 minutes) for the extension to exchange for its token. The two
 * boxes: the sensitive answers (reading and changing them), and reading the saved job-site password.
 */
export function createConnectCode(choices: Pick<AutofillConnectBody, 'includeSensitive' | 'allowSignIn'>) {
  const body: AutofillConnectBody = { includeSensitive: choices.includeSensitive, allowSignIn: choices.allowSignIn };
  return api.post<AutofillConnectResponse>('/api/autofill/connect', body, { schema: AutofillConnectResponseSchema });
}

/** GET /api/autofill/answers: the answers the extension saved, the latest first. */
export function fetchSavedAnswers(signal?: AbortSignal) {
  return api.get<AutofillSavedAnswerList>('/api/autofill/answers', { signal, schema: AutofillSavedAnswerListSchema });
}

/** PUT /api/autofill/answers: saves the answer under its key, replacing the one there. */
export function saveSavedAnswer(body: PutAutofillSavedAnswerBody) {
  return api.put<AutofillSavedAnswer>('/api/autofill/answers', body, { schema: AutofillSavedAnswerSchema });
}

/** DELETE /api/autofill/answers/:id: the extension stops giving that answer. */
export function deleteSavedAnswer(id: string) {
  return api.delete<void>(`/api/autofill/answers/${encodeURIComponent(id)}`);
}

/** GET /api/autofill/sign-ins: the saved job-site sign-ins, every site's first. Never a password. */
export function fetchSignIns(signal?: AbortSignal) {
  return api.get<AutofillSignInList>('/api/autofill/sign-ins', { signal, schema: AutofillSignInListSchema });
}

/**
 * PUT /api/autofill/sign-ins: saves the sign-in for `body.host`, replacing the one there. Without `password` the saved
 * one is kept. Answers the item, without its password. The caller keeps the password no longer than its form.
 */
export function saveSignIn(body: PutAutofillSignInBody) {
  return api.put<AutofillSignInItem>('/api/autofill/sign-ins', body, { schema: AutofillSignInItemSchema });
}

/** DELETE /api/autofill/sign-ins/:id: the extension can no longer sign in with it. */
export function deleteSignIn(id: string) {
  return api.delete<void>(`/api/autofill/sign-ins/${encodeURIComponent(id)}`);
}

/** GET /api/autofill/site-requests: the sites the person asked TailorIT to support, the latest first. */
export function fetchSiteRequests(signal?: AbortSignal) {
  return api.get<AutofillSiteRequestList>('/api/autofill/site-requests', { signal, schema: AutofillSiteRequestListSchema });
}
