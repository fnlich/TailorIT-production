import type { McpUnsupportedItem } from '@tailorit/shared/mcp';

// v1.5 Q2: the words of Settings › Integrations › "Your own AI (MCP)" › "Requests your AI could not do", apart from
// the view so a test reads them.

export const UNSUPPORTED_TITLE = 'Requests your AI could not do';
export const UNSUPPORTED_INTRO =
  'When you ask your AI for something no TailorIT tool can do, it reports it here instead of guessing. Delete a report once you have read it.';
export const UNSUPPORTED_EMPTY = 'Nothing yet. Your AI has done everything you asked it through TailorIT.';

/**
 * What else the person's own AI can do through TailorIT (v1.5 Q2), in the owner's words of the plan. v2.0 fix (UX-5):
 * nothing reaches the queue directly any more (A4): the AI saves jobs, and Prepare & Queue takes them, with the saved
 * filters always applied.
 */
export const ALSO_ASK = [
  'Search every job in your own words ("devops jobs from yesterday, no security clearance").',
  'Save the jobs it found, filter your saved jobs, and Prepare & Queue them. Your saved filters always apply.',
  'Count your applications ("how many did I apply to this week", "interviews this week by job board").',
] as const;

/** The line under a report: what the AI tried, which token sent it, and when. */
export function reportLine(item: McpUnsupportedItem, ago: (value: string) => string): string {
  const parts = [
    item.triedTools.length > 0 ? `Tried ${item.triedTools.join(', ')}` : null,
    item.tokenName ? `From ${item.tokenName}` : 'From a token you revoked',
    ago(item.createdAt),
  ];
  return parts.filter((part): part is string => part !== null).join(' · ');
}
