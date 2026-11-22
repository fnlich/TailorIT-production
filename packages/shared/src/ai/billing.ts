// v34 AIKEY (PLAN Addendum G11): who pays for TailorIT's own AI, the operator's choice in .env (AI_BILLING, a constant
// that only .env sets: constants.ts). A leaf module (no imports), so the constants table and the AI contracts share it.

/**
 * - `subscription` (the default): the `claude` CLI's own sign-in, a Claude subscription. TailorIT never passes an API
 *   key to the CLI and stops any call the CLI says an API key pays for (ai/provider/env.ts, classify.ts).
 * - `api-key`: the Anthropic API key in ANTHROPIC_API_KEY, billed per call. TailorIT passes that one key to the CLI and
 *   stops any call the CLI says the subscription pays for (a public service must not fall back to one person's plan).
 */
export const AI_BILLING_MODES = ['subscription', 'api-key'] as const;
export type AiBilling = (typeof AI_BILLING_MODES)[number];
