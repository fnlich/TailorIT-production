import { capUtf16, safePathSegment } from '../../core/files/names';

// The paths inside a resume ZIP (work package WP11), all pure: {Company}/{Role}/{First_Last}_Resume.{ext}, made safe for
// Windows (core/files/names.ts `safePathSegment`), with "(2)", "(3)" for a company and role seen again, and the text of
// SKIPPED.txt. Windows compares names without regard to case, so every clash is found that way too. v20 P10 (A28): the
// Documents batch download's own paths, {shown name}/{First_Last}_resume.{ext}, and its SKIPPED.txt, at the end.

/** The longest folder and file-name parts, in UTF-16 units: a path stays well inside Windows' 260 with room to unpack. */
export const COMPANY_MAX = 50;
export const ROLE_MAX = 70;
export const PERSON_MAX = 40;

/** The one file at the root of the zip, besides the company folders. */
export const SKIPPED_FILE = 'SKIPPED.txt';

const UNKNOWN_COMPANY = 'Unknown company';
const UNTITLED_ROLE = 'Untitled role';

/** Titles and credentials that are not the first or the last name ("Dr. Jane Smith, PhD" is Jane_Smith). */
const LEADING_TITLES: ReadonlySet<string> = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'miss', 'prof']);
const TRAILING_SUFFIXES: ReadonlySet<string> = new Set([
  'jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'mba', 'cpa', 'pmp', 'esq', 'msc', 'bsc',
]);

/** "José" -> "Jose": combining marks are dropped only after a basic Latin letter, so "नमस्ते" or "محمّد" stay whole. */
function plainLatin(word: string): string {
  return word.normalize('NFD').replace(/([A-Za-z])\p{M}+/gu, '$1').normalize('NFC');
}

/**
 * The "First_Last" part of a resume's file name, from the name on the resume: the first and the last word (titles such
 * as "Dr." and suffixes such as "Jr." or "PhD" set aside when more words are left), accents dropped from Latin letters,
 * letters of every script kept; null when the name has no letters or digits.
 * "José María López" -> "Jose_Lopez", "Mary-Kate O'Neil Jr." -> "Mary-Kate_O'Neil", "山田 太郎" -> "山田_太郎".
 */
export function personFileStem(name: string | null | undefined): string | null {
  const words = (name ?? '')
    .normalize('NFC')
    .replace(/’/g, "'")
    .match(/[\p{L}\p{M}\p{N}'-]+/gu)
    ?.map((word) => plainLatin(word).replace(/^['-]+|['-]+$/g, ''))
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (!words || words.length === 0) return null;
  while (words.length > 2 && TRAILING_SUFFIXES.has(words[words.length - 1]!.toLowerCase())) words.pop();
  while (words.length > 2 && LEADING_TITLES.has(words[0]!.toLowerCase())) words.shift();
  const parts = words.length === 1 ? [words[0]!] : [words[0]!, words[words.length - 1]!];
  const stem = capUtf16(parts.join('_'), PERSON_MAX).replace(/[_'-]+$/, '');
  return stem || null;
}

/** "Nadia_Ali_Resume.pdf", or "Resume.pdf" with no name to go by. */
export function resumeFileName(stem: string | null, extension: string): string {
  return stem ? `${stem}_Resume.${extension}` : `Resume.${extension}`;
}

/** The first of `name`, `name (2)`, `name (3)`... not taken yet (compared without case), within `max` units. */
function freeName(name: string, taken: ReadonlySet<string>, max: number): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`;
    const base = capUtf16(name, max - suffix.length).replace(/[. ]+$/, '');
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export interface FolderRequest {
  id: string;
  companyName: string | null;
  title: string | null;
}

/**
 * Each application's folder, "Company/Role", in the order given (the tracker's). A company keeps the spelling it first
 * appeared with ("ACME" joins "Acme/"); a company and role seen again become "Role (2)", "Role (3)"; a company named
 * like the root's SKIPPED.txt gets a leading "_".
 */
export function planFolders(requests: readonly FolderRequest[]): Map<string, string> {
  const companies = new Map<string, { name: string; roles: Set<string> }>();
  const folders = new Map<string, string>();
  for (const request of requests) {
    let company = safePathSegment(request.companyName, UNKNOWN_COMPANY, COMPANY_MAX);
    if (company.toLowerCase() === SKIPPED_FILE.toLowerCase()) company = `_${company}`;
    let entry = companies.get(company.toLowerCase());
    if (!entry) {
      entry = { name: company, roles: new Set() };
      companies.set(company.toLowerCase(), entry);
    }
    const role = freeName(safePathSegment(request.title, UNTITLED_ROLE, ROLE_MAX), entry.roles, ROLE_MAX);
    entry.roles.add(role.toLowerCase());
    folders.set(request.id, `${entry.name}/${role}`);
  }
  return folders;
}

// ------------------------------------------------------------------------------------------------- SKIPPED.txt

/** One application as SKIPPED.txt names it: "Stripe / Senior Backend Engineer (Saved)". */
export interface SkippedApplication {
  company: string | null;
  role: string | null;
  status: string;
}

export interface SkippedReport {
  /** Applications that got no resume, each with the reason (a sentence). */
  skipped: ReadonlyArray<SkippedApplication & { reason: string }>;
  /** Applications with no resume linked that got this resume instead. */
  usedDefault: { label: string; isDefault: boolean; applications: readonly SkippedApplication[] } | null;
  /** Saved applications past the most one zip holds. */
  leftOut: number;
  maxApplications: number;
}

/** One line of text: controls and format characters dropped, whitespace collapsed. */
function oneLine(text: string | null, fallback: string): string {
  const line = (text ?? '').replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return line || fallback;
}

function nameOf(application: SkippedApplication): string {
  return `${oneLine(application.company, UNKNOWN_COMPANY)} / ${oneLine(application.role, UNTITLED_ROLE)} (${application.status})`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Whether the zip needs a SKIPPED.txt: something got no resume, got the default one, or was left out. */
export function needsSkippedFile(report: SkippedReport): boolean {
  return report.skipped.length > 0 || (report.usedDefault?.applications.length ?? 0) > 0 || report.leftOut > 0;
}

/** SKIPPED.txt: what the zip leaves out and why, as Windows' Notepad reads it (CRLF line ends). */
export function skippedText(report: SkippedReport): string {
  const lines: string[] = [];
  const paragraph = (...text: string[]) => {
    if (lines.length > 0) lines.push('');
    lines.push(...text);
  };
  if (report.skipped.length > 0) {
    paragraph(`TailorIT could not add a resume for ${plural(report.skipped.length, 'application', 'applications')}:`, '');
    for (const item of report.skipped) lines.push(`- ${nameOf(item)}: ${oneLine(item.reason, 'it could not be added.')}`);
  }
  const fallback = report.usedDefault;
  if (fallback && fallback.applications.length > 0) {
    const which = fallback.isDefault ? 'your default resume' : 'your newest resume';
    const count = fallback.applications.length;
    paragraph(
      `${plural(count, 'application has', 'applications have')} no resume linked, so ${count === 1 ? 'it got' : 'they got'} ` +
        `${which}, "${oneLine(fallback.label, 'Untitled resume')}". Link the resume you want in each application's ` +
        'Documents tab to change it:',
      '',
    );
    for (const item of fallback.applications) lines.push(`- ${nameOf(item)}`);
  }
  if (report.leftOut > 0) {
    paragraph(
      `${plural(report.leftOut, 'more Saved application was', 'more Saved applications were')} left out, because one zip ` +
        `holds up to ${report.maxApplications}. Choose them with Select applications and build again.`,
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

// --------------------------------------------------------------------- v20 P10: Documents' batch download (A28)
// The same rules for the selected resumes of Documents › Resumes: each file at "<shown name>/<First>_<Last>_resume.pdf",
// where the folder is the resume's name as Documents shows it, with " (2)", " (3)" for a name seen again.

/** The longest folder name made from a resume's shown name, in UTF-16 units. */
export const SHOWN_NAME_MAX = 80;

const UNTITLED_RESUME = 'Untitled resume';

/** "Nadia_Ali_resume.pdf" (the owner's lower-case "resume"), or "resume.pdf" with no name to go by. */
export function documentFileName(stem: string | null, extension: string): string {
  return stem ? `${stem}_resume.${extension}` : `resume.${extension}`;
}

export interface ShownNameRequest {
  id: string;
  /** The resume's label as Documents shows it now. */
  shownName: string | null;
}

/**
 * Each resume's folder, its shown name made safe, in the order given (the selection's): a name seen again (compared
 * without case) becomes "Name (2)", "Name (3)"; a name like the root's SKIPPED.txt gets a leading "_".
 */
export function planDocumentFolders(requests: readonly ShownNameRequest[]): Map<string, string> {
  const taken = new Set<string>();
  const folders = new Map<string, string>();
  for (const request of requests) {
    let name = safePathSegment(request.shownName, UNTITLED_RESUME, SHOWN_NAME_MAX);
    if (name.toLowerCase() === SKIPPED_FILE.toLowerCase()) name = `_${name}`;
    const folder = freeName(name, taken, SHOWN_NAME_MAX);
    taken.add(folder.toLowerCase());
    folders.set(request.id, folder);
  }
  return folders;
}

export interface DocumentsReport {
  /** Resumes that could not be added, each with the reason (a sentence naming it). */
  skipped: ReadonlyArray<{ label: string; reason: string }>;
  /** Selected resumes deleted while the zip was being built (their names went with them). */
  gone: number;
  /** Uploads that are not PDFs, in as their original files (uploads are never changed): their paths in the zip. */
  uploadedOriginals: readonly string[];
  /** Built resumes in as Word files, because a PDF could not be made: their paths in the zip. */
  builtAsWord: readonly string[];
}

/** Whether the batch download's zip needs a SKIPPED.txt. */
export function needsDocumentsReport(report: DocumentsReport): boolean {
  return (
    report.skipped.length > 0 || report.gone > 0 || report.uploadedOriginals.length > 0 || report.builtAsWord.length > 0
  );
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The batch download's SKIPPED.txt: what is not in the zip, and what is in it but not as a PDF (CRLF line ends). */
export function documentsSkippedText(report: DocumentsReport): string {
  const lines: string[] = [];
  const paragraph = (...text: string[]) => {
    if (lines.length > 0) lines.push('');
    lines.push(...text);
  };
  if (report.skipped.length > 0) {
    paragraph(`TailorIT could not add ${plural(report.skipped.length, 'resume', 'resumes')}:`, '');
    for (const item of report.skipped) {
      lines.push(`- ${sentence(oneLine(item.reason, `"${oneLine(item.label, UNTITLED_RESUME)}" could not be added.`))}`);
    }
  }
  if (report.gone > 0) {
    paragraph(
      `${plural(report.gone, 'selected resume was', 'selected resumes were')} deleted while the zip was being built, ` +
        `so ${report.gone === 1 ? 'it is' : 'they are'} not in it.`,
    );
  }
  if (report.uploadedOriginals.length > 0) {
    const count = report.uploadedOriginals.length;
    paragraph(
      `${plural(count, 'uploaded resume is not a PDF', 'uploaded resumes are not PDFs')}. TailorIT never changes an ` +
        `uploaded resume, so ${count === 1 ? 'it is' : 'each is'} in the zip as the original file:`,
      '',
    );
    for (const path of report.uploadedOriginals) lines.push(`- ${path}`);
  }
  if (report.builtAsWord.length > 0) {
    const count = report.builtAsWord.length;
    paragraph(
      `${plural(count, 'resume is', 'resumes are')} in the zip as ${count === 1 ? 'a Word file' : 'Word files'}, because ` +
        `a PDF could not be made right now. Try Download PDF on ${count === 1 ? 'it' : 'them'} in Documents:`,
      '',
    );
    for (const path of report.builtAsWord) lines.push(`- ${path}`);
  }
  return `${lines.join('\r\n')}\r\n`;
}
// end v20 P10
