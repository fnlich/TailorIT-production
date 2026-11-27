import type { EmploymentType } from '@tailorit/shared';
import { assertNewReadAllowed, type NewReadKind } from '../../../core/http/identity';
import { PERSONIO_BOARD, personioCompany } from '@tailorit/shared/sourcing'; // v38 FRAME: the board registry's rules
import { parseXml, xmlChild, xmlChildren, xmlText, type XmlElement } from '../sitemap';
import { IngestError, SourceNotFoundError, type FetchFailure, type ListingValidators, type RawPosting } from '../types';
import { nameFromSlug, str } from './common';
import { conditionalOf, defineAdapter, notModifiedResult } from './define';

// v30 S3: Personio's XML job feed (docs/design/part2/12-job-sourcing.md §3.3; Personio's reference read 2026-11-16:
// developer.personio.de/v1.0/reference/get_xml): GET https://{company}.jobs.personio.de/xml?language={code}, the feed an
// employer turns on for integrations, no credentials. Root <workzag-jobs>, one <position> per open job: id, name, office
// (and additionalOffices), department, subcompany, employmentType (permanent, intern, trainee, freelance), schedule
// (full-time, part-time), seniority, yearsOfExperience, createdAt, and jobDescriptions (<jobDescription> with a <name>
// heading and a <value> of HTML in CDATA). The feed is the employer's whole list of open positions: a complete listing,
// so a posting it no longer lists closes after two misses (12 §8.2). Each posting's page is
// https://{company}.jobs.personio.de/job/{id}.
//
// A source: config `{ company, domain?, language?, companyName? }` (`domain` de, the default, or com: the host
// {company}.jobs.personio.{domain}; `language` one of PERSONIO_LANGUAGES, en by default). A new kind of read: the
// identity guard first ('feed_read'), then BOT_USER_AGENT (the service's client for this kind).

const NEW_READ: NewReadKind = 'feed_read';

/** The feed's languages (Personio's reference); a career site answers in the ones it has. */
export const PERSONIO_LANGUAGES = ['en', 'de', 'fr', 'es', 'nl', 'it', 'pt'] as const;

/** The company's name on Personio as typed: a name or an address on jobs.personio.de / .com (v38 FRAME: the registry's). */
export { personioCompany };

/** A Personio source's feed: its host, address and language. */
export function personioFeedOf(config: Record<string, unknown>): { company: string; host: string; language: string; url: string } {
  const company = personioCompany(str(config.company) ?? '');
  const domain = /jobs\.personio\.com/i.test(str(config.company) ?? '') ? 'com' : config.domain;
  const host = company ? PERSONIO_BOARD.hostOf({ company, domain }) : null;
  if (!host) throw new IngestError('This source has no Personio company name ({company}.jobs.personio.de). Edit the source and add it.');
  const wanted = (str(config.language) ?? 'en').toLowerCase();
  const language = (PERSONIO_LANGUAGES as readonly string[]).includes(wanted) ? wanted : 'en';
  return { company, host, language, url: `https://${host}/xml?language=${language}` };
}

/** An ISO time with a "+0200" offset written "+02:00" (createdAt); null for any other text. */
function timeOf(value: string | null): string | null {
  if (!value) return null;
  const text = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  return Number.isFinite(Date.parse(text)) ? text : null;
}

/** Personio's employmentType and schedule as an employment type. */
function employmentOf(kind: string | null, schedule: string | null): EmploymentType | null {
  const type = kind?.toLowerCase() ?? '';
  if (type === 'intern' || type === 'trainee') return 'internship';
  if (type === 'freelance') return 'contract';
  const hours = schedule?.toLowerCase() ?? '';
  if (hours === 'part-time') return 'part_time';
  if (hours === 'full-time') return 'full_time';
  return null;
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The posting's sections as one description: each heading, then its HTML. */
function descriptionOf(position: XmlElement): string | null {
  const parts = xmlChildren(xmlChild(position, 'jobDescriptions'), 'jobDescription')
    .map((section) => {
      const heading = xmlText(section, 'name');
      const body = xmlText(section, 'value');
      if (!body) return null;
      return heading ? `<h3>${escapeHtml(heading)}</h3>\n${body}` : body;
    })
    .filter((part): part is string => Boolean(part));
  return parts.length ? parts.join('\n') : null;
}

/** One <position> as a RawPosting; null when it lacks an id or a name. */
export function personioPosting(position: XmlElement, feed: { host: string }, companyName: string): RawPosting | null {
  const id = xmlText(position, 'id');
  const title = xmlText(position, 'name');
  if (!id || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || !title) return null;
  const offices = [
    xmlText(position, 'office'),
    ...xmlChildren(xmlChild(position, 'additionalOffices'), 'office').map((office) => office.text.trim() || null),
  ].filter((office): office is string => Boolean(office));
  const kind = xmlText(position, 'employmentType');
  const schedule = xmlText(position, 'schedule');
  return {
    sourceJobId: id,
    title,
    company: { name: companyName },
    descriptionHtml: descriptionOf(position),
    url: `https://${feed.host}/job/${id}`,
    locations: [...new Set(offices)],
    employmentType: employmentOf(kind, schedule),
    employmentText: [kind, schedule].filter(Boolean).join(', ') || null,
    department: xmlText(position, 'department'),
    postedAt: timeOf(xmlText(position, 'createdAt')),
  };
}

export const personioAdapter = defineAdapter({
  kind: 'personio',
  label: 'Personio job feed',
  access: 'api',
  hosts: ['*.jobs.personio.de', '*.jobs.personio.com'],
  robotsPaths(source) {
    try {
      const feed = personioFeedOf(source.config);
      return [`/xml?language=${feed.language}`, '/job/'];
    } catch {
      return [];
    }
  },
  async fetch(source, ctx) {
    assertNewReadAllowed(ctx.deps, NEW_READ);
    const feed = personioFeedOf(source.config);
    let validators: ListingValidators | null = null;
    const answer = await ctx.http.getJson(feed.url, {
      signal: ctx.signal,
      text: true,
      allow: [404, 410],
      allowRedirectHost: (host) => host === feed.host,
      ...conditionalOf(ctx),
      meta: (meta) => (validators = { etag: meta.etag, lastModified: meta.lastModified }),
    });
    if (answer.status === 304) return notModifiedResult();
    if (answer.status === 404 || answer.status === 410) {
      throw new SourceNotFoundError(`Personio has no job feed for "${feed.company}" (${feed.host}). Check the company name.`);
    }
    const root = typeof answer.data === 'string' ? parseXml(answer.data) : null;
    if (root?.name !== 'workzag-jobs') {
      throw new IngestError(`Personio answered without its job feed for "${feed.company}": the employer may have turned the XML feed off.`);
    }
    // The source's company name, else the subsidiary the position names, else the company's name on Personio.
    const named = str(source.config.companyName);
    const postings: RawPosting[] = [];
    const failures: FetchFailure[] = [];
    for (const position of xmlChildren(root, 'position')) {
      const posting = personioPosting(position, feed, named ?? xmlText(position, 'subcompany') ?? nameFromSlug(feed.company));
      if (posting) postings.push(posting);
      else failures.push({ sourceJobId: xmlText(position, 'id') ?? undefined, message: 'A position has no id or name.' });
    }
    ctx.log(`Personio feed ${feed.company} (${feed.language}): ${postings.length} positions.`);
    return { postings, complete: true, failures, validators };
  },
});
