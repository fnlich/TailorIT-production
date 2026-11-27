import { TALEO_BOARD, taleoTenant } from '@tailorit/shared/sourcing';
import { str } from '../adapters/common';
import { readTaleoPosting, taleoAdapter, taleoPageOf, taleoRefOf, type TaleoRef } from '../adapters/taleo';
import { IngestError } from '../types';
import { configString } from './read-json';
import type { ApiBoardDescriptor, PostingRef } from './types';

// v38 ATS-C: Taleo's API part (its shared part: @tailorit/shared/sourcing TALEO_BOARD), links only. A link to a posting
// (<tenant>.taleo.net/careersection/<section>/jobdetail.ftl?job=<requisition>, its apply pages too) is read from the
// posting's page (its fillList data by label: adapters/taleo.ts), a new kind of read. Its read needs the career section,
// which only a link names: a ref carries its page (PostingRef.page).

/** v38 ATS-C (A5): a Taleo source's recorded terms note (job_sources.terms_note, at most 1,000 characters). */
export const TALEO_TERMS_NOTE =
  "2026-11-25: the owner asked TailorIT to verify Taleo job links. Checked that day: a posting's page " +
  '(<tenant>.taleo.net/careersection/<section>/jobdetail.ftl?job=<id>) is public and carries its data in the page (its ' +
  'fillList call); the portal checked has no robots.txt. Its job search is a JSON POST, which TailorIT does not send: ' +
  'links only, no portal list. Conditions: one request at a time to Taleo, with the bot user agent (BOT_USER_AGENT); ' +
  'the apply pages are never read.';

/** A requisition as Taleo writes it. */
const JOB_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** A posting's ref for its reader: its page names its section; IngestError when it names none. */
function taleoRefOfPosting(ref: PostingRef): TaleoRef {
  const read = ref.page ? taleoRefOf(ref.page) : null;
  if (!read || read.tenant !== ref.board || read.job.toLowerCase() !== ref.externalId.toLowerCase()) {
    throw new IngestError("TailorIT does not know this Taleo posting's career section.");
  }
  return read;
}

/** The posting's ref from one of its addresses on `tenant` naming requisition `job`, or null. */
function refOfAddresses(tenant: string, job: string, addresses: readonly string[]): PostingRef | null {
  for (const address of addresses) {
    const read = taleoRefOf(address);
    if (read && read.tenant === tenant && read.job.toLowerCase() === job.toLowerCase()) {
      return { kind: 'taleo', board: tenant, externalId: read.job, region: 'global', page: taleoPageOf(read) };
    }
  }
  return null;
}

export const TALEO: ApiBoardDescriptor<'taleo'> = {
  board: TALEO_BOARD,
  adapter: taleoAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed_with_conditions', url: null, note: TALEO_TERMS_NOTE },
  posting: {
    // A stored link: its portal's, its requisition, its section from its job's own link.
    refOf: ({ source, sourceJobId, jobUrl }) => {
      const tenant = taleoTenant(configString(source.config, 'tenant'));
      return tenant && JOB_ID.test(sourceJobId) ? refOfAddresses(tenant, sourceJobId, [jobUrl]) : null;
    },
    // The link itself, else the posting page the extension's reading names (an account page's return address).
    refOfLink: (read) => {
      const tenant = taleoTenant(read.board ?? '');
      return tenant && JOB_ID.test(read.externalId) ? refOfAddresses(tenant, read.externalId, [read.url, ...read.canonical]) : null;
    },
    apiUrl: (ref) => taleoPageOf(taleoRefOfPosting(ref)),
    read: async (http, ref, options) => {
      const read = await readTaleoPosting(http, taleoRefOfPosting(ref), { companyName: str(options.config?.companyName), signal: options.signal });
      return read.found ? { found: true, raw: read.raw, company: { name: read.companyName } } : { found: false };
    },
  },
};
