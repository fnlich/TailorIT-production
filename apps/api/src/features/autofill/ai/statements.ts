import { isEeoText } from '../answers/vocabulary';
import { detectionViews } from './fold';
import { isBareSum, isSensitiveQuestion, isSumOfMoney, type SensitiveTopic } from './screen';

// A statement of a sensitive answer (work package AF, Phase 6; the Phase 6 review, T6-2): a nationality or
// citizenship, a residence status, a visa held or sponsorship needed, the right to work, pronouns, a gender, an
// orientation, a race or a religion stated as the person's own, a birth date or an age, a salary, a marital or family
// status, veteran or disability status, a criminal record or an identity number. The facts a draft is written from
// leave out every line that states one (draft-facts.ts), and a draft that states one is discarded, reason `sensitive`
// (draft.ts): those answers come only from the autofill profile's sensitive part, which no draft reads. Matched over
// every detection view (fold.ts), so a look-alike letter or an invisible character cannot hide one.
//
// Unlike the question screen (screen.ts), which holds back a question that so much as names a topic, this reads a
// statement: ordinary facts that share a word stay ("payments on Visa", "Citizens Bank", "tools for people with
// disabilities", "the national sales team", "equity research"). Each statement names a topic (screen.ts's
// SensitiveTopic: statedTopicsOf), so an answer of the answer route's `all` scope may state its own question's answer
// (the owner's decision of 2026-11-01: textIsSensitive's `open`).

/** Nationalities, as a statement of citizenship names one ("Indian national", "US citizen"). */
const DEMONYMS = String.raw`(?:u\.?\s?s\.?|us|usa|american|canadian|british|uk|eu|european|indian|australian|chinese|german|french|irish|mexican|brazilian|nigerian|pakistani|bangladeshi|filipino|singaporean|malaysian|japanese|korean|vietnamese|italian|spanish|portuguese|dutch|belgian|swiss|swedish|norwegian|danish|finnish|polish|ukrainian|russian|turkish|israeli|egyptian|kenyan|ghanaian|south\s+african|new\s+zealand|nz|argentin(?:e|ian)|colombian|chilean|peruvian|venezuelan|iranian|iraqi|syrian|lebanese|saudi|emirati|sri\s+lankan|nepali|indonesian|thai|taiwanese|hong\s+kong|scottish|welsh|english|austrian|czech|greek|hungarian|romanian)`;

/** Who the person says they are, after "I am a" or "as a": a gender, an orientation, a faith, an origin. A family
 *  role is a statement only with its children ("a mother of two"), so "a father figure" stays. */
const IDENTITIES = String.raw`(?:wom[ae]n|m[ae]n|female|male|girl|lady|non[\s-]?binary|trans(?:gender)?|queer|gay|lesbian|bisexual|immigrant|refugee|muslim|hindu|christian|jew|jewish|sikh|buddhist|catholic|atheist|minority|person\s+of\s+colou?r)`;

/** The same, said without an article ("I am Hindu", "I'm married"). */
const BARE_IDENTITIES = String.raw`(?:muslim|hindu|christian|jewish|sikh|buddhist|catholic|atheist|agnostic|gay|lesbian|bisexual|queer|trans(?:gender)?|non[\s-]?binary|disabled|deaf|blind|autistic|black|white|asian|latin[aoex]|hispanic|indigenous|married|divorced|single|widowed|pregnant)`;

/** The visa types a statement names ("an H-1B visa", "a Skilled Worker visa"). */
const VISA_TYPES = String.raw`(?:h[\s-]?1[\s-]?b|h[\s-]?4|f[\s-]?1|j[\s-]?1|l[\s-]?1|o[\s-]?1|e[\s-]?3|tn|opt|cpt|stem\s+opt|student|work|tourist|skilled\s+worker|tier\s+[25]|graduate|working\s+holiday|employment|dependa[nt]t|spouse|partner|blue\s+card|investor|talent)`;

/** Citizenship, residence, a visa, sponsorship and the right to work. */
const AUTHORIZATION_STATEMENTS: readonly string[] = [
  // Citizenship, nationality and residence.
  String.raw`\b${DEMONYMS}\s+(?:citizen(?:ship)?|national(?:ity)?|passport(?:\s+holder)?|resident)s?\b`,
  String.raw`\b(?:i\s+am|i'm|as|being)\s+an?\s+(?:[\p{L}-]+\s+){1,2}(?:citizen|national|resident|passport\s+holder)\b`,
  String.raw`\bcitizen(?:ship)?\s*(?:of|status|:)`,
  String.raw`\bcitizenship\b`,
  String.raw`\bnationalit(?:y|ies)\b`,
  String.raw`\bdual\s+(?:citizen|national)`,
  String.raw`\bpermanent\s+resid`,
  String.raw`\bgreen\s+card\b`,
  String.raw`\b(?:work|residence|residency)\s+permits?\b`,
  String.raw`\b(?:pre[\s-]?)?settled\s+status\b`,
  String.raw`\bleave\s+to\s+remain\b`,
  // A visa held, sponsorship needed, the right to work.
  String.raw`\bh[\s-]?1[\s-]?b\b`,
  String.raw`\b${VISA_TYPES}\s+visas?\b`,
  String.raw`\bvisas?\s*(?::|status|holder|sponsorship|required|needed|transfer|type|expir|valid)`,
  String.raw`\b(?:on|hold|holding|have|has|with)\s+an?\s+(?:[\w-]+\s+)?visa\b(?!\s+(?:card|network|integration|payments?|api|direct|checkout|platform|partnership|account))`,
  String.raw`\b(?:on|holding|hold|have|with)\s+(?:an?\s+)?(?:stem\s+)?(?:opt|cpt|tn|ead)\b(?!\s*-?\s*(?:in|out|ins|outs)\b)`,
  String.raw`\b(?:opt|cpt)\s+(?:status|ead|extension|work\s+authori[sz]ation)\b`,
  String.raw`\b(?:visa|immigration|work|employment|employer|h[\s-]?1[\s-]?b)\s+sponsor(?:ship|ed)?\b`,
  String.raw`\bsponsorship\s*:`,
  String.raw`\b(?:require|requires|required|requiring|need|needs|needed|needing|without|no|seek|seeking)\s+(?:any\s+|future\s+|further\s+)?(?:visa\s+|immigration\s+|employer\s+|work\s+|h[\s-]?1[\s-]?b\s+)?sponsor(?:ship)?\b`,
  String.raw`\bsponsorship\s+(?:is\s+)?(?:not\s+)?(?:required|needed)\b`,
  String.raw`\b(?:authori[sz]ed|eligible|legally\s+(?:able|allowed|permitted|entitled)|permitted|entitled|allowed|cleared)\s+to\s+(?:work|be\s+employed)\b`,
  String.raw`\b(?:work|employment)\s+(?:authori[sz]ation|permit|rights|eligibility)\b`,
  String.raw`\bright\s+to\s+work\b`,
];

/** Who the person is: pronouns, a gender, an orientation, a race, an ethnicity, a religion, a marital or family
 *  status, veteran or disability status. */
const SELF_IDENTIFICATION_STATEMENTS: readonly string[] = [
  // Pronouns, a gender, an orientation, a race or a religion, stated.
  String.raw`\bpronouns?\b`,
  String.raw`\b(?:she|he|they|ze|xe)\s*\/\s*(?:her|him|them|hir|zir|xem|hers|his|theirs)\b`,
  String.raw`\b(?:gender(?:\s+identity)?|sex|sexual\s+orientation|orientation|race|ethnicity|ethnic\s+origin|religion|faith|caste)\s*:`,
  String.raw`\b(?:i\s+am|i'm|i\s+identify\s+as|as|being)\s+an?\s+(?:[\p{L}-]+\s+){0,2}${IDENTITIES}\b`,
  String.raw`\b(?:i\s+am|i'm|i\s+identify\s+as)\s+(?:(?:a\s+)?(?:practicing|practising|devout|proud|openly|happily)\s+)?${BARE_IDENTITIES}\b`,
  // An ethnicity or races answer as a whole ("Hispanic or Latino", "Not Hispanic or Latino", "Two or more races").
  String.raw`^\W*(?:(?:yes|no)\W+)?(?:(?:i\s+am|i'm)\s+)?(?:not\s+)?(?:hispanic|latin[aoxe])(?:\W+(?:or|and)?\W*(?:hispanic|latin[aoxe]))?\W*$`,
  String.raw`^\W*two\s+or\s+more\s+races\W*$`,
  // A marital or family status.
  String.raw`\bmarital\b`,
  String.raw`\b(?:married|divorced|widow(?:ed|er)?|spouse|husband|wife)\b`,
  String.raw`\b(?:children|dependants|dependents|kids)\s*:`,
  String.raw`\b(?:mother|father|parent)\s+of\s+(?:\d+|one|two|three|four|five|twins)\b`,
  String.raw`\b(?:mother|father|parent|carer|caregiver)\s+(?:of|to)\s+(?:[\p{L}-]+\s+){0,2}(?:children|child|kids|dependants|dependents)\b`,
  String.raw`\bnumber\s+of\s+children\b`,
  String.raw`\b(?:i\s+am|i'm|currently)\s+pregnant\b`,
  // Veteran and disability status.
  String.raw`\b(?:protected|military|army|navy|naval|marine|marines|air\s+force|disabled|u\.?\s?s\.?|us|combat|war)\s+veterans?\b`,
  String.raw`\bveterans?\s*(?:status|:|of\s+(?:the\s+)?(?:u\.?\s?s\.?|us|british|army|navy|marines?|air\s+force|armed\s+forces|military|iraq|afghanistan|gulf))`,
  String.raw`\b(?:disability|disabilities)\s*(?:status|:)`,
  String.raw`\b(?:i\s+(?:am|have|live\s+with)|i'm|as\s+an?|living\s+with)\s+(?:an?\s+)?(?:person\s+with\s+(?:an?\s+)?)?(?:disab\w*|deaf|blind|autistic|dyslexic|neuro\s?divergent|wheelchair\s+user|chronic(?:ally)?\s+ill|chronic\s+(?:illness|condition|pain)|adhd|autism|dyslexia|(?:physical|mental|learning)\s+(?:disability|impairment|condition|health\s+condition))\b`,
  String.raw`\b(?:i\s+have|i've\s+(?:got|had)|living\s+with|my)\s+(?:an?\s+)?(?:[\p{L}-]+\s+)?(?:health|medical)\s+conditions?\b`,
];

/** A birth date or an age. */
const AGE_STATEMENTS: readonly string[] = [
  String.raw`\bdate\s+of\s+birth\b`,
  String.raw`\bd\.?\s?o\.?\s?b\b`,
  String.raw`\bborn\b`,
  String.raw`\bbirth\s*(?:date|day|year|place)\b`,
  String.raw`\b(?:years?|place)\s+of\s+birth\b`,
  String.raw`\bage[ds]?\s*:?\s*\d`,
  String.raw`\b\d{1,3}\s*(?:years|yrs)\s+old\b`,
  // An age said as a number alone ("I am 34.", "I'm 34 years of age"; not "I am 100% remote" or "I am 2 hours away").
  String.raw`\b(?:i\s+am|i'm)\s+\d{1,3}(?:\s*(?:years?|yrs?)(?:\s+of\s+age)?)?(?=\s*(?:[.!;,]|$))`,
];

/** A salary. */
const PAY_STATEMENTS: readonly string[] = [
  String.raw`\b(?:current|expected|desired|target|present|last|previous|minimum|asking)\s+(?:annual\s+|base\s+)?(?:salary|compensation|pay|ctc|package|rate|wage|remuneration|total\s+compensation)\b`,
  String.raw`\bbase\s+(?:salary|pay|compensation)\b`,
  String.raw`\b(?:salary|compensation|ctc|pay|remuneration)\s*(?:expectations?|requirements?|range|:)`,
  String.raw`\b(?:earn|earned|earning|make|made|making)\s+(?:about\s+|around\s+|over\s+)?(?:[$€£¥₹]|usd|eur|gbp|inr|cad|aud)\s*\d`,
];

/** A criminal record. */
const CRIMINAL_STATEMENTS: readonly string[] = [
  String.raw`\bcriminal\s+(?:record|history|conviction|background)s?\b`,
  String.raw`\b(?:convicted|felony|felon|misdemeanou?r)\b`,
];

/** An identity number. */
const IDENTITY_NUMBER_STATEMENTS: readonly string[] = [
  String.raw`\b(?:social\s+security|national\s+insurance)\s*(?:numbers?|no\b|#|:)`,
  String.raw`\b(?:ssn|ni\s+number|aadhaa?r|pan\s+card)\b`,
  String.raw`\bpassport\s*(?:numbers?|no\b|#)`,
];

/** Each topic's statements (screen.ts's SensitiveTopic; consent has none). */
const STATEMENTS_BY_TOPIC: Readonly<Partial<Record<SensitiveTopic, readonly string[]>>> = {
  authorization: AUTHORIZATION_STATEMENTS,
  self_identification: SELF_IDENTIFICATION_STATEMENTS,
  age: AGE_STATEMENTS,
  pay: PAY_STATEMENTS,
  criminal: CRIMINAL_STATEMENTS,
  identity_number: IDENTITY_NUMBER_STATEMENTS,
};

const SENSITIVE_STATEMENT = new RegExp(Object.values(STATEMENTS_BY_TOPIC).flat().join('|'), 'iu');

/** Each topic's statements in one pattern. */
const STATEMENT_SCREENS = Object.entries(STATEMENTS_BY_TOPIC).map(([topic, patterns]) => ({
  topic: topic as SensitiveTopic,
  pattern: new RegExp(patterns.join('|'), 'iu'),
}));

/** True when a text states a sensitive answer, in any of its detection views. */
export function statesSensitiveAnswer(text: string): boolean {
  return detectionViews(text).some((view) => SENSITIVE_STATEMENT.test(view));
}

/**
 * The topics of the sensitive answers a text states ("Yes, I am a US citizen": authorization; "I am married":
 * self-identification), empty exactly when statesSensitiveAnswer is false.
 */
export function statedTopicsOf(text: string): Set<SensitiveTopic> {
  const views = detectionViews(text);
  const stated = STATEMENT_SCREENS.filter(({ pattern }) => views.some((view) => pattern.test(view)));
  return new Set(stated.map(({ topic }) => topic));
}

/**
 * A sum of money written with its currency ("$120,000", "USD 95000", "95000 EUR"), over every detection view, so a
 * look-alike letter cannot hide one.
 */
const CURRENCY_AMOUNT =
  /[$€£¥₹]\s*\d|\b(?:usd|eur|gbp|cad|aud|inr|chf|jpy)\s*\d|\b\d[\d,.]*\s*(?:usd|eur|gbp|cad|aud|inr|chf|jpy)\b/i;

/**
 * True when a text is or holds a sum of money: with its currency, as "150k", "120K base" or "85 per hour" (screen.ts's
 * isSumOfMoney), with its currency sign or code (CURRENCY_AMOUNT), or, in a short text, a bare figure of 10,000 or more
 * ("150,000", "150000": isBareSum).
 */
export function holdsSumOfMoney(text: string): boolean {
  if (isSumOfMoney(text) || isBareSum(text)) return true;
  return [text, ...detectionViews(text)].some((view) => CURRENCY_AMOUNT.test(view));
}

/**
 * True when a text is, or holds, a sensitive answer: a statement of one (above), an EEO answer as a whole ("Female":
 * answers/vocabulary.ts), or a sum of money: with its currency, as "150k", "120K base" or "85 per hour" (screen.ts's
 * isSumOfMoney), or, in a short text, a bare figure of 10,000 or more ("150,000", "150000": isBareSum). Read for what
 * Claude would write as the person's answer (an answer's text, a chosen option: answer.ts) and for a field's current
 * answer before it is sent to be rewritten (draft.ts): the pay, legal and self-identification answers are the
 * sensitive part's, which never reaches Claude.
 *
 * `open` relaxes it for an answer of the answer route's `all` scope (the owner's decision of 2026-11-01) to a question
 * of those topics: a statement of an open topic's answer stays ("Yes, I am a US citizen" to a work authorization
 * question), and with `pay` open, so does a sum of money ("$150,000" to a salary question). An EEO answer, and a
 * statement of a topic not open, never does.
 */
export function textIsSensitive(text: string, open: ReadonlySet<SensitiveTopic> = new Set()): boolean {
  if (text.trim() === '') return false;
  if (isEeoText(text)) return true;
  if ([...statedTopicsOf(text)].some((topic) => !open.has(topic))) return true;
  return !open.has('pay') && holdsSumOfMoney(text);
}

/** A label before a colon, of at most six words ("Nationality", "Current salary", "Right to work in the UK"). */
const LABEL = /^[\s\-*+>]*([^:\n]{1,60}):/u;

/**
 * True when a line reads "label: value" and its label names a sensitive topic (the question screen's terms:
 * "Nationality: ...", "Gender: ...", "Current salary: ..."). The drafts' facts leave such a line out, as they leave out a
 * line that statesSensitiveAnswer.
 */
export function hasSensitiveLabel(line: string): boolean {
  const label = LABEL.exec(line)?.[1]?.trim() ?? '';
  return label !== '' && label.split(/\s+/).length <= 6 && isSensitiveQuestion(label);
}
