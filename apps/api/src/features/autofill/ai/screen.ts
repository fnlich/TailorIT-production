import type { AutofillPickCategory } from '@tailorit/shared/autofill';
import { caseKeptText, closedUp, detectionViews } from './fold';
import { untrustedText } from './untrusted';

// The screen before the CLI (work package AF, Phase 4). The extension never sends a sensitive question: its worker
// screens a field with the same terms before it asks, and its policy keeps the self-identification, legal, pay and
// consent questions to the profile and the person. TailorIT screens every item again, and answers one that still looks
// sensitive null (reason `sensitive`) without asking Claude: such an item enters the task's input as its key alone.
// This screen reads no answer of the person's: it goes by the item's own text. The tiebreak's values are also compared
// with the person's sensitive answers, yes or no only, by profile/sensitive-screen.ts, the one module under profile/
// the AI modules import (autofill-ai.test.ts walks their imports). Since the owner's decision of 2026-11-01 the answer
// route's `all` scope asks the questions of the open topics (OPEN_TOPICS) and the attention checks too, so the terms
// are kept by topic (sensitiveTopicsOf); another person's details and the "I did not use AI" attestations
// (asksAboutAnotherPerson, isAiAttestation) are never asked in any scope.

/**
 * What a sensitive term names, so the answer route's `all` scope (the owner's decision of 2026-11-01) can ask Claude a
 * question of an open topic (OPEN_TOPICS: work authorization, age, pay, criminal history) and still hold back the
 * rest. Every term, statement (statements.ts) and acronym belongs to one.
 */
export const SENSITIVE_TOPICS = [
  'authorization',
  'self_identification',
  'age',
  'pay',
  'consent',
  'criminal',
  'identity_number',
] as const;
export type SensitiveTopic = (typeof SENSITIVE_TOPICS)[number];

/**
 * The topics the answer route's `all` scope asks Claude about: work authorization (sponsorship, a visa, citizenship
 * or residence status, a clearance, export control), age (18 or over), pay and criminal history. Self-identification,
 * consent and identity numbers are never asked.
 */
export const OPEN_TOPICS: ReadonlySet<SensitiveTopic> = new Set<SensitiveTopic>([
  'authorization',
  'age',
  'pay',
  'criminal',
]);

/** Work authorization. */
const AUTHORIZATION_TERMS: readonly string[] = [
  String.raw`\bauthori[sz]`,
  String.raw`\bsponsor`,
  String.raw`\bvisas?\b`,
  String.raw`\bcitizen`,
  String.raw`\bnationalit(?:y|ies)\b`,
  String.raw`\b(?:in)?eligib`,
  String.raw`\bwork\s*permits?\b`,
  String.raw`\bright\s+to\s+work\b`,
  String.raw`\blegally\s+(?:able|allowed|permitted|entitled)\b`,
  String.raw`\bimmigra`,
  String.raw`\bgreen\s+card\b`,
  String.raw`\bexport\s+control`,
  String.raw`\bu\s*\.?\s*s\s*\.?\s*persons?\b`,
  String.raw`\bclearances?\b`,
  // Sponsorship with no topic word (the Phase 6 review, as the extension screens it): "Will you now or in the future
  // require us to support your employment?".
  String.raw`\bnow\s+or\s+in\s+the\s+future\b`,
  String.raw`\bsupport\s+(?:for\s+)?(?:your|my|their)\s+(?:employment|work)\b`,
];

/** Self-identification (EEO). */
const SELF_IDENTIFICATION_TERMS: readonly string[] = [
  String.raw`\bgender`,
  String.raw`\bsex(?:es|ual\w*)?\b`,
  String.raw`\btrans(?:gender|sexual)`,
  String.raw`\bpronouns?\b`,
  String.raw`\brac(?:e|es|ial)\b`,
  String.raw`\bethnic`,
  String.raw`\bhispanic`,
  String.raw`\blatin[aeox]s?\b`,
  String.raw`\bveterans?\b`,
  String.raw`\bmilitary\b`,
  String.raw`\bdisab`,
  String.raw`\breligio`,
  String.raw`\bmarital\b`,
  String.raw`\bself[\s-]*identif`,
  String.raw`\beeoc?\b`,
  String.raw`\bequal\s+(?:employment\s+)?opportunit`,
  String.raw`\baboriginal`,
  String.raw`\btorres\s+strait`,
  String.raw`\bindigenous`,
  String.raw`\bfirst\s+nations?\b`,
  String.raw`\bvisible\s+minorit`,
  String.raw`\blgbt`,
  // Orientation as the EEO phrase only: "sexual orientation", or within three words of gender, LGBTQ or identity.
  String.raw`\bsexual\s+orientation\b`,
  String.raw`\b(?:identit|gender|lgbt)\w*\W+(?:\w+\W+){0,3}orientation\b`,
  String.raw`\borientation\W+(?:\w+\W+){0,3}(?:identit|gender|lgbt)`,
  // Disability as the ADA defines it, with no "disab" word.
  String.raw`\bsubstantially\s+limit(?:s|ed|ing)?\b`,
  String.raw`\bmajor\s+life\s+activit(?:y|ies)\b`,
];

/** Age. */
const AGE_TERMS: readonly string[] = [
  String.raw`\bages?\b`,
  String.raw`\bdate\s+of\s+birth\b`,
  String.raw`\bbirth\s*(?:date|day)\b`,
  String.raw`\byears?\s+of\s+birth\b`,
  String.raw`\bbirth\s*years?\b`,
  String.raw`\bborn\b`,
  String.raw`\bdob\b`,
  String.raw`\bhow\s+old\b`,
  String.raw`\b(?:at\s+least|over|under|older\s+than|younger\s+than)\s+(?:the\s+age\s+of\s+)?(?:16|18|19|21)\b`,
  String.raw`\b(?:16|18|19|21)\s*(?:(?:years?|yrs?)\s+)?(?:of\s+age|old\b|or\s+(?:older|over|above)\b|\+)`,
];

/** Pay. */
const PAY_TERMS: readonly string[] = [
  String.raw`\bsalar(?:y|ies)\b`,
  String.raw`\bcompensation\b`,
  String.raw`\bpay\b`,
  String.raw`\bwages?\b`,
  String.raw`\bremuneration\b`,
  String.raw`\bhourly\s+rates?\b`,
  String.raw`\brates?\s+of\s+pay\b`,
  String.raw`\bctc\b`,
  String.raw`\bannual\s+base\b`,
  String.raw`\bbonus(?:es)?\b`,
  String.raw`\bequity\b`,
];

/** Consent and agreement. */
const CONSENT_TERMS: readonly string[] = [
  String.raw`\bconsent`,
  String.raw`\b(?:dis)?agree`,
  String.raw`\bprivacy\b`,
  String.raw`\bshare\s+(?:my|your)\s+(?:personal\s+)?(?:data|information|info|details)\b`,
  String.raw`\bbackground\s+(?:check|screening)s?\b`,
  String.raw`\backnowledg`,
  String.raw`\bcertif(?:y|ies|ied|ying)\b`,
  String.raw`\baccept(?:s|ed|ing)?\s+(?:all\s+)?(?:the\s+|these\s+|our\s+)?terms\b`,
];

/** Criminal history. */
const CRIMINAL_TERMS: readonly string[] = [
  String.raw`\bcriminal`,
  String.raw`\bconvict`,
  String.raw`\bfelon`,
  String.raw`\bmisdemeano`,
  String.raw`\barrest`,
  String.raw`\bguilty\b`,
  String.raw`\boffen[cs]es?\b`,
];

/** Identity numbers. */
const IDENTITY_NUMBER_TERMS: readonly string[] = [
  String.raw`\bsocial\s+security\b`,
  String.raw`\bssn\b`,
  String.raw`\bpassport\s*(?:numbers?|no\b|#)`,
  String.raw`\bnational\s+insurance\b`,
];

/**
 * The sensitive terms, one pattern each, matched in any case over every detection view of a text (fold.ts), so a
 * look-alike letter, a combining mark, an invisible character or letters written one by one cannot split a word. The
 * extension's SENSITIVE_TERMS (src/core/resolver/classify.ts) hold the same terms (the Phase 4 review's additions are
 * its SHARED_SENSITIVE_TERMS, which autofill-ai.test.ts pins here too), and both repositories' tests run one shared
 * phrase fixture (apps/api/test/fixtures/sensitive-phrases.json, a copy of the extension's), so the two cannot drift
 * apart unseen. What they name: work authorization (authorized, sponsorship, visa, citizenship, eligibility, work
 * permit, right to work, legally able to work, immigration, export control, U.S. person, clearance, and the Phase 6
 * review's sponsorship paraphrases "now or in the future" and "support your employment or work"),
 * self-identification (gender, sex, pronouns, sexual orientation, race, ethnicity, Hispanic or Latino, veteran or
 * military status, disability, religion, marital status, Aboriginal, Torres Strait Islander, Indigenous, First
 * Nations, visible minority, LGBTQ; orientation only near gender, LGBTQ or identity words), disability as the ADA
 * words it (substantially limits, major life activity), age (date or year of birth, birth year, born, 18 or older),
 * pay (salary, compensation, pay, wage, hourly rate, CTC, base salary, annual base, bonus, equity), consent (consent,
 * agree, privacy, share my or your data or information, background checks, acknowledge, certify as a verb, accept
 * the terms), criminal history (criminal, convicted, felony, misdemeanor, arrest, guilty, offence) and identity
 * numbers (social security, SSN, passport number, National Insurance). The acronyms OPT, CPT, TN, H-1B and NI number
 * are SENSITIVE_ACRONYMS, in capitals only. In this order, topic by topic (SHARED_TERMS_BY_TOPIC).
 */
export const SENSITIVE_TERMS: readonly string[] = [
  ...AUTHORIZATION_TERMS,
  ...SELF_IDENTIFICATION_TERMS,
  ...AGE_TERMS,
  ...PAY_TERMS,
  ...CONSENT_TERMS,
  ...CRIMINAL_TERMS,
  ...IDENTITY_NUMBER_TERMS,
];

/** The shared terms by the topic each names. */
const SHARED_TERMS_BY_TOPIC: Readonly<Record<SensitiveTopic, readonly string[]>> = {
  authorization: AUTHORIZATION_TERMS,
  self_identification: SELF_IDENTIFICATION_TERMS,
  age: AGE_TERMS,
  pay: PAY_TERMS,
  consent: CONSENT_TERMS,
  criminal: CRIMINAL_TERMS,
  identity_number: IDENTITY_NUMBER_TERMS,
};

/** Every sensitive term in one pattern, in any case. */
export const SENSITIVE_LABEL = new RegExp(SENSITIVE_TERMS.join('|'), 'i');

/** The acronyms of work authorization: OPT, CPT, TN and H-1B (H1B). */
const AUTHORIZATION_ACRONYMS: readonly RegExp[] = [
  /\bOPT\b/,
  /\bCPT\b/,
  /(?<!,\s*)\bTN\b/,
  /\bH\s*[-\u2010-\u2015]?\s*1\s*[-\u2010-\u2015]?\s*B\b/,
];

/** The acronym of an identity number: NI (the National Insurance number). */
const IDENTITY_NUMBER_ACRONYMS: readonly RegExp[] = [/\bNI\s*(?:[Nn][Uu][Mm][Bb][Ee][Rr][Ss]?\b|[Nn][Oo]\b|#)/];

/**
 * The short acronyms, the extension's SENSITIVE_ACRONYMS: matched in capitals only, case-sensitively, over the text as
 * written and its case-keeping fold (fold.ts, caseKeptText), each also with letters spaced out one by one closed up:
 * OPT, CPT, TN and H-1B (H1B) for work authorization, NI for the National Insurance number. In any case they would
 * catch "Opt in to SMS updates"; TN right after a comma is a state written after a city ("Nashville, TN").
 */
export const SENSITIVE_ACRONYMS: readonly RegExp[] = [...AUTHORIZATION_ACRONYMS, ...IDENTITY_NUMBER_ACRONYMS];

/** A sum of money ("$120,000", "120k", "USD 95000", "45 per hour"): never the value a tiebreak is about. */
const MONEY = new RegExp(
  [
    String.raw`[$€£¥₹]\s*\d`,
    String.raw`\b(?:usd|eur|gbp|cad|aud|inr|chf|jpy)\s*\d`,
    String.raw`\b\d[\d,.]*\s*(?:k|usd|eur|gbp|cad|aud|inr|chf|jpy)\b`,
    String.raw`\b\d[\d,.]*\s*(?:per|an?|\/)\s*(?:year|yr|month|mo|hour|hr|annum)\b`,
  ].join('|'),
  'i',
);

/** Long enough for any text an item may carry (the contract's caps are lower). */
const SCREEN_CAP = 10_000;

/** The text as sent (capped) and as a prompt quotes it. */
function readings(text: string): [string, string] {
  const capped = [...text].slice(0, SCREEN_CAP).join('');
  return [capped, untrustedText(capped, SCREEN_CAP)];
}

/** The texts the terms run over: every detection view of each reading, in lower case. */
function screenViews(text: string): string[] {
  return [...new Set(readings(text).flatMap(detectionViews))];
}

/** The texts the acronyms run over, case kept: each reading and its case-keeping fold, each also closed up. */
function acronymViews(text: string): string[] {
  const kept = readings(text).flatMap((reading) => [reading, caseKeptText(reading)]);
  return [...new Set([...kept, ...kept.map(closedUp)])];
}

/** True when a question's text (a label, hint or section) names a sensitive topic. */
export function isSensitiveQuestion(text: string): boolean {
  if (acronymViews(text).some((view) => SENSITIVE_ACRONYMS.some((acronym) => acronym.test(view)))) return true;
  return screenViews(text).some((view) => SENSITIVE_LABEL.test(view));
}

/** The server's criminal-history terms. */
const SERVER_CRIMINAL_TERMS: readonly string[] = [
  String.raw`\bcrimes?\b`,
  String.raw`\bcharged\s+with\b`,
  String.raw`\bpending\s+charges?\b`,
  String.raw`\bprobation\b`,
  String.raw`\bparole\b`,
  String.raw`\bincarcerat`,
  String.raw`\b(?:jail|prison)\b`,
  String.raw`\bsentenced\b`,
  String.raw`\bno\s+contest\b|\bnolo\b`,
];

/** The server's pay terms. */
const SERVER_PAY_TERMS: readonly string[] = [
  String.raw`\bincome\b`,
  String.raw`\bote\b`,
  String.raw`\b(?:expected|desired|target|minimum|asking)\s+(?:base|rates?|earnings)\b`,
  String.raw`\b(?:current|day|daily|contract|billing)\s+(?:rates?|earnings)\b`,
  String.raw`\b(?:current|expected|desired|target|minimum|asking)\s+(?:salary\s+)?package\b(?!\s+(?:manager|management|registry|version))`,
  String.raw`\bwhat\s+rate\b`,
];

/** The server's identity and tax number terms. */
const SERVER_IDENTITY_NUMBER_TERMS: readonly string[] = [
  String.raw`\bsocial\s+insurance\b`,
  String.raw`\btax\s+(?:file|identification|id|reference|registration|payer)\s*(?:numbers?|no\b|#)`,
];

/**
 * The server's own stricter terms (the Phase D review), for the routes whose Claude writes the answer itself (answer
 * and draft, where a guess would be the person's answer) and the tiebreak's label (a saved answer's value can be the
 * person's answer to it): matched as SENSITIVE_TERMS are, besides them. Not in the extension's lists or the shared
 * phrase fixture yet, so neither changes: criminal history in the words forms use without "criminal" (a crime,
 * charged with, pending charges, probation, parole, incarcerated, jail or prison, sentenced, no contest or nolo), pay
 * by other names (income, OTE, an expected or desired base, rate or earnings, a current or day rate, a current or
 * expected package but not a package manager, "what rate"), and the identity and tax numbers of other countries
 * (social insurance number, tax file or identification number).
 */
export const SERVER_SENSITIVE_TERMS: readonly string[] = [
  ...SERVER_CRIMINAL_TERMS,
  ...SERVER_PAY_TERMS,
  ...SERVER_IDENTITY_NUMBER_TERMS,
];

/** The server's own acronyms, in capitals only as SENSITIVE_ACRONYMS are: SIN (social insurance) and TFN (tax file). */
export const SERVER_SENSITIVE_ACRONYMS: readonly RegExp[] = [/\bSIN\b/, /\bTFN\b/];

const SERVER_SENSITIVE_LABEL = new RegExp(SERVER_SENSITIVE_TERMS.join('|'), 'i');

/**
 * True when a question's text names a sensitive topic by the shared terms or by the server's own stricter ones: the
 * screen of the routes whose Claude writes the answer (answer.ts, draft.ts) and of the tiebreak's label (pick.ts).
 */
export function namesSensitiveTopic(text: string): boolean {
  if (isSensitiveQuestion(text)) return true;
  if (acronymViews(text).some((view) => SERVER_SENSITIVE_ACRONYMS.some((acronym) => acronym.test(view)))) return true;
  return screenViews(text).some((view) => SERVER_SENSITIVE_LABEL.test(view));
}

/** The server's terms by the topic each names. */
const SERVER_TERMS_BY_TOPIC: Readonly<Partial<Record<SensitiveTopic, readonly string[]>>> = {
  criminal: SERVER_CRIMINAL_TERMS,
  pay: SERVER_PAY_TERMS,
  identity_number: SERVER_IDENTITY_NUMBER_TERMS,
};

/** The acronyms, the shared and the server's, by the topic each names. */
const ACRONYMS_BY_TOPIC: Readonly<Partial<Record<SensitiveTopic, readonly RegExp[]>>> = {
  authorization: AUTHORIZATION_ACRONYMS,
  identity_number: [...IDENTITY_NUMBER_ACRONYMS, ...SERVER_SENSITIVE_ACRONYMS],
};

/** Each topic's screen: its terms, the shared and the server's, in one pattern, and its acronyms. */
const TOPIC_SCREENS = SENSITIVE_TOPICS.map((topic) => ({
  topic,
  terms: new RegExp([...SHARED_TERMS_BY_TOPIC[topic], ...(SERVER_TERMS_BY_TOPIC[topic] ?? [])].join('|'), 'i'),
  acronyms: ACRONYMS_BY_TOPIC[topic] ?? [],
}));

/**
 * The topics a question's text names (SENSITIVE_TOPICS), by the shared terms and the server's stricter ones read as
 * namesSensitiveTopic reads them, so it is empty exactly when namesSensitiveTopic is false: "Will you now or in the
 * future require sponsorship?" names authorization, "Expected salary and start date?" pay, "Gender" and "Do you consent
 * to a background check?" the topics never asked.
 */
export function sensitiveTopicsOf(text: string): Set<SensitiveTopic> {
  const views = screenViews(text);
  const kept = acronymViews(text);
  const topics = new Set<SensitiveTopic>();
  for (const { topic, terms, acronyms } of TOPIC_SCREENS) {
    const named = views.some((view) => terms.test(view)) || kept.some((view) => acronyms.some((a) => a.test(view)));
    if (named) topics.add(topic);
  }
  return topics;
}

/**
 * Questions that ask for one of the person's own details: their name, an email address, a phone number, a postal
 * address, their date or year of birth. The facts Claude reads hold none of them (draft-facts.ts), so any answer it
 * gave would be made up; the answer route never asks it, in either scope (the extension fills these from the profile).
 * An age question ("Are you 18 or older?") is not one of them: the `all` scope may ask it.
 */
const PERSONAL_DETAIL = new RegExp(
  [
    String.raw`\b(?:date|year)\s+of\s+birth\b|\bbirth\s*(?:date|day|year)s?\b|\bd\.?\s*o\.?\s*b\b`,
    String.raw`\b(?:full|legal|first|last|given|family|middle|preferred|maiden|birth)\s+names?\b`,
    String.raw`\bsurnames?\b`,
    String.raw`\b(?:your|my)\s+(?:full\s+)?names?\b`,
    String.raw`^\W*(?:names?|e\W?mail|phone|mobile|telephone|address)\W*$`,
    String.raw`\be\W?mail\s+address(?:es)?\b`,
    String.raw`\b(?:your|my)\s+e\W?mail\b`,
    String.raw`\b(?:phone|mobile|cell|telephone|contact)\s*(?:numbers?|no\b|#)`,
    String.raw`\b(?:home|street|mailing|postal|residential|current|permanent)\s+address(?:es)?\b`,
    String.raw`\b(?:your|my)\s+address\b`,
    String.raw`\baddress\s+line\b`,
    String.raw`\b(?:zip|postal)\s*codes?\b|\bpost\s*codes?\b`,
  ].join('|'),
  'i',
);

/** True when a question asks for the person's name, an email address, a phone number or a postal address. */
export function asksPersonalDetail(text: string): boolean {
  return screenViews(text).some((view) => PERSONAL_DETAIL.test(view));
}

/**
 * Questions about someone other than the person (the owner's decision of 2026-11-01, as the extension's
 * namesAnotherPerson reads a field): a referee or a reference (a job's own reference number aside), an emergency
 * contact, next of kin, and another person's details (a manager's, a spouse's, the name of whoever referred them).
 * The facts hold nothing about them, so an answer would be made up: never asked, in any scope.
 */
const ANOTHER_PERSON = new RegExp(
  [
    String.raw`\breferees?\b`,
    String.raw`(?<!\b(?:job|requisition|posting|vacancy|role|position)\s)\breferences?\b(?!\s+(?:number|no|num|code|id|letters?)\b)`,
    String.raw`\bemergency\s+contacts?\b`,
    String.raw`\bnext\s+of\s+kin\b`,
    String.raw`\b(?:manager|supervisor|spouse|partner|parent|guardian|referr?er|recruiter|relative)(?:'|’)?s\s+(?:full\s+|first\s+|last\s+)?(?:names?|e\W?mail|phone|numbers?|contact|title|details?)\b`,
    String.raw`\b(?:manager|supervisor|referr?er|referral|recruiter)\s+(?:names?|e\W?mail|phone|contact)\b`,
    String.raw`\b(?:names?|e\W?mail|phone(?:\s+number)?|contact(?:\s+details)?|title)\s+of\s+(?:your|the|a)\s+(?:current\s+|previous\s+|former\s+|last\s+)?(?:manager|supervisor|referr?er|referee|reference|recruiter|spouse|partner|guardian|relative|employee|person)\b`,
    String.raw`\bwho\s+referred\s+you\b`,
  ].join('|'),
  'i',
);

/** True when a question asks about someone other than the person (ANOTHER_PERSON). */
export function asksAboutAnotherPerson(text: string): boolean {
  return screenViews(text).some((view) => ANOTHER_PERSON.test(view));
}

/** Words for AI, as an attestation names it. */
const AI_WORDS = String.raw`(?:ai|artificial\s+intelligence|gen(?:erative)?\s*ai|chat\s?gpt|gpt(?:\s?\d)?|llms?|large\s+language\s+models?)`;
/** What an attestation says AI did or did not write: the application or a part of it. */
const APPLICATION_PARTS = String.raw`(?:application|answers?|responses?|submission|essays?|cover\s+letter|resume|cv|statements?)`;

/**
 * An "I did not use AI" attestation (the owner's decision of 2026-11-01), as a statement ("I did not use AI to write
 * my answers", "not written by AI", "completed without the use of AI") or as a question about the application ("Did
 * you use AI to complete this application?"): its answer would be the person's word on how it was written, which an
 * AI answering it could not give truthfully. Never asked, in any scope. A question about AI work ("Have you used
 * generative AI tools in your work?") is none.
 */
const AI_ATTESTATION = new RegExp(
  [
    String.raw`\b(?:did\s+not|didn't|have\s+not|haven't|has\s+not|hasn't|was\s+not|wasn't|were\s+not|weren't|never)\s+(?:been\s+)?(?:use[ds]?|using|written|generated|created|produced|drafted|prepared|assisted|helped)\b(?:\W+\w+){0,3}?\W+${AI_WORDS}\b`,
    String.raw`\bnot\s+(?:been\s+)?(?:written|generated|created|produced|drafted|prepared|completed|assisted)\s+(?:\w+\s+){0,2}?(?:by|with|using|through)\s+(?:an?\s+|any\s+)?${AI_WORDS}\b`,
    String.raw`\bwithout\s+(?:the\s+)?(?:(?:use|help|aid|assistance)\s+of\s+|using\s+)?(?:any\s+)?${AI_WORDS}\b`,
    String.raw`\bno\s+${AI_WORDS}\s+(?:tools?\s+)?(?:was|were|has\s+been|have\s+been)\s+(?:used|involved)\b`,
    String.raw`\b(?:did|have|has)\s+(?:you|anyone)\s+(?:use[ds]?|rel(?:y|ied)\s+on|get|got)\b(?:\W+\w+){0,4}?\W+${AI_WORDS}\b(?:\W+\w+){0,6}?\W+(?:this|your|these|the)\s+${APPLICATION_PARTS}\b`,
    String.raw`\b(?:was|were|is|are)\s+(?:any\s+(?:part\s+)?of\s+)?(?:this|your|these|the)\s+${APPLICATION_PARTS}\b(?:\W+\w+){0,3}?\W+(?:written|generated|created|produced|drafted|prepared|assisted|completed)\s+(?:\w+\s+){0,2}?(?:by|with|using)\s+(?:an?\s+|any\s+)?${AI_WORDS}\b`,
  ].join('|'),
  'i',
);

/** True when a text is, or asks for, an "I did not use AI" attestation (AI_ATTESTATION). */
export function isAiAttestation(text: string): boolean {
  return screenViews(text).some((view) => AI_ATTESTATION.test(view));
}

/**
 * The extension's nine attention-check patterns (src/core/guard/attention.ts there, docs/design/core.md §7.9),
 * exactly: a question that tests whether the reader is paying attention ("Attention check: select PURPLE", "To prove
 * you read this, choose 'Strongly disagree'", "What is 4 + 3?") has no answer in any profile. The extension leaves such
 * a field blank and flagged; TailorIT drafts no answer to one and saves none. Matched over every detection view.
 */
export const ATTENTION_PATTERNS = [
  { id: 'select-to-prove', re: /\b(?:please\s+)?(?:select|choose|pick|click|check|tick|mark)\s+(?!all\s+(?:that|which)\s+appl(?:y|ies)\b)(?:the\s+)?(?:option|answer|box|response|colou?r|word|number)?\s*["'“‘`]?[\w -]{1,30}?["'”’`]?\s+(?:to\s+(?:show|prove|confirm|indicate|demonstrate)\s+(?:that\s+)?you\s+(?:are\s+(?:reading\s+this|paying\s+attention|(?:a\s+)?(?:real\s+)?(?:human|person))|were\s+paying\s+attention|(?:have\s+)?(?:carefully\s+)?read\s+(?:this|the\s+(?:whole|entire|full|posting|job\s+description|description|instructions|question))\b)|if\s+you\s+(?:are\s+)?(?:reading|human|paying\s+attention)\b(?!\s+(?:the\s+|our\s+)?(?:privacy|terms|polic(?:y|ies)|notice|agreement))|if\s+you\s+(?:have\s+)?read\b(?!,?\s+(?:and|or)\s+(?:\w+\s+)?(?:agree|accept|understood|understand|acknowledge|consent)\w*\b|\s+(?:and\s+(?:understood|understand|agree\w*|accept\w*)\s+)?(?:the\s+|our\s+|this\s+|these\s+|all\s+|its\s+)?(?:privacy|terms|polic(?:y|ies)|notice|agreement|statement|disclosures?|conditions|above|following|foregoing)\b))/i },
  { id: 'type-to-prove', re: /\b(?:type|write|enter|input)\s+(?:the\s+(?:word|phrase|number)\s+)?["'“‘`][^"'”’`]{1,40}["'”’`][^.?!]{0,60}\bto\s+(?:show|prove|confirm|demonstrate|verify)\b/i },
  { id: 'prove-reading', re: /\bto\s+(?:prove|show|confirm|demonstrate|verify)\s+(?:that\s+)?you\s+(?:have\s+)?(?:(?:carefully\s+)?read\b(?!,?\s+(?:and|or)\s+(?:\w+\s+)?(?:agree|accept|understood|understand|acknowledge|consent)\w*\b|\s+(?:and\s+(?:understood|understand|agree\w*|accept\w*)\s+)?(?:the\s+|our\s+|this\s+|these\s+|all\s+|its\s+)?(?:privacy|terms|polic(?:y|ies)|notice|agreement|statement|disclosures?|conditions|above|following|foregoing)\b)|are\s+(?:reading|paying\s+attention|(?:a\s+)?(?:real\s+)?(?:human|person)))\b/i },
  { id: 'attention-check', re: /\battention[-\s]check\b/i },
  { id: 'if-reading', re: /\bif\s+you\s+(?:are\s+)?(?:reading|have\s+read)\s+(?:this|the\s+(?:full\s+)?(?:description|posting|instructions))\b/i },
  { id: 'select-labelled', re: /\b(?:select|choose|pick)\s+(?:the\s+)?(?:option|answer)\s+(?:labell?ed|marked|that\s+says|named)\b/i },
  { id: 'answer-literal', re: /\b(?:answer|respond|reply)\s+(?:with\s+)?["'“‘`][^"'”’`]{1,40}["'”’`]\s+(?:to|for)\s+(?:this|the)\s+question\b/i },
  { id: 'human-check', re: /\bare\s+you\s+(?:a\s+)?(?:human(?!\s+resources?\b)|robot|bot)\b/i },
  { id: 'arithmetic', re: /\bwhat\s+is\s+\d+\s*(?:\+|plus|x|times|-|minus)\s*\d+\b/i },
] as const;

/** True when a question's text looks like an attention check (any of the nine patterns, in any detection view). */
export function isAttentionCheck(text: string): boolean {
  if (text.trim() === '') return false;
  const views = screenViews(text);
  return ATTENTION_PATTERNS.some(({ re }) => views.some((view) => re.test(view)));
}

/** True when a text is a sum of money. */
export function isSumOfMoney(text: string): boolean {
  return screenViews(text).some((view) => MONEY.test(view));
}

/**
 * A figure of 10,000 or more, with or without separators ("150,000", "150 000", "150000", "50,000-80,000"; not "2019"
 * or "3.850", which the loose view reads "3 850").
 */
const LARGE_FIGURE = /\b\d{2,3}(?:[,'\s]\d{3})+\b|\b\d(?:[,'\s]\d{3}){2,}\b|\b\d{5,}\b/;
/** The most words a text has for a large figure in it to count as a sum: an answer, not a story of figures. */
const FIGURE_TEXT_WORDS = 8;

/**
 * True when a short text (at most eight words: a form's answer, an option) holds a figure of 10,000 or more, which
 * there is most likely a sum of money written without its currency ("150,000", "150000"). A longer text's figures are
 * the person's numbers ("served 150,000 users a day"), left to the other checks.
 */
export function isBareSum(text: string): boolean {
  if (text.trim().split(/\s+/).length > FIGURE_TEXT_WORDS) return false;
  return screenViews(text).some((view) => LARGE_FIGURE.test(view));
}

/** True when a value from the profile (a pick's intended value or an alias) is sensitive: a topic or a sum of money. */
export function isSensitiveValue(text: string): boolean {
  return isSensitiveQuestion(text) || isSumOfMoney(text);
}

/**
 * The pick categories whose values are names (a school, a degree, a major). An ordinary one's name can hold a topic
 * word ("United States Military Academy", "Gender Studies", "Religious Studies"), so a topic word says nothing about
 * it: such a value is screened here as a sum of money only, and in the router by equality with the person's
 * sensitive answers (profile/sensitive-screen.ts). The field's label is still screened by the terms.
 */
const NAME_CATEGORIES: ReadonlySet<AutofillPickCategory> = new Set(['school', 'degree', 'field_of_study']);

/** True when a pick's intended value or alias is sensitive for its category (see NAME_CATEGORIES). */
export function isSensitivePickValue(category: AutofillPickCategory, text: string): boolean {
  return NAME_CATEGORIES.has(category) ? isSumOfMoney(text) : isSensitiveValue(text);
}
