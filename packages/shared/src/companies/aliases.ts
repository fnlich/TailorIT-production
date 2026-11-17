// v30 CT: the board alias's value (11-database.md §5.4, reconciled with 12 §4.2): '<platform>:<board>' with the
// ATS's platforms key, not the source kind ('greenhouse:stripe'; 'workday:acme' for every Workday site of tenant acme),
// and 'site:<host>' for a career site ('site:careers.acme.com'). Multi-employer feeds (government, remote, vendor)
// give none. The board is the one the source's adapter normalises; these helpers only join and read the two parts.

/** A platforms key (the platforms table's check): a lower-case letter, then 1 to 39 letters or digits. */
export const PLATFORM_KEY_PATTERN = /^[a-z][a-z0-9]{1,39}$/;
/** A board alias's value: '<platform>:<board>' or 'site:<host>', no white space, at most 500 characters after the colon. */
export const BOARD_ALIAS_PATTERN = /^(?:[a-z][a-z0-9]{1,39}):\S{1,500}$/;
/** The platform part of a career site's alias. */
export const SITE_ALIAS_PLATFORM = 'site';

/** '<platform>:<board>'; null when the platform is no platforms key or the board is empty or holds white space. */
export function boardAlias(platform: string, board: string): string | null {
  const value = `${platform}:${board}`;
  return PLATFORM_KEY_PATTERN.test(platform) && BOARD_ALIAS_PATTERN.test(value) ? value : null;
}

/** 'site:<host>' for a career site, the host in lower case without trailing dots; null for an empty host. */
export function siteAlias(host: string): string | null {
  return boardAlias(SITE_ALIAS_PLATFORM, host.trim().toLowerCase().replace(/\.+$/, ''));
}

/** A board alias's two parts, or null when `value` is not one. */
export function parseBoardAlias(value: string): { platform: string; board: string } | null {
  if (!BOARD_ALIAS_PATTERN.test(value)) return null;
  const at = value.indexOf(':');
  return { platform: value.slice(0, at), board: value.slice(at + 1) };
}

/**
 * A company's LinkedIn page as company_profiles keeps it (its check): https://www.linkedin.com/company/<slug>, only
 * as an allowed source names it; TailorIT never reads LinkedIn.
 */
export const LINKEDIN_COMPANY_URL_PATTERN = /^https:\/\/www\.linkedin\.com\/company\/\S+$/;
