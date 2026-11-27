import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardUrl } from './types';
import { boardHostOf, boardSegmentsOf, boardUrlOf, configWords } from './url';

// v38 ATS-C (SP v38 PLAN A2, "Final coverage" row 15): a company's Paylocity job board,
// recruiting.paylocity.com/Recruiting/Jobs/All/<boardGuid>. A posting's link is /Recruiting/Jobs/Details/<jobId> (its
// application /Recruiting/Jobs/Apply/<jobId>/); the clean link is the Details page, its path compared in any case, with
// no trailing slash or query (REQUEST.md). A posting's link names no board: its Details page links to the board (the
// API's adapters/paylocity.ts reads it there), and a source's config holds the board's guid. The board's page carries
// its list as JSON (window.pageData.Jobs).

/** Paylocity's recruiting host. */
export const PAYLOCITY_HOST = 'recruiting.paylocity.com';
const JOB_ID = /^\d{1,15}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A posting's clean link (its Details page). */
export const paylocityDetailsUrl = (id: string) => `https://${PAYLOCITY_HOST}/Recruiting/Jobs/Details/${id}`;
/** A board's page (its list). */
export const paylocityBoardUrl = (guid: string) => `https://${PAYLOCITY_HOST}/Recruiting/Jobs/All/${guid}`;

/** The posting a link names (/Recruiting/Jobs/Details/<id> or /Apply/<id>, any case): its id and clean link; or null. */
export function paylocityLinkOf(url: BoardUrl): { id: string; clean: string } | null {
  if (boardHostOf(url) !== PAYLOCITY_HOST) return null;
  const parts = boardSegmentsOf(url);
  if (parts.length !== 4 || parts[0]!.toLowerCase() !== 'recruiting' || parts[1]!.toLowerCase() !== 'jobs') return null;
  const page = parts[2]!.toLowerCase();
  const id = parts[3]!;
  if ((page !== 'details' && page !== 'apply') || !JOB_ID.test(id)) return null;
  return { id, clean: paylocityDetailsUrl(id) };
}

/** The board an address names (/Recruiting/Jobs/All/<guid>, any case), in lower case; null for none. */
function boardOfParts(parts: readonly string[]): string | null {
  if (parts.length < 4 || parts[0]!.toLowerCase() !== 'recruiting' || parts[1]!.toLowerCase() !== 'jobs' || parts[2]!.toLowerCase() !== 'all') return null;
  return GUID.test(parts[3]!) ? parts[3]!.toLowerCase() : null;
}

/** The board a typed guid or an address of the board's page names, in lower case; '' for none. */
export function paylocityBoard(input: string): string {
  const text = input.trim();
  if (GUID.test(text)) return text.toLowerCase();
  if (!text.includes('/')) return '';
  const url = boardUrlOf(text);
  if (!url || boardHostOf(url) !== PAYLOCITY_HOST) return '';
  return boardOfParts(boardSegmentsOf(url)) ?? '';
}

export const PAYLOCITY_BOARD = defineBoard({
  kind: 'paylocity',
  label: 'Paylocity',
  row: { access: 'structured_data', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'paylocity',
  hosts: String.raw`^recruiting\.paylocity\.com$`,
  domains: ['paylocity.com'],
  atsKind: 'paylocity',
  configKey: 'board',
  boardWords: 'Paylocity job board',
  configSchema: z.strictObject({ board: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  boardOf: paylocityBoard,
  configOfBoard: (board) => ({ board }),
  hostOf: (config) => (typeof config.board === 'string' && paylocityBoard(config.board) ? PAYLOCITY_HOST : null),
  boardOfUrl: (url, parts) => (boardHostOf(url) === PAYLOCITY_HOST ? boardOfParts(parts) : null),
  // The extension's contract reads /Apply/<id> (exactly so written); every other spelling, and the Details page, here.
  parseLink: (url) => {
    const found = paylocityLinkOf(url);
    return found ? { board: null, externalId: found.id, canonical: [found.clean] } : null;
  },
  cleanLink: (url) => paylocityLinkOf(url)?.clean ?? null,
  // SP v38 PLAN A4: one request at a time to Paylocity (its one host is the lane's).
  lane: { key: 'paylocity.lane', label: 'Paylocity (all companies)', name: 'Paylocity' },
  addSource: {
    field: 'board',
    label: 'Paylocity job board',
    // v38 FIX-APP (REVIEW38-ux L18): where the All Jobs page is, and a job's own link works too.
    hint: "Its All Jobs page's address (recruiting.paylocity.com/Recruiting/Jobs/All/<id>): a job's page links to it (View All Jobs). A job's own link works too.",
    placeholder: 'https://recruiting.paylocity.com/Recruiting/Jobs/All/…',
    help: "Reads the board's job list and each job's page on its schedule, one request at a time, once BOT_USER_AGENT is set.",
    invalid: 'Enter the address of the board\'s All Jobs page (recruiting.paylocity.com/Recruiting/Jobs/All/<id>).',
    required: "Enter the board's All Jobs page address.",
    refusal: "Enter the address of the board's All Jobs page, recruiting.paylocity.com/Recruiting/Jobs/All/<id>. A job's page links to it (View All Jobs).",
    refusalField: 'Enter the All Jobs page address.',
    what: 'Paylocity job board',
    inputMode: 'url',
    companyHint: "Shown when the board doesn't name the company. TailorIT reads the name from the board's own page.",
    boardOfInput: (input) => paylocityBoard(input) || null,
    postingLink: "TailorIT reads that job's page once to find its board.", // v38 FIX-APP (REVIEW38-ux L18)
  },
  detail: (config) => (configWords(config, 'board') ? `Board ${configWords(config, 'board')}` : null),
  examples: [
    {
      link: 'https://recruiting.paylocity.com/Recruiting/Jobs/Apply/1234567/?source=LinkedIn',
      clean: 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/1234567',
      board: null,
      externalId: '1234567',
      found: null, // a posting's link names no board
    },
    {
      link: 'https://recruiting.paylocity.com/recruiting/jobs/details/1234568?utm_source=Newsletter',
      clean: 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/1234568',
      board: null,
      externalId: '1234568',
    },
    {
      link: 'https://recruiting.paylocity.com/Recruiting/Jobs/All/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d?utm_source=Newsletter',
      clean: 'https://recruiting.paylocity.com/Recruiting/Jobs/All/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      board: null,
      externalId: null,
      found: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    },
  ],
});
