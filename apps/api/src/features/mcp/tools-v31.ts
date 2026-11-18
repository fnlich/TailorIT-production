import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { JOB_LINK_MAX_CHARS } from '@tailorit/shared';
import { MCP_ARG_DESCRIPTIONS, MCP_TOOL_DESCRIPTIONS } from '../../ai/prompts/mcp/tool-descriptions';
import type { AppDeps } from '../../core/context';
import { AppError } from '../../core/http/errors';
import { newInFlight } from '../autofill/jobs';
import { takeAddSlot } from '../jobs/add/limits';
import { addJobByLink } from '../jobs/add/pipeline';
import { addJobResultOf } from '../jobs/add/router';

// v31 LINK: the MCP tool add_job (docs/design/v3.1/21-jobs-from-links.md §7): the person's AI adds a job by its link,
// through the one pipeline (jobs/add/pipeline.ts addJobByLink, origin `mcp`): TailorIT reads the posting itself, and
// the job is saved to the person's tracker. It takes only the link (the AI's title or text is never asked for), counts
// against the account's JOB_ADDS_PER_HOUR, and answers as POST /api/jobs/add answers. server.ts registers it with one
// marked line (registerV31Tools). The log names the tool, the account and done or refused, never the link.

/** One request's runner: a JSON answer, a refusal as a tool error, logs without values (as tools-q2.ts's). */
function runner(deps: AppDeps, userId: string) {
  const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  return async (tool: string, work: () => unknown): Promise<CallToolResult> => {
    try {
      const result = await work();
      deps.log.debug(`[mcp] account ${userId}: ${tool} done`);
      return json(result);
    } catch (error) {
      if (error instanceof AppError && error.status < 500) {
        deps.log.debug(`[mcp] account ${userId}: ${tool} refused (${error.code})`);
        return { ...json({ error: { code: error.code, message: error.message } }), isError: true };
      }
      deps.log.error(`[mcp] account ${userId}: ${tool} failed`, error instanceof Error ? error.name : 'unknown');
      return { ...json({ error: { code: 'internal', message: "Something went wrong on TailorIT's side. Try again." } }), isError: true };
    }
  };
}

/** Registers the v3.1 LINK tools on one request's server, for the token's account. */
export function registerV31Tools(server: McpServer, deps: AppDeps, userId: string): void {
  const run = runner(deps, userId);
  const inFlight = newInFlight();
  server.registerTool(
    'add_job',
    {
      title: 'Add a job',
      description: MCP_TOOL_DESCRIPTIONS.add_job,
      inputSchema: { url: z.string().trim().min(1).max(JOB_LINK_MAX_CHARS).describe(MCP_ARG_DESCRIPTIONS.url) },
      // It writes (a job, a tracker entry) and reads the posting's own site; adding the same link again changes nothing.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ url }) =>
      run('add_job', async () => {
        takeAddSlot(deps, userId);
        const outcome = await addJobByLink(deps, { url, userId, origin: 'mcp', save: true, inFlight });
        return addJobResultOf(deps, outcome);
      }),
  );
}
