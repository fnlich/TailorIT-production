import {
  OAuthConsentAnswerSchema,
  OAuthGrantListSchema,
  OAuthRequestViewSchema,
  type OAuthConsentAnswer,
  type OAuthConsentBody,
  type OAuthGrantList,
  type OAuthRequestView,
} from '@tailorit/shared/oauth';
import { api } from '@/lib/api';

// v3.1 OAUTH: the web's OAuth routes (the session's; apps/api/src/features/oauth/router.ts). The consent page uses the
// first two; the Integrations page (INTEG) lists and disconnects the connected AI apps with the last two.

/** GET /api/oauth/requests/:id: the consent page's facts (the browser that began the request only). */
export function fetchOAuthRequest(requestId: string, signal?: AbortSignal): Promise<OAuthRequestView> {
  return api.get<OAuthRequestView>(`/api/oauth/requests/${encodeURIComponent(requestId)}`, { signal, schema: OAuthRequestViewSchema });
}

/** POST /api/oauth/consent: Allow or Cancel; answers where to send the browser (the AI app's own address). */
export function sendOAuthConsent(body: OAuthConsentBody): Promise<OAuthConsentAnswer> {
  return api.post<OAuthConsentAnswer>('/api/oauth/consent', body, { schema: OAuthConsentAnswerSchema });
}

export const OAUTH_GRANTS_KEY = ['oauth', 'grants'] as const;

/** GET /api/oauth/grants: the account's connected AI apps (Claude, ChatGPT, others), newest first. */
export function fetchOAuthGrants(signal?: AbortSignal): Promise<OAuthGrantList> {
  return api.get<OAuthGrantList>('/api/oauth/grants', { signal, schema: OAuthGrantListSchema });
}

/** DELETE /api/oauth/grants/:id: the app is disconnected at once (every token it holds stops working). */
export async function revokeOAuthGrant(id: string): Promise<void> {
  await api.delete(`/api/oauth/grants/${encodeURIComponent(id)}`);
}
