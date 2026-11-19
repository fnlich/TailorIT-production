import { claudeCodeCommand, genericMcpConfig, mcpEndpointUrl } from '@tailorit/shared/mcp';

// The words and the copyable setup of Integrations › AI assistants (v1.5 M's "Your own AI (MCP)"), apart from the page
// so a test reads them.

/** What stands for the secret in the setup until a token is made (the secret is shown once, then never again). */
export const TOKEN_PLACEHOLDER = '<your-token>';

/** The two ways to add TailorIT's MCP server: Claude Code's command, and the JSON most other clients read. */
export function setupSnippets(token: string | null, endpoint = mcpEndpointUrl()) {
  const secret = token ?? TOKEN_PLACEHOLDER;
  return { command: claudeCodeCommand(secret, endpoint), json: genericMcpConfig(secret, endpoint) };
}

/**
 * "How it works", in the owner's words of decision 5. v2.0 fix (UX-5): Prepare & Queue as v2.0 runs it over MCP
 * (docs/design/v2.0/07-mcp.md): the saved filters first, then the jobs that pass, with the person's resume setting;
 * a job is queued once its parts are saved; custom instructions add to TailorIT's and never change its rules.
 */
export const HOW_IT_WORKS = [
  'Your AI writes on your own plan; TailorIT checks, scores and stores it.',
  'The prepare_all prompt runs your saved filters, then prepares the jobs that pass with your resume setting.',
  'Each job is queued for auto-apply once its parts are saved.',
  'Self-ID, work authorization and pay answers never leave TailorIT.',
  "Custom instructions add to TailorIT's; your filters and limits always apply.",
] as const;

/** A token's line under its name. */
export function tokenUseLine(createdAt: string, lastUsed: string | null, formatDate: (value: string) => string, ago: (value: string) => string) {
  return `Made ${formatDate(createdAt)} · Last used ${lastUsed ? ago(lastUsed) : 'never'}`;
}

// v1.5 Q1: the revision rounds control.
/** The rounds a person may choose, as the control lists them. */
export function reviseRoundOptions(min: number, max: number, fallback: number) {
  return Array.from({ length: max - min + 1 }, (_value, index) => {
    const rounds = min + index;
    const label = rounds === 0 ? '0 (no revision)' : rounds === fallback ? `${rounds} (default)` : String(rounds);
    return { value: String(rounds), label };
  });
}

/** What the control's hint says. */
export const REVISE_ROUNDS_HINT = 'How often your AI revises each tailored resume; more can raise the score and use more of your plan.';
// end v1.5 Q1
