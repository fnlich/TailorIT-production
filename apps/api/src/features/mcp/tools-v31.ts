import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { JOB_LINK_MAX_CHARS } from '@tailorit/shared';
import { MCP_ARG_DESCRIPTIONS, MCP_TOOL_DESCRIPTIONS } from '../../ai/prompts/mcp/tool-descriptions';
import { newInFlight } from '../autofill/jobs';
import { takeAddSlot } from '../jobs/add/limits';
import { addJobByLink } from '../jobs/add/pipeline';
import { addJobResultOf } from '../jobs/add/router';
import { ProfileArg, type McpSession } from './profiles';
import { refuseGrantTripwire } from './save';

// v31 LINK: the MCP tool add_job (docs/design/v3.1/21-jobs-from-links.md §7): the person's AI adds a job by its link,
// through the one pipeline (jobs/add/pipeline.ts addJobByLink, origin `mcp`): TailorIT reads the posting itself, and
// the job is saved to the person's tracker. It takes only the link (the AI's title or text is never asked for), counts
// against the account's JOB_ADDS_PER_HOUR, and answers as POST /api/jobs/add answers. server.ts registers it with one
// marked line (registerV31Tools). The log names the tool, the account and done or refused, never the link.
// v33 SHARE-8 (SHARE-3's edit 5, the MCP half): the job is saved to the tracker of the profile the call names
// (`profile`; tracker:edit on another person's), and the add counts against the CALLER's hour (takeAddSlot by the
// caller: adds on several profiles never multiply it).

/** Registers the v3.1 LINK tools on one request's server, for the token's account. */
export function registerV31Tools(server: McpServer, session: McpSession): void {
  const inFlight = newInFlight();
  server.registerTool(
    'add_job',
    {
      title: 'Add a job',
      description: MCP_TOOL_DESCRIPTIONS.add_job,
      inputSchema: {
        url: z.string().trim().min(1).max(JOB_LINK_MAX_CHARS).describe(MCP_ARG_DESCRIPTIONS.url),
        profile: ProfileArg,
      },
      // It writes (a job, a tracker entry) and reads the posting's own site; adding the same link again changes nothing.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ url, profile }) =>
      session.run('add_job', { profile }, async (ctx) => {
        refuseGrantTripwire(ctx, url);
        takeAddSlot(ctx.deps, ctx.caller.id);
        // v33 INT-D (SHARE-6's exact edit 1, SHARE-8's 2): on another person's profile the caller is the link's adder
        // under the grant (jobs/add/pipeline.ts AddJobByLinkInput.actor): the link's later notices reach them there.
        const actor = ctx.profile.grant ? { actor: { id: ctx.caller.id, grantId: ctx.profile.grant.id } } : {};
        const outcome = await addJobByLink(ctx.deps, { url, userId: ctx.userId, origin: 'mcp', save: true, inFlight, ...actor });
        return addJobResultOf(ctx.deps, outcome);
      }),
  );
}
