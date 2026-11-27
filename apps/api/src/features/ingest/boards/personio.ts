import { PERSONIO_BOARD } from '@tailorit/shared/sourcing';
import { personioAdapter } from '../adapters/personio';
import type { ApiBoardDescriptor } from './types';

// v38 FRAME: Personio's API part (its shared part: @tailorit/shared/sourcing PERSONIO_BOARD): its documented XML feed,
// which the employer turns on (v30 S3, 12 §3.3: the docs read 2026-11-16).

export const PERSONIO: ApiBoardDescriptor<'personio'> = {
  board: PERSONIO_BOARD,
  adapter: personioAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed', url: 'https://developer.personio.de/v1.0/reference/get_xml' },
  transferKeys: ['company', 'domain'],
};
