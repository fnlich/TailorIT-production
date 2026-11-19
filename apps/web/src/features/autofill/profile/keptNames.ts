// v3.2 FILL: the names of the answers a fill kept though the resume says otherwise ("Name", "Phone", "Experience"), in
// the profile's order, each once: what the Import step's offer to use the resume's instead lists.

const NAMES: ReadonlyArray<readonly [prefix: string, name: string]> = [
  ['name', 'Name'],
  ['contact.email', 'Email'],
  ['contact.phone', 'Phone'],
  ['contact.address', 'Address'],
  ['links.linkedin', 'LinkedIn'],
  ['links.github', 'GitHub'],
  ['links.portfolio', 'Portfolio'],
  ['links', 'Links'],
  ['education', 'Education'],
  ['experience', 'Experience'],
  ['languages', 'Languages'],
  ['skills', 'Skills'],
  ['certifications', 'Certifications'],
];

/** The kept fields' names ("contact.phone.number" is "Phone"); a field of no named group is left out. */
export function keptNames(kept: readonly string[]): string[] {
  const names = new Set<string>();
  for (const field of kept) {
    const found = NAMES.find(([prefix]) => field === prefix || field.startsWith(`${prefix}.`));
    if (found) names.add(found[1]);
  }
  return NAMES.map(([, name]) => name).filter((name) => names.has(name));
}
