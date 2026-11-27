import { companySourceText } from '../../companies/about';
import { str } from '../adapters/common';
import type { RawPosting } from '../types';
import type { CompanyFacts } from './types';

// v38 FRAME (SP v38 PLAN A6): what a platform says about a posting's company (a descriptor's companyOf: its readPosting's
// `company`, or its adapter's per posting), applied to the posting as every board kind's is:
//   - the name names the job's company as today: the source's companyName first (an admin's word, or the name Add job
//     kept), then the platform's, then what the reader named it (its own name for the company, or the board's slug);
//   - the about text, the website and the logo's address ride on the posting's company (RawCompany: about, website,
//     logoSourceUrl) into the company's `ats_board` source row (companies/resolve.ts), which feeds the company's record
//     only where no better source gives a value (companies/profile.ts: an admin's, the company's own site's, an AI
//     summary's rank above it; nothing is overwritten); a logo is copied, never hot-linked (companies/site/step.ts).
// A value the posting already carries (its reader's own) stands.

/** An https address, or null (a platform's logo or website as kept). */
function httpsAddress(value: unknown): string | null {
  const text = str(value);
  if (!text || text.length > 2048) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The posting with the platform's facts about its company applied (see the top). */
export function withCompanyFacts(raw: RawPosting, facts: CompanyFacts, config: Record<string, unknown> | undefined): RawPosting {
  const name = str(config?.companyName) ?? str(facts.name) ?? raw.company.name;
  const about = raw.company.about ?? (facts.about ? companySourceText(facts.about) : null);
  const website = raw.company.website ?? httpsAddress(facts.website);
  const logoSourceUrl = raw.company.logoSourceUrl ?? httpsAddress(facts.logoUrl);
  return {
    ...raw,
    company: {
      ...raw.company,
      name,
      ...(about ? { about } : {}),
      ...(website ? { website } : {}),
      ...(logoSourceUrl ? { logoSourceUrl } : {}),
    },
  };
}
