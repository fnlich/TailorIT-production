import { randomUUID } from 'node:crypto';
import type { McpUnsupportedList } from '@tailorit/shared/mcp';
import { MCP_REPORTS_PER_HOUR } from '@tailorit/shared/mcp';
import { constantsOf } from '../../core/constants/service';
import type { AppDeps } from '../../core/context';
import { AppError } from '../../core/http/errors';
import { untrustedText } from '../autofill/ai/untrusted';
import { credentialColumns } from './tokens'; // v31 OAUTH

// v1.5 Q2: report_unsupported (migration 0818, mcp_unsupported_reports). When no tool or filter can do what the
// person asked, their AI reports it here instead of guessing; the person reads the reports in Settings ›
// Integrations › "Your own AI (MCP)" under "Requests your AI could not do", and deletes them there. The words are the
// AI's, cleaned as page text (they are shown as plain text, never as markup). Per token, MCP_REPORTS_PER_HOUR an hour;
// per account, the newest MCP_REPORTS_KEPT are kept (v30 ST2: the central constant, an admin may change it). Only this
// file touches the table.
// v3.0 D2 (the concurrency audit): the token's hourly count and the account's cap are checks, then writes: one
// transaction behind the person's lock (a token is one account's), so two reports at once keep both limits.
// v31 OAUTH: a report made with an OAuth access token names its grant (grant_id, migration 0041) instead of a personal
// token, and its hourly count is the grant's (credentialColumns); the list names the connected app.

type Deps = Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>;

export interface ReportInput {
  request: string;
  missing: string;
  triedTools?: string[];
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** report_unsupported: keeps the report; a refusal (rate_limited) past the token's hourly limit. */
export async function reportUnsupported(deps: Deps, userId: string, tokenId: string | null, input: ReportInput) {
  const request = untrustedText(input.request, 500);
  const missing = untrustedText(input.missing, 300);
  if (!request || !missing) throw new AppError('validation_failed', 'Say what the person asked (request) and what TailorIT lacks (missing).');
  const tried = [...new Set((input.triedTools ?? []).filter((name) => TOOL_NAME.test(name)))].slice(0, 20);
  const now = deps.now();
  const kept = constantsOf(deps).get('MCP_REPORTS_KEPT');
  return deps.db.tx(async (t) => {
    await t.lockPerson(userId);
    const credential = credentialColumns(tokenId); // v31 OAUTH
    if (credential.tokenId || credential.grantId) {
      const since = new Date(now.getTime() - 60 * 60_000).toISOString();
      const column = credential.tokenId ? 'token_id' : 'grant_id';
      const recent = await t.one<{ n: number }>(`SELECT count(*) AS n FROM mcp_unsupported_reports WHERE ${column} = ? AND created_at > ?`, [
        credential.tokenId ?? credential.grantId,
        since,
      ]);
      if ((recent?.n ?? 0) >= MCP_REPORTS_PER_HOUR) {
        throw new AppError('rate_limited', `This token has sent ${MCP_REPORTS_PER_HOUR} reports this hour. Tell the person what is missing instead.`);
      }
    }
    const id = randomUUID();
    await t.run(
      `INSERT INTO mcp_unsupported_reports(id, user_id, token_id, grant_id, request, missing, tried_tools, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, credential.tokenId, credential.grantId, request, missing, JSON.stringify(tried), now.toISOString()],
    );
    // seq: the insertion order among reports of one instant (v3.0 PG-G: the baseline's identity column).
    await t.run(
      `DELETE FROM mcp_unsupported_reports WHERE user_id = ? AND id NOT IN (
         SELECT id FROM mcp_unsupported_reports WHERE user_id = ? ORDER BY created_at DESC, ${t.dialect.seq()} DESC LIMIT ?)`,
      [userId, userId, kept],
    );
    return { reported: id };
  }, { label: 'report_unsupported' });
}

/** GET /api/mcp/unsupported: the account's reports, newest first, with the name of the token that sent each. */
export async function listUnsupported(deps: Pick<AppDeps, 'db'>, userId: string): Promise<McpUnsupportedList> {
  const rows = await deps.db.all<{
    id: string;
    request: string;
    missing: string;
    tried_tools: string;
    created_at: string;
    token_name: string | null;
  }>(
    `SELECT r.id, r.request, r.missing, r.tried_tools, r.created_at, COALESCE(t.name, c.name) AS token_name
     FROM mcp_unsupported_reports r LEFT JOIN mcp_tokens t ON t.id = r.token_id
     LEFT JOIN oauth_grants g ON g.id = r.grant_id LEFT JOIN oauth_clients c ON c.id = g.client_id
     WHERE r.user_id = ? ORDER BY r.created_at DESC, ${deps.db.dialect.seq('r')} DESC`,
    [userId],
  );
  return {
    items: rows.map((row) => {
      let tried: unknown = [];
      try {
        tried = JSON.parse(row.tried_tools);
      } catch {
        tried = [];
      }
      return {
        id: row.id,
        request: row.request,
        missing: row.missing,
        triedTools: Array.isArray(tried) ? tried.filter((name): name is string => typeof name === 'string') : [],
        tokenName: row.token_name,
        createdAt: row.created_at,
      };
    }),
  };
}

/** DELETE /api/mcp/unsupported/:id: true when the account's report was deleted. */
export async function deleteUnsupported(deps: Pick<AppDeps, 'db'>, userId: string, id: string): Promise<boolean> {
  return (await deps.db.run('DELETE FROM mcp_unsupported_reports WHERE id = ? AND user_id = ?', [id, userId])).changes === 1;
}

/** DELETE /api/mcp/unsupported: deletes every report of the account, answering how many. */
export async function clearUnsupported(deps: Pick<AppDeps, 'db'>, userId: string): Promise<number> {
  return (await deps.db.run('DELETE FROM mcp_unsupported_reports WHERE user_id = ?', [userId])).changes;
}
