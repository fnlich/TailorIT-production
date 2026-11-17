import { COMPANY_SUMMARY_MAX, htmlToText, normalizeCompanyName } from '@tailorit/shared';
import type { AppDeps } from '../../core/context';
import type { DailyStep } from '../../core/feature';
import { readJobText } from '../jobs/text';
import { clipText, minConfidenceOf, recomputeProfile, upsertSource } from './profile';
import { refreshCompanySearchIn } from './search-refresh'; // v30 FIX-PERF (PGL-19)

// v30 E0-API: the company's own words (docs/design/part2/13-company-enrichment.md §3.2, §6.1 "summary", owner question
// 22): a board's intro (Greenhouse's GET /v1/boards/{token} `content`, which ingest already reads) and the "About
// {company}" section many postings end with, both kept as source text (at most COMPANY_SUMMARY_MAX characters) and
// shown verbatim, labelled by their source, until an AI summary (wave 4's E3) exists.
//
// The About sections are read by a daily step, never per posting: for each company with open jobs and no summary of
// its own yet, the newest open posting's last About section (a heading that names the company, or "About us", "Who we
// are", ...), until the next heading. A company whose newest posting has none is read again when a newer posting
// arrives (its `about` source row's time).

/** A section shorter than this says too little to stand for the company. */
const MIN_SECTION_CHARS = 80;
/** A line longer than this is no heading. */
const HEADING_MAX_CHARS = 80;
/** Companies per run of the daily step. */
const ABOUT_BATCH = 500;

/** A board's intro HTML (or any company text) as the profile keeps source text: plain, at most COMPANY_SUMMARY_MAX. */
export function companySourceText(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = htmlToText(html).replace(/\s+/g, ' ').trim();
  return text.length >= MIN_SECTION_CHARS ? clipText(text, COMPANY_SUMMARY_MAX) : null;
}

const ABOUT_HEADING = /^(?:about\s+(?:us|the\s+(?:company|team|organi[sz]ation|employer))|who\s+we\s+are|our\s+(?:company|story|mission)|company\s+(?:overview|description|profile))\s*[:.!]?$/i;
const OTHER_HEADING =
  /^(?:(?:the\s+|your\s+)?(?:role|position|job|opportunity|responsibilities|requirements|qualifications|benefits|perks|compensation|salary|pay|location|how\s+to\s+apply|what\s+you(?:'|’)?ll\s+do|what\s+we(?:'|’)?re\s+looking\s+for|what\s+we\s+offer|about\s+(?:the|this|you)\s+(?:role|position|job|opportunity|team)|about\s+you|nice\s+to\s+have|equal\s+opportunity.*|eeo.*))\s*[:.!]?$/i;

/** Whether a short line is a heading that opens a section about the company named `nameKey`. */
function isAboutHeading(line: string, nameKey: string): boolean {
  if (ABOUT_HEADING.test(line)) return true;
  const match = /^about\s+(.{2,60}?)\s*[:.!]?$/i.exec(line);
  if (!match || nameKey.length < 3) return false;
  // "About Acme Analytics" for the company "Acme" (and the other way round).
  const named = normalizeCompanyName(match[1]);
  return named.length >= 3 && (named.startsWith(nameKey) || nameKey.startsWith(named));
}

/**
 * The last "About {company}" section of a posting's HTML, as plain text of at most COMPANY_SUMMARY_MAX characters;
 * null when it has none (or one too short to say anything).
 */
export function aboutSectionOf(html: string, companyName: string): string | null {
  const nameKey = normalizeCompanyName(companyName);
  const lines = htmlToText(html)
    .split('\n')
    .map((line) => line.replace(/^[-•*]\s*/, '').trim());
  let found: string | null = null;
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]!;
    if (line.length > HEADING_MAX_CHARS || !isAboutHeading(line, nameKey)) continue;
    const body: string[] = [];
    for (let next = at + 1; next < lines.length; next += 1) {
      const text = lines[next]!;
      if (!text) continue;
      if (text.length <= HEADING_MAX_CHARS && (OTHER_HEADING.test(text) || isAboutHeading(text, nameKey))) break;
      body.push(text);
    }
    const section = body.join(' ').replace(/\s+/g, ' ').trim();
    if (section.length >= MIN_SECTION_CHARS) found = section;
  }
  return found ? clipText(found, COMPANY_SUMMARY_MAX) : null;
}

/**
 * One pass of the About sections: the companies with open jobs and no summary that read a newer posting than their
 * last read. Each company in its own transaction; answers how many profiles changed. v30 FIX-C SEC-3: a held job
 * (an extension's add an admin has not approved) never writes the shared description.
 */
export async function readAboutSections(deps: Pick<AppDeps, 'db' | 'config' | 'log' | 'now' | 'services'>): Promise<number> {
  const due = await deps.db.all<{ company_id: number; name: string; job_id: number }>(
    `SELECT c.id AS company_id, c.name, newest.id AS job_id
     FROM companies c
     JOIN company_profiles p ON p.company_id = c.id
     CROSS JOIN LATERAL (SELECT j.id, j.first_seen_at FROM jobs j
                         WHERE j.company_id = c.id AND j.active AND j.owner_user_id IS NULL AND j.held_since IS NULL
                         ORDER BY j.posted_sort DESC, j.id DESC LIMIT 1) newest
     LEFT JOIN company_sources s ON s.company_id = c.id AND s.kind = 'job_posting' AND s.ref = 'about'
     WHERE c.owner_user_id IS NULL AND c.merged_into_id IS NULL AND NOT c.do_not_fetch AND p.summary IS NULL
       AND (s.id IS NULL OR s.retrieved_at < newest.first_seen_at)
     ORDER BY c.id
     LIMIT ?`,
    [ABOUT_BATCH],
  );
  const minConfidence = minConfidenceOf(deps);
  let changed = 0;
  for (const company of due) {
    const text = await readJobText(deps.db, company.job_id);
    const section = text ? aboutSectionOf(text.html, company.name) : null;
    const at = deps.now().toISOString();
    changed += await deps.db.tx(
      async (t) => {
        const source = await upsertSource(
          t,
          company.company_id,
          { kind: 'job_posting', ref: 'about', licence: 'ats_public_api', matchConfidence: 100, status: section ? 'ok' : 'not_found' },
          section ? { summary: section } : {},
          at,
        );
        // An unchanged answer still moves its time, so the company waits for a newer posting.
        if (!source.changed) await t.run('UPDATE company_sources SET retrieved_at = ? WHERE id = ?', [at, source.sourceId]);
        if (!source.changed) return 0;
        const result = await recomputeProfile(t, company.company_id, at, minConfidence);
        await refreshCompanySearchIn(t, company.company_id, result);
        return result.changed ? 1 : 0;
      },
      { label: 'company about section' },
    );
  }
  return changed;
}

/** Feature.daily: `companies.about-sections`. */
export const aboutSectionsStep: DailyStep = { name: 'about-sections', run: (deps) => readAboutSections(deps) };
