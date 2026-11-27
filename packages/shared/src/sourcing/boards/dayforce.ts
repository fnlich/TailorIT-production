import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import type { BoardUrl } from './types';
import { boardHostOf, boardSegmentsOf, configWords } from './url';

// v38 ATS-B: Dayforce job postings (SP v38 REQUEST.md 17, EVIDENCE.md §17; the API's adapters/dayforce.ts). Links only:
// a posting's page carries its data (__NEXT_DATA__ jobData), but a portal's job list needs a browser (SP v38 PLAN "Final
// coverage" 17), so the kind never runs (as Workday's one-posting kind): its sources keep the links Add job read, by the
// client's namespace (the extension's lookup's `dayforce` board, as written).

/** Dayforce's candidate host. */
export const DAYFORCE_HOST = 'jobs.dayforcehcm.com';
const LOCALE = /^[A-Za-z]{2,3}-[A-Za-z]{2}$/;
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
export const DAYFORCE_POSTING_ID = /^\d{1,15}$/;

/** A posting's page: [<locale>/]<namespace>/<portal>/jobs/<id>, then nothing, /apply or /apply/manualApplication. */
export interface DayforcePosting {
  locale: string | null;
  namespace: string;
  portal: string;
  id: string;
}

/** The posting a link names (its page or its application's steps), with its locale, namespace and portal as written. */
export function dayforcePostingOf(url: BoardUrl): DayforcePosting | null {
  if (boardHostOf(url) !== DAYFORCE_HOST) return null;
  const parts = boardSegmentsOf(url);
  const locale = parts[0] && LOCALE.test(parts[0]) && parts.length >= 5 ? parts.shift()! : null;
  const [namespace, portal, jobs, id, ...tail] = parts;
  if (!namespace || !portal || !SEGMENT.test(namespace) || !SEGMENT.test(portal) || jobs !== 'jobs' || !id || !DAYFORCE_POSTING_ID.test(id)) return null;
  const apply = tail.length === 0 || (tail[0] === 'apply' && (tail.length === 1 || (tail.length === 2 && tail[1] === 'manualApplication')));
  return apply ? { locale, namespace, portal, id } : null;
}

/** A posting's clean link: https://jobs.dayforcehcm.com/[<locale>/]<namespace>/<portal>/jobs/<id> (REQUEST.md 17). */
export const dayforcePostingUrl = (posting: DayforcePosting) =>
  `https://${DAYFORCE_HOST}/${posting.locale ? `${posting.locale}/` : ''}${posting.namespace}/${posting.portal}/jobs/${posting.id}`;

/** A client's namespace as typed ('' for none). */
const namespaceOf = (input: string) => (SEGMENT.test(input.trim()) ? input.trim() : '');

export const DAYFORCE_BOARD = defineBoard({
  kind: 'dayforce',
  label: 'Dayforce (one posting)',
  runLabel: 'Dayforce',
  row: { access: 'structured_data', runs: false, precedence: 4, rawKeepDays: 30 },
  platform: 'dayforce',
  hosts: String.raw`^jobs\.dayforcehcm\.com$`,
  domains: ['dayforcehcm.com'],
  atsKind: 'dayforce',
  configKey: 'tenant',
  boardWords: 'Dayforce client',
  configSchema: z.strictObject({ tenant: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  // The namespace as written (the extension's board), compared in any case.
  keepsCase: true,
  boardOf: namespaceOf,
  configOfBoard: (board) => ({ tenant: board }),
  hostOf: () => DAYFORCE_HOST,
  // v38 FIX-A (SP v38 FIXES-38 D4, REVIEW38-beh M12): one request at a time to Dayforce's job sites, at the lanes' pace
  // (LANE_DEFAULT_MIN_INTERVAL_MS), as every v3.8 platform.
  lane: { key: 'dayforce.lane', label: 'Dayforce (all job sites)', name: 'Dayforce' },
  // REQUEST.md 17: keep the locale, drop the query and the application's steps (the portal is the customer's own).
  cleanLink: (url) => {
    const posting = dayforcePostingOf(url);
    return posting ? dayforcePostingUrl(posting) : null;
  },
  detail: (config) => (configWords(config, 'tenant') ? `Client ${configWords(config, 'tenant')}` : null),
  examples: [
    {
      link: 'https://jobs.dayforcehcm.com/en-GB/acmeinsurance/candidateportal/jobs/2468?jr_id=6b0400000000000000000002',
      clean: 'https://jobs.dayforcehcm.com/en-GB/acmeinsurance/candidateportal/jobs/2468',
      board: 'acmeinsurance',
      externalId: '2468',
      found: null,
    },
    {
      link: 'https://jobs.dayforcehcm.com/en-US/globex/CAREERS/jobs/1357/apply/manualApplication?applicationSource=Manual',
      clean: 'https://jobs.dayforcehcm.com/en-US/globex/CAREERS/jobs/1357',
      board: 'globex',
      externalId: '1357',
      found: null,
    },
  ],
});
