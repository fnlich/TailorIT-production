import { JOB_BENEFIT_MAX_CHARS, JOB_BENEFITS_MAX } from '@tailorit/shared';
import { classifyHeading, headingOfLine } from './sections';
import { BENEFITS_HEADING, NOT_A_ROLE_AFTER } from './trim'; // v33 FIX-2: NOT_A_ROLE_AFTER

// v33 JOBDETAIL (F2): a posting's benefits for the job page's Benefits card, read from the posting's own words without
// AI (the job analysis leaves benefits out: trim.ts cuts them before the AI reads the posting). It works for every job
// already stored, from its plain text (jobs/text.ts plainTextOf: a list item is a "- " line).
//
// The rules, in order:
// - a benefits part starts at a heading that names benefits, perks or what the employer offers (trim.ts's
//   BENEFITS_HEADING, "Compensation & Benefits" too) or what the person gets ("What you'll get", "What's in it for
//   you", "Total rewards"), and ends at the next heading of any other kind (before its first item, only a heading that
//   surely opens a part: a short line such as "Competitive salary and equity" reads as a heading but is a benefit), at
//   a closing statement (equal opportunity, accommodations, privacy), or at the first plain line after its list;
//   v33 FIX-2 (final review, security 1): a heading that names a role or a duty ("Benefits Specialist", "Benefits
//   Administration:", trim.ts's NOT_A_ROLE_AFTER), what a firm offers its clients, or the job's own title, is not one;
// - inside it, each list item is a benefit, and so is a short plain line (a line ending with ":" introduces a list or
//   names a group, and a pay range is the header's salary chip: neither is one);
// - a heading and its list on one line ("Benefits: medical, dental and vision; 401(k) match") is split at ";", "•",
//   "·" and "|" (never at commas: "Medical, dental and vision insurance" is one benefit);
// - bullet marks and trailing separators are dropped, spacing tidied, duplicates left out (ignoring case), each item cut
//   at a word to JOB_BENEFIT_MAX_CHARS with "…", at most JOB_BENEFITS_MAX items.

/**
 * Headings of what the person gets, beyond trim.ts's (which keeps these parts for the analysis). v33 FIX-2: "rewards"
 * followed by a role or a function is a job title ("Total Rewards Analyst"), as with "benefits" (NOT_A_ROLE_AFTER).
 */
const OFFER_HEADING = new RegExp(String.raw`\bwhat you(?:['’]ll| will) get\b|\bwhat['’]?s in it for you\b|\b(?:total )?rewards\b${NOT_A_ROLE_AFTER}`, 'i');
/**
 * Headings of a posting's other parts (about the company, applying, values). With a posting section's heading, a line
 * ending with ":" and another benefits heading, these end a part even before its first item; any other short line that
 * reads as a heading there ("Competitive salary and equity") is one of its benefits.
 */
const OTHER_PART =
  /\babout (?:us|the company|the team|our)\b|\blife at\b|\bour values\b|\bwhy (?:join|work)\b|\bhow to apply\b|\bhiring process\b|\binterview process\b|\bwho we are\b|\bequal (?:opportunity|employment)\b|\beeo\b|\bprivacy\b|\btechnologies we use\b|\b(?:our )?(?:tech )?stack\b/i;
/** A closing statement: it ends a benefits part, and is never a benefit. */
const CLOSING =
  /\bequal (?:opportunity|employment)\b|\ball qualified applicants\b|\bwithout regard to\b|\breasonable accommodations?\b|\bprivacy (?:policy|notice)\b/i;
/** A list item's mark (plainTextOf writes "- "; pasted text may use others). */
const BULLET = /^(?:[•·●▪◦‣►✓✔]\s*|[-*–—](?=\s)\s*|\(?\d{1,2}[.)](?=\s)\s*)/;
/** A pay range ("$120,000 - $150,000", "€60k to €75k"): the header's salary chip says it. */
const PAY_RANGE = /[$€£¥₹]\s?\d[\d,.]*\s*[kK]?\s*(?:-|–|—|to)\s*[$€£¥₹]?\s?\d/;
/** A heading and its value on one line ("Benefits: health, dental"). */
const LABELLED = /^([^:]{1,50}):\s+(\S.*)$/;
/** Where an inline list splits. */
const INLINE_SEPARATOR = /\s*[;•·|]\s*/;
/** A plain line longer than this is prose, not a benefit. */
const PLAIN_LINE_MAX = JOB_BENEFIT_MAX_CHARS;

/** A heading or a title as compared (case, spacing and trailing punctuation aside). */
const comparable = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').replace(/[\s:;,.!|–—-]+$/, '').trim();

/**
 * Whether a heading opens a benefits part. v33 FIX-2: never a heading that repeats the job's title (`title`): a posting
 * that starts with its title ("Benefits Coordinator") names the job there.
 */
export function isBenefitsHeading(heading: string, title?: string | null): boolean {
  if (title && comparable(title) !== '' && comparable(heading) === comparable(title)) return false;
  return (BENEFITS_HEADING.test(heading) || OFFER_HEADING.test(heading)) && !CLOSING.test(heading);
}

/** Whether a heading line surely starts a new part (see OTHER_PART). */
function opensPart(line: string, heading: string, title: string | null): boolean {
  return /:\s*$/.test(line) || classifyHeading(heading) !== null || OTHER_PART.test(heading) || isBenefitsHeading(heading, title);
}

/** An item as shown: spacing tidied, a trailing separator dropped, cut at a word to the longest a benefit may be. */
function tidyItem(text: string): string {
  const item = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:and|or)\s+/i, '')
    .replace(/[\s;,.:]+$/, '');
  if (item.length <= JOB_BENEFIT_MAX_CHARS) return item;
  const cut = item.slice(0, JOB_BENEFIT_MAX_CHARS - 1);
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > JOB_BENEFIT_MAX_CHARS / 2 ? cut.slice(0, atWord) : cut).replace(/[\s;,.:]+$/, '')}…`;
}

/** The parts of an inline list ("A; B • C"); one part when it has no separator. */
function inlineParts(text: string): string[] {
  return text.split(INLINE_SEPARATOR).filter((part) => part.trim().length > 0);
}

/**
 * The posting's benefits (see above): [] when it lists none. Pure; no AI. `title`: the job's title (v33 FIX-2: a
 * heading equal to it names the job, never a benefits part).
 */
export function postingBenefits(text: string | null | undefined, options: { title?: string | null } = {}): string[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const title = options.title ?? null;
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    if (out.length >= JOB_BENEFITS_MAX) return;
    const item = tidyItem(raw);
    const key = item.toLowerCase();
    if (item.length < 2 || seen.has(key) || CLOSING.test(item) || PAY_RANGE.test(item)) return;
    seen.add(key);
    out.push(item);
  };

  let inPart = false;
  let sawItem = false;
  for (const raw of text.split(/\r?\n/)) {
    if (out.length >= JOB_BENEFITS_MAX) break;
    const line = raw.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const bullet = BULLET.test(line);
    const body = bullet ? line.replace(BULLET, '').trim() : line;

    // "Benefits: medical, dental and vision; 401(k) match" (or the same as a list item): the heading with its list.
    const labelled = LABELLED.exec(body);
    if (labelled && isBenefitsHeading(labelled[1]!, title)) {
      for (const part of inlineParts(labelled[2]!)) add(part);
      inPart = false;
      continue;
    }
    const heading = bullet ? null : headingOfLine(line);
    if (heading !== null && !(inPart && !sawItem && !opensPart(line, heading, title))) {
      inPart = isBenefitsHeading(heading, title);
      sawItem = false;
      continue;
    }
    if (!inPart) continue;
    if (CLOSING.test(body)) {
      inPart = false;
      continue;
    }
    if (bullet) {
      sawItem = true;
      // "• Health:" over a sub-list names a group, not a benefit.
      if (!/:$/.test(body)) add(body);
      continue;
    }
    // A plain line after the part's list is the posting's next text, not a benefit.
    if (sawItem) {
      inPart = false;
      continue;
    }
    if (/:$/.test(body) || body.length > PLAIN_LINE_MAX) continue;
    for (const part of inlineParts(body)) add(part);
  }
  return out;
}
