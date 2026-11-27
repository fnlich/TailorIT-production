import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardUrl } from './types';
import { boardHostOf, boardSegmentsOf, configWords, NOT_A_BOARD } from './url';

// v38 FRAME: Lever sites (api.lever.co/v0/postings/{site}; EU sites on api.eu.lever.co; the API's adapters/lever.ts).
// v38 ATS-A (SP v38 PLAN "Final coverage" row 3; REQUEST.md 3): a posting's clean link (no /apply, no query).

/** The site as typed: a site name or a jobs.lever.co URL. */
export function leverSite(input: string): string {
  const text = input.trim();
  const fromUrl = /lever\.co\/(?:v0\/postings\/)?([A-Za-z0-9_.-]+)/i.exec(text);
  return (fromUrl?.[1] ?? text).replace(/[^A-Za-z0-9_.-]/g, '');
}

/** A Lever source's region: `eu` for a site on Lever's EU hosts, else `global`. */
export const leverRegionOf = (config: Record<string, unknown>): 'global' | 'eu' =>
  typeof config.region === 'string' && config.region.toLowerCase() === 'eu' ? 'eu' : 'global';

const LEVER_HOSTS: ReadonlySet<string> = new Set(['jobs.lever.co', 'jobs.eu.lever.co']);

/** v38 ATS-A: a site's name and a posting's id as the shared lookup reads them (LEVER_SITE, LEVER_POSTING_ID). */
const LEVER_SITE_NAME = /^[A-Za-z0-9_.-]+$/;
const LEVER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * v38 ATS-A (REQUEST.md 3): a posting's clean link, https://jobs[.eu].lever.co/<site>/<uuid>: /apply (and the page after
 * it) and the query dropped, the EU host kept; null for any other address.
 */
function leverPostingLink(url: BoardUrl): string | null {
  const host = boardHostOf(url);
  if (!LEVER_HOSTS.has(host)) return null;
  const [site, posting, ...rest] = boardSegmentsOf(url);
  if (!site || !posting || !LEVER_SITE_NAME.test(site) || !LEVER_UUID.test(posting)) return null;
  if (!['', 'apply', 'thanks', 'apply/thanks'].includes(rest.join('/'))) return null;
  return `https://${host}/${site}/${posting.toLowerCase()}`;
}

export const LEVER_BOARD = defineBoard({
  kind: 'lever',
  label: 'Lever',
  row: { access: 'public_api', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'lever',
  hosts: String.raw`^jobs(?:\.eu)?\.lever\.co$`,
  domains: ['lever.co'],
  atsKind: 'lever',
  configKey: 'site',
  boardWords: 'Lever site',
  configSchema: z.strictObject({ site: z.string().min(1), region: z.enum(['global', 'eu']).optional(), ...BOARD_CONFIG_COMMON }),
  boardOf: leverSite,
  configOfBoard: (board) => ({ site: board }),
  hostOf: (config) => (leverRegionOf(config) === 'eu' ? 'api.eu.lever.co' : 'api.lever.co'),
  boardOfUrl: (url, parts) =>
    LEVER_HOSTS.has(boardHostOf(url)) && parts[0] && !NOT_A_BOARD.has(parts[0].toLowerCase()) ? parts[0] : null,
  cleanLink: leverPostingLink, // v38 ATS-A
  detail: (config) => `Site ${configWords(config, 'site')}${configWords(config, 'region') === 'eu' ? ' (EU)' : ''}`,
  examples: [
    {
      link: 'https://jobs.lever.co/acmerobotics/0b9a5f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b?lever-source=LinkedIn',
      clean: 'https://jobs.lever.co/acmerobotics/0b9a5f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
      board: 'acmerobotics',
      externalId: '0b9a5f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
      found: 'acmerobotics',
    },
    {
      // v38 ATS-A (REQUEST.md 3): the form's address, on Lever's EU host, is the posting's there.
      link: 'https://jobs.eu.lever.co/acmerobotics/0b9a5f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b/apply?jr_id=6ae395e5eab1',
      clean: 'https://jobs.eu.lever.co/acmerobotics/0b9a5f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
      board: 'acmerobotics',
      externalId: '0b9a5f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
      found: 'acmerobotics',
    },
  ],
});
