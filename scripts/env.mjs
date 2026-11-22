// Loads the repository's single root `.env` for every launcher (and, through them, both apps).
//
// Windows PowerShell 5.1 writes UTF-16LE from `>` and `Set-Content`; read as UTF-8 such a file parses into keys full
// of NUL bytes and silently configures nothing. So the BOM decides the encoding. apps/api/src/config/env.ts parses the
// same file the same way; change the two together.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Reads a text file whatever encoding Windows wrote it in. */
export function readEnvText(filePath) {
  const buffer = readFileSync(filePath);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

/** `KEY=value` lines, `#` comments, optional `export `, single or double quotes (double quotes honour \n). */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
    let value = rest;
    if (value.startsWith('"')) {
      const end = value.lastIndexOf('"');
      value = (end > 0 ? value.slice(1, end) : value.slice(1)).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (value.startsWith("'")) {
      const end = value.lastIndexOf("'");
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    out[key] = value;
  }
  return out;
}

/** Applies the root `.env` to process.env. Variables already set in the environment win unless `override`. */
export function loadRootEnv({ override = false } = {}) {
  const file = join(repoRoot, '.env');
  if (!existsSync(file)) return {};
  const parsed = parseEnv(readEnvText(file));
  for (const [key, value] of Object.entries(parsed)) {
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
  return parsed;
}

// ── v30 SCH: the keys the launchers and the doctor read (apps/api/src/config/env.ts and config/outside.ts read the same
// keys by the same rules for the API: change them together; apps/api/test/config-v30.test.ts runs both) ──

/** The embedded PostgreSQL's port when PG_PORT is blank (core/db/pg/embedded.ts DEFAULT_PG_PORT). */
export const DEFAULT_PG_PORT = 5442;

/**
 * The database keys: DATABASE_URL (a PostgreSQL 18 server; `embedded` false), else the embedded server on PG_PORT with
 * its data in PG_DATA_DIR (null: <DATA_DIR>/pg, which the API resolves).
 */
export function databaseSettings(env = process.env) {
  const url = env.DATABASE_URL?.trim() || null;
  const port = Number(env.PG_PORT?.trim() || DEFAULT_PG_PORT);
  return { url, embedded: url === null, port, dataDir: env.PG_DATA_DIR?.trim() || null };
}

/**
 * The new outside reads' settings: BOT_USER_AGENT read as the API reads it (botUserAgentState), and which services'
 * keys are set (USAJOBS_API_KEY, HIMALAYAS_API_KEY, LOGO_DEV_KEY; never their values).
 */
export function outsideSettings(env = process.env) {
  const set = (key) => Boolean(env[key]?.trim()) && !/^<[^>]*>$/.test(env[key].trim());
  return {
    bot: botUserAgentState(env.BOT_USER_AGENT),
    keys: { usajobs: set('USAJOBS_API_KEY'), himalayas: set('HIMALAYAS_API_KEY'), logoDev: set('LOGO_DEV_KEY') },
  };
}

/** BOT_USER_AGENT's form (config/outside.ts BOT_USER_AGENT_PLACEHOLDER). */
export const BOT_USER_AGENT_PLACEHOLDER = 'TailorIT/1.0 (+https://<public site>/bot; <role mailbox>)';

const RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|net|org)|example|invalid|test|localhost|local)$/i;
const BOT_PAGE = /\+?https:\/\/([^\s/;()<>]+)[^\s;()<>]*/i;
const MAILBOX = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/;

/**
 * BOT_USER_AGENT read as the API reads it (config/outside.ts readBotUserAgent): `{ userAgent, placeholder }`, or
 * `{ error }` for a value the API refuses at start.
 */
export function botUserAgentState(value) {
  const text = value?.trim() ?? '';
  if (!text) return { userAgent: BOT_USER_AGENT_PLACEHOLDER, placeholder: true };
  if (text.length > 256 || /[^\x20-\x7e]/.test(text)) return { error: 'not one line of plain ASCII text of 256 characters or fewer' };
  if (/[<>]/.test(text)) return { userAgent: text, placeholder: true };
  if (!/^TailorIT\//i.test(text)) return { error: 'does not start with TailorIT/' };
  const page = BOT_PAGE.exec(text);
  if (!page) return { error: 'names no public bot page (+https://<public site>/bot)' };
  const mailbox = MAILBOX.exec(text);
  if (!mailbox) return { error: 'names no role mailbox' };
  const host = page[1].toLowerCase().replace(/:\d+$/, '').replace(/\.+$/, '');
  const placeholder = !host.includes('.') || RESERVED_DOMAIN.test(host) || RESERVED_DOMAIN.test(mailbox[1].toLowerCase());
  return { userAgent: text, placeholder };
}

// ── v34 AIKEY (review fix L4): who pays for TailorIT's AI, for the doctor. apps/api/src/config/env.ts (AI_BILLING) and
// apps/api/src/ai/provider/env.ts (buildChildEnv) are the API's rules; apps/api/test/v34-aikey.test.ts runs both ──

/** AI_BILLING's choices (@tailorit/shared AI_BILLING_MODES). */
export const AI_BILLING_MODES = ['subscription', 'api-key'];

/** AI_BILLING as the API reads it: blank is subscription; a value that is not one of the two is `{ error }`. */
export function aiBillingState(value) {
  const text = (value ?? '').trim();
  if (text === '') return { billing: 'subscription' };
  return AI_BILLING_MODES.includes(text) ? { billing: text } : { error: `Use one of: ${AI_BILLING_MODES.join(', ')}` };
}

/**
 * The environment the API gives the `claude` CLI (buildChildEnv): the server's own minus ANTHROPIC_API_KEY,
 * ANTHROPIC_AUTH_TOKEN, CLAUDECODE, MAX_THINKING_TOKENS and CLAUDE_* (CLAUDE_CONFIG_DIR stays); with `api-key`,
 * ANTHROPIC_API_KEY stays and every other ANTHROPIC_* goes. Names are compared case-insensitively.
 */
export function cliChildEnv(parent, billing = 'subscription') {
  const dropped = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'MAX_THINKING_TOKENS']);
  const child = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (billing === 'api-key') {
      if (upper.startsWith('ANTHROPIC_') && upper !== 'ANTHROPIC_API_KEY') continue;
      if (dropped.has(upper) && upper !== 'ANTHROPIC_API_KEY') continue;
    } else if (dropped.has(upper)) continue;
    if (upper.startsWith('CLAUDE_') && upper !== 'CLAUDE_CONFIG_DIR') continue;
    child[name] = value;
  }
  return child;
}

/** The `authMethod` values of an API key's sign-in (apps/api/src/ai/provider/health.ts API_KEY_AUTH_METHODS). */
export const API_KEY_AUTH_METHODS = ['api_key', 'api_key_helper'];
