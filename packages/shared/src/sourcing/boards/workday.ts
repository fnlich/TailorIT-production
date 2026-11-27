import { z } from 'zod';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import { configWords } from './url';
import type { BoardLane } from './types';

// v38 FRAME: Workday's one-posting kind (autofill API version 5: the postings Add job reads one at a time, the read a
// posting's own page makes; never run as a board; the API's adapters/workday.ts) and its lane, which its career sites
// (./workday-site.ts) share.

/** The tenant as a source's config names it: letters, digits, '-' and '_', in lower case; '' when it names none. */
export function workdayTenant(input: string): string {
  const text = input.trim().toLowerCase();
  return /^[a-z0-9_-]{1,100}$/.test(text) ? text : '';
}

/** Whether a host (lower case) is a Workday tenant's (<tenant>[.wd<n>].myworkdayjobs.com) or the shared wd<n>.myworkdaysite.com. */
export const isWorkdayHost = (host: string) =>
  /^[a-z0-9-]+\.(?:wd\d{1,3}\.)?myworkdayjobs\.com$/.test(host) || /^wd\d{1,3}\.myworkdaysite\.com$/.test(host);

/** Workday's link hosts (a tenant's, the shared myworkdaysite.com). */
export const WORKDAY_HOSTS = String.raw`(?:^|\.)(?:myworkdayjobs|myworkdaysite)\.com$`;

/**
 * v37 LANE: every Workday host (a tenant's <tenant>.wd<n>.myworkdayjobs.com, the shared wd<n>.myworkdaysite.com, a
 * tenant's wd<n>.myworkday.com) takes its turns on ONE lane: Workday answers one address's requests from one limit.
 */
export const WORKDAY_LANE: BoardLane = {
  key: 'workday.lane',
  label: 'Workday (all sites)',
  name: 'Workday',
  hosts: String.raw`(?:^|\.)(?:myworkdayjobs|myworkdaysite|myworkday)\.com$`,
};

export const WORKDAY_BOARD = defineBoard({
  kind: 'workday',
  label: 'Workday (one posting)',
  runLabel: 'Workday',
  row: { access: 'public_api', runs: false, precedence: 4, rawKeepDays: 30 },
  platform: 'workday',
  hosts: WORKDAY_HOSTS,
  domains: ['myworkdayjobs.com', 'myworkdaysite.com'],
  atsKind: 'workday',
  configKey: 'tenant',
  configSchema: z.strictObject({ tenant: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  boardOf: workdayTenant,
  configOfBoard: (board) => ({ tenant: board }),
  // Its postings are read on each tenant's own hosts, one at a time: no one host.
  hostOf: () => null,
  lane: WORKDAY_LANE,
  detail: (config) => `Tenant ${configWords(config, 'tenant')}`,
  examples: [
    {
      link: 'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin-TX/Robotics-Engineer_R12345?source=LinkedIn',
      clean: 'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin-TX/Robotics-Engineer_R12345',
      board: 'acme',
      externalId: 'R12345',
      found: 'acme.wd5.myworkdayjobs.com/External',
    },
  ],
});
