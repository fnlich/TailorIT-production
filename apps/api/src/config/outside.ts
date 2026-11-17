// v30 SCH: the new outside reads' identity and keys, from .env (config/env.ts reads them; docs/design/part2/00-overview.md
// §4, 12 §1, 13 §4; DECISIONS P1, owner questions 7, 10 and 20). Pure, so each rule has a test (test/config-v30.test.ts).
// scripts/env.mjs reads BOT_USER_AGENT by the same rule for `npm run doctor`: change the two together (the test runs
// both on the same values).
//
// - BOT_USER_AGENT: the one User-Agent of every NEW kind of outside read (discovery's validation, the new source kinds,
//   the shared site reader, Wikidata, SEC and GLEIF lookups, logo.dev). Until the owner names TailorIT's public site
//   (its /bot page) and a role mailbox, it holds a placeholder, and core/http/identity.ts's assertNewReadAllowed refuses
//   every such read. Today's ingest, Add job and the closed reports' re-checks keep today's identity
//   (INGEST_USER_AGENT) whatever this says.
// - USAJOBS_API_KEY, HIMALAYAS_API_KEY, LOGO_DEV_KEY: each source or step stays off while its key is empty.

/** The form BOT_USER_AGENT takes: robots.txt files name the product token TailorIT; the page and mailbox are the owner's. */
export const BOT_USER_AGENT_PLACEHOLDER = 'TailorIT/1.0 (+https://<public site>/bot; <role mailbox>)';

/** The longest BOT_USER_AGENT: one header line. */
export const BOT_USER_AGENT_MAX = 256;

/** BOT_USER_AGENT read: the User-Agent new reads would send, and whether it is still a placeholder (they refuse). */
export interface BotIdentity {
  userAgent: string;
  placeholder: boolean;
}

/** Domains reserved for examples and tests (RFC 2606, RFC 6761): never a real site or mailbox. */
const RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|net|org)|example|invalid|test|localhost|local)$/i;
/** The bot page: `+https://<host>/...` (or without the +). */
const BOT_PAGE = /\+?https:\/\/([^\s/;()<>]+)[^\s;()<>]*/i;
/** A mailbox: local part @ a dotted domain. */
const MAILBOX = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/;

/**
 * BOT_USER_AGENT's rule (pure): unset or blank is the placeholder; a value still holding `<...>` parts or an example
 * domain (example.com, *.test, localhost) is a placeholder too; otherwise it must be one line of plain ASCII text of at
 * most BOT_USER_AGENT_MAX characters, start with "TailorIT/", and name the bot page (+https://<site>/bot) and a role
 * mailbox, or `{ error }` says what is missing (the API refuses to start, naming the key).
 */
export function readBotUserAgent(value: string | undefined): BotIdentity | { error: string } {
  const text = value?.trim() ?? '';
  if (!text) return { userAgent: BOT_USER_AGENT_PLACEHOLDER, placeholder: true };
  if (text.length > BOT_USER_AGENT_MAX || /[^\x20-\x7e]/.test(text)) {
    return { error: `must be one line of plain ASCII text (a User-Agent header), no longer than ${BOT_USER_AGENT_MAX} characters` };
  }
  if (/[<>]/.test(text)) return { userAgent: text, placeholder: true };
  if (!/^TailorIT\//i.test(text)) return { error: 'must start with "TailorIT/" (the name robots.txt files give TailorIT)' };
  const page = BOT_PAGE.exec(text);
  if (!page) return { error: "must name TailorIT's public bot page, as (+https://<public site>/bot; <role mailbox>)" };
  const mailbox = MAILBOX.exec(text);
  if (!mailbox) return { error: "must name a role mailbox (an email address, never a person's), as (+https://<public site>/bot; <role mailbox>)" };
  const host = page[1]!.toLowerCase().replace(/:\d+$/, '').replace(/\.+$/, '');
  const placeholder = !host.includes('.') || RESERVED_DOMAIN.test(host) || RESERVED_DOMAIN.test(mailbox[1]!.toLowerCase());
  return { userAgent: text, placeholder };
}

/**
 * An outside service's key (USAJOBS_API_KEY, HIMALAYAS_API_KEY, LOGO_DEV_KEY), pure: unset, blank or a `<...>`
 * placeholder is null (the source or step stays off); otherwise one word of plain ASCII text, as the service gave it,
 * or `{ error }` (which never repeats the value: it is a secret).
 */
export function readServiceKey(value: string | undefined): { key: string | null } | { error: string } {
  const text = value?.trim() ?? '';
  if (!text || /^<[^>]*>$/.test(text)) return { key: null };
  if (!/^[\x21-\x7e]{1,512}$/.test(text)) return { error: 'must be the key as the service gave it: one word of plain ASCII text, no spaces' };
  return { key: text };
}

/**
 * DATABASE_URL's rule (pure): a postgres:// or postgresql:// address naming a host (or a `host` parameter). The error
 * never repeats the value: it holds a password.
 */
export function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && (url.hostname !== '' || url.searchParams.has('host'));
  } catch {
    return false;
  }
}
