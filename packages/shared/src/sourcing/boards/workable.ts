import { z } from 'zod';
import { isWorkableAccountName } from '../../autofill/lookup';
import { BOARD_CONFIG_COMMON, defineBoard } from './define';
import { boardHostOf, configWords, NOT_A_BOARD, tenantLabelOfHost } from './url';

// v38 FRAME: Workable accounts (apply.workable.com/<account>; the API's adapters/workable.ts).

/**
 * The account as typed: its name, its careers page (apply.workable.com/<account>) or its own host
 * (<account>.workable.com), in lower case; '' when it names none: a workable.com address that names no account
 * (apply.workable.com/j/<shortcode>, www., jobs., help., the bare host) or one of Workable's own names
 * (WORKABLE_SERVICE_NAMES).
 */
export function workableAccount(input: string): string {
  const text = input.trim();
  let named: string;
  if (/workable\.com/i.test(text)) {
    named =
      /apply\.workable\.com\/(?:api\/v\d+\/(?:widget\/)?accounts\/)?([A-Za-z0-9-]+)(?=[/?#]|$)/i.exec(text)?.[1] ??
      /^(?:https?:\/\/)?([A-Za-z0-9-]+)\.workable\.com(?:[/?#:]|$)/i.exec(text)?.[1] ??
      '';
  } else {
    named = text.replace(/[^A-Za-z0-9-]/g, '');
  }
  const account = named.toLowerCase();
  return account && isWorkableAccountName(account) ? account : '';
}

export const WORKABLE_BOARD = defineBoard({
  kind: 'workable',
  label: 'Workable',
  row: { access: 'public_api', runs: true, precedence: 4, rawKeepDays: 30 },
  platform: 'workable',
  hosts: String.raw`(?:^|\.)workable\.com$`,
  domains: ['workable.com'],
  atsKind: 'workable',
  configKey: 'account',
  boardWords: 'Workable account',
  configSchema: z.strictObject({ account: z.string().min(1), ...BOARD_CONFIG_COMMON }),
  boardOf: workableAccount,
  configOfBoard: (board) => ({ account: board }),
  hostOf: () => 'apply.workable.com',
  boardOfUrl: (url, parts) => {
    const host = boardHostOf(url);
    if (host === 'apply.workable.com') return parts[0] && !NOT_A_BOARD.has(parts[0].toLowerCase()) ? parts[0] : null;
    return tenantLabelOfHost(host, '.workable.com');
  },
  detail: (config) => `Account ${configWords(config, 'account')}`,
  examples: [
    {
      link: 'https://apply.workable.com/acme-robotics/j/0A1B2C3D4E/?utm_medium=social',
      clean: 'https://apply.workable.com/acme-robotics/j/0A1B2C3D4E',
      board: 'acme-robotics',
      externalId: '0A1B2C3D4E',
      found: 'acme-robotics',
    },
  ],
});
