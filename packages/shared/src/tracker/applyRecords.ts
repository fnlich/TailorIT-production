import { z } from 'zod';
import { IsoDate, IsoDateTime } from '../core/list';

export const APPLY_VIAS = ['agent', 'tab', 'manual', 'page', 'tracker', 'legacy'] as const;
export type ApplyVia = (typeof APPLY_VIAS)[number];
export const APPLY_RECORD_ANSWERS = ['submitted', 'prepared', 'none'] as const;
export type ApplyRecordAnswers = (typeof APPLY_RECORD_ANSWERS)[number];

/**
 * A document an apply record names. v30 DB-JOBS (docs/design/part2/11-database.md §5.8): the live document while it is
 * as it was sent; once it was edited or deleted after the application, the snapshot frozen at that moment (its title
 * then, `snapshotId` set; `id` stays the document's id, which may name a deleted one).
 */
export const ApplyRecordDocumentRefSchema = z.object({
  id: z.string(),
  title: z.string(),
  snapshotId: z.number().int().positive().optional(),
});
export type ApplyRecordDocumentRef = z.infer<typeof ApplyRecordDocumentRefSchema>;

export const ApplyRecordSchema = z.object({
  id: z.number().int().positive(),
  via: z.enum(APPLY_VIAS),
  appliedAt: IsoDateTime,
  dayKey: IsoDate,
  prepareId: z.string().nullable(),
  resume: ApplyRecordDocumentRefSchema.nullable(),
  coverLetter: ApplyRecordDocumentRefSchema.nullable(),
  answers: z.enum(APPLY_RECORD_ANSWERS),
  answerCount: z.number().int().nonnegative(),
});
export type ApplyRecord = z.infer<typeof ApplyRecordSchema>;
export const ApplyRecordListSchema = z.object({ items: z.array(ApplyRecordSchema) });
export type ApplyRecordList = z.infer<typeof ApplyRecordListSchema>;

// v30 DB-JOBS: what one record was sent with, exactly (GET /api/applications/:id/apply-records/:recordId/documents).

/** Where a sent document is read from: the live document (unchanged since), or its frozen snapshot. */
export const APPLY_RECORD_DOCUMENT_SOURCES = ['live', 'snapshot'] as const;
export type ApplyRecordDocumentSource = (typeof APPLY_RECORD_DOCUMENT_SOURCES)[number];

/** The resume as sent: a built resume's document, or an upload's stored file and the text read from it. */
export const ApplyRecordSentResumeSchema = z.object({
  source: z.enum(APPLY_RECORD_DOCUMENT_SOURCES),
  resumeId: z.string().nullable(),
  revision: z.number().int().nonnegative().nullable(),
  title: z.string(),
  kind: z.enum(['built', 'uploaded']),
  /** A built resume's document (the editor's shape), else null. */
  document: z.unknown().nullable(),
  /** An upload's stored file, else null. */
  fileId: z.string().nullable(),
  /** An upload's text as read, else null. */
  extractedText: z.string().nullable(),
});
export type ApplyRecordSentResume = z.infer<typeof ApplyRecordSentResumeSchema>;

/** The cover letter as sent. */
export const ApplyRecordSentLetterSchema = z.object({
  source: z.enum(APPLY_RECORD_DOCUMENT_SOURCES),
  letterId: z.string().nullable(),
  revision: z.number().int().nonnegative().nullable(),
  title: z.string(),
  html: z.string(),
  text: z.string(),
});
export type ApplyRecordSentLetter = z.infer<typeof ApplyRecordSentLetterSchema>;

/** One answer as the record keeps it (the form's label, the answer's stored value). */
export const ApplyRecordAnswerSchema = z.object({ label: z.string(), answer: z.unknown() });

export const ApplyRecordDocumentsSchema = z.object({
  recordId: z.number().int().positive(),
  resume: ApplyRecordSentResumeSchema.nullable(),
  coverLetter: ApplyRecordSentLetterSchema.nullable(),
  answers: z.enum(APPLY_RECORD_ANSWERS),
  /** The answers kept in the record (prepared ones, or a submission a later one replaced); null: none kept there. */
  answersUsed: z.array(ApplyRecordAnswerSchema).nullable(),
  /** The posting text's version applied to (the job's content hash then), or null. */
  postingHash: z.string().nullable(),
});
export type ApplyRecordDocuments = z.infer<typeof ApplyRecordDocumentsSchema>;
