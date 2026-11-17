import { countKeyword, toKeywordMatchForm } from '../ats';
import { namesIn, repeatsHeading, skillsShown } from './names';
import {
  classifyReferenceSkill,
  isSkillLibrary,
  loadSkillsReference,
  referenceAliases,
  referenceCategory,
  referenceOrder,
  type SkillGroupDefinition,
  type SkillsReference,
} from './reference';

// tailor_builder0's services/tailoring/skillGroups.ts, ported (the owner's permission of 2026-11-09).

// The technical skills as lines of a grouped list ("Cloud: AWS, Azure, GCP"), for templates that show them that
// way. Each line is one heading from the skill library and shows 3 to 5 skills, as a person lists the tools of
// one area. The tailoring step already gave each heading that many where it could (withHeadingsBalanced). Here a
// short line first takes more of the candidate's own skills of its heading, then shares a line with other short
// headings of its group ("Testing and Quality", "Containers and Infrastructure as Code"), as long as the shared
// line stays within 5. The heading always says what the line holds. Lines follow the library's heading order,
// and the skills in a line its priorities.

export interface SkillGroup {
  title: string;
  /** The skills, comma separated, as the templates print them. */
  description: string;
  items: string[];
}

// Skills a line shows, counted as names: "AWS (EC2, S3)" is 3.
const MIN_PER_LINE = 3;
const MAX_PER_LINE = 5;
// Lines a skills section holds before it stops reading like one.
const MAX_GROUPS = 8;
// Skills a grouped section may hold once thin lines are topped up.
const MAX_TOTAL_SKILLS = 30;
// Fewer skills than this make no sensible groups, and the list stays flat.
const MIN_SKILLS_TO_GROUP = 4;
// The heading of the line that holds whatever fits under no other heading. It always goes last.
const OTHER_HEADING = 'Tools';

interface Line {
  title: string;
  categories: string[];
  items: string[];
}

const key = toKeywordMatchForm;

// How many skills a line shows. An entry that only repeats one of its headings ("CI/CD") isn't counted.
const count = (line: Line) => line.items.reduce((sum, item) => sum + skillsShown(item, line.categories), 0);
const countAll = (lines: Line[]) => lines.reduce((sum, line) => sum + count(line), 0);

/**
 * `skills` is the finished technical skills list. `evidence` is the candidate's other skills (their profile's
 * list, tools their bullets name), the only source a thin line is topped up from, so nothing is added that the
 * resume doesn't already show. Null when the list is too short to group or the library has no headings, and
 * the template shows the flat list instead.
 */
export function buildSkillGroups(skills: string[], evidence: string[] = [], reference: SkillsReference = loadSkillsReference()): SkillGroup[] | null {
  if (!isSkillLibrary(reference) || skills.length < MIN_SKILLS_TO_GROUP) return null;
  const categoryOf = (skill: string) => referenceCategory(skill, reference) ?? OTHER_HEADING;
  const headings = reference.groups.flatMap((group) => group.categories);
  const rank = (category: string) => (headings.includes(category) ? headings.indexOf(category) : headings.length);
  const inHeadingOrder = (categories: string[]) => [...categories].sort((a, b) => rank(a) - rank(b));
  const lineRank = (line: Line) => (line.title === OTHER_HEADING ? Number.MAX_SAFE_INTEGER : Math.min(...line.categories.map(rank)));

  // One line per heading.
  const byCategory = new Map<string, Line>();
  for (const skill of skills) {
    const category = categoryOf(skill);
    const line = byCategory.get(category) ?? { title: category, categories: [category], items: [] };
    line.items.push(skill);
    byCategory.set(category, line);
  }

  // A thin line takes more of the candidate's skills from its own heading, never another name for one it has.
  const taken = new Set(skills.flatMap(namesIn).flatMap((name) => [name, ...referenceAliases(name, reference)]).map(key));
  let total = skills.flatMap(namesIn).length;
  for (const candidate of evidence) {
    if (total >= MAX_TOTAL_SKILLS) break;
    const line = byCategory.get(categoryOf(candidate));
    if (!line || count(line) >= MIN_PER_LINE || line.title === OTHER_HEADING) continue;
    if (classifyReferenceSkill(candidate, reference) !== 'hard') continue;
    const names = [candidate, ...referenceAliases(candidate, reference)].map(key);
    if (names.some((name) => taken.has(name))) continue;
    line.items.push(candidate);
    names.forEach((name) => taken.add(name));
    total += 1;
  }

  const merge = (lines: Line[], title: string): Line => ({
    title,
    categories: inHeadingOrder(lines.flatMap((line) => line.categories)),
    items: lines.flatMap((line) => line.items),
  });

  // The headings of one group share lines, each line kept within 5 (see sharedLines). A line still short is a
  // stray, placed below.
  const lines: Line[] = [];
  const strays: Line[] = [];
  const placed = new Set<string>();
  for (const group of reference.groups) {
    const members = group.categories.map((category) => byCategory.get(category)).filter((line): line is Line => Boolean(line));
    members.forEach((line) => placed.add(line.title));
    const shared = sharedLines(members, rank);
    for (const bin of shared) {
      const line = bin.length === 1 ? bin[0]! : merge(bin, '');
      const titled = { ...line, title: titleFor(line.categories, group, shared.length > 1) };
      (count(line) >= MIN_PER_LINE ? lines : strays).push(titled);
    }
  }
  for (const line of byCategory.values()) if (!placed.has(line.title)) (count(line) >= MIN_PER_LINE ? lines : strays).push(line);

  // A stray is a short line no heading of its group could take. Pairing far areas ("Languages and Compliance")
  // reads as filler, so a stray of two skills keeps a line of its own ("Languages: Python, Go"). Single skills
  // share an "other tools" line when there are two or more, and a lone one joins the nearest line with room,
  // which then names both headings ("Monitoring and Databases").
  const distance = (a: Line, b: Line) => Math.abs(lineRank(a) - lineRank(b));
  const named = (line: Line) => ({ ...line, title: line.title || namesOf(line.categories) });
  let result = lines;
  const singles = strays.filter((stray) => count(stray) < 2 || stray.title === OTHER_HEADING);
  result.push(...strays.filter((stray) => !singles.includes(stray)).map(named));
  const joinNearest = (single: Line) => {
    const byNearness = result.filter((line) => line.title !== OTHER_HEADING).sort((a, b) => distance(a, single) - distance(b, single));
    const host =
      byNearness.find((line) => line.categories.length === 1 && count(line) + count(single) <= MAX_PER_LINE) ??
      byNearness.find((line) => count(line) + count(single) <= MAX_PER_LINE) ??
      [...result].sort((a, b) => count(a) - count(b))[0];
    if (host) result = result.map((line) => (line === host ? named(merge([host, single], '')) : line));
    else result.push({ ...single, title: OTHER_HEADING });
  };
  if (singles.length > 1) {
    // Up to 5 share the line. Any more join the nearest lines with room, as a lone one does.
    result.push(merge(singles.slice(0, MAX_PER_LINE), OTHER_HEADING));
    singles.slice(MAX_PER_LINE).forEach(joinNearest);
  } else if (singles.length === 1 && singles[0]!.title === OTHER_HEADING) {
    // Skills the library has no heading for stay together under "Tools".
    result.push(singles[0]!);
  } else {
    singles.forEach(joinNearest);
  }

  // Too many lines: the groups whose headings each have a line of their own are folded, largest group first,
  // then the smallest lines go to "other tools".
  const groupOf = (line: Line) => reference.groups.find((group) => line.categories.every((c) => group.categories.includes(c)));
  while (result.length > MAX_GROUPS) {
    const byGroup = new Map<string, Line[]>();
    for (const line of result) {
      const group = groupOf(line);
      if (group) byGroup.set(group.name, [...(byGroup.get(group.name) ?? []), line]);
    }
    const [name, members] = [...byGroup.entries()].filter(([, list]) => list.length > 1).sort((a, b) => b[1].length - a[1].length)[0] ?? [];
    if (!name || !members) break;
    result = [...result.filter((line) => !members.includes(line)), merge(members, name)];
  }
  if (result.length > MAX_GROUPS) {
    const moved = [...result].sort((a, b) => count(a) - count(b)).slice(0, result.length - MAX_GROUPS + 1);
    result = [...result.filter((line) => !moved.includes(line)), merge(moved, OTHER_HEADING)];
  }

  // Lines in the library's heading order, "other tools" last. The skills in a line by heading, then priority.
  const itemRank = (item: string) => referenceOrder(namesIn(item)[0]!, reference);
  const grouped = result
    .map((line, index) => ({ line, index }))
    .sort((a, b) => lineRank(a.line) - lineRank(b.line) || a.index - b.index)
    .map(({ line }) => {
      // An entry that only repeats its heading ("CI/CD" under "CI/CD and Version Control") is left out, since
      // the heading already says it, in words a scanner reads.
      const shown = line.items.filter((item) => namesIn(item).length > 1 || !repeatsHeading(item, line.title));
      const items = (shown.length > 0 ? shown : line.items)
        .map((item, index) => ({ item, index }))
        .sort((a, b) => itemRank(a.item) - itemRank(b.item) || a.index - b.index)
        .map(({ item }) => item);
      return { title: line.title, description: items.join(', '), items };
    });
  // A scanner reads the printed page. Grouping only rearranges, so if it would ever show a skill less often
  // than the flat list does, the flat list is shown instead.
  return showsEverySkill(skills, grouped) ? grouped : null;
}

/**
 * How the headings of one group share lines. Every way of splitting them is tried (a group has at most a
 * handful), with no line over 5 and no two lines that stand on their own put together. The best split leaves
 * the fewest skills on lines under 3, then the fewest such lines, then shares as little as it can (more lines,
 * each under its own heading), then keeps neighbouring headings together ("Containers and Infrastructure as Code" before "Cloud
 * and Infrastructure as Code").
 */
function sharedLines(members: Line[], rank: (category: string) => number): Line[][] {
  const stands = (line: Line) => count(line) >= MIN_PER_LINE;
  const span = (bin: Line[]) => {
    const ranks = bin.flatMap((line) => line.categories.map(rank));
    return Math.max(...ranks) - Math.min(...ranks);
  };
  let best: { bins: Line[][]; score: number[] } | null = null;
  const visit = (index: number, bins: Line[][]) => {
    if (index === members.length) {
      const score = [
        bins.filter((bin) => countAll(bin) < MIN_PER_LINE).reduce((sum, bin) => sum + countAll(bin), 0),
        bins.filter((bin) => countAll(bin) < MIN_PER_LINE).length,
        -bins.length,
        bins.reduce((sum, bin) => sum + span(bin), 0),
      ];
      if (!best || isLower(score, best.score)) best = { bins: bins.map((bin) => [...bin]), score };
      return;
    }
    const line = members[index]!;
    for (const bin of bins) {
      if (countAll(bin) + count(line) > MAX_PER_LINE || (stands(line) && bin.some(stands))) continue;
      bin.push(line);
      visit(index + 1, bins);
      bin.pop();
    }
    bins.push([line]);
    visit(index + 1, bins);
    bins.pop();
  };
  visit(0, []);
  return best ? (best as { bins: Line[][] }).bins : members.map((line) => [line]);
}

// Compared first value first: [1, 5] is lower than [2, 0].
function isLower(a: number[], b: number[]): boolean {
  const i = a.findIndex((value, index) => value !== b[index]);
  return i >= 0 && a[i]! < b[i]!;
}

// "Monitoring and Databases"; "Containers, Infrastructure as Code and Operating Systems".
function namesOf(categories: string[]): string {
  return categories.length <= 2 ? categories.join(' and ') : `${categories.slice(0, -1).join(', ')} and ${categories[categories.length - 1]}`;
}

/**
 * The heading of a line of one group. A whole group is the group's name ("Security and Compliance"). Otherwise
 * the headings it holds are named, in heading order ("Containers and Infrastructure as Code"), except that three
 * or more take the group's name when no other line of the group stands beside it to make that name ambiguous.
 */
function titleFor(categories: string[], group: SkillGroupDefinition, othersOfGroup: boolean): string {
  const held = group.categories.filter((category) => categories.includes(category));
  if (held.length === 1) return held[0]!;
  if (held.length === group.categories.length) return group.name;
  if (held.length === 2 || othersOfGroup) return namesOf(held);
  return group.name;
}

/** True when the grouped lines (headings included) show every name of the flat list at least as often. */
export function showsEverySkill(skills: string[], groups: SkillGroup[]): boolean {
  const flatText = skills.join(', ');
  const groupedText = groups.map((group) => `${group.title} ${group.description}`).join(' \n ');
  return skills.flatMap(namesIn).every((name) => countKeyword(groupedText, name) >= countKeyword(flatText, name));
}

/** True when a template prints grouped technical skills: it reads `hardSkills.[0].title`. */
export function templateGroupsSkills(htmlContent: string): boolean {
  return /hardSkills\.\[0\]\.title/.test(htmlContent);
}
