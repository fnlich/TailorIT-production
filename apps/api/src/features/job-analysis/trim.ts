import { headingOfLine, namesPostingSection } from './sections';

// v1.3 C (decision 12): a posting as the job_analysis prompt quotes it. The prompt already tells Claude to leave out
// benefits, perks, the equal-opportunity statement and legal text, so those parts are cut before they are sent, by
// their headings, conservatively:
// - a part is cut from a heading that names benefits or perks, the equal-opportunity statement, accommodations or
//   privacy, up to the next heading of any other kind; a heading that also names pay ("Compensation & Benefits") or
//   one of the posting's own sections ("What you'll get") cuts nothing;
// - inside a cut part, a line that states what the analysis reads is kept where it stands: a sum of money or pay, a
//   visa or sponsorship, a clearance, where the work is done (remote, hybrid, on site), a number of years; from v2.0
//   (input 3) also who may apply, a time zone, a cover letter, a certification or licence (eligibilityLine);
// - a lone equal-opportunity or privacy statement without a heading of its own (a closing line) goes too, unless it
//   states one of those;
// - when the cut would leave less than a third of the text, nothing is cut (a heading read wrongly).
// The answer may differ only where Claude would have read a cut line, which the prompt tells it not to, so the prompt
// version stays: no stored analysis is asked for again (job-analysis/prompt.ts).

// v33 JOBDETAIL: the benefits part of the cut headings, exported for the job page's Benefits (job-analysis/benefits.ts);
// BOILERPLATE_HEADING is built from it.
// v33 FIX-2 (final review, security 1): a heading names the person's benefits, not a role or a duty of the job (v3.3's
// HR families: "Benefits Specialist", "Benefits Administration:", "Benefits and Leave Coordinator") nor what a firm
// offers its clients ("What we offer our clients"): both are the job's own text, so the Benefits card no longer lists
// them and the analysis reads them again. Only those headings changed: "Benefits", "Perks & Benefits", "What we offer"
// and "What we offer you" are cut as before.
/**
 * After "benefit(s)" or "rewards", right away or one word on ("and" or "&" allowed between): a role or a function, so
 * the heading is a job title or a duty group ("Benefits Specialist", "Benefits Administration", "Total Rewards Analyst").
 */
export const NOT_A_ROLE_AFTER = String.raw`(?![\s/&-]+(?:(?:and|&)\s+)?(?:[a-z]+[\s/&-]+)?(?:administration|administrators?|admins?|specialists?|coordinators?|analysts?|managers?|management|consultants?|advisors?|advisers?|partners?|representatives?|reps?|associates?|leads?|directors?|clerks?|generalists?|assistants?|officers?|supervisors?|brokers?|counsell?ors?|technicians?|auditors?|audits?|team|enrol(?:l)?ments?|operations|compliance|strategy|claims|billing|processing|accounting|communications)\b)`;
/** After "we offer": what a firm sells or whom it serves ("What we offer our clients"), not what the person gets. */
const NOT_TO_OTHERS_AFTER = String.raw`(?!\s+(?:to\s+)?(?:our\s+|the\s+|your\s+)?(?:clients?|customers?|patients?|partners?|businesses|brands?|companies|organi[sz]ations?|communit(?:y|ies)|members|students|residents|guests|families|consumers|users|services?|products?|solutions?)\b)`;
/** Headings of a posting's benefits part ("Benefits", "Perks", "What we offer"). */
export const BENEFITS_HEADING = new RegExp(
  String.raw`\bbenefits?\b${NOT_A_ROLE_AFTER}|\bperks\b|\bwhat we offer\b${NOT_TO_OTHERS_AFTER}|\bwe offer\b${NOT_TO_OTHERS_AFTER}`,
  'i',
);
/** Headings of the parts the analysis never reads. */
const BOILERPLATE_HEADING = new RegExp(
  `${BENEFITS_HEADING.source}|\\bequal (?:opportunity|employment)\\b|\\beeo\\b|\\bdiversity\\b|\\binclusion\\b|\\baccommodations?\\b|\\bprivacy\\b|\\bdata protection\\b`,
  'i',
);
/** A heading that also names pay is kept whole: salary is one of the analysis's facts. */
const PAY_HEADING = /\bcompensation\b|\bsalary\b|\bpay\b|\bwages?\b|\bremuneration\b/i;
/** A line that states one of the analysis's facts: kept wherever it stands. */
const FACT_LINE =
  /[$€£¥₹]|\b(?:usd|eur|gbp|cad|aud|chf|inr)\b|\bsalary\b|\bcompensation\b|\bpay\b|\bwages?\b|\bvisa\b|\bsponsor|\bclearance\b|\bremote\b|\bhybrid\b|\bon[\s-]?site\b|\bin[\s-]office\b|\b\d+\+?\s*years?\b/i;
/** A closing statement the analysis never reads, with or without a heading. */
const BOILERPLATE_LINE =
  /\bequal (?:opportunity|employment)\b|\ball qualified applicants\b|\bwithout regard to\b|\breasonable accommodations?\b|\bprivacy (?:policy|notice)\b/i;
/** Below this share of the text left, the cut is not trusted and the posting goes whole. */
const MIN_SHARE_LEFT = 1 / 3;

/** Facts a long posting often states last (pay transparency, a visa rule, where the work is done): kept past the cap. */
const TAIL_FACT =
  /[$€£¥₹]|\b(?:usd|eur|gbp|cad|aud|chf|inr)\b|\bsalary\b|\bcompensation\b|\bpay\b|\bwages?\b|\bvisa\b|\bsponsor|\bclearance\b|\bremote\b|\bhybrid\b|\bon[\s-]?site\b|\bin[\s-]office\b/i;
/**
 * v2.0 (06-filters-analysis.md, "input 3"): a line that states who may apply (where they live or work from, a time
 * zone), a cover letter or a certification or licence. Kept where it stands and past the cap like a fact, so a "must
 * reside in" sentence at the end of a long posting still reaches the AI.
 */
const ELIGIBILITY_WORDS =
  /\breside\b|\bresiding\b|\blocated in\b|\bbased in\b|\blive in\b|\bcandidates in\b|\bopen to\b|\beligible\b|\btime ?zones?\b|\bworking hours\b|\bcover letter\b|\bcertif|\blicen[cs]/i;
/** Time-zone tokens as postings write them (in capitals), and zones in words before "time" or "hours". */
const ZONE_TOKEN =
  /\b(?:PST|PDT|PT|MST|MDT|MT|CST|CDT|CT|EST|EDT|ET|AKST|HST|GMT|UTC|CET|EET|IST|SGT|JST|AEST)\b|\b(?:Pacific|Mountain|Central|Eastern)\s+(?:time|hours)\b/;

export function eligibilityLine(line: string): boolean {
  return ELIGIBILITY_WORDS.test(line) || ZONE_TOKEN.test(line);
}

/** The room kept, at the end of a capped posting, for its facts from past the cap. */
const TAIL_ROOM = 1_000;
const TAIL_LINE_MAX = 300;
const ELLIPSIS = '\n[...]\n';

/**
 * At most `max` characters of a posting: its head, and when it runs longer, the lines past the cut that state a fact
 * the analysis reads (TAIL_FACT: pay, a visa or a clearance, the work arrangement), after a "[...]" line, in at most
 * TAIL_ROOM characters. A posting that states pay last keeps it.
 */
export function capWithFacts(text: string, max: number): string {
  if (text.length <= max) return text;
  const headLength = max - TAIL_ROOM;
  const facts: string[] = [];
  let room = TAIL_ROOM - ELLIPSIS.length;
  for (const raw of text.slice(headLength).split(/\r?\n/).slice(1)) {
    const line = raw.trim();
    if (!line || line.length > TAIL_LINE_MAX || !(TAIL_FACT.test(line) || eligibilityLine(line)) || line.length + 1 > room) continue;
    facts.push(line);
    room -= line.length + 1;
  }
  if (facts.length === 0) return text.slice(0, max);
  return `${text.slice(0, headLength).trimEnd()}${ELLIPSIS}${facts.join('\n')}`;
}

/** The posting without its benefits and equal-opportunity parts (see above); the text as it came when nothing is cut. */
export function withoutBoilerplate(text: string): string {
  const out: string[] = [];
  let cutting = false;
  let cut = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = headingOfLine(line);
    if (heading !== null) {
      cutting = BOILERPLATE_HEADING.test(heading) && !PAY_HEADING.test(heading) && !namesPostingSection(heading);
      if (cutting) {
        cut = true;
        continue;
      }
      out.push(raw);
      continue;
    }
    if (line && !FACT_LINE.test(line) && !eligibilityLine(line) && (cutting || BOILERPLATE_LINE.test(line))) {
      cut = true;
      continue;
    }
    out.push(raw);
  }
  if (!cut) return text;
  const left = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return left.length >= text.trim().length * MIN_SHARE_LEFT ? left : text;
}
