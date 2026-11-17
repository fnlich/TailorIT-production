import { isEditorDocument, normalizeResumeDocument, SECTION_KINDS, type ResumeDocument } from '@tailorit/shared';
import { renderResumePrintHtml } from '@tailorit/render';
import { DEFAULT_SECTION_HEADINGS, resumePlainText } from '@tailorit/resume-templates';
import type { AppDeps } from '../../core/context';
import { upgradeLegacyDocument } from '../../core/resume-upgrade';
import { getResumeEngine } from './engine';
import { updateResumeDocument } from './repository';

// `npm run resumes:upgrade`: every stored resume written before the on-page editor, moved into it (the switch of
// v1.1). `--dry-run` changes nothing and checks the content instead: for each resume, the words the old Handlebars
// template prints against the words the new template prints, so any word the move would lose or add is listed for the
// owner to look at before the old engine goes. Section headings ("Professional Summary" is now "Summary") and the
// format of dates ("Jan 2021" is now "01/2021") change by design and are not counted.

const USAGE = `Usage: npm run resumes:upgrade -- [--dry-run] [--email <address>]

  Moves every resume built before the on-page editor into it, with the same content. With --dry-run nothing is
  written: each resume's printed words are compared between the old and the new templates and every difference is
  listed. --email limits it to one account.`;

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ' };

/** The text an HTML page shows: no style or script, no tags, the common entities decoded. */
export function visibleText(html: string): string {
  return html
    .replace(/<(style|script|title)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&(?:amp|lt|gt|quot|nbsp);/g, (entity) => ENTITIES[entity] ?? ' ');
}

const MONTHS = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$/i;
const DATE = /^(?:\d{1,2}\/)?\d{4}$/;
const HEADING_WORDS = new Set(
  // Plus the labels some old templates print beside the sections ("Contact", "Profile").
  [
    ...SECTION_KINDS.map((kind) => kind.heading),
    ...Object.values(DEFAULT_SECTION_HEADINGS),
    'Certifications',
    'Contact',
    'Profile',
  ]
    .flatMap((heading) => heading.toLowerCase().split(/\s+/)),
);

/** A text's words as the comparison counts them: punctuation off, headings and dates left out. */
function wordsOf(text: string): string[] {
  return text
    .split(/[\s|•·,;:()]+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%+#]+$/gu, ''))
    .filter((word) => word && !MONTHS.test(word) && !DATE.test(word) && !/^present$/i.test(word))
    .filter((word) => !HEADING_WORDS.has(word.toLowerCase()));
}

/** The words one text has that the other has not, as many times as they are missing (case kept, compared without it). */
export function compareWords(before: string, after: string): { lost: string[]; added: string[] } {
  const count = (words: string[]) => {
    const counts = new Map<string, { word: string; n: number }>();
    for (const word of words) {
      const key = word.toLowerCase();
      const entry = counts.get(key) ?? { word, n: 0 };
      entry.n += 1;
      counts.set(key, entry);
    }
    return counts;
  };
  const old = count(wordsOf(before));
  const now = count(wordsOf(after));
  const diff = (a: typeof old, b: typeof old) =>
    [...a].flatMap(([key, { word, n }]) => Array.from({ length: Math.max(0, n - (b.get(key)?.n ?? 0)) }, () => word));
  return { lost: diff(old, now), added: diff(now, old) };
}

export interface UpgradeReport {
  id: string;
  lost: string[];
  added: string[];
}

/** One older resume moved into the editor: the upgraded document and how its printed words compare. */
export async function upgradeWithCheck(deps: AppDeps, userId: string, document: ResumeDocument) {
  const engine = getResumeEngine(deps);
  const skills = await engine.skillsFor(userId);
  const upgraded = upgradeLegacyDocument(document, { templates: engine.templates, skills });
  const before = visibleText(renderResumePrintHtml({ document, templates: engine.templates, skills }).html);
  return { upgraded, ...compareWords(before, resumePlainText(upgraded)) };
}

export async function runResumesUpgrade(deps: AppDeps, args: string[]): Promise<void> {
  if (args.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const dryRun = args.includes('--dry-run');
  const emailAt = args.indexOf('--email');
  const email = emailAt >= 0 ? args[emailAt + 1]?.trim().toLowerCase() : undefined;
  const rows = await deps.db.all<{ id: string; user_id: string; data: string }>(
    `SELECT r.id, r.user_id, r.data FROM resumes r JOIN users u ON u.id = r.user_id
       WHERE r.kind = 'built' AND r.data IS NOT NULL ${email ? 'AND lower(u.email) = ?' : ''} ORDER BY r.created_at`,
    email ? [email] : [],
  );

  let moved = 0;
  let already = 0;
  const reports: UpgradeReport[] = [];
  for (const row of rows) {
    const document = normalizeResumeDocument(JSON.parse(row.data));
    if (isEditorDocument(document)) {
      already += 1;
      continue;
    }
    const { upgraded, lost, added } = await upgradeWithCheck(deps, row.user_id, document);
    if (lost.length > 0 || added.length > 0) reports.push({ id: row.id, lost, added });
    if (!dryRun) await updateResumeDocument(deps, row.user_id, row.id, upgraded);
    moved += 1;
  }

  console.log(`${dryRun ? 'Would move' : 'Moved'} ${moved} resume(s) into the on-page editor; ${already} already there.`);
  if (reports.length === 0) {
    console.log('Every resume prints the same words on its new template.');
    return;
  }
  console.log(`${reports.length} resume(s) print other words on the new template:`);
  for (const report of reports) {
    console.log(`  ${report.id}`);
    if (report.lost.length > 0) console.log(`    no longer printed: ${report.lost.slice(0, 40).join(' ')}`);
    if (report.added.length > 0) console.log(`    newly printed:     ${report.added.slice(0, 40).join(' ')}`);
  }
}
