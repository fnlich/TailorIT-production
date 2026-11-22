import { formatUsd } from '@tailorit/shared';
import type { AppConfig } from '../config/env';
import type { CapacityState, KeyBudgetState } from './capacity';
import { aboutMinutes } from './errors';
import { buildChildEnv } from './provider/env'; // v34 FIX-API
import { isApiKeySignIn, type CliStatus } from './provider/health';

// v34 AIKEY (PLAN Addendum G11): what the operator reads about who pays for TailorIT's AI, AI_BILLING. The default,
// `subscription`, is the claude CLI's own sign-in (before v3.4 the only way); `api-key` bills every call to the
// Anthropic API key in ANTHROPIC_API_KEY. None of these lines ever holds the key: only whether it is set.

/** A credential source's name as the CLI gives it ("ANTHROPIC_API_KEY", "apiKeyHelper"); anything else is not shown. */
const SOURCE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * The line the API logs at its start (apps/api/src/index.ts): which billing is in use, never the key. Review fix H1:
 * with api-key it names the API key's daily budget (`keyBudgetMicros`, AI_KEY_DAILY_BUDGET_USD as the start reads it).
 */
export function aiBillingStartLine(ai: Pick<AppConfig['ai'], 'enabled' | 'billing'>, env: NodeJS.ProcessEnv, keyBudgetMicros?: number): string {
  if (!ai.enabled) return `[ai] TailorIT's AI is off (AI_ENABLED=false); AI_BILLING=${ai.billing}.`;
  if (ai.billing === 'api-key') {
    return (
      '[ai] AI billing: api-key. Every AI call is billed to the Anthropic API key in ANTHROPIC_API_KEY; a call the ' +
      'claude CLI would bill to a Claude subscription is stopped.' +
      (keyBudgetMicros === undefined
        ? ''
        : // v34 FIX-API (the final security review, F2): a soft cap, tight; the workspace's limit is the hard guard.
          // v34 INT-2: the budget's one sentence, as Admin › AI, the guide and docs/directory/CHECKLIST.md say it.
          ` TailorIT stops starting AI calls when today's spend reaches ${formatUsd(keyBudgetMicros)}; calls already running ` +
          'finish. The budget is AI_KEY_DAILY_BUDGET_USD (Admin › Constants › Server AI), per UTC day. The Anthropic ' +
          "workspace's spend limit is the hard guard: set one there too.")
    );
  }
  const keySet = Boolean(env.ANTHROPIC_API_KEY?.trim());
  return (
    "[ai] AI billing: subscription. The claude CLI runs on its own sign-in (a Claude subscription) and never gets an API key." +
    (keySet ? ' ANTHROPIC_API_KEY is set on this server and is not used (AI_BILLING=api-key would use it).' : '')
  );
}

/**
 * v34 FIX-API (the final security review, O1; the decision: the default billing passes them on, as a CLI run by hand
 * gets them): with AI_BILLING=subscription the claude CLI gets this server's ANTHROPIC_* variables but the key and the
 * token (provider/env.ts buildChildEnv), such as ANTHROPIC_BASE_URL (where the calls go) or ANTHROPIC_LOG (what the CLI
 * prints). The start names them, never their values, so a stray one is seen. Null: none passed, AI off, or api-key
 * (which passes ANTHROPIC_API_KEY alone).
 */
export function aiCliPassedEnvLine(ai: Pick<AppConfig['ai'], 'enabled' | 'billing'>, env: NodeJS.ProcessEnv): string | null {
  if (!ai.enabled || ai.billing !== 'subscription') return null;
  const names = [...new Set(Object.keys(buildChildEnv(env, 'subscription')).filter((name) => name.toUpperCase().startsWith('ANTHROPIC_')))].sort();
  if (names.length === 0) return null;
  return (
    `[ai] The claude CLI also gets ${names.length === 1 ? 'this setting' : 'these settings'} from this server's environment ` +
    `(names only): ${names.join(', ')}. ${names.length === 1 ? 'It changes' : 'They change'} where or how the CLI sends ` +
    "TailorIT's AI calls; remove any that is not meant for TailorIT."
  );
}

/**
 * Admin › AI's availability and sentence with AI_BILLING=api-key (ai/queue.ts describeHealth; the default keeps its
 * own): ready when the CLI runs on an API key, not when it is signed in with a subscription and no key.
 */
export function describeApiKeyHealth(status: CliStatus): { available: boolean; message: string } {
  if (!status.loggedIn) {
    // Review fix L7: the start makes sure ANTHROPIC_API_KEY is set, so what is wrong is that the CLI does not say it
    // uses it.
    return {
      available: false,
      message:
        'AI_BILLING=api-key and ANTHROPIC_API_KEY is set, but "claude auth status" does not report the CLI using it. ' +
        "Run Admin › AI's test: if it answers, AI runs on the key; if not, check that the key is valid and the Claude " +
        'CLI is up to date.',
    };
  }
  if (isApiKeySignIn(status)) {
    const source = status.apiKeySource && SOURCE_NAME.test(status.apiKeySource) ? ` (${status.apiKeySource})` : '';
    return {
      available: true,
      message:
        `Claude CLI ${status.version ?? '(unknown version)'} is using the Anthropic API key${source}: every AI call is ` +
        'billed to it (AI_BILLING=api-key).',
    };
  }
  return {
    available: false,
    message:
      `AI_BILLING=api-key, but the Claude CLI is signed in with authMethod "${status.authMethod ?? 'unknown'}" and no API ` +
      'key, which a Claude subscription pays for, so TailorIT stops every AI call. Check that ANTHROPIC_API_KEY is set ' +
      "for this server and that the CLI's own settings do not choose another sign-in.",
  };
}

// Review fix H1 --------------------------------------------------------------------------------------------------------

/** "in about 3 hours" (2 hours or more), else "in about 40 minutes". */
function inAbout(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes >= 120 ? `in about ${Math.round(minutes / 60)} hours` : `in ${aboutMinutes(ms)}`;
}

/** The admin's sentence for a reached API key daily budget: the reason and when AI resumes. */
export function keyBudgetPausedText(budget: KeyBudgetState, nowMs: number): string {
  return (
    `TailorIT's AI is paused: today's AI spend (${formatUsd(budget.spentMicros)}) reached the API key's daily budget ` +
    `(${formatUsd(budget.capMicros)}, AI_KEY_DAILY_BUDGET_USD). It resumes at 00:00 UTC, ${inAbout(budget.resetsAtMs - nowMs)}.`
  );
}

/**
 * What Admin › AI's health adds while server AI is blocked: the API key's reached daily budget (api-key), and the
 * capacity block's sentence when a reading blocks (on a subscription the only one, as before v3.4).
 */
export function capacityBlockedText(state: Pick<CapacityState, 'keyBudget' | 'top' | 'threshold'>, nowMs: number): string {
  const reached = state.keyBudget?.reached === true;
  const windowBlocked = state.top !== null && state.top.utilization >= state.threshold;
  return (reached ? ` ${keyBudgetPausedText(state.keyBudget!, nowMs)}` : '') + (windowBlocked || !reached ? ' The server AI capacity block is on.' : '');
}
