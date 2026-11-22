import type { PublicConstants } from '@tailorit/shared/constants';

// v34 PUBLIC (PLAN G8): who runs this TailorIT, as the public pages name them. The values are the public constants
// OPERATOR_NAME, OPERATOR_WEBSITE and ADMIN_CONTACT_EMAIL (.env OPERATOR_NAME, OPERATOR_WEBSITE, CONTACT_EMAIL, or an
// admin's override), never written here. Each may be blank: the pages then say "the operator of this service", link no
// website and say there is no contact address yet.

export interface Operator {
  /** OPERATOR_NAME, trimmed; null when blank. */
  name: string | null;
  /** OPERATOR_WEBSITE when it is an https address (its normalized href); null otherwise (safeWebsite). */
  website: string | null;
  /** The website as the pages show it: its host and path, without the scheme or a trailing slash. */
  websiteLabel: string | null;
  /** ADMIN_CONTACT_EMAIL; null when unset. */
  contactEmail: string | null;
}

/** The hosts an http (not https) website may name: this computer, for a development install. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * An https address's href, or null: anything else (http on a public host, a javascript: or mailto: value, a bare word,
 * a typo, an address with a user or password) is never a link, since an admin's text reaches every visitor's page and
 * a directory listing asks for a secure company website (the review's finding 16). http is taken only for this
 * computer (localhost, 127.0.0.1, [::1]), for development.
 */
export function safeWebsite(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
    if (!secure || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** "example.com/careers" for https://example.com/careers/. */
function labelOf(href: string): string {
  const url = new URL(href);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return `${url.host}${path}${url.search}`;
}

/** The operator's details from the public constants. */
export function operatorOf(values: Pick<PublicConstants, 'OPERATOR_NAME' | 'OPERATOR_WEBSITE' | 'ADMIN_CONTACT_EMAIL'>): Operator {
  const name = values.OPERATOR_NAME.trim() || null;
  const website = safeWebsite(values.OPERATOR_WEBSITE);
  const contactEmail = values.ADMIN_CONTACT_EMAIL?.trim() || null;
  return { name, website, websiteLabel: website ? labelOf(website) : null, contactEmail };
}
