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
  'Your AI does the writing on your own plan; TailorIT checks the facts, scores and stores what it makes.',
  'In your AI client, run the prepare_all prompt (or ask it to "prepare my saved jobs with TailorIT"). It runs your saved filters on your Saved jobs, then prepares the jobs that pass: the resume your Prepare & Queue setting asks for (your default resume, your best-matched one or a tailored one), the cover letter when one is wanted, and answers to the questions TailorIT knows.',
  'TailorIT keeps your employers, titles, dates and figures as they are, scores each tailored resume against the job, and queues each job for auto-apply once its parts are saved.',
  'Your self-identification, work authorization and pay answers never leave TailorIT: your profile fills those questions on the form.',
  // v1.5 Q1
  "Your AI uses TailorIT's step prompts unless you ask it to use your own; either way TailorIT checks what it saves, strictly.",
  "Your custom instructions below are added to TailorIT's. Your filters and your account's limits always apply.",
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
export const REVISE_ROUNDS_HINT =
  "How many times your AI revises each tailored resume after TailorIT's check, while it still finds keywords or facts to fix. More rounds can raise the score and use more of your AI plan. TailorIT's own Prepare always does 2.";
// end v1.5 Q1
