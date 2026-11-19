import type { McpUnsupportedItem } from '@tailorit/shared/mcp';

// v1.5 Q2: the words of Integrations › AI assistants › "Requests your AI could not do", apart from the view so a test
// reads them.

export const UNSUPPORTED_TITLE = 'Requests your AI could not do';
export const UNSUPPORTED_INTRO = "What your AI couldn't do with TailorIT's tools, instead of guessing.";
export const UNSUPPORTED_EMPTY = 'Your AI has done everything you asked.';

/**
 * What else the person's own AI can do through TailorIT (v1.5 Q2), in the owner's words of the plan. v2.0 fix (UX-5):
 * nothing reaches the queue directly any more (A4): the AI saves jobs, and Prepare & Queue takes them, with the saved
 * filters always applied.
 */
export const ALSO_ASK = [
  'Search jobs in your own words.',
  'Save, filter and Prepare & Queue jobs; your saved filters always apply.',
  'Count your applications and interviews.',
] as const;

/**
 * The line under a report: what the AI tried, which token or connected assistant sent it (v31 OAUTH: the API names the
 * assistant), and when.
 */
export function reportLine(item: McpUnsupportedItem, ago: (value: string) => string): string {
  const parts = [
    item.triedTools.length > 0 ? `Tried ${item.triedTools.join(', ')}` : null,
    item.tokenName ? `From ${item.tokenName}` : 'From a token or assistant you removed',
    ago(item.createdAt),
  ];
  return parts.filter((part): part is string => part !== null).join(' · ');
}
