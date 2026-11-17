import { defaultLetterTitle, findPlaceholders, htmlToText } from '@tailorit/shared';
import {
  AUTOFILL_COVER_LETTER_LIMITS,
  AUTOFILL_COVER_LETTER_MAX_BYTES,
  type AutofillCoverLetterRequest,
  type AutofillCoverLetterResponse,
  type AutofillCoverLetterState,
  type AutofillCoverLetterText,
} from '@tailorit/shared/autofill';
import type { AppDeps } from '../../core/context';
import { conflict, notFound, validationFailed } from '../../core/http/errors';
import { refuse } from '../../core/http/refuse';
import {
  jobExists,
  letterProfile,
  linkApplicationLetter,
  requireOwnResume,
  visibleTemplate,
} from '../cover-letters/context';
import { letterPdf } from '../cover-letters/export';
import {
  generationInFlight,
  requireEvidence,
  startGeneration,
  templateHasContent,
  unfilledVariables,
  type GenerateTaskInput,
} from '../cover-letters/generate';
import { downloadName } from '../cover-letters/http';
import { createLetterRepository, type LetterRow } from '../cover-letters/repository';
import { untrustedLines, untrustedText } from './ai/untrusted';
import { currentJobId } from './lookup';
import type { AttachedFile } from './resumes';

// The cover letter the extension uploads into a form's cover-letter field (POST /api/autofill/cover-letters, its state
// and its file). It is one of the person's own letters, the Cover Letters tab's: the one for this job when they have
// one, else one TailorIT writes now, with the cover-letter feature's own generation (the editor's Generate with no
// template, TailorIT's default: an account has no default template of its own, and a template can leave a
// `{{PLACEHOLDER}}` no one is there to fill). Which letter (AutofillCoverLetterRequestSchema says it for the
// extension):
//   - with a job: the tracker entry's letter for it (applications.cover_letter_id), then the account's other letters
//     with that job or entry, newest first, then its letters with no job for the entry's or the job's company and
//     title (one written before the job was added); while Prepare & Queue has the job queued, the kit's letter first
//     and never one written from another resume than the kit's (v2.0, A29/A30); without one (a posting TailorIT does
//     not have): its letters with no job for the request's company and title, so a second form of the posting finds
//     the first one's letter. A
//     company and a title are compared cleaned as page text is (untrustedText: compatibility forms, invisible
//     characters, any whitespace one space) and in lower case, on both sides;
//   - the first of them that is ready, else the first being written; else the first decides: one with text is the
//     person's unfinished letter (a placeholder left), answered `failed` as it is, never written over and never
//     doubled; an empty one is written into, unless its template uses a detail of the person's they have not given
//     (answered `failed` without asking Claude: the fill would leave a placeholder). Only with none at all is a letter
//     made, linked to the job and the entry as the Cover Letters tab's New links it (a letter written here becomes the
//     entry's when it has none);
//   - `generate` false (a posting that forbids AI) never writes and uses only a letter the person wrote or edited:
//     none being written, none the AI wrote that they never touched; else 404.
// A letter is written from the page alone: the request's `jobText` (the extension's view of the text the form's page
// shows), never TailorIT's stored description of the job (ingest keeps text a page hides) nor a letter's stored copy;
// the company and the title are TailorIT's (the tracker entry's, else the job's), the request's where those are empty.
// All three are cleaned as page text before they are stored, and quoted to Claude in wrappers as data; the answer is
// checked for the page's canaries, talk of being an AI, the prompt's markup and contact details not the person's, and
// written only into a letter still empty by then (cover-letters/generate.ts): one that fails keeps what it has. Every
// step runs without an await, so two requests for one job never make two letters. A letter made here whose writing
// the queue refuses (busy, paused, off) is removed again; the person's empty one is left exactly as it was.

const LIMITS = AUTOFILL_COVER_LETTER_LIMITS;
const MB = 1024 * 1024;
/** notFound's subject: "A cover letter for this job was not found." */
const NO_LETTER = 'A cover letter for this job';
const NOT_FINISHED =
  'This cover letter is not finished: it is empty, or it still has a placeholder to fill. Finish it in TailorIT ' +
  '(Documents › Cover Letters), or write one there.';
const NO_JOB_FACTS = 'Name the company and the job title, so the cover letter is written for this job.';

/** Text, with no placeholder left for the person to fill: a letter an employer may read. */
function isFinished(row: LetterRow): boolean {
  return hasText(row) && findPlaceholders(row.content_html).length === 0;
}

function hasText(row: LetterRow): boolean {
  return row.content_text.trim() !== '';
}

/** A letter the person wrote or edited: not one the AI wrote that they never touched. */
function personWrote(row: LetterRow): boolean {
  return !(row.origin === 'generated' && row.last_edited_at === null);
}

/** The answer for one of the account's letters: TailorIT's AI wrote it when it is being written, or when the AI wrote
 *  it and the person never touched it. */
function answerFor(row: LetterRow, state: AutofillCoverLetterState): AutofillCoverLetterResponse {
  return { letterId: row.id, state, aiWritten: state === 'generating' || !personWrote(row) };
}

/** Where one of the account's letters stands (AUTOFILL_COVER_LETTER_STATES). */
export async function letterState(deps: Pick<AppDeps, 'db'>, userId: string, row: LetterRow): Promise<AutofillCoverLetterState> {
  if (await generationInFlight(deps, userId, row.id)) return 'generating';
  return isFinished(row) ? 'ready' : 'failed';
}

/** A company and a job title. */
interface JobNames {
  companyName: string;
  jobTitle: string;
}

/** A company or a title as a letter keeps it: page text, cleaned (untrustedText). */
const cleanName = (text: string, max: number) => untrustedText(text, max);

/** A company and a title as two asks compare them (cleaned, in lower case), or null when either is blank. */
function namesKey(names: JobNames): string | null {
  const key = (text: string) => untrustedText(text, Number.MAX_SAFE_INTEGER).toLocaleLowerCase();
  const [company, title] = [key(names.companyName), key(names.jobTitle)];
  return company && title ? JSON.stringify([company, title]) : null;
}

interface Candidates {
  /** The person's tracker entry for the job, with its company and title, when they have one. */
  application: ({ id: string } & JobNames) | null;
  /** The job's company and title, when TailorIT has the job. */
  job: JobNames | null;
  /** Their letters for it, in the order they are tried. */
  letters: LetterRow[];
}

/** The account's letters with no job for one of these companies and titles, newest first. */
async function lettersForPosting(deps: Pick<AppDeps, 'db'>, userId: string, names: readonly JobNames[]): Promise<LetterRow[]> {
  const wanted = new Set(names.map(namesKey).filter((key): key is string => key !== null));
  if (wanted.size === 0) return [];
  const rows = await deps.db.all<LetterRow>(
    'SELECT * FROM cover_letters WHERE user_id = ? AND job_id IS NULL ORDER BY updated_at DESC, id',
    [userId],
  );
  return rows.filter((row) => wanted.has(namesKey({ companyName: row.company_name, jobTitle: row.job_title }) ?? ''));
}

/** The company and the title TailorIT keeps for a job ('' for none). */
async function jobNames(deps: Pick<AppDeps, 'db'>, jobId: number): Promise<JobNames> {
  const row = await deps.db.one<{ title: string; company_name: string | null }>(
    'SELECT j.title, c.name AS company_name FROM jobs j LEFT JOIN companies c ON c.id = j.company_id WHERE j.id = ?',
    [jobId],
  );
  return { companyName: row?.company_name ?? '', jobTitle: row?.title ?? '' };
}

/**
 * The account's letters for a job TailorIT has: its tracker entry's own first, then the rest with the job or the
 * entry, newest first, then those with no job for the entry's or the job's company and title.
 */
async function lettersForJob(deps: Pick<AppDeps, 'db' | 'now'>, userId: string, jobId: number): Promise<Candidates> {
  const entry = await deps.db.one<{ id: string; cover_letter_id: string | null; title: string; company_name: string }>(
    'SELECT id, cover_letter_id, title, company_name FROM applications WHERE user_id = ? AND job_id = ?',
    [userId, jobId],
  );
  const application = entry ? { id: entry.id, companyName: entry.company_name, jobTitle: entry.title } : null;
  const job = await jobNames(deps, jobId);
  // v20 P3 (A30): while Prepare & Queue has the job queued, its frozen kit's letter (the draft's) comes first.
  // v20 FIX-B (BEH-2): and no letter written from another resume than the kit's is offered then (A29): a kit with no
  // letter never hands over an earlier kit's; a letter is then written from the kit's resume (the one attached).
  const kit = await deps.db.one<{ resume_id: string | null; cover_letter_id: string | null }>(
    `SELECT q.resume_id, d.cover_letter_id FROM autofill_agent_queue q
       LEFT JOIN application_drafts d ON d.application_id = q.application_id AND d.user_id = q.user_id
     WHERE q.user_id = ? AND q.job_id = ? AND q.state IN ('queued', 'running') AND q.prepare_id IS NOT NULL`,
    [userId, jobId],
  );
  const fits = (row: LetterRow) => !kit || row.resume_id === null || row.resume_id === kit.resume_id;
  const letters = createLetterRepository(deps);
  const found =
    (kit?.cover_letter_id ? await letters.getRow(kit.cover_letter_id, userId) : undefined) ??
    (entry?.cover_letter_id ? await letters.getRow(entry.cover_letter_id, userId) : undefined);
  const linked = found && fits(found) ? found : undefined;
  // end v20 P3
  const others = (
    await deps.db.all<LetterRow>(
      `SELECT * FROM cover_letters WHERE user_id = ? AND (job_id = ? OR application_id = ?)
       ORDER BY updated_at DESC, id`,
      [userId, jobId, entry?.id ?? null],
    )
  ).filter(fits);
  const ordered = linked ? [linked, ...others.filter((row) => row.id !== linked.id)] : others;
  const seen = new Set(ordered.map((row) => row.id));
  const named = (await lettersForPosting(deps, userId, application ? [application, job] : [job])).filter(fits);
  return { application, job, letters: [...ordered, ...named.filter((row) => !seen.has(row.id))] };
}

/**
 * What a letter is written about, as page text cleaned: the tracker entry's company and title, else the job's, else
 * the request's; the request's job text alone.
 */
function factsFor(request: AutofillCoverLetterRequest, found: Candidates) {
  const kept = found.application ?? found.job;
  return {
    applicationId: found.application?.id ?? null,
    jobId: request.jobId ?? null,
    companyName: cleanName(kept?.companyName ?? '', LIMITS.company) || cleanName(request.company, LIMITS.company),
    jobTitle: cleanName(kept?.jobTitle ?? '', LIMITS.jobTitle) || cleanName(request.jobTitle, LIMITS.jobTitle),
    jobDescription: untrustedLines(request.jobText ?? '', LIMITS.jobText),
  };
}

/** How the answer's letter came about, for the debug line. */
export type LetterOutcome = 'existing' | 'written_into_empty' | 'new' | 'template_unfilled';

export interface FoundLetter {
  answer: AutofillCoverLetterResponse;
  outcome: LetterOutcome;
}

/** POST /cover-letters: the letter to upload for this application, written now when asked and there is none. */
export async function coverLetterFor(deps: AppDeps, userId: string, asked: AutofillCoverLetterRequest): Promise<FoundLetter> {
  // A page job an upgrade closed stands for the shared job it gave way to; another account's is as good as none, and
  // where it went is never told (audit A3).
  const current = asked.jobId === undefined ? undefined : await currentJobId(deps, userId, asked.jobId);
  const request = current === undefined || current === null ? asked : { ...asked, jobId: current };
  await requireOwnResume(deps, userId, request.resumeId);
  if (current === null || (request.jobId !== undefined && !await jobExists(deps, request.jobId, userId))) {
    throw notFound('That job');
  }
  const found: Candidates =
    request.jobId !== undefined
      ? await lettersForJob(deps, userId, request.jobId)
      : {
          application: null,
          job: null,
          letters: await lettersForPosting(deps, userId, [{ companyName: request.company, jobTitle: request.jobTitle }]),
        };

  const states: Array<{ row: LetterRow; state: AutofillCoverLetterState }> = [];
  for (const row of found.letters) states.push({ row, state: await letterState(deps, userId, row) });
  // A posting that forbids AI gets only a letter the person wrote or edited.
  const allowed = request.generate
    ? states
    : states.filter(({ row, state }) => state !== 'generating' && personWrote(row));
  const usable = allowed.find(({ state }) => state === 'ready') ?? allowed.find(({ state }) => state === 'generating');
  if (usable) return { answer: answerFor(usable.row, usable.state), outcome: 'existing' };
  const first = allowed[0]?.row ?? null;
  // The person's unfinished letter is theirs to finish; an empty one is used only to write into.
  if (first && (hasText(first) || !request.generate)) {
    return { answer: answerFor(first, 'failed'), outcome: 'existing' };
  }
  if (!request.generate) throw notFound(NO_LETTER);

  const evidence = await requireEvidence(deps, userId, request.resumeId);
  const facts = factsFor(request, found);
  const about = {
    companyName: cleanName(first?.company_name ?? '', LIMITS.company) || facts.companyName,
    jobTitle: cleanName(first?.job_title ?? '', LIMITS.jobTitle) || facts.jobTitle,
    // The page's text alone: never the letter's stored copy.
    jobDescription: facts.jobDescription,
  };
  if (!about.companyName || !about.jobTitle) {
    throw validationFailed(NO_JOB_FACTS, {
      ...(about.companyName ? {} : { company: 'Required' }),
      ...(about.jobTitle ? {} : { jobTitle: 'Required' }),
    });
  }

  // An empty letter keeps the template the person chose for it; a new one is written with none. A template using a
  // detail of the person's they have not given would keep a placeholder, and the letter would read as their unfinished
  // one from then on: it stays empty, and Claude is not asked.
  const template = first?.template_id ? await visibleTemplate(deps, userId, first.template_id) : null;
  if (
    first &&
    template &&
    templateHasContent(template.contentHtml) &&
    unfilledVariables(template, letterProfile(evidence), about, deps.now()).length > 0
  ) {
    return { answer: answerFor(first, 'failed'), outcome: 'template_unfilled' };
  }

  const repository = createLetterRepository(deps);
  const target =
    first ??
    await repository.create(userId, {
      title: defaultLetterTitle(deps.now()),
      origin: 'blank',
      applicationId: facts.applicationId,
      jobId: facts.jobId,
      ...about,
    });
  const input: GenerateTaskInput = {
    letterId: target.id,
    ...about,
    templateId: template?.id ?? null,
    customPrompt: target.custom_prompt,
    resumeId: request.resumeId,
    page: { canaries: request.canaries ?? [] },
    onlyIfEmpty: true,
  };
  try {
    await startGeneration(deps, userId, input, template);
  } catch (error) {
    if (!first) await repository.remove(target.id, userId);
    throw error;
  }
  // The empty letter keeps what it is written about, as the Generate dialog's fields stay on a letter.
  if (first) await repository.update(first.id, userId, about);
  // The entry's letter from now on, unless it has one.
  if (facts.applicationId) await linkApplicationLetter(deps, userId, facts.applicationId, target.id);
  return { answer: answerFor(target, 'generating'), outcome: first ? 'written_into_empty' : 'new' };
}

/** GET /cover-letters/:id: where one of the account's letters stands; 404 for another account's or none. */
export async function coverLetterStateOf(deps: AppDeps, userId: string, id: string): Promise<AutofillCoverLetterState> {
  return letterState(deps, userId, await createLetterRepository(deps).require(id, userId));
}

/**
 * GET /cover-letters/:id/file: the letter as GET /api/cover-letters/:id/export?format=pdf prints it, under the same
 * name. 404 for another account's letter, 409 `conflict` while it is written or when it is not finished, 413
 * `file_too_large` above AUTOFILL_COVER_LETTER_MAX_BYTES; a print Chrome refuses is its 503 or 500.
 */
export async function coverLetterFileOf(deps: AppDeps, userId: string, id: string): Promise<AttachedFile> {
  const row = await createLetterRepository(deps).require(id, userId);
  const state = await letterState(deps, userId, row);
  if (state === 'generating') throw refuse(deps, 'conflict', 'MSG_AUTOFILL_LETTER_BEING_WRITTEN');
  if (state === 'failed') throw conflict(NOT_FINISHED);
  const started = performance.now();
  const buffer = await letterPdf(deps, { title: row.title, contentHtml: row.content_html, fontFamily: row.font_family });
  const printMs = Math.round(performance.now() - started);
  // v30 ST3: the refusal is the constant MSG_AUTOFILL_LETTER_TOO_LARGE.
  if (buffer.length > AUTOFILL_COVER_LETTER_MAX_BYTES) {
    throw refuse(deps, 'file_too_large', 'MSG_AUTOFILL_LETTER_TOO_LARGE', { max_mb: AUTOFILL_COVER_LETTER_MAX_BYTES / MB });
  }
  return { buffer, kind: 'pdf', fileName: downloadName(row.title, 'pdf', 'Cover Letter'), printMs };
}

/** A paragraph's or a block's end in a letter's HTML: a blank line follows it in the plain text. */
const LETTER_BLOCK_END = /<\/(?:p|div|ul|ol|h[1-6]|blockquote|pre)\s*>/gi;

/**
 * GET /cover-letters/:id/text (version 3): a ready letter's words as plain text, for a form's cover-letter text box:
 * the editor's HTML as text (htmlToText, as the letter's stored text is made), its paragraphs one blank line apart.
 * 404 for another account's letter or none; 409 `conflict` while it is being written or not finished, as its file.
 */
export async function coverLetterTextOf(deps: AppDeps, userId: string, id: string): Promise<AutofillCoverLetterText> {
  const row = await createLetterRepository(deps).require(id, userId);
  const state = await letterState(deps, userId, row);
  if (state === 'generating') throw refuse(deps, 'conflict', 'MSG_AUTOFILL_LETTER_BEING_WRITTEN');
  if (state === 'failed') throw conflict(NOT_FINISHED);
  const text = htmlToText(row.content_html.replace(LETTER_BLOCK_END, (end) => `${end}\n`));
  if (!text) throw conflict(NOT_FINISHED);
  return { text };
}
