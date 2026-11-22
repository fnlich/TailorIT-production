import { cleanCustomInstructions, DEFAULT_MCP_SETTINGS, type McpPromptMode, type McpSettings } from '@tailorit/shared/mcp';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { validationFailed } from '../../core/http/errors';

// v1.5 Q1: mcp_settings (migration 0817), the person's own AI settings: the revision rounds prepare_save_resume asks
// for (0 to 5, 2 by default) and whose prompts the tools' next steps point to. The only module that reads or writes the
// table; every read and write names the account. An account without a row has the defaults.
// v2.0 P5 (07-mcp.md): custom_instructions (0824), the person's own words for their AI: plain text, at most
// MCP_CUSTOM_INSTRUCTIONS_MAX_CHARS, control characters but line breaks and tabs removed. Served after TailorIT's
// default instructions and appended to every step prompt (instructions.ts); never logged.

// v34 MCPDIR (the security review, finding 1): custom instructions the person's AI asks for (set_prepare_settings) wait
// in pending_custom_instructions (0054) until the person approves them in Settings › Integrations; every prompt keeps
// the approved custom_instructions until then. The person's own edits there take effect at once.

interface Row {
  revise_rounds: number;
  prompt_mode: McpPromptMode;
  custom_instructions: string;
  pending_custom_instructions: string | null;
  updated_at: string;
}

function rowOf(deps: Pick<AppDeps, 'db'>, userId: string): Promise<Row | undefined> {
  return deps.db.one<Row>(
    `SELECT revise_rounds, prompt_mode, custom_instructions, pending_custom_instructions, updated_at
       FROM mcp_settings WHERE user_id = ?`,
    [userId],
  );
}

/** The account's settings, the defaults when it never changed one (pendingCustomInstructions only when one waits). */
export async function mcpSettings(deps: Pick<AppDeps, 'db'>, userId: string): Promise<McpSettings> {
  const row = await rowOf(deps, userId);
  if (!row) return { ...DEFAULT_MCP_SETTINGS };
  return {
    reviseRounds: row.revise_rounds,
    promptMode: row.prompt_mode,
    customInstructions: row.custom_instructions,
    ...(row.pending_custom_instructions !== null ? { pendingCustomInstructions: row.pending_custom_instructions } : {}),
  };
}

/**
 * v34 MCPDIR: custom instructions the person's AI asked for, kept to wait for the person's OK (checked and cleaned by
 * the caller); a later request replaces an earlier one. Nothing the prompts read changes.
 */
export async function askCustomInstructions(deps: Pick<AppDeps, 'db' | 'now'>, userId: string, text: string): Promise<McpSettings> {
  const now = deps.now().toISOString();
  await deps.db.run(
    `INSERT INTO mcp_settings(user_id, updated_at, pending_custom_instructions, pending_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET pending_custom_instructions = excluded.pending_custom_instructions,
       pending_at = excluded.pending_at`,
    [userId, now, text, now],
  );
  return mcpSettings(deps, userId);
}

/** v34 MCPDIR: the person's OK (the pending text becomes the custom instructions) or no (it is dropped). */
export async function decidePendingInstructions(
  deps: Pick<AppDeps, 'db' | 'now'>,
  userId: string,
  decision: 'approve' | 'discard',
): Promise<McpSettings | null> {
  const changed = await deps.db.tx(
    async (t) => {
      await t.lockPerson(userId);
      const row = await t.one<{ pending: string | null }>(
        'SELECT pending_custom_instructions AS pending FROM mcp_settings WHERE user_id = ?',
        [userId],
      );
      if (row?.pending == null) return false;
      if (decision === 'approve') {
        await t.run(
          `UPDATE mcp_settings SET custom_instructions = pending_custom_instructions, pending_custom_instructions = NULL,
             pending_at = NULL, updated_at = ? WHERE user_id = ?`,
          [deps.now().toISOString(), userId],
        );
      } else {
        await t.run('UPDATE mcp_settings SET pending_custom_instructions = NULL, pending_at = NULL WHERE user_id = ?', [userId]);
      }
      return true;
    },
    { label: 'decidePendingInstructions' },
  );
  return changed ? mcpSettings(deps, userId) : null;
}

/** When the account last changed its settings (null: never), so the AI is pointed at the instructions again. */
export async function mcpSettingsChangedAt(deps: Pick<AppDeps, 'db'>, userId: string): Promise<string | null> {
  return (await rowOf(deps, userId))?.updated_at ?? null;
}

/**
 * Custom instructions as they are stored: cleaned (cleanCustomInstructions) and at most the constant
 * MCP_CUSTOM_INSTRUCTIONS_MAX_CHARS (the schema holds the column's own 4,000); 400 `validation_failed` past it.
 */
export function checkedCustomInstructions(
  deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>,
  text: string,
): string {
  const cleaned = cleanCustomInstructions(text);
  const max = constantsOf(deps).get('MCP_CUSTOM_INSTRUCTIONS_MAX_CHARS');
  if (cleaned.length > max) {
    // v2.0 FIX-C (REQ-3): the words are MSG_TEXT_TOO_LONG.
    const message = constantsOf(deps).message('MSG_TEXT_TOO_LONG', { max });
    throw validationFailed(`Custom instructions: ${message.charAt(0).toLowerCase()}${message.slice(1)}`, { customInstructions: message });
  }
  return cleaned;
}

/** Saves the fields given (the others kept) and answers the settings as saved. Values are checked by the caller. */
export async function saveMcpSettings(
  deps: Pick<AppDeps, 'db' | 'now'>,
  userId: string,
  changes: Partial<McpSettings>,
): Promise<McpSettings> {
  // Read, merge, then write behind the person's lock: two saves at once keep each other's fields.
  return deps.db.tx(
    async (t) => {
      await t.lockPerson(userId);
      const saved = { ...(await mcpSettings(deps, userId)), ...changes };
      await t.run(
        `INSERT INTO mcp_settings(user_id, revise_rounds, prompt_mode, custom_instructions, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET revise_rounds = excluded.revise_rounds, prompt_mode = excluded.prompt_mode,
           custom_instructions = excluded.custom_instructions, updated_at = excluded.updated_at`,
        [userId, saved.reviseRounds, saved.promptMode, saved.customInstructions, deps.now().toISOString()],
      );
      return saved;
    },
    { label: 'saveMcpSettings' },
  );
}
