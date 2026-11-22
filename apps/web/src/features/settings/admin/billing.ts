import type { AiBilling } from '@tailorit/shared/ai';

// v34 AIKEY (PLAN Addendum G11): Admin › AI's "Billed to", the AI_BILLING the server started with (set in .env only,
// so the admin reads it here and changes it with the operator). It never shows a key: the API sends only the mode.

export const BILLING_FACT_LABEL = 'Billed to';

/** Each mode's value and its "?" tip (one short sentence). */
export const BILLING_TEXT: Record<AiBilling, { value: string; tip: string }> = {
  subscription: {
    value: 'Claude subscription',
    tip: "The claude CLI's own sign-in pays for each AI call; AI_BILLING=api-key in .env bills an Anthropic API key instead.",
  },
  'api-key': {
    value: 'Anthropic API key',
    tip: 'Each AI call is billed to the Anthropic API key in ANTHROPIC_API_KEY, as AI_BILLING=api-key in .env asks.',
  },
};

/** The words for `billing`; an older API that sends none is on the subscription (its only mode before v3.4). */
export function billingText(billing: AiBilling | undefined): { value: string; tip: string } {
  return BILLING_TEXT[billing ?? 'subscription'];
}

// v34 FIX-WEB (final review U-L7): Admin › AI's "Signed in" in words. The CLI names its sign-in by a value (`claude.ai`,
// `api_key`, ...); the page says what it is, never the value's name.

/** The CLI's sign-in methods in words (an unknown one: "Yes"). */
export const SIGN_IN_METHOD_TEXT: Readonly<Record<string, string>> = {
  'claude.ai': 'Claude account',
  oauth_token: 'Claude token',
  api_key: 'API key',
  api_key_helper: 'API key helper',
  third_party: 'Cloud provider',
};

/** "Signed in": "No"; the method in words, with the plan when the CLI names one ("Claude account, Max"); else "Yes". */
export function signedInText(health: { loggedIn: boolean; authMethod: string | null; subscriptionType: string | null }): string {
  if (!health.loggedIn) return 'No';
  const method = health.authMethod ? SIGN_IN_METHOD_TEXT[health.authMethod] : undefined;
  const plan = health.subscriptionType?.trim() ? health.subscriptionType.trim().replace(/^./, (first) => first.toUpperCase()) : null;
  return [method, plan].filter(Boolean).join(', ') || 'Yes';
}
