// v34 DIRKIT (PLAN G8; Claude's Connectors Directory review): what the MCP server's own words and its tool list are held
// to, in one place for the tests of this server (test/mcp-wording.test.ts, test/mcp-tools-budget.test.ts) and for
// `npm run directory:check`, which reads a deployed server's tools/list, prompts/list and instructions
// (scripts/directory-check.mjs). The phrases and their reasons were MCPDIR's, in test/mcp-wording.test.ts (v34 MCPDIR):
// phrases that claim to override other instructions, address an AI reading the text, or order a call. Text TailorIT
// fences as data (a posting, another person's words, the person's own custom instructions in <person>) is not
// TailorIT's own words and is left out before a scan (withoutFencedData).

/** Phrase, and why the directory would read it as injection. */
export const MCP_WORDING_BANNED: ReadonlyArray<readonly [RegExp, string]> = [
  [/\boverrid(?:e|es|ing|den)\b/i, 'claims to override other instructions'],
  [/\b(?:take|takes) precedence\b|\bsupersede/i, 'claims precedence over other instructions'],
  [/\bplatform rules\b/i, 'ranks its rules over every other instruction'],
  [/\bany AI\b|\bAI reading\b|\bnote to (?:any|the) (?:AI|assistant|model)\b|\bif you are an AI\b/i, 'addresses an AI reading the text'],
  [/\bignore (?:all |any )?(?:previous|prior|other|earlier|above) instructions\b/i, 'an injection phrase'],
  [/\binstead of guessing\b/i, 'orders a call'],
  [/\bfollow (?:it|them|the prompt|each answer)\b/i, 'orders the AI to follow text'],
  [/\bread (?:them|it|this) first\b/i, 'orders the AI to read first'],
  [/\bcall instructions first\b/i, 'an imperative pointer in a result'],
  [/\bwrite the (?:code )?word\b/i, 'a tripwire order'],
  [/\b(?:do not|don't|never) (?:tell|inform|show|mention)\b[^.]*\b(?:person|user)\b/i, 'hides something from the person'],
  [/\bsystem prompt\b/i, 'speaks of a system prompt'],
  // v34 MCPDIR (the directory review, finding 6): no line that reads as restricting the client's tools.
  [/\byou have no tools\b|\bno authority over\b/i, "restricts the client's tools"],
  [/\bnever override\b/i, 'a precedence claim'],
];

/** `text` without the parts TailorIT fences as data: <untrusted ...>...</untrusted> and <person>...</person>. */
export function withoutFencedData(text: string): string {
  return text.replace(/<untrusted\b[^>]*>[\s\S]*?<\/untrusted>/g, ' ').replace(/<person>[\s\S]*?<\/person>/g, ' ');
}

/** What `text` says that MCP_WORDING_BANNED forbids: each finding's reason and the words it matched. */
export function bannedWordingIn(text: string): Array<{ why: string; pattern: RegExp; words: string }> {
  return MCP_WORDING_BANNED.filter(([pattern]) => pattern.test(text)).map(([pattern, why]) => ({ why, pattern, words: text.match(pattern)![0] }));
}

/**
 * The tools/list answer's budget, in tokens estimated at 4 characters a token (estimatedTokens): what a person's AI
 * reads once per session. v34 MCPDIR (PLAN G8 addendum): 8,600 for v3.4 (the read and write tools apart, descriptions
 * that state each tool's side effects). The directory sets no number; it asks a server to be frugal with tokens. v38 INT
 * (SP v38 INT-BRIEF section 4): 8,650 for v3.8, the next 50 above the 8,613 measured, the whole growth search_jobs'
 * source enum (20 more board kinds, 214 characters; every other text byte-identical to v3.7's).
 */
export const MCP_TOOLS_LIST_TOKEN_BUDGET = 8_650;

/** A JSON text's size in tokens, estimated at 4 characters a token (the budget tests' measure). */
export function estimatedTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * A tool name Claude accepts: 1 to 64 letters, digits, `_` or `-` (Claude's tool names; the directory: "tool names
 * of 64 characters at most").
 */
export const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
