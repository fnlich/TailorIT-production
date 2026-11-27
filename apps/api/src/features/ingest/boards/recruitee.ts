import { boardUrlOf, RECRUITEE_BOARD, recruiteeCompany, recruiteeOfferOf } from '@tailorit/shared/sourcing';
import { readRecruiteeOffer, recruiteeAdapter, recruiteeFeedOf, recruiteeNeedsToken } from '../adapters/recruitee';
import { str } from '../adapters/common';
import { configString } from './read-json';
import type { ApiBoardDescriptor, PostingRef } from './types';

// v38 FRAME: Recruitee's API part (its shared part: @tailorit/shared/sourcing RECRUITEE_BOARD): its documented careers
// API, open until 2027-02-10 (then each employer's token: the adapter stops; v30 S3, 12 §3.3).
// v38 ATS-A (SP v38 PLAN "Final coverage" row 9; EVIDENCE.md 9): an offer's link (https://<company>.recruitee.com/o/<slug>)
// is read on its own, GET /api/offers/<slug> (404, or a status other than published: closed): Add job, imports, the
// extension, MCP and the re-checks. A ref names the offer by its slug (its link's); the offer is stored by its id, as a
// run stores it. From 2027-02-10 nothing is read (no token): can't read.
// v38 FIX-A (SP v38 FIXES-38 item 12, REVIEW38-beh L9): a stored offer's ref names its stored id (externalId) and its
// slug (its job's own link, `page`): an answer for that slug with another offer's id (the slug reused by a newer offer)
// is can't read, never the stored offer's "still live".

/** The offer's clean link on its company. */
const offerPage = (company: string, slug: string) => `https://${company}.recruitee.com/o/${slug}`;

/** The offer a link's ref names on its company, by its slug (`page`: the offer's clean link). */
function offerRef(company: string, slug: string): PostingRef | null {
  return company && slug ? { kind: 'recruitee', board: company, externalId: slug, region: 'global', page: offerPage(company, slug) } : null;
}

/** The slug a ref's read takes: its page's (a stored offer's), else its externalId (a link's). */
function slugOfRef(ref: PostingRef): string {
  const url = ref.page ? boardUrlOf(ref.page) : null;
  const offer = url ? recruiteeOfferOf(url) : null;
  return offer && offer.company === ref.board ? offer.slug : ref.externalId;
}

export const RECRUITEE: ApiBoardDescriptor<'recruitee'> = {
  board: RECRUITEE_BOARD,
  adapter: recruiteeAdapter,
  readKind: 'feed_read',
  terms: { status: 'allowed_with_conditions', url: 'https://docs.recruitee.com/reference/offers' },
  transferKeys: ['company'],
  importable: true, // v38 ATS-A (A9)
  posting: {
    // A stored offer by its job's own link (/o/<slug> on the source's company): the slug its read takes; v38 FIX-A (L9):
    // its stored id, which the offer read must have.
    refOf: ({ source, sourceJobId, jobUrl }) => {
      const company = recruiteeCompany(configString(source.config, 'company'));
      const url = boardUrlOf(jobUrl);
      const offer = url ? recruiteeOfferOf(url) : null;
      return offer && offer.company === company && sourceJobId ? { kind: 'recruitee', board: company, externalId: sourceJobId, region: 'global', page: offerPage(company, offer.slug) } : null;
    },
    refOfLink: (read) => (read.board ? offerRef(recruiteeCompany(read.board), read.externalId) : null),
    apiUrl: (ref) => `https://${recruiteeFeedOf({ company: ref.board }).host}/api/offers/${encodeURIComponent(slugOfRef(ref))}`,
    // Named by the source's companyName, else the offer's company_name, else the company's address made readable.
    read: async (http, ref, options) => {
      // v38 INT: from 2027-02-10 Recruitee's careers API needs the employer's own token (none kept): ATS-D's "needs its
      // own login" (can't read), nothing sent.
      if (recruiteeNeedsToken((options.now ?? (() => new Date()))())) return { found: false, unreadable: 'needs_login' };
      const slug = slugOfRef(ref);
      // v38 FIX-A (L9): a stored offer's read must answer its own id (a link's names only its slug).
      const expected = slug === ref.externalId ? null : ref.externalId;
      const read = await readRecruiteeOffer(http, ref.board, slug, str(options.config?.companyName), options.signal, expected);
      return read ? { found: true, raw: read.raw, company: { name: read.companyName } } : { found: false };
    },
  },
};
