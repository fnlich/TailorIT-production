import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import { boardHostOf, boardSegmentsOf, configWords, DNS_LABEL, hostOfTyped } from './url';

// v38 FRAME: an employer's iCIMS site (v37 BOARDS: <board>.icims.com, listed by its sitemap, each posting's page read; the
// API's adapters/icims.ts).

/**
 * One employer's iCIMS host (lower case): careers-acme.icims.com, jobs-acme.icims.com, acme.icims.com; never iCIMS's www,
 * api or login hosts nor an employees' internal-<co> portal. Its first label is the `icims` source's board. v37 FIX-37A
 * (REVIEW37-beh F11): exactly the shared lookup's rule (@tailorit/shared/autofill lookup.ts ICIMS_HOST, a DNS label). Its
 * lookahead reads the same in PostgreSQL (migration 0063, the iCIMS lane).
 */
export const ICIMS_BOARD_HOST = /^(?!(?:www|api|login)\.)(?!internal-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.icims\.com$/;

/** v37 FIX-37A (F11): hosts iCIMS runs for itself, never a portal of job pages (discovery's boardOfUrl). */
export const ICIMS_SERVICE_HOST = /^(?:developer|developers|community|status|support|cdn|static)\.icims\.com$/;

/** Whether a host (any case, a trailing dot allowed) is one employer's iCIMS host (ICIMS_BOARD_HOST). */
export function isIcimsBoardHost(host: string): boolean {
  return ICIMS_BOARD_HOST.test(host.toLowerCase().replace(/\.+$/, ''));
}

/** An iCIMS board's host. */
export const icimsHostOf = (board: string) => `${board}.icims.com`;

/**
 * The iCIMS board a name, host or address gives ("careers-acme", "careers-acme.icims.com",
 * "https://careers-acme.icims.com/jobs/1234/x/job"): its host's first label in lower case; '' when it names none (another
 * host, iCIMS's own, a label that is no DNS label).
 */
export function icimsBoardOf(input: string): string {
  const text = input.trim().toLowerCase();
  if (!text) return '';
  let host = text;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text) || text.includes('/')) {
    const parsed = hostOfTyped(text);
    if (!parsed) return '';
    host = parsed;
  } else if (!text.includes('.')) {
    host = `${text}.icims.com`;
  }
  host = host.replace(/\.+$/, '');
  return isIcimsBoardHost(host) ? host.slice(0, -'.icims.com'.length) : '';
}

/** iCIMS's own hosts' first labels: never an employer's site (Add source's check under the field). */
const ICIMS_OWN_LABELS: ReadonlySet<string> = new Set(['www', 'api', 'login']);

/**
 * Add source's check under the field (the web's, v37 BOARDS): an iCIMS site's board from what an admin typed, its board
 * ("careers-acme"), its host or any page of it; null when it names none (another domain, iCIMS's own hosts, an
 * employees' internal-<co> portal).
 */
export function icimsBoardOfTyped(input: string): string | null {
  const host = hostOfTyped(input);
  const label = host.includes('.') ? (host.endsWith('.icims.com') ? host.slice(0, -'.icims.com'.length) : '') : host;
  return DNS_LABEL.test(label) && !ICIMS_OWN_LABELS.has(label) && !label.startsWith('internal-') ? label : null;
}

export const ICIMS_BOARD = defineBoard({
  kind: 'icims',
  label: 'iCIMS',
  row: { access: 'sitemap', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'icims',
  hosts: ICIMS_BOARD_HOST.source,
  domains: ['icims.com'],
  atsKind: 'icims',
  configKey: 'board',
  boardWords: 'iCIMS site',
  configSchema: z.strictObject({ board: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  boardOf: icimsBoardOf,
  configOfBoard: (board) => ({ board }),
  hostOf: (config) => {
    const board = icimsBoardOf(typeof config.board === 'string' ? config.board : '');
    return board ? icimsHostOf(board) : null;
  },
  // v37 BOARDS (SP v37 PLAN I5): any page on one employer's iCIMS host names its site (never iCIMS's own hosts). v37
  // FIX-37A (F11): a host iCIMS runs for itself (its developers', community, status pages) only by a posting's page.
  boardOfUrl: (url, parts) => {
    const host = boardHostOf(url);
    return isIcimsBoardHost(host) && (!ICIMS_SERVICE_HOST.test(host) || (parts[0] === 'jobs' && /^\d{1,12}$/.test(parts[1] ?? ''))) ? host : null;
  },
  // v38 ATS-D (REQUEST.md #10, SP v38 EVIDENCE.md §10): a posting's page, /jobs/<id>/[<slug>/]job, keeps no query (its
  // frame's in_iframe=1, a search's or a step's parameters); iCIMS's other pages stay as the generic form keeps them.
  cleanLink: (url) => {
    const parts = boardSegmentsOf(url);
    const posting = (parts.length === 3 || parts.length === 4) && parts[0] === 'jobs' && /^\d{1,12}$/.test(parts[1]!) && parts.at(-1) === 'job';
    return posting && url.search ? `https://${boardHostOf(url)}${url.pathname}` : null;
  },
  // v37 INT-2b (E1): one request at a time to all of iCIMS (a turned-on career site on such a host takes it too).
  lane: {
    key: 'icims.lane',
    label: 'iCIMS (all sites)',
    name: 'iCIMS',
  },
  // v37 BOARDS (SP v37 PLAN I5): a career site an admin turned on before v3.7 on its host is its source (migration 0063).
  adoptsCareerSites: true,
  addSource: {
    field: 'board',
    label: 'iCIMS site',
    hint: "The site's address or any page of it, such as careers-acme.icims.com.",
    placeholder: 'careers-acme.icims.com',
    help: "Reads the site's sitemap and each posting's page on its schedule, one request at a time, once BOT_USER_AGENT is set.",
    invalid: 'Enter an address on <name>.icims.com, such as careers-acme.icims.com.',
    required: 'Enter the iCIMS site address (careers-acme.icims.com).',
    refusal: "Enter the iCIMS site's address, such as careers-acme.icims.com.",
    refusalField: 'Enter an address on <name>.icims.com.',
    inputMode: 'url',
    boardOfInput: icimsBoardOfTyped,
  },
  detail: (config) => (configWords(config, 'board') ? `iCIMS site ${configWords(config, 'board')}.icims.com` : null),
  examples: [
    {
      link: 'https://careers-acmerobotics.icims.com/jobs/10747/senior-robotics-engineer/job?iis=Job+Board&iisn=LinkedIn',
      clean: 'https://careers-acmerobotics.icims.com/jobs/10747/senior-robotics-engineer/job',
      board: 'careers-acmerobotics',
      externalId: '10747',
      found: 'careers-acmerobotics',
    },
    {
      // v38 ATS-D: a search result's link carries the frame's flag (SP v38 EVIDENCE.md §10).
      link: 'https://careers-acmerobotics.icims.com/jobs/10748/robotics-technician/job?in_iframe=1&mode=job',
      clean: 'https://careers-acmerobotics.icims.com/jobs/10748/robotics-technician/job',
      board: 'careers-acmerobotics',
      externalId: '10748',
      found: 'careers-acmerobotics',
    },
  ],
});
