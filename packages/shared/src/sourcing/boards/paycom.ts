import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardUrl } from './types';
import { boardHostOf, boardUrlOf, configWords } from './url';

// v38 ATS-C (SP v38 PLAN A2, "Final coverage" row 16): a company's Paycom careers portal, links only. A posting's link is
// www.paycomonline.net/v4/ats/web.php/portal/<clientKey>/jobs/<jobId> (the client key is 32 hexadecimal digits); its
// clean link drops the query (REQUEST.md). The API reads the posting's page, whose schema.org JobPosting is in the raw
// HTML (the API's adapters/paycom.ts). No board list in v3.8 (the careers page needs a browser): the kind never runs, has
// no Add source field, and discovery finds no Paycom portal.

/** Paycom's candidate host. */
export const PAYCOM_HOST = 'www.paycomonline.net';
const KEY = /^[A-Fa-f0-9]{32}$/;
/** A posting's path on a client's portal (the extension's rule: autofill lookup.ts). */
const POSTING_PATH = /^\/v4\/ats\/web\.php\/portal\/([A-Fa-f0-9]{32})\/jobs\/(\d{1,15})\/?$/;

/** A posting's clean link. */
export const paycomJobUrl = (key: string, id: string) => `https://${PAYCOM_HOST}/v4/ats/web.php/portal/${key}/jobs/${id}`;

/** The posting a link names: its client key (as written), its id and its clean link; or null. */
export function paycomLinkOf(url: BoardUrl): { key: string; id: string; clean: string } | null {
  if (boardHostOf(url) !== PAYCOM_HOST) return null;
  const match = POSTING_PATH.exec(url.pathname);
  return match ? { key: match[1]!, id: match[2]!, clean: paycomJobUrl(match[1]!, match[2]!) } : null;
}

/** The client key a typed key or an address on a client's portal names, in upper case; '' for none. */
export function paycomClientKey(input: string): string {
  const text = input.trim();
  if (KEY.test(text)) return text.toUpperCase();
  if (!text.includes('/')) return '';
  const url = boardUrlOf(text);
  if (!url || boardHostOf(url) !== PAYCOM_HOST) return '';
  const key = /^\/v4\/ats\/web\.php\/portal\/([A-Fa-f0-9]{32})(?:\/|$)/.exec(url.pathname)?.[1];
  return key ? key.toUpperCase() : '';
}

export const PAYCOM_BOARD = defineBoard({
  kind: 'paycom',
  label: 'Paycom',
  row: { access: 'structured_data', runs: false, precedence: 4, rawKeepDays: 30 },
  platform: 'paycom',
  hosts: String.raw`^www\.paycomonline\.net$`,
  domains: ['paycomonline.net'],
  atsKind: 'paycom',
  configKey: 'board',
  boardWords: 'Paycom portal',
  configSchema: z.strictObject({ board: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  keepsCase: true, // the client key in upper case (paycomClientKey)
  boardOf: paycomClientKey,
  configOfBoard: (board) => ({ board }),
  hostOf: (config) => (typeof config.board === 'string' && paycomClientKey(config.board) ? PAYCOM_HOST : null),
  cleanLink: (url) => paycomLinkOf(url)?.clean ?? null,
  // SP v38 PLAN A4: one request at a time to Paycom (its one host is the lane's).
  lane: { key: 'paycom.lane', label: 'Paycom (all companies)', name: 'Paycom' },
  detail: (config) => (configWords(config, 'board') ? `Portal ${configWords(config, 'board')}` : null),
  // v38 FIX-APP (REVIEW38-ux L12): named by its company (the posting's employer), else by the key's first part.
  sourceName: (board) => `Paycom portal ${board.slice(0, 8)}`,
  examples: [
    {
      link: 'https://www.paycomonline.net/v4/ats/web.php/portal/0A1B2C3D4E5F60718293A4B5C6D7E8F9/jobs/412345/?source=Newsletter&jr_id=0a1b',
      clean: 'https://www.paycomonline.net/v4/ats/web.php/portal/0A1B2C3D4E5F60718293A4B5C6D7E8F9/jobs/412345',
      board: '0A1B2C3D4E5F60718293A4B5C6D7E8F9',
      externalId: '412345',
      found: null, // links only: discovery finds no Paycom portal
    },
  ],
});
