// Messages with {placeholders} (02-constants.md, "Messages"). The server fills them before it answers; the web fills
// the ones it shows before any request (the confirm, the usage line, the filter labels) with the same function.
//
// v30 INT-0: a count's words follow the count. `{name|singular|plural}` is the singular words when {name} is 1 and the
// plural words otherwise: "Wait {seconds} more {seconds|second|seconds}" reads "Wait 1 more second" and "Wait 30 more
// seconds"; "{left_out} {left_out|file was|files were} not added". One rule for every message, so no message says
// "1 seconds" or "1 minutes", and an admin's override may use it too (its name must be one of the constant's own).

const PLACEHOLDER = /\{([a-z][a-z0-9_]*)(?:\|([^{}|]*)\|([^{}|]*))?\}/g;

/**
 * The placeholder names in `template`, each once, in order: "Resets at {reset_time}" → ["reset_time"]. A count's words
 * name their count: "{seconds} {seconds|second|seconds}" → ["seconds"].
 */
export function placeholdersOf(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export type MessageParams = Readonly<Record<string, string | number | null | undefined>>;

/** True when a count is one (1 or "1"): its words are the singular ones. */
const isOne = (value: string | number | null | undefined) => value === 1 || value === '1';

/**
 * Fills each {name} of `template` from `params`, and each {name|singular|plural} with the words for {name}'s count
 * (the plural words when it is not 1, or has no value). A param the template does not name is ignored. A placeholder
 * with no value (missing, null or '') renders as nothing, and the words around it are tidied: a pair of brackets left
 * empty goes, runs of spaces become one, and no space is left before punctuation or at either end of a line. So the
 * filter label "location ({value})" without a value reads "location". Text with every value given is never tidied.
 */
export function renderMessage(template: string, params: MessageParams = {}): string {
  let missing = false;
  const filled = template.replace(PLACEHOLDER, (_whole, name: string, singular?: string, plural?: string) => {
    const value = Object.hasOwn(params, name) ? params[name] : undefined;
    if (singular !== undefined) return isOne(value) ? singular : plural!;
    if (value === undefined || value === null || value === '') {
      missing = true;
      return '';
    }
    return String(value);
  });
  return missing ? tidy(filled) : filled;
}

function tidy(text: string): string {
  return text
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?)])/g, '$1')
    .replace(/\([ \t]+/g, '(')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}
