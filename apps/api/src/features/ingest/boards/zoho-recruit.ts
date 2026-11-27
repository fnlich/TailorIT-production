import { boardUrlOf, ZOHO_JOB_ID, ZOHO_RECRUIT_BOARD, ZOHO_RECRUIT_PORTAL, zohoRecruitHostOf, zohoRecruitJobOf, zohoRecruitJobUrl } from '@tailorit/shared/sourcing';
import { str } from '../adapters/common';
import { readZohoRecruitPosting, zohoRecruitAdapter } from '../adapters/zohoRecruit';
import { IngestError } from '../types';
import { configString } from './read-json';
import type { ApiBoardDescriptor, PostingRef } from './types';

// v38 ATS-B: Zoho Recruit's API part (its shared part: @tailorit/shared/sourcing ZOHO_RECRUIT_BOARD). A run reads the
// careers site's list (and a job's page when the list left out its text: adapters/zohoRecruit.ts); a link to a job
// (https://<company>.zohorecruit.com/jobs/<portal>/<id>/<slug>) is read from its own page, the record it embeds, a new
// kind of read. The "no longer available" page, a locked or unpublished record, a 404: closed.

/** v38 ATS-B (SP v38 PLAN A5): a Zoho Recruit source's recorded terms note (job_sources.terms_note, at most 1,000 characters). */
export const ZOHO_RECRUIT_TERMS_NOTE =
  '2026-11-25: the owner asked TailorIT to verify job links and read Zoho Recruit careers sites. Checked that day: ' +
  'robots.txt allows /jobs (and disallows the rest, never read); the careers page holds its job list in a hidden field ' +
  "and each job's page its record (embedded JSON), with the company's name and description; pages run to about 2 MB, " +
  'so the list is read once a run. Conditions: one request at a time to all of Zoho Recruit, with the bot user agent ' +
  "(BOT_USER_AGENT); a run reads at most ZOHO_RECRUIT_READS_PER_RUN jobs' own pages; the careers site's mailbox is never " +
  'read or stored.';

/** The job's own page: the ref's clean link when it names this job on this host, else the careers portal's. */
function pageOfRef(ref: PostingRef): string {
  const page = ref.page ? boardUrlOf(ref.page) : null;
  const own = page ? zohoRecruitJobOf(page) : null;
  return own && own.host === ref.board && own.id === ref.externalId
    ? zohoRecruitJobUrl(own.host, own.portal, own.id, own.slug)
    : zohoRecruitJobUrl(ref.board, ZOHO_RECRUIT_PORTAL, ref.externalId, null);
}

export const ZOHO_RECRUIT: ApiBoardDescriptor<'zoho_recruit'> = {
  board: ZOHO_RECRUIT_BOARD,
  adapter: zohoRecruitAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed_with_conditions', url: null, note: ZOHO_RECRUIT_TERMS_NOTE },
  transferKeys: ['site'],
  importable: true,
  posting: {
    refOf: ({ source, sourceJobId, jobUrl }) => {
      const host = zohoRecruitHostOf(configString(source.config, 'site'));
      return host && ZOHO_JOB_ID.test(sourceJobId) ? { kind: 'zoho_recruit', board: host, externalId: sourceJobId, region: 'global', page: jobUrl } : null;
    },
    refOfLink: (read) =>
      read.board && ZOHO_JOB_ID.test(read.externalId)
        ? { kind: 'zoho_recruit', board: read.board, externalId: read.externalId, region: 'global', page: read.canonical[0] ?? read.url }
        : null,
    apiUrl: (ref) => pageOfRef(ref),
    // Named by the source's companyName, else the careers site's own name.
    read: async (http, ref, options) => {
      const host = zohoRecruitHostOf(ref.board);
      if (!host) throw new IngestError('TailorIT does not know this Zoho Recruit careers site.');
      const read = await readZohoRecruitPosting(http, host, ref.externalId, {
        url: pageOfRef(ref),
        companyName: str(options.config?.companyName),
        signal: options.signal,
      });
      return read.found ? { found: true, raw: read.raw, company: read.company } : { found: false };
    },
  },
};
