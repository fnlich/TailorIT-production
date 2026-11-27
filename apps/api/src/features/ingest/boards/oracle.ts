import { boardUrlOf, ORACLE_BOARD, oracleBoardOf, oraclePostingOf, oraclePostingUrl, oracleSiteOf, type OracleSite } from '@tailorit/shared/sourcing';
import { str } from '../adapters/common';
import {
  oracleAdapter,
  oracleDetailUrl,
  oracleJobUrl,
  readOracleCompanyName,
  readOraclePosting,
} from '../adapters/oracle';
import { IngestError } from '../types';
import { configString } from './read-json';
import type { ApiBoardDescriptor, PostingRef } from './types';

// v38 ATS-B: Oracle Recruiting Cloud's API part (its shared part: @tailorit/shared/sourcing ORACLE_BOARD). A run reads the
// site's list and each posting's details (adapters/oracle.ts); a link to a posting (…/hcmUI/CandidateExperience/<lang>/
// sites/<site>/job/<id>) is read as its run reads it: the posting's details JSON, a new kind of read. `items: []` (or a
// past end date) is closed. A posting names no employer: its site's list names it once, when it names one organisation.
// v38 FIX-A (SP v38 FIXES-38 D5, REVIEW38-beh M8): the site's code is read as written: a link's as the link wrote it, a
// stored link's as its job's own link wrote it when that names the source's site in another case (sources are looked up
// in any case, so a link written CX_1 may be kept under a source typed cx_1), else the source's.

/** v38 ATS-B (SP v38 PLAN A5): an Oracle source's recorded terms note (job_sources.terms_note, at most 1,000 characters). */
export const ORACLE_TERMS_NOTE =
  '2026-11-25: the owner asked TailorIT to verify job links and read career sites on Oracle Recruiting Cloud. Checked ' +
  "that day: the career site's own pages load its job list (recruitingCEJobRequisitions) and each job's details " +
  "(recruitingCEJobRequisitionDetails) as keyless JSON from the tenant's host; Oracle's reference marks these Candidate " +
  "Experience resources for its own pages' use; robots.txt answers 404 (no rules). Conditions: one request at a time to " +
  'all of Oracle Recruiting Cloud, with the bot user agent (BOT_USER_AGENT); a run reads at most ORACLE_LIST_MAX listed ' +
  "jobs and ORACLE_READS_PER_RUN jobs' details; a job's contact name and email are never read or stored.";

/** A posting's site, from a ref's board (<host>/<SITE>). */
function siteOfRef(ref: PostingRef): OracleSite {
  const site = oracleSiteOf(ref.board);
  if (!site) throw new IngestError('TailorIT does not know this Oracle career site.');
  return site;
}

/** The posting's own clean link (its language as the link wrote it), else the site's page in English. */
function urlOfRef(ref: PostingRef, site: OracleSite): string {
  const page = ref.page ? boardUrlOf(ref.page) : null;
  const own = page ? oraclePostingOf(page) : null;
  return own && own.id === ref.externalId && own.host === site.host ? oracleJobUrl(site, own.id, own.language) : oracleJobUrl(site, ref.externalId);
}

export const ORACLE: ApiBoardDescriptor<'oracle'> = {
  board: ORACLE_BOARD,
  adapter: oracleAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed_with_conditions', url: null, note: ORACLE_TERMS_NOTE },
  transferKeys: ['site'],
  importable: true,
  posting: {
    refOf: ({ source, sourceJobId, jobUrl }) => {
      const kept = oracleBoardOf(configString(source.config, 'site'));
      // v38 FIX-A (D5): the site as the job's own link writes it, when it is the source's in another case.
      const own = oracleBoardOf(jobUrl ?? '');
      const board = own && own.toLowerCase() === kept.toLowerCase() ? own : kept;
      return board && /^\d{1,15}$/.test(sourceJobId) ? { kind: 'oracle', board, externalId: sourceJobId, region: 'global', page: jobUrl } : null;
    },
    // parseAtsUrl's board is the site; its host is the link's.
    refOfLink: (read) => {
      const url = boardUrlOf(read.url);
      const posting = url ? oraclePostingOf(url) : null;
      const board = posting ? oracleBoardOf(`${posting.host}/${posting.site}`) : '';
      return board && posting!.id === read.externalId
        ? { kind: 'oracle', board, externalId: read.externalId, region: 'global', page: oraclePostingUrl(posting!.host, posting!.language, posting!.site, posting!.id) }
        : null;
    },
    apiUrl: (ref) => oracleDetailUrl(siteOfRef(ref), ref.externalId),
    // Named by the source's companyName (or the one the site's list gave: board-link.ts); v38 FIX-APP (D1): else by none
    // (the person's typed company names it, or Add job asks for it), never the tenant's host label.
    read: async (http, ref, options) => {
      const site = siteOfRef(ref);
      const raw = await readOraclePosting(http, site, ref.externalId, {
        companyName: str(options.config?.companyName) ?? '', // v38 FIX-APP (D1)
        signal: options.signal,
        now: (options.now ?? (() => new Date()))(),
        url: urlOfRef(ref, site),
      });
      return raw ? { found: true, raw } : { found: false };
    },
    companyName: (http, board, signal) => {
      const site = oracleSiteOf(board);
      return site ? readOracleCompanyName(http, site, signal) : Promise.resolve(null);
    },
  },
};
