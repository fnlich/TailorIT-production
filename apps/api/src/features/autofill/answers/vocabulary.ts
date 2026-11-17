import { detectionViews } from '../ai/fold';

// The answers a saved answer may never be (work package AF, Phase 6 review, T6-1): an EEO question whose label names
// no topic ("How do you identify?" with Man, Woman and Non-binary; "Which best describes you?" with races) shows
// itself by its answers, and a legal question asked in other words ("Will you now or in the future require us to
// support your employment?") by the words around a yes or no. The extension's vocabulary (src/core/vocab/data/
// answers.json there) holds the same EEO answers; its screen reads every option a field shows, this one the answer
// alone. Veteran and disability statements name their topic ("protected veteran", "a disability", "military
// service"), so the topic terms (ai/screen.ts) catch them on the option labels; the ones here have no such word.
//
// Every pattern runs over the words of each detection view (fold.ts): lower case, look-alike letters read as Latin,
// punctuation read as one space ("Non-binary" reads "non binary", "I'm" reads "i m").

/** The words of each detection view of a text, punctuation read as one space. */
export function wordViews(text: string): string[] {
  const views = detectionViews(text).map((view) => view.replace(/[^\p{L}\p{N}]+/gu, ' ').trim());
  return [...new Set(views)].filter((view) => view !== '');
}

/** Declining to self-identify ("Prefer not to say", "I don't wish to answer", "Decline to state"): an answer to a
 *  self-identification, legal or pay question only. */
const DECLINE_PHRASES: readonly string[] = [
  String.raw`(?:prefer|choose|wish|want|would like|d like|rather) not to (?:say|answer|disclose|specify|respond|state|share|tell|provide|self identify|identify)`,
  String.raw`(?:do not|don t|dont) (?:wish|want) to (?:say|answer|disclose|specify|respond|state|share|provide|self identify|identify)`,
  String.raw`declined? to (?:answer|state|specify|disclose|respond|say|provide|self identify|identify)`,
];

/** EEO answers distinctive enough to mean one wherever they stand in an answer ("Black or African American"). */
const EEO_PHRASES: readonly string[] = [
  // Gender identities.
  String.raw`non ?binary`,
  String.raw`enby`,
  String.raw`gender ?(?:queer|fluid)`,
  String.raw`agender`,
  String.raw`bigender`,
  String.raw`two spirit(?:ed)?`,
  String.raw`intersex`,
  String.raw`cis ?gender`,
  String.raw`self describe[sd]?`,
  String.raw`(?:use|prefer) (?:another|a different) term`,
  // Races and ethnicities.
  String.raw`african americans?`,
  String.raw`pacific islanders?`,
  String.raw`native hawaiians?`,
  String.raw`alaskan? natives?`,
  String.raw`american indians?`,
  String.raw`native americans?`,
  String.raw`middle eastern`,
  String.raw`north african`,
  String.raw`multi ?racial`,
  String.raw`bi ?racial`,
  String.raw`(?:mixed|multiple) (?:races?|heritage|ethnicit(?:y|ies)|ethnic backgrounds?)`,
  String.raw`caucasian`,
  String.raw`metis`,
  String.raw`inuit`,
  String.raw`maori`,
  // Sexual orientations.
  String.raw`(?:hetero|homo|bi|pan|a)sexual`,
  String.raw`lesbians?`,
  // Disability without the word.
  String.raw`neuro ?(?:divergent|diverse)`,
  String.raw`wheelchair users?`,
  String.raw`hard of hearing`,
  String.raw`(?:visually|hearing) impaired`,
  String.raw`(?:physical|mental|sensory|learning|cognitive|visual|hearing) impairments?`,
  String.raw`(?:long (?:term|standing)|chronic) (?:health |medical )?(?:conditions?|illness(?:es)?)`,
  ...DECLINE_PHRASES,
];

/** EEO answers that mean one only as the whole answer ("White", "Woman"; not "White-box testing"). */
const EEO_WORDS: readonly string[] = [
  // Gender identities.
  String.raw`wom[ae]n`,
  String.raw`female`,
  String.raw`m[ae]n`,
  String.raw`male`,
  String.raw`(?:cis|trans) (?:wom[ae]n|m[ae]n|female|male)`,
  String.raw`trans`,
  String.raw`cis`,
  // Races and ethnicities.
  String.raw`asian(?: american| indian| british| canadian| australian)?`,
  String.raw`(?:east|south|south ?east|southeast|central|west) asian`,
  String.raw`black(?: african| british| caribbean| american| canadian)?`,
  String.raw`african`,
  String.raw`white(?: british| irish| european| american| canadian| australian| other)?`,
  String.raw`arab(?: american)?`,
  String.raw`mena`,
  // Sexual orientations.
  String.raw`gay`,
  String.raw`queer`,
  String.raw`straight`,
  // Disability without the word.
  String.raw`deaf`,
  String.raw`blind`,
  String.raw`autistic`,
  String.raw`dyslexic`,
  String.raw`decline(?:d)?`,
];

const EEO_PHRASE = new RegExp(String.raw`\b(?:${EEO_PHRASES.join('|')})\b`);
/** A whole answer: an optional "Yes, I am a", the answer, and pronouns after it ("Female (she/her)"). */
const EEO_WHOLE = new RegExp(
  String.raw`^(?:(?:yes|no) )?(?:(?:i am|i m|i identify as|identify as) )?(?:an? )?(?:${[...EEO_WORDS, ...EEO_PHRASES].join('|')})` +
    String.raw`(?: (?:she|he|they|ze|xe|her|him|them|hers|his|theirs|hir|zir|xem|pronouns?))*$`,
);

/** True when an option's label is an EEO answer, or holds one of the distinctive ones. */
export function isEeoOption(label: string): boolean {
  return wordViews(label).some((view) => EEO_WHOLE.test(view) || EEO_PHRASE.test(view));
}

/** True when a written answer is, as a whole, an EEO answer ("Female"); a sentence that holds one is the person's. */
export function isEeoText(text: string): boolean {
  return wordViews(text).some((view) => EEO_WHOLE.test(view));
}

/** A decline as the whole answer: "Prefer not to say", "I don't wish to answer this question", "Decline". */
const DECLINE_WHOLE = new RegExp(String.raw`^(?:i )?(?:(?:${DECLINE_PHRASES.join('|')})\b.*|declined?)$`);

/**
 * True when an option is a decline to answer or to self-identify, as a whole (DECLINE_WHOLE). The answer route's `all`
 * scope offers one to Claude beside a legal, criminal-history or pay question's other answers; isEeoOption reads it as
 * an EEO answer everywhere else.
 */
export function isDeclineOption(label: string): boolean {
  return wordViews(label).some((view) => DECLINE_WHOLE.test(view));
}

/** A question that asks how the person identifies or would describe themselves. */
const IDENTITY_QUESTION = /\b(?:identif(?:y|ies|ied|ication)|identity|describes? (?:you|yourself)|describe yourself)\b/;
/** The letters a self-identification answers with ("F", "M", "X"), which mean nothing elsewhere ("T-shirt size: M"). */
const IDENTITY_LETTER = /^[fmwx]$/;

/** True when an answer is a single letter EEO answer to a question asking how the person identifies. */
export function isIdentityLetter(question: readonly string[], answer: string): boolean {
  return (
    question.some((text) => wordViews(text).some((view) => IDENTITY_QUESTION.test(view))) &&
    wordViews(answer).some((view) => IDENTITY_LETTER.test(view))
  );
}

/** Countries and their words, as a question names the place the person would work. */
const PLACES = String.raw`(?:the )?(?:u s(?: a)?|us|usa|united states(?: of america)?|america|u k|uk|united kingdom|great britain|britain|england|scotland|wales|ireland|canada|australia|new zealand|india|singapore|germany|france|netherlands|spain|italy|switzerland|eu|e u|european union|eea|schengen area|this country|the country|that country|country|countries)`;

/**
 * The words of a legal question that names no topic: sponsorship and the right to work in other words, residence, and
 * age in words ("at least eighteen"). Any choice, or a yes or no, under such a question is a legal answer.
 */
const LEGAL_QUESTION = new RegExp(
  [
    String.raw`\b(?:require|need)s?\b(?: \w+){0,6}? (?:support|assist\w*|help|petition\w*|transfer\w*)\b(?: \w+){0,4}? (?:employment|work|stay|status|residen\w*|permission)\b`,
    String.raw`\bnow or in the future\b`,
    String.raw`\b(?:residen\w*|legal) status\b`,
    String.raw`\blawful(?:ly)?\b`,
    String.raw`\blegal(?:ly)? (?:right|permission|entitle\w*|resident|residence|to work)\b`,
    String.raw`\b(?:can|could|able|allowed|permitted|entitled|free|cleared)\b(?: \w+){0,3}? (?:work|be employed|take up employment|start work)\b(?: \w+){0,2}? (?:in|within) ${PLACES}\b`,
    String.raw`\bwork\w*\b(?: \w+){0,6}? without (?:any )?(?:restrictions?|limitations?|support|assistance|a permit)\b`,
    String.raw`\b(?:work|employment|s) pass(?:es)?\b`,
    String.raw`\bleave to remain\b`,
    String.raw`\b(?:pre )?settled status\b`,
    String.raw`\bpermanent resid\w*\b`,
    String.raw`\bresiden(?:ce|cy) (?:permit|status|card|visa)s?\b`,
    String.raw`\b(?:ead|i 9|e verify)\b`,
    // Age in words.
    String.raw`\b(?:at least|over|under|older than|younger than|above|below) (?:the age of )?(?:sixteen|seventeen|eighteen|nineteen|twenty one)\b`,
    String.raw`\b(?:sixteen|seventeen|eighteen|nineteen|twenty one) (?:(?:years?|yrs?) )?(?:of age|old|or (?:older|over|above))\b`,
    String.raw`\bare you (?:a minor|an adult)\b`,
  ].join('|'),
);

/** True when a question's words ask a legal question without naming the topic. */
export function asksLegalQuestion(question: readonly string[]): boolean {
  return question.some((text) => wordViews(text).some((view) => LEGAL_QUESTION.test(view)));
}

/**
 * The words of a self-identification question asked yes or no ("Do you identify as a woman?", "Are you a member of
 * an under-represented group?"): a yes or no under such a question is an EEO answer.
 */
const SELF_IDENTIFICATION_QUESTION = new RegExp(
  [
    String.raw`\bidentify (?:yourself )?as\b`,
    String.raw`\bminorit(?:y|ies)\b`,
    String.raw`\bunder ?represented\b`,
    String.raw`\b(?:person|persons|people|wom[ae]n|m[ae]n) of colou?r\b`,
    String.raw`\bbipoc\b`,
    String.raw`\breasonable (?:accommodations?|adjustments?)\b`,
    String.raw`\b(?:accommodations?|adjustments?) (?:during|for|in|to) (?:the |our |this |your |an? )?(?:interview|hiring|recruitment|application|assessment|selection)\w*\b`,
    String.raw`\bprotected (?:class|group|characteristic|status)\w*\b`,
    String.raw`\b(?:are you|i am|i m) (?:an? )?(?:${EEO_WORDS.join('|')})\b`,
    String.raw`\b(?:wom[ae]n|female|m[ae]n|male)\b`,
    String.raw`\b(?:${EEO_PHRASES.join('|')})\b`,
  ].join('|'),
);

/** True when a question's words ask a self-identification question to be answered yes or no. */
export function asksSelfIdentification(question: readonly string[]): boolean {
  return question.some((text) => wordViews(text).some((view) => SELF_IDENTIFICATION_QUESTION.test(view)));
}

/** A yes or a no, alone or as its sentence ("Yes", "No, I will not", "Not now", "I do", "I am not"). */
const YES_NO = /^(?:yes|no|y|n|true|false|yeah|yep|nope|not|never|none|i (?:am|m|do|did|will|would|can|could|have|ve|shall|need|require|don t|dont|cannot|can t|cant|won t|wont|haven t|havent))\b/;

/** True when an answer (an option's label, or a text) is a yes or a no. */
export function isYesNo(text: string): boolean {
  return wordViews(text).some((view) => YES_NO.test(view));
}
