import type { AiBilling } from '@tailorit/shared';

// The environment a `claude` child gets: the server's own, minus what would change who pays or which session answers.

const DROPPED = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'MAX_THINKING_TOKENS']);

/**
 * v34 AIKEY (review fix L2): with AI_BILLING=api-key, the only ANTHROPIC_* variable the CLI gets. Every other one is
 * dropped: ANTHROPIC_BASE_URL would send the key to another host, ANTHROPIC_CUSTOM_HEADERS and ANTHROPIC_LOG change
 * what is sent or printed, and the model variables (ANTHROPIC_MODEL, ANTHROPIC_SMALL_FAST_MODEL,
 * ANTHROPIC_DEFAULT_*_MODEL) change what each call costs. TailorIT sets none of them itself: it names each call's model
 * with `--model` (argv.ts).
 */
export const API_KEY_PASSED = ['ANTHROPIC_API_KEY'] as const;

/**
 * - `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`: the CLI prefers a key over the subscription and bills every call.
 *   v34 AIKEY (PLAN Addendum G11): with AI_BILLING=api-key (`billing`) ANTHROPIC_API_KEY alone is passed, so every call
 *   is billed to it; ANTHROPIC_AUTH_TOKEN is dropped in both modes. Review fix L2: with api-key every other ANTHROPIC_*
 *   variable is dropped too (API_KEY_PASSED). The default keeps them, as before v3.4 (no key goes with them there).
 * - `CLAUDECODE` and `CLAUDE_*` (set when the server itself runs inside Claude Code): the child would join the parent
 *   session. `CLAUDE_CONFIG_DIR` stays: it is where the operator's sign-in lives.
 * - `MAX_THINKING_TOKENS`: an operator's shell setting must not make this server answer differently.
 * Names are compared case-insensitively, as Windows resolves them. scripts/env.mjs cliChildEnv is the same rule for
 * `npm run doctor` (v34-aikey.test compares them).
 */
export function buildChildEnv(parent: NodeJS.ProcessEnv, billing: AiBilling = 'subscription'): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (billing === 'api-key') {
      // v34 AIKEY (review fix L2): an allowlist of one.
      if (upper.startsWith('ANTHROPIC_') && !(API_KEY_PASSED as readonly string[]).includes(upper)) continue;
      if (DROPPED.has(upper) && upper !== 'ANTHROPIC_API_KEY') continue;
    } else if (DROPPED.has(upper)) continue;
    if (upper.startsWith('CLAUDE_') && upper !== 'CLAUDE_CONFIG_DIR') continue;
    child[name] = value;
  }
  return child;
}

// v34 AIKEY
/**
 * The values of ANTHROPIC_API_KEY in `parent` (any case, as Windows resolves names), for scrubbing the CLI's own texts
 * before they reach a log, an error or Admin › AI. Values shorter than 8 characters are left out: replacing them could
 * mangle ordinary words, and no real key is that short.
 */
export function apiKeyValues(parent: NodeJS.ProcessEnv): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(parent)) {
    if (name.toUpperCase() !== 'ANTHROPIC_API_KEY' || typeof value !== 'string') continue;
    for (const form of [value, value.trim()]) if (form.length >= 8) values.add(form);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** The name a scrubbed value is replaced with. */
export const SCRUBBED = '[ANTHROPIC_API_KEY]';
/**
 * Review fix L3: a piece of a key this long or longer at a cut edge is replaced too. Shorter pieces are left: 3
 * characters of a key say nothing about it, and replacing them would mangle ordinary text that happens to match.
 */
export const MIN_SCRUBBED_PIECE = 4;

/**
 * `text` with every value of `secrets` replaced by the variable's name. Scrub a text BEFORE shortening it (review fix
 * L3: a cut through a key leaves a piece no exact match finds). Where the text was already cut by someone else (a
 * buffer that kept only its tail: `cut.start`; one that stopped at a size: `cut.end`), a piece of a key at that edge is
 * replaced as well (MIN_SCRUBBED_PIECE characters or more).
 */
export function scrubSecrets(text: string, secrets: readonly string[], cut: { start?: boolean; end?: boolean } = {}): string {
  let out = text;
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join(SCRUBBED);
  if (cut.start) {
    let piece = 0;
    for (const secret of secrets) {
      for (let n = Math.min(secret.length - 1, out.length); n >= MIN_SCRUBBED_PIECE && n > piece; n -= 1) {
        if (out.startsWith(secret.slice(-n))) piece = n;
      }
    }
    if (piece > 0) out = SCRUBBED + out.slice(piece);
  }
  if (cut.end) {
    let piece = 0;
    for (const secret of secrets) {
      for (let n = Math.min(secret.length - 1, out.length); n >= MIN_SCRUBBED_PIECE && n > piece; n -= 1) {
        if (out.endsWith(secret.slice(0, n))) piece = n;
      }
    }
    if (piece > 0) out = out.slice(0, out.length - piece) + SCRUBBED;
  }
  return out;
}
// end v34 AIKEY
