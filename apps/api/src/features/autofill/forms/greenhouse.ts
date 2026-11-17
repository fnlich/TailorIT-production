import { addablePosting, type AutofillFieldKind } from '@tailorit/shared/autofill';
import { nowIso, type AppDeps } from '../../../core/context';
import { GREENHOUSE_API, greenhouseToken } from '../../ingest/adapters/greenhouse';
import type { IngestHttp } from '../../ingest/http';
import type { PageReading } from '../lookup';
import { formKnown, keepApiQuestions, openForm, type ApiQuestion, type FormPlace } from './store';

// A Greenhouse job's application questions from its board's public API (TailorIT v1.3, decision 2), so the first
// person to open a Greenhouse job's form gets its questions before anyone submitted it: GET
// boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>?questions=true, the same public API Add job and the board runs
// read, through the job boards' HTTP client (core/http/outbound.ts's rules, one request a second per host, its
// timeout), with no AI. Read once, the first time a lookup (or a known-form request) finds a shared Greenhouse job
// whose form TailorIT keeps no questions of; never while the answer waits (the read runs after it is sent). One read of
// a posting at a time; a failed read is not tried again for an hour. The questions are kept as an 'ats-api' form's
// (forms/store.ts keepApiQuestions): labels, kinds, options' labels and required marks, never anything a person
// wrote. Nothing names the posting in the log.
//
// v3.0 D2: on the async client; the board's answer is read before the transaction that keeps its questions.

/** How long the board has to answer. */
export const GREENHOUSE_QUESTIONS_TIMEOUT_MS = 15_000;
/** The most of the answer read. */
export const GREENHOUSE_QUESTIONS_MAX_BYTES = 2_000_000;
/** How long a posting whose read failed is left alone. */
export const GREENHOUSE_RETRY_MS = 60 * 60_000;

/** A Greenhouse posting by its board token and id. */
export interface GreenhousePosting {
  board: string;
  id: string;
}

/** The reads under way and the ones that failed lately, per posting ("<board>:<id>", lower case). */
export interface GreenhouseQuestionReads {
  reading: Map<string, Promise<number>>;
  failedAt: Map<string, number>;
}

const READS = new WeakMap<object, GreenhouseQuestionReads>();

/** The app's reads (one per app, shared by the lookup and the known-form routes). */
export function greenhouseReadsOf(deps: AppDeps): GreenhouseQuestionReads {
  let reads = READS.get(deps);
  if (!reads) {
    reads = { reading: new Map(), failedAt: new Map() };
    READS.set(deps, reads);
  }
  return reads;
}

/**
 * The Greenhouse posting a lookup's job is: the page's (or the employer link's) board and id when the address names
 * the board, else the job's own Greenhouse source link (its source's board token, the posting's id); null for any other.
 */
export async function greenhousePostingOf(
  deps: Pick<AppDeps, 'db'>,
  page: PageReading | null,
  jobId: number | null,
): Promise<GreenhousePosting | null> {
  const named = pageGreenhousePosting(page);
  if (named || jobId === null) return named;
  return postingOfLink(await deps.db.one<GreenhouseLink>(GREENHOUSE_LINK_SQL, [jobId]));
}

/** The page's (or the employer link's) Greenhouse board and id, when the address names the board. */
export function pageGreenhousePosting(page: PageReading | null): GreenhousePosting | null {
  for (const ats of [page?.employer?.ats ?? null, page?.ats ?? null]) {
    const posting = addablePosting(ats);
    if (posting?.kind === 'greenhouse') return { board: posting.board, id: posting.externalId };
  }
  return null;
}

/** The job's own Greenhouse source link (greenhousePostingOf's statement): the job's id. */
export const GREENHOUSE_LINK_SQL = `SELECT s.config, l.source_job_id FROM job_source_links l JOIN job_sources s ON s.id = l.source_id
       WHERE l.job_id = ? AND s.kind = 'greenhouse' ORDER BY (l.missing_since IS NULL) DESC, l.last_seen_at DESC LIMIT 1`;

export type GreenhouseLink = { config: string; source_job_id: string };

/** The posting a job's Greenhouse source link names: its source's board token, the posting's id; null for none. */
export function postingOfLink(link: GreenhouseLink | undefined): GreenhousePosting | null {
  if (!link || !/^\d{1,20}$/.test(link.source_job_id)) return null;
  let token = '';
  try {
    const config = JSON.parse(link.config) as { token?: unknown };
    token = greenhouseToken(typeof config.token === 'string' ? config.token : '');
  } catch {
    return null;
  }
  return token ? { board: token, id: link.source_job_id } : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const records = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter(isRecord) : []);

/** Greenhouse's field types as the extension's kinds; a hidden field is none. */
const FIELD_KINDS: Record<string, AutofillFieldKind> = {
  input_text: 'text',
  textarea: 'textarea',
  input_file: 'file',
  multi_value_single_select: 'select',
  multi_value_multi_select: 'checkbox-group',
};

/** A label as plain text: markup out, one line. */
function plainLabel(value: unknown): string {
  return typeof value === 'string'
    ? value
        .replace(/<[^>]*>/g, ' ')
        .replace(/[\p{Cc}\s]+/gu, ' ')
        .trim()
    : '';
}

/** Options' labels, from Greenhouse's `values` (or a demographic question's `answer_options`). */
function optionLabels(values: unknown): string[] {
  return records(values)
    .map((value) => plainLabel(value.label))
    .filter((label) => label !== '');
}

/**
 * The questions of Greenhouse's answer, in its order: the application's own (`questions`), the location questions,
 * the compliance (EEO) questions under "Voluntary Self-Identification", and the demographic questions. A question
 * with several fields (a resume's file or text) is its first field Greenhouse shows; a hidden field is skipped.
 */
export function greenhouseQuestions(data: unknown): ApiQuestion[] {
  if (!isRecord(data)) return [];
  const found: ApiQuestion[] = [];
  const add = (question: Record<string, unknown>, section: string) => {
    const label = plainLabel(question.label);
    if (!label) return;
    const field = records(question.fields).find((item) => typeof item.type === 'string' && FIELD_KINDS[item.type]);
    const type = field ? String(field.type) : typeof question.type === 'string' ? question.type : '';
    const kind = FIELD_KINDS[type];
    if (!kind) return;
    const options = optionLabels(field ? field.values : question.answer_options);
    found.push({ label, kind, options, section, required: question.required === true });
  };
  for (const question of records(data.questions)) add(question, '');
  for (const question of records(data.location_questions)) add(question, '');
  for (const block of records(data.compliance)) {
    for (const question of records(block.questions)) add(question, 'Voluntary Self-Identification');
  }
  const demographic = data.demographic_questions;
  if (isRecord(demographic)) {
    const heading = plainLabel(demographic.header) || 'Demographic questions';
    for (const question of records(demographic.questions)) add(question, heading);
  }
  return found;
}

/** The question read's address. */
export function greenhouseQuestionsUrl(posting: GreenhousePosting): string {
  return `${GREENHOUSE_API}/${encodeURIComponent(posting.board)}/jobs/${encodeURIComponent(posting.id)}?questions=true`;
}

/**
 * Reads the posting's questions and keeps them for the place's form, unless it keeps some already (see above).
 * Answers how many questions the read kept (0 for a form that had some, a posting the board no longer has, or a read
 * that failed) once it ends, or null when none was started (the form keeps questions, the posting is being read, or
 * its read failed within the hour). Never throws.
 */
export async function readGreenhouseQuestionsLater(
  deps: AppDeps,
  reads: GreenhouseQuestionReads,
  place: FormPlace,
  posting: GreenhousePosting,
  http: IngestHttp | null = deps.services.ingest?.http ?? null,
): Promise<number | null> {
  if (!http || (await formKnown(deps.db, place))) return null;
  const read = startGreenhouseRead(deps, reads, place, posting, http);
  return read === null ? null : await read;
}

/**
 * The read itself, once the caller found the form keeps no questions: started at once (never waited for here), its
 * promise answered; null when none starts (no HTTP client, the posting is being read, or its read failed within the
 * hour). The questions are kept in a transaction of their own after the board answered, unless someone kept some
 * meanwhile.
 */
export function startGreenhouseRead(
  deps: AppDeps,
  reads: GreenhouseQuestionReads,
  place: FormPlace,
  posting: GreenhousePosting,
  http: IngestHttp | null,
): Promise<number> | null {
  if (!http) return null;
  const key = `${posting.board.toLowerCase()}:${posting.id}`;
  const failed = reads.failedAt.get(key);
  if (reads.reading.has(key) || (failed !== undefined && deps.now().getTime() - failed < GREENHOUSE_RETRY_MS)) return null;
  const read = (async () => {
    const answer = await http.getJson(greenhouseQuestionsUrl(posting), {
      signal: AbortSignal.timeout(GREENHOUSE_QUESTIONS_TIMEOUT_MS),
      allow: [404],
      maxBytes: GREENHOUSE_QUESTIONS_MAX_BYTES,
    });
    if (answer.status === 404) return 0;
    const questions = greenhouseQuestions(answer.data);
    if (questions.length === 0) return 0;
    return deps.db.tx(
      async (t) => {
        if (await formKnown(t, place)) return 0;
        const now = nowIso(deps);
        const form = await openForm(t, place, 'ats-api', now);
        return keepApiQuestions(t, form.id, questions, now);
      },
      { label: 'keepGreenhouseQuestions' },
    );
  })()
    .then((kept) => {
      reads.failedAt.delete(key);
      if (kept > 0) deps.log.debug(`[autofill] kept ${kept} Greenhouse question(s) for a job's form`);
      return kept;
    })
    .catch((error: unknown) => {
      reads.failedAt.set(key, deps.now().getTime());
      // Never the error's text: it holds the board's API address.
      deps.log.warn('[autofill] reading a Greenhouse job\'s questions failed', error instanceof Error ? error.name : 'unknown');
      return 0;
    })
    .finally(() => reads.reading.delete(key));
  reads.reading.set(key, read);
  return read;
}
