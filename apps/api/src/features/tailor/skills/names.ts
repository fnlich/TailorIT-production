import { toKeywordMatchForm } from '../ats';

// tailor_builder0's services/tailoring/skillNames.ts, ported (the owner's permission of 2026-11-09).

// How one entry of the hard skills list is written and what it shows: "AWS (EC2, S3)" is AWS with two of its
// parts, "Google Cloud Platform (GCP)" is one skill under two names.

// A vendor's name in front of a product ("Microsoft Azure", "Amazon EKS", "Apache Kafka").
const VENDOR_NAME = /^(?:aws|amazon|azure|microsoft|google cloud|google|apache|hashicorp|jfrog|red hat)\s+/;
const SMALL_WORDS = new Set(['and', 'as', 'for', 'of', 'the', 'to']);

function initials(name: string, withSmallWords: boolean): string {
  return name
    .split(/[\s/-]+/)
    .filter((word) => word && (withSmallWords || !SMALL_WORDS.has(word.toLowerCase())))
    .map((word) => word[0])
    .join('')
    .toLowerCase();
}

// "GCP" for "Google Cloud Platform", "AWS" for "Amazon Web Services", "IaC" for "Infrastructure as Code".
function isAcronymOf(short: string, long: string): boolean {
  if (/\s/.test(short) || short.length < 2 || short.length > 5 || !/\s/.test(long)) return false;
  const letters = short.toLowerCase().replace(/[^a-z0-9]/g, '');
  return letters === initials(long, false) || letters === initials(long, true);
}

/**
 * How two names for one skill are written once, or null when they are different skills. A vendor name in front
 * ("Microsoft Azure" and "Azure") keeps the longer name, which still contains the shorter for a scanner. An
 * acronym and its words ("GCP" and "Google Cloud Platform") become "Google Cloud Platform (GCP)", as a person
 * writes it. "Azure" and "Azure DevOps" are two products and stay apart.
 */
export function combinedSkillName(a: string, b: string): string | null {
  const [ka, kb] = [toKeywordMatchForm(a), toKeywordMatchForm(b)];
  if (ka === kb) return a;
  if (ka.replace(VENDOR_NAME, '') === kb) return a;
  if (kb.replace(VENDOR_NAME, '') === ka) return b;
  if (isAcronymOf(a, b)) return `${b} (${a})`;
  if (isAcronymOf(b, a)) return `${a} (${b})`;
  return null;
}

// "Google Cloud Platform (GCP)" -> "Google Cloud Platform"; "AWS (EC2, S3)" -> "AWS".
export const baseSkillName = (skill: string) => skill.replace(/\s*\([^)]*\)\s*$/, '').trim();

// Every name an entry shows: "AWS (EC2, S3)" is AWS, EC2 and S3; "Google Cloud Platform (GCP)" is both names.
export function namesIn(entry: string): string[] {
  const nested = entry.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (!nested) return [entry];
  return [nested[1]!, ...nested[2]!.split(',')].map((name) => name.trim()).filter(Boolean);
}

// The parts written under an entry's technology, without the other names for it: EC2 and S3 of "AWS (EC2, S3)",
// none of "Google Cloud Platform (GCP)".
export function partsOf(entry: string): string[] {
  const [head, ...inside] = namesIn(entry);
  return inside.filter((name) => combinedSkillName(head!, name) === null);
}

// The entry without one of the names in its parentheses: "AWS (EC2, S3)" without S3 is "AWS (EC2)".
export function withoutPart(entry: string, part: string): string {
  const [, ...inside] = namesIn(entry);
  const kept = inside.filter((name) => toKeywordMatchForm(name) !== toKeywordMatchForm(part));
  return kept.length > 0 ? `${baseSkillName(entry)} (${kept.join(', ')})` : baseSkillName(entry);
}

/**
 * How many skills an entry shows: the technology and each part under it. One skill under two names is one. An
 * entry that only repeats a heading it sits under ("CI/CD" under "CI/CD") shows none, since the heading says it.
 */
export function skillsShown(entry: string, headings: string[] = []): number {
  if (partsOf(entry).length === 0 && headings.some((heading) => repeatsHeading(entry, heading))) return 0;
  return 1 + partsOf(entry).length;
}

// True when the heading's own words already say the entry ("CI/CD" in "CI/CD and Version Control").
export function repeatsHeading(entry: string, heading: string): boolean {
  return ` ${toKeywordMatchForm(heading)} `.includes(` ${toKeywordMatchForm(entry)} `);
}
