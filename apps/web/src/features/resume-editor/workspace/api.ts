import { normalizeResumeDocument, type ResumeDocument } from '@tailorit/shared';
import { api, ApiError, isApiError } from '@/lib/api';
import type { SaveCallOptions, SaveTransport } from '../save/saveQueue';

// The on-page editor's calls: its read of a resume (an older document comes upgraded by the server) and the two
// saves autosave makes. A save sends the whole document and the revision it was made from, and reads back only the
// new revision: the document being edited is never replaced by an answer.

export interface EditorResume {
  id: string;
  label: string;
  title: string | null;
  documentRevision: number;
  document: ResumeDocument;
}

export const editorKeys = {
  resume: (id: string) => ['resumes', 'editor', id] as const,
};

/** A save answered with a body this page does not understand; the save itself may have worked. */
function badAnswer(path: string): ApiError {
  return new ApiError({ status: 500, code: 'internal', message: 'The server sent an answer this page does not understand.', path });
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const revisionOf = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);

export async function fetchEditorResume(id: string, signal?: AbortSignal): Promise<EditorResume> {
  const path = `/api/resumes/${encodeURIComponent(id)}/editor`;
  const answer = record(await api.get(path, { signal }));
  const revision = revisionOf(answer.documentRevision);
  if (typeof answer.id !== 'string' || revision === null || !answer.document) throw badAnswer(path);
  return {
    id: answer.id,
    label: typeof answer.label === 'string' ? answer.label : 'Resume',
    title: typeof answer.title === 'string' ? answer.title : null,
    documentRevision: revision,
    document: normalizeResumeDocument(answer.document),
  };
}

/** Browsers cap a keepalive request's body near 64 KB: a larger save leaving the page goes as an ordinary one. */
const KEEPALIVE_MAX_BYTES = 60_000;
const keepaliveFor = (options: SaveCallOptions, body: object) =>
  options.keepalive === true && new TextEncoder().encode(JSON.stringify(body)).length < KEEPALIVE_MAX_BYTES;

/** An answer the Next proxy gives when the API is down counts as unreachable, as a dropped connection does. */
function asSaveFailure(error: unknown): unknown {
  return isApiError(error) && error.isUnreachable ? { status: 0, code: error.code, message: error.message } : error;
}

export const editorSaveTransport: SaveTransport<ResumeDocument> = {
  async create(document: ResumeDocument, options: SaveCallOptions) {
    try {
      const body = { document };
      const answer = record(await api.post('/api/resumes', body, { keepalive: keepaliveFor(options, body) }));
      const revision = revisionOf(answer.documentRevision);
      if (typeof answer.id !== 'string' || revision === null) throw badAnswer('/api/resumes');
      return { id: answer.id, documentRevision: revision };
    } catch (error) {
      throw asSaveFailure(error);
    }
  },
  async update(id: string, document: ResumeDocument, baseRevision: number, options: SaveCallOptions) {
    const path = `/api/resumes/${encodeURIComponent(id)}`;
    try {
      const body = { document, baseRevision };
      const answer = record(await api.put(path, body, { keepalive: keepaliveFor(options, body) }));
      const revision = revisionOf(answer.documentRevision);
      if (revision === null) throw badAnswer(path);
      return { documentRevision: revision };
    } catch (error) {
      throw asSaveFailure(error);
    }
  },
};
