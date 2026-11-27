import { boardUrlOf, taleoLinkOf } from '@tailorit/shared/sourcing';
import { htmlToText } from '@tailorit/shared';
import { isoOf, placeOfParts } from '../career/jsonld';
import { assertNewReadAllowed } from '../../../core/http/identity';
import type { IngestHttp } from '../http';
import { IngestError, type RawPosting } from '../types';
import { nameFromSlug } from './common';
import { defineAdapter } from './define';
import { inlineText, readPage, titleOf } from './page-boards';

// v38 ATS-C (SP v38 PLAN "Final coverage" row 11; SP v38 EVIDENCE.md §11): Taleo, links only. A posting's page,
// https://<tenant>.taleo.net/careersection/<section>/jobdetail.ftl?job=<requisition>&lang=<lang>, is server-rendered with
// its data in a script call:
//   api.fillList('requisitionDescriptionInterface', 'descRequisition', ['357708', 'true', ..., '<title>', '<contest no.>',
//     '!*!<URL-encoded HTML>', ...]);
// and its labels, one per position, in the interface's `descRequisition: { ..., _hlid: ['reqlistitem.no', ...,
// 'reqlistitem.title', 'reqlistitem.contestnumber', 'reqlistitem.description', ...] }`. Each section's layout orders its
// fields its own way, so the data is read BY LABEL, never by position: title, contestnumber (the requisition: it must be
// the link's), description and qualification ("!*!" then URL-encoded HTML), primarylocation and otherlocations
// ("US-CA-Sacramento-..."), jobfield (its category), postingdate when the layout has one; a custom field
// (reqlistitem.G<digits>) that says an employment type ("Full-Time"). A gone posting answers 200 with no fillList data
// and "The job is no longer available." (a 404 or 410 too). The company's name is the page's <title> "Careers at
// <Company>". Never a POST: Taleo's job search (a JSON POST) is out of v3.8, so the kind lists no portal.

/** The fillList call of a posting's data. */
const FILL_LIST = /api\.fillList\(\s*'requisitionDescriptionInterface'\s*,\s*'descRequisition'\s*,\s*\[/;
/** Its labels, in the interface's descRequisition block. */
const LABELS = /descRequisition\s*:\s*\{[\s\S]*?_hlid\s*:\s*\[([\s\S]*?)\]/;
/** The words of a gone posting's page. */
const GONE_WORDS = /The job is no longer available|The job description you are trying to view is no longer available|requisitionUnavailableInterface/i;
/** An employment type a custom field may say. */
const EMPLOYMENT = /^(?:full[\s-]?time|part[\s-]?time|temporary|temp|contract(?:or)?|intern(?:ship)?|seasonal|per diem|prn|casual|regular)(?:\s.*)?$/i;

/** The strings of a JavaScript array literal written from `start` (just after its '['), its escapes read; null for none. */
export function jsStringList(text: string, start: number): string[] | null {
  const values: string[] = [];
  let index = start;
  for (;;) {
    while (index < text.length && /[\s,]/.test(text[index]!)) index += 1;
    const char = text[index];
    if (char === undefined) return null;
    if (char === ']') return values;
    if (char === "'" || char === '"') {
      let value = '';
      index += 1;
      for (; index < text.length && text[index] !== char; index += 1) {
        if (text[index] !== '\\') {
          value += text[index];
          continue;
        }
        const next = text[(index += 1)] ?? '';
        if (next === 'n') value += '\n';
        else if (next === 'r') value += '\r';
        else if (next === 't') value += '\t';
        else if (next === 'x' && /^[0-9a-f]{2}$/i.test(text.slice(index + 1, index + 3))) {
          value += String.fromCharCode(parseInt(text.slice(index + 1, index + 3), 16));
          index += 2;
        } else if (next === 'u' && /^[0-9a-f]{4}$/i.test(text.slice(index + 1, index + 5))) {
          value += String.fromCharCode(parseInt(text.slice(index + 1, index + 5), 16));
          index += 4;
        } else value += next;
      }
      if (index >= text.length) return null;
      values.push(value);
      index += 1;
      continue;
    }
    // A bare value (null, a number): kept as its text.
    const bare = /^[^,\]\s]+/.exec(text.slice(index))?.[0];
    if (!bare) return null;
    values.push(bare === 'null' ? '' : bare);
    index += bare.length;
  }
}

/** URL-encoded text decoded, a stray '%' kept; a run of escapes that is no UTF-8 read as Latin-1. */
export function decodeTaleoText(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run.replace(/%([0-9A-Fa-f]{2})/g, (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      }
    });
  }
}

/** A field's rich text ("!*!" then URL-encoded HTML) as HTML; plain text as it is. */
const richText = (value: string): string => (value.startsWith('!*!') ? decodeTaleoText(value.slice(3)) : value).trim();

/** A posting's fields by label (each label's first non-empty value), or null when the page holds no posting data. */
export function taleoFieldsOf(html: string): Map<string, string> | null {
  const list = FILL_LIST.exec(html);
  const labels = LABELS.exec(html);
  if (!list || !labels) return null;
  const values = jsStringList(html, list.index + list[0].length);
  const names = jsStringList(`${labels[1]!}]`, 0);
  if (!values || !names || values.length === 0) return null;
  const fields = new Map<string, string>();
  names.forEach((name, index) => {
    const value = values[index]?.trim() ?? '';
    if (value && !fields.has(name)) fields.set(name, value);
  });
  return fields;
}

/** A Taleo place ("US-CA-Sacramento-Remote - Nationwide": country, state, city, site) as a place line. */
export function taleoPlace(value: string): string | null {
  const text = inlineText(value);
  if (!text) return null;
  const match = /^([A-Za-z]{2})-([A-Za-z]{2,3})-([^-]+?)(?:-.*)?$/.exec(text);
  if (match) return placeOfParts(match[3]!.trim(), match[2]!, match[1]!);
  const country = /^([A-Za-z]{2})-([^-]+?)(?:-.*)?$/.exec(text);
  return country ? placeOfParts(country[2]!.trim(), null, country[1]!) : text;
}

/** A Taleo posting: its portal, section, requisition and the page it is read from. */
export interface TaleoRef {
  tenant: string;
  section: string;
  job: string;
  lang: string | null;
}

/** The page a posting is read from (its clean link, the English page when the link names no language). */
export const taleoPageOf = (ref: TaleoRef) =>
  `https://${ref.tenant}.taleo.net/careersection/${ref.section}/jobdetail.ftl?job=${encodeURIComponent(ref.job)}&lang=${ref.lang ?? 'en'}`;

/** The posting a page address names (a career section's posting page), or null. */
export function taleoRefOf(address: string): TaleoRef | null {
  const url = boardUrlOf(address);
  const link = url ? taleoLinkOf(url) : null;
  return link ? { tenant: link.tenant, section: link.section, job: link.job, lang: link.lang } : null;
}

/** The company's name a posting's page gives (its <title> "Careers at <Company> | ..."), or null. */
export function taleoCompanyOfPage(html: string): string | null {
  const title = titleOf(html) ?? '';
  const name = /^Careers at (.+?)(?:\s+[|–—-]\s+.*)?$/i.exec(title)?.[1]?.trim();
  return name || null;
}

/** A posting's fields as a RawPosting (`page` its link); null without a title. */
export function taleoPosting(fields: ReadonlyMap<string, string>, ref: TaleoRef, page: string, companyName: string): RawPosting | null {
  const title = fields.get('reqlistitem.title');
  if (!title) return null;
  const description = richText(fields.get('reqlistitem.description') ?? '');
  const qualification = richText(fields.get('reqlistitem.qualification') ?? '');
  const sameText = htmlToText(qualification) && htmlToText(description).includes(htmlToText(qualification));
  const descriptionHtml = [description, qualification && !sameText ? `<h3>Qualifications</h3>\n${qualification}` : ''].filter(Boolean).join('\n') || null;
  const places = [fields.get('reqlistitem.primarylocation'), ...(fields.get('reqlistitem.otherlocations') ?? '').split(/\s*[;|\n]\s*/)]
    .map((value) => (value ? taleoPlace(richText(value)) : null))
    .filter((place): place is string => Boolean(place));
  const employment = [...fields.entries()].find(([name, value]) => /^reqlistitem\.G\d+$/.test(name) && EMPLOYMENT.test(value.trim()))?.[1];
  const remote = /\bremote\b/i.test(fields.get('reqlistitem.primarylocation') ?? '');
  return {
    // v38 FIX-C (REVIEW38-beh L12): one posting is one link whatever case its link writes its requisition in
    // (260003p7, 260003P7): kept in upper case; the page is read with the link's own (taleoPageOf, SP v38 FIXES-38 D5).
    sourceJobId: ref.job.toUpperCase(),
    title: inlineText(title),
    company: { name: companyName },
    descriptionHtml,
    url: page,
    locations: [...new Set(places)],
    workArrangement: remote ? 'remote' : null,
    employmentText: employment ? employment.trim() : null,
    department: fields.get('reqlistitem.jobfield') ? inlineText(fields.get('reqlistitem.jobfield')!) : null,
    postedAt: isoOf(fields.get('reqlistitem.postingdate') ?? fields.get('reqlistitem.postedDate') ?? null),
  };
}

/** One posting's read: found (its posting, and the company's name its page gives), or gone. */
export type TaleoRead = { found: true; raw: RawPosting; companyName: string | null } | { found: false };

/**
 * One posting read from its page (on its portal's host only): gone on a 404, a 410, or a page with the words of a gone
 * posting (v38 INT: no posting data alone is can't read). Throws IngestHttpError when Taleo fails, RobotsRefusal when robots.txt refuses the read, and
 * IngestError when the page holds another requisition.
 */
export async function readTaleoPosting(
  http: IngestHttp,
  ref: TaleoRef,
  options: { companyName?: string | null; signal?: AbortSignal } = {},
): Promise<TaleoRead> {
  const page = taleoPageOf(ref);
  const host = `${ref.tenant}.taleo.net`;
  const answer = await readPage(http, page, { signal: options.signal, allow: [404, 410], allowRedirectHost: (to) => to === host });
  if (answer.status === 404 || answer.status === 410) return { found: false };
  const fields = taleoFieldsOf(answer.html);
  if (!fields) {
    // v38 INT (closed only on a positive sign): the page's own "no longer available" words close it; a page with no
    // fillList data and none of those words (a challenge page answering 200) is can't read.
    if (GONE_WORDS.test(answer.html)) return { found: false };
    throw new IngestError("The posting's page holds no Taleo posting data.");
  }
  const contest = fields.get('reqlistitem.contestnumber');
  if (contest && contest.toLowerCase() !== ref.job.toLowerCase()) throw new IngestError('Taleo answered with another requisition.');
  const ownName = taleoCompanyOfPage(answer.html);
  const raw = taleoPosting(fields, ref, page, options.companyName ?? ownName ?? nameFromSlug(ref.tenant));
  if (!raw) throw new IngestError("Taleo's posting has no title.");
  return { found: true, raw, companyName: ownName };
}

export const taleoAdapter = defineAdapter({
  kind: 'taleo',
  label: 'Taleo postings',
  access: 'page',
  hosts: ['*.taleo.net'],
  robotsPaths: () => ['/careersection/'],
  // Never run (links only); the identity guard first, as every new kind of read's (v30-switches.test.ts).
  async fetch(_source, ctx) {
    assertNewReadAllowed(ctx.deps, 'feed_read');
    throw new IngestError(
      "TailorIT reads Taleo postings one at a time (the links people add), never a portal's whole list: this source " +
        'cannot be run. The daily check keeps its postings up to date.',
    );
  },
});
