import { SetDefaultResumeBodySchema, type Account } from '@tailorit/shared/auth';
import {
  RESUME_COPY_PAUSES,
  RESUME_COPY_STATES,
  RESUME_FILE_KINDS,
  ResumeCopiesResponseSchema,
  ResumeDetailSchema,
  ResumeEditTargetSchema,
  ResumeSummarySchema,
  normalizeResumeDocument,
  resumeLabel,
  type BulletsRequest,
  type ResumeAnalysisBrief,
  type ResumeCopiesPause,
  type ResumeCopiesResponse,
  type ResumeCopy,
  type ResumeCopyState,
  type ResumeDocument,
  type ResumeEditTarget,
  type ResumeFileKind,
  type ResumeMadeBy,
  type ResumeSummary,
  type ResumeTemplateId,
  type SkillType,
  type StoredFileInfo,
  type TechnicalSkillsLayout,
} from '@tailorit/shared/resume';
import type { ZodType } from 'zod';
import { ApiError, api } from '../../lib/api';

/*
 * The resume endpoints as the resume pages and the Resumes tab call them. Answers are read leniently: the shared zod
 * contract first, and when an answer differs from it (the API is built alongside), the fields this page needs are
 * picked out by hand and the difference is reported once in the console, so a small mismatch never blanks the page.
 */

export const resumeKeys = {
  all: ['resumes'] as const,
  list: () => ['resumes', 'list'] as const,
  detail: (id: string) => ['resumes', 'detail', id] as const,
  /** What TailorIT read from one resume (under `all`, so `invalidateResumes` reads it again). */
  analysis: (id: string) => ['resumes', 'analysis', id] as const,
  /** The editable copies of several uploads (under `all`, so `invalidateResumes` reads it again). */
  copies: () => ['resumes', 'copies'] as const,
  /** v33 SKILLS: per field, as the field's skills lead the list ('' = no field). */
  skills: (type: SkillType, family: string | null = null) => ['skills', type, family ?? ''] as const,
};

// ------------------------------------------------------------------------------------------- lenient reading

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : {};
}

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const strOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const bool = (value: unknown): boolean => value === true;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const reported = new Set<string>();

/** Says once per answer kind that the API's answer differs from the shared contract (the integration report reads it). */
export function noteMismatch(where: string, detail: unknown): void {
  if (reported.has(where)) return;
  reported.add(where);
  console.warn(`[resumes] The answer of ${where} differs from the shared contract; reading it leniently.`, detail);
}

function readWith<T>(schema: ZodType<T>, raw: unknown, where: string, lenient: (raw: unknown) => T | null): T | null {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  noteMismatch(where, parsed.error.issues.slice(0, 5));
  return lenient(raw);
}

function readFileKind(value: unknown): ResumeFileKind | null {
  return (RESUME_FILE_KINDS as readonly unknown[]).includes(value) ? (value as ResumeFileKind) : null;
}

/** Years read off a resume (0 to 80), or null. */
export function readYears(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 80 ? value : null;
}

/** A list row's reading by hand: undefined when the answer has none, null when it says "not read yet". */
function leniBrief(value: unknown): ResumeAnalysisBrief | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = rec(value);
  const softSkillCount = Number(r.softSkillCount);
  return {
    yearsExperience: readYears(r.yearsExperience),
    hardSkills: strings(r.hardSkills),
    softSkillCount: Number.isInteger(softSkillCount) && softSkillCount >= 0 ? softSkillCount : 0,
    refining: bool(r.refining),
    aiWaiting: bool(r.aiWaiting),
  };
}

// v1.5 W
/** How a resume came to be, from an answer that may not say (an older API): an upload's is `upload`, else the editor's. */
function readMadeBy(value: unknown, kind: ResumeSummary['kind']): ResumeMadeBy {
  if (kind === 'uploaded') return 'upload';
  return value === 'copy' || value === 'tailor' ? value : 'editor';
}
// end v1.5 W

function leniSummary(raw: unknown): ResumeSummary | null {
  const r = rec(raw);
  const id = str(r.id);
  if (!id) return null;
  const kind = r.kind === 'uploaded' ? 'uploaded' : 'built';
  const document = rec(r.document);
  const title = strOrNull(r.title);
  const createdAt = str(r.createdAt);
  const analysis = leniBrief(r.analysis);
  return {
    id,
    kind,
    label: str(r.label) || resumeLabel({ name: str(document.name), title: str(document.title) }, title),
    title,
    templateId: strOrNull(r.templateId),
    templateName: strOrNull(r.templateName),
    isDefault: bool(r.isDefault),
    fileKind: readFileKind(r.fileKind),
    nameOnResume: str(r.nameOnResume) || str(document.name),
    madeBy: readMadeBy(r.madeBy, kind), // v1.5 W
    createdAt,
    updatedAt: str(r.updatedAt) || createdAt,
    lastEditedAt: strOrNull(r.lastEditedAt),
    ...(analysis !== undefined ? { analysis } : {}),
    ...(r.onPageEditor === true ? { onPageEditor: true } : {}),
  };
}

export function readResumeSummary(raw: unknown): ResumeSummary | null {
  return readWith(ResumeSummarySchema, raw, 'a resume summary', leniSummary);
}

/** `{ items: [...] }` (or a bare list) as summaries; entries that cannot be read are skipped. */
export function readResumeList(raw: unknown): ResumeSummary[] {
  const items = Array.isArray(raw) ? raw : Array.isArray(rec(raw).items) ? (rec(raw).items as unknown[]) : [];
  return items.map(readResumeSummary).filter((item): item is ResumeSummary => item !== null);
}

/** One resume as the editor opens it: its summary, its document (built) or file (uploaded). */
export interface ResumeView extends ResumeSummary {
  document: ResumeDocument | null;
  file: StoredFileInfo | null;
  hasExtractedText: boolean;
  /** The revision `document` is at (autosave starts from it); null when the answer did not say. */
  documentRevision: number | null;
}

function leniFile(value: unknown): StoredFileInfo | null {
  const file = rec(value);
  const id = str(file.id);
  if (!id) return null;
  const pageCount = Number(file.pageCount);
  return {
    id,
    name: str(file.name),
    mime: str(file.mime),
    sizeBytes: Number(file.sizeBytes) >= 0 ? Number(file.sizeBytes) : 0,
    pageCount: Number.isInteger(pageCount) && pageCount > 0 ? pageCount : null,
  };
}

export function readResumeView(raw: unknown): ResumeView | null {
  const parsed = ResumeDetailSchema.safeParse(raw);
  if (!parsed.success) noteMismatch('GET /api/resumes/:id', parsed.error.issues.slice(0, 5));
  const summary = parsed.success ? parsed.data : leniSummary(raw);
  if (!summary) return null;
  const r = rec(raw);
  const document = r.document && typeof r.document === 'object' ? normalizeResumeDocument(r.document) : null;
  return {
    ...summary,
    document: summary.kind === 'built' ? (document ?? normalizeResumeDocument({})) : document,
    file: leniFile(r.file),
    hasExtractedText: bool(r.hasExtractedText),
    documentRevision: Number.isInteger(r.documentRevision) && Number(r.documentRevision) >= 0 ? Number(r.documentRevision) : null,
  };
}

/** A first page: an image (an upload's PNG), or a built resume's document, which the page draws. */
export type ThumbAnswer =
  | { kind: 'image'; url: string }
  /** A built resume (an older one as the editor opens it): the page draws it from its document. */
  | { kind: 'document'; document: ResumeDocument };

/** GET /api/resumes/:id/thumbnail: `{kind:'document', document}` or `{kind:'image', url}`. */
export function readThumbnail(raw: unknown): ThumbAnswer | null {
  const r = rec(raw);
  if (r.kind === 'document' && r.document && typeof r.document === 'object') {
    return { kind: 'document', document: normalizeResumeDocument(r.document) };
  }
  if (typeof r.url === 'string' && r.url) return { kind: 'image', url: r.url };
  return null;
}

/** POST /api/resumes/bulk-delete: `{deleted, skippedIds}` (the contract) or `{deleted, skipped}`. */
export function readBulkDelete(raw: unknown, asked: number): { deleted: number; skipped: number; skippedIds: string[] } {
  const r = rec(raw);
  const deleted = Number(r.deleted);
  const skippedIds = strings(Array.isArray(r.skippedIds) ? r.skippedIds : r.skipped);
  const skipped = skippedIds.length || (Number.isFinite(Number(r.skipped)) ? Number(r.skipped) : 0);
  return { deleted: Number.isFinite(deleted) ? deleted : Math.max(0, asked - skipped), skipped, skippedIds };
}

function invalidAnswer(path: string): ApiError {
  return new ApiError({
    status: 200,
    code: 'internal',
    message: 'The server sent an answer this page does not understand. Please reload and try again.',
    path,
  });
}

/** The id a create, duplicate or import answered with (a detail, a summary, or `{ resume }`). */
export function readCreatedId(raw: unknown): string {
  const r = rec(raw);
  return str(r.id) || str(rec(r.resume).id);
}

/** An AI endpoint's `202 { taskId }`. */
export function readTaskId(raw: unknown, path: string): string {
  const id = str(rec(raw).taskId);
  if (!id) throw invalidAnswer(path);
  return id;
}

/** A finished `resume_import` task's `{ resumeId }`. */
export function readImportResult(result: unknown): string | null {
  return strOrNull(rec(result).resumeId);
}

function leniCopy(raw: unknown): ResumeCopy | null {
  const r = rec(raw);
  const id = str(r.id);
  const batchId = str(r.batchId);
  if (!id || !batchId || !(RESUME_COPY_STATES as readonly unknown[]).includes(r.state)) return null;
  return {
    id,
    batchId,
    label: str(r.label) || 'Uploaded resume',
    state: r.state as ResumeCopyState,
    resumeId: strOrNull(r.resumeId),
    error: strOrNull(r.error),
    retryable: bool(r.retryable),
  };
}

function leniPause(value: unknown): ResumeCopiesPause | null {
  const r = rec(value);
  if (!(RESUME_COPY_PAUSES as readonly unknown[]).includes(r.reason)) return null;
  return { reason: r.reason as ResumeCopiesPause['reason'], until: strOrNull(r.until) };
}

/**
 * GET /api/resumes/copies (and the answer of Stop the rest, Try again and Dismiss): the editable copies of several
 * uploads, and why those in line wait. Copies that cannot be read are skipped; a pause for an unknown reason is none.
 */
export function readResumeCopies(raw: unknown): ResumeCopiesResponse {
  const parsed = ResumeCopiesResponseSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  noteMismatch('GET /api/resumes/copies', parsed.error.issues.slice(0, 5));
  const r = rec(raw);
  const items = Array.isArray(r.items) ? (r.items as unknown[]) : [];
  return {
    items: items.map(leniCopy).filter((item): item is ResumeCopy => item !== null),
    paused: leniPause(r.paused),
  };
}

// ------------------------------------------------------------------------------------------------- the calls

const enc = encodeURIComponent;

export async function fetchResumes(signal?: AbortSignal): Promise<ResumeSummary[]> {
  return readResumeList(await api.get('/api/resumes', { query: { source: 'all' }, signal }));
}

export async function fetchResume(id: string, signal?: AbortSignal): Promise<ResumeView> {
  const view = readResumeView(await api.get(`/api/resumes/${enc(id)}`, { signal }));
  if (!view) throw invalidAnswer(`/api/resumes/${id}`);
  return view;
}

/** A change's answer: the resume as it now stands (null when the answer does not say). */
export interface SavedResume {
  id: string;
  summary: ResumeSummary | null;
}

function savedFrom(raw: unknown, fallbackId = ''): SavedResume {
  const summary = rec(raw).id ? readResumeSummary(raw) : null;
  return { id: summary?.id ?? (readCreatedId(raw) || fallbackId), summary };
}

/** PATCH /api/resumes/:id (Rename): '' or null goes back to the label rule. */
export async function renameResume(id: string, title: string | null): Promise<SavedResume> {
  return savedFrom(await api.patch(`/api/resumes/${enc(id)}`, { title }), id);
}

/** DELETE /api/resumes/:id → the default resume after it (the server moves it off a deleted default). */
export async function deleteResume(id: string): Promise<{ defaultResumeId: string | null | undefined }> {
  const answer = rec(await api.delete(`/api/resumes/${enc(id)}`));
  return { defaultResumeId: 'defaultResumeId' in answer ? strOrNull(answer.defaultResumeId) : undefined };
}

export async function duplicateResume(id: string): Promise<SavedResume> {
  return savedFrom(await api.post(`/api/resumes/${enc(id)}/duplicate`, {}));
}

export async function bulkDeleteResumes(ids: readonly string[]): Promise<{ deleted: number; skipped: number; skippedIds: string[] }> {
  return readBulkDelete(await api.post('/api/resumes/bulk-delete', { ids }), ids.length);
}

/** PUT /api/me/default-resume → the account as it now stands. */
export async function setDefaultResume(resumeId: string | null): Promise<Account | null> {
  const body = SetDefaultResumeBodySchema.parse({ resumeId });
  const answer = rec(await api.put('/api/me/default-resume', body));
  return answer.id ? (answer as unknown as Account) : null;
}

/**
 * POST /api/resumes/upload (multipart `file`, optional `title`). `parse` also asks for the AI import (an editable
 * copy), made on `templateId` and `layout` when they are given. Alone it starts at once (`taskId`); with `batch` (the
 * Upload dialog's id for its runs of several files) it waits in the server's copy line, `taskId` is null and GET
 * /api/resumes/copies follows it. The upload is kept even when that copy cannot start: `copyError` then says why.
 */
export async function uploadResume(
  file: File,
  options: { title?: string; parse?: boolean; templateId?: string; layout?: TechnicalSkillsLayout; batch?: string } = {},
): Promise<{ resume: ResumeSummary | null; taskId: string | null; copyError: string | null }> {
  const form = new FormData();
  form.append('file', file, file.name);
  if (options.title?.trim()) form.append('title', options.title.trim());
  const query = {
    parse: options.parse ? 1 : undefined,
    templateId: options.parse && options.templateId ? options.templateId : undefined,
    layout: options.parse && options.layout ? options.layout : undefined,
    batch: options.parse && options.batch ? options.batch : undefined,
  };
  const answer = rec(await api.post('/api/resumes/upload', form, { query }));
  return {
    resume: readResumeSummary(answer.resume ?? answer),
    taskId: strOrNull(answer.taskId),
    copyError: strOrNull(answer.copyError),
  };
}

/** POST /api/resumes/import-json with a file the browser already parsed. */
export async function importResumeJson(data: unknown, fileName: string): Promise<{ ids: string[]; imported: number }> {
  const answer = rec(await api.post('/api/resumes/import-json', { data, fileName: fileName.slice(0, 255) }));
  const ids = Array.isArray(answer.resumes) ? answer.resumes.map((item) => readCreatedId(item)).filter(Boolean) : [];
  const imported = Number(answer.imported);
  return { ids, imported: Number.isFinite(imported) ? imported : ids.length };
}

/**
 * POST /api/resumes/:id/parse (202): an editable copy of an uploaded file, a resume of the editor on `templateId`.
 * Without one the server picks it: the template picked for the upload's batch when its copy still waits there, else
 * the editor's default.
 */
export async function startEditableCopy(id: string, templateId?: ResumeTemplateId): Promise<string> {
  const path = `/api/resumes/${enc(id)}/parse`;
  return readTaskId(await api.post(path, templateId ? { templateId } : {}), path);
}

// v1.5 W
/**
 * POST /api/resumes/:id/edit (decision 3): what Edit opens. A built resume itself; an upload's editable copy, or, with
 * none, the copy's task, just started (or already being made). Read leniently, as every answer here is.
 */
export async function fetchEditTarget(id: string): Promise<ResumeEditTarget> {
  const raw = await api.post(`/api/resumes/${enc(id)}/edit`, {});
  const parsed = ResumeEditTargetSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  noteMismatch('POST /api/resumes/:id/edit', parsed.error.issues.slice(0, 5));
  const r = rec(raw);
  return { kind: r.kind === 'uploaded' ? 'uploaded' : 'built', label: str(r.label), resumeId: strOrNull(r.resumeId), taskId: strOrNull(r.taskId) };
}
// end v1.5 W

/** GET /api/resumes/copies: the editable copies of several uploads, one batch per Upload dialog. */
export async function fetchResumeCopies(signal?: AbortSignal): Promise<ResumeCopiesResponse> {
  return readResumeCopies(await api.get('/api/resumes/copies', { signal }));
}

/** Stop the rest, Try again or Dismiss for one batch of copies → the copies as they now stand. */
export async function changeResumeCopies(batchId: string, action: 'stop' | 'retry' | 'dismiss'): Promise<ResumeCopiesResponse> {
  return readResumeCopies(await api.post(`/api/resumes/copies/${enc(batchId)}/${action}`, {}));
}

/** A resume's first page. GET /api/resumes/:id/thumbnail (an upload with no picture answers 404). */
export async function fetchThumbnail(id: string, signal?: AbortSignal): Promise<ThumbAnswer> {
  const answer = readThumbnail(await api.get(`/api/resumes/${enc(id)}/thumbnail`, { signal }));
  if (answer) return answer;
  noteMismatch('GET /api/resumes/:id/thumbnail', 'neither a document nor a url');
  throw invalidAnswer(`/api/resumes/${id}/thumbnail`);
}

/** The library a skill box suggests from: the main skills, and each one's other spellings (aliases). */
export interface SkillLibraryList {
  skills: string[];
  /** Main skill -> its other spellings ("ASP.NET Core" of ".NET"). Empty for soft skills. */
  aliases: Record<string, string[]>;
}

/** v33 SKILLS: with `family` (the resume's field), the field's skills lead the list. */
export async function fetchSkills(type: SkillType, signal?: AbortSignal, family?: string | null): Promise<SkillLibraryList> {
  const answer = await api.get('/api/skills', { query: { type, family: family ?? undefined }, signal });
  if (Array.isArray(answer)) return { skills: strings(answer), aliases: {} };
  const aliases: Record<string, string[]> = {};
  for (const [skill, spellings] of Object.entries(rec(rec(answer).aliases))) aliases[skill] = strings(spellings);
  return { skills: strings(rec(answer).skills), aliases };
}

/**
 * POST /api/skills: a skill the library lacks, kept for this user; resolves to the spelling stored. v33 SKILLS: `family`
 * (the resume's field) files it under the field's heading when no rule places it.
 */
export async function addSkill(type: SkillType, skill: string, family?: string | null): Promise<string> {
  const answer = rec(await api.post('/api/skills', family ? { type, skill, family } : { type, skill }));
  return str(answer.skill) || skill;
}

const BULLETS_PATHS = ['/api/resumes/bullets', '/api/ai/resume-bullets'] as const;
let bulletsPath: string | null = null;

function isMissingRoute(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === 'not_found';
}

/**
 * Write with AI (202 { taskId }). The work package names POST /api/resumes/bullets and the shared contract
 * /api/ai/resume-bullets; whichever the API mounts answers, and is remembered.
 */
export async function requestBullets(body: BulletsRequest): Promise<string> {
  const paths = bulletsPath ? [bulletsPath] : BULLETS_PATHS;
  let lastError: unknown = null;
  for (const path of paths) {
    try {
      const taskId = readTaskId(await api.post(path, body), path);
      bulletsPath = path;
      return taskId;
    } catch (error) {
      lastError = error;
      if (!isMissingRoute(error) || bulletsPath) throw error;
      noteMismatch(`POST ${path}`, 'no such route');
    }
  }
  throw lastError;
}

/** A finished `entry_bullets` task's `{ bullets }`. */
export function readBulletsResult(result: unknown): string[] {
  return strings(rec(result).bullets);
}

// -------------------------------------------------------------------------------------------------- addresses

/** An uploaded resume's own file; `inline` shows a PDF in the browser instead of downloading it. */
export function resumeFileHref(id: string, inline = false): string {
  return `/api/resumes/${enc(id)}/file${inline ? '?inline=1' : ''}`;
}

export function resumeExportHref(id: string, format: 'pdf' | 'docx' | 'json'): string {
  return `/api/resumes/${enc(id)}/export?format=${format}`;
}

/** A stored resume's page: an upload's own page, or the editor for a built one (the page decides by its kind). */
export function resumeEditorHref(id: string): string {
  return `/resumes/${enc(id)}`;
}

// v1.5 W
/**
 * Edit for any resume (decision 3): a built one opens in the editor; an upload opens its editable copy, made first
 * when it has none (with progress). The extension opens this address too.
 */
export function resumeEditRouteHref(id: string): string {
  return `/resumes/${enc(id)}/edit`;
}
// end v1.5 W

/** A new resume: the template chooser, then (`templateId`) a blank page on that template. */
export const NEW_RESUME_HREF = '/resumes/new';

/**
 * A new resume's page on a template; `draftId` names the changes this browser keeps until the first save. `tailorId`
 * (v1.4 E): the draft starts from that stored resume's content, on this template, instead of a blank page; nothing is
 * stored until the first change, which creates a new resume.
 */
export function newResumeHref(templateId: ResumeTemplateId, draftId?: string, tailorId?: string): string {
  return `${NEW_RESUME_HREF}?template=${enc(templateId)}${draftId ? `&draft=${enc(draftId)}` : ''}${tailorId ? `&tailor=${enc(tailorId)}` : ''}`;
}
export const RESUMES_TAB_HREF = '/documents?tab=resumes';
