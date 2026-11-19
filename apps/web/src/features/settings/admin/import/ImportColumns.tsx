'use client';

import type { ReactNode } from 'react';
import { AdminTable, type AdminColumn } from '@/components/admin';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field, FieldLabel } from '@/components/ui/Field';
import { HelpTip } from '@/components/ui/HelpTip';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { userMessage } from '@/lib/api';
import { LinkProgress } from '../links/LinkProgress';
import { runBatchId } from '../links/links';
import type { ImportField, ImportMapping, ImportPreview, ImportResult } from '../types';
import { chosenFields, ignoredColumns, ignoredText, linkCountText, missingFields } from './linkColumns';

const NONE = '__none';

export interface ImportColumnsProps {
  preview: ImportPreview;
  /** The mapping shown (the preview's, or the one just chosen while its preview loads). */
  mapping: ImportMapping;
  onRemap: (field: ImportField, column: string | null) => void;
  /** The count line's ending: "CSV", "JSON", "Google Sheet". */
  countLabel: string;
  /** The accessible name of the first-rows table ("First rows of the file"). */
  sampleLabel: string;
  /** "Not in this file", "Not in this tab". */
  noneLabel: string;
  name: string;
  onNameChange: (value: string) => void;
  onNameBlur?: () => void;
  namePlaceholder: string;
  nameHint: ReactNode;
  importing: boolean;
  importDisabled: boolean;
  onImport: () => void;
  /** Shown at the top of the columns card. */
  notices?: ReactNode;
}

/**
 * The second step of an import (v31 ADMINWEB: of links): which column holds the job links (and any other column the
 * server still needs to read a row), the columns TailorIT ignores, the rows that will be skipped, the first links, and
 * the source name with the Import button. Shared by the file and the Google Sheet imports.
 */
export function ImportColumns({
  preview,
  mapping,
  onRemap,
  countLabel,
  sampleLabel,
  noneLabel,
  name,
  onNameChange,
  onNameBlur,
  namePlaceholder,
  nameHint,
  importing,
  importDisabled,
  onImport,
  notices,
}: ImportColumnsProps) {
  const fields = chosenFields(preview);
  const missing = missingFields(preview, mapping);
  const ignored = ignoredColumns(preview, mapping);
  const sampleColumns: AdminColumn<Record<string, string>>[] = fields
    .filter((field) => mapping[field.field])
    .map((field) => ({
      key: field.field,
      header: field.label,
      cell: (row: Record<string, string>) => <span className="line-clamp-2 break-all">{row[mapping[field.field]!] || '-'}</span>,
    }));

  return (
    <div className="flex flex-col gap-6" data-import-columns="">
      <Card padding="lg">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          {/* v32 COPY (E5): what a column other than the link does is the heading's "?". */}
          <span className="flex items-center gap-1.5">
            <h3 className="text-[15px] leading-5 font-semibold text-foreground">Columns</h3>
            <HelpTip label="Columns">Only the link column is read; the others only name a row in a message.</HelpTip>
          </span>
          <p className="text-[13px] leading-5 text-muted-foreground" aria-live="polite" data-import-count="">
            {linkCountText(preview, countLabel)}
          </p>
        </div>
        {notices && <div className="mt-4 flex flex-col gap-3">{notices}</div>}
        <div className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {fields.map((field) => (
            <div key={field.field} className="flex flex-col gap-1.5">
              <FieldLabel required={field.required}>{field.field === 'url' ? 'Job link column' : field.label}</FieldLabel>
              <Select
                aria-label={field.label}
                options={[{ value: NONE, label: noneLabel }, ...preview.columns.map((column) => ({ value: column, label: column }))]}
                value={mapping[field.field] ?? NONE}
                onValueChange={(column) => onRemap(field.field, column === NONE ? null : column)}
              />
            </div>
          ))}
        </div>
        {missing.length > 0 && (
          <Notice tone="warning" className="mt-5">
            Choose the column for {missing.join(', ')}.
          </Notice>
        )}
        <div className="mt-5 border-t border-divider-soft pt-4" data-import-ignored="">
          <p className="flex items-center gap-1.5 text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
            <span>
              Ignored columns <span className="num">{ignored.length}</span>
            </span>
            <HelpTip label="Ignored columns">{ignoredText(ignored.length)}</HelpTip>
          </p>
          {ignored.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Ignored columns">
              {ignored.map((column) => (
                <li key={column}>
                  <Badge tone="neutral">{column}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
        {preview.problems.length > 0 && (
          <Notice tone="warning" className="mt-5" title="Some rows will be skipped">
            <ul className="list-disc pl-5">
              {preview.problems.slice(0, 8).map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
            {preview.problems.length > 8 && <p className="mt-1">And {preview.problems.length - 8} more.</p>}
          </Notice>
        )}
      </Card>

      {sampleColumns.length > 0 && preview.sample.length > 0 && (
        <div>
          <h3 className="mb-3 text-[15px] leading-5 font-semibold text-foreground">First rows</h3>
          <AdminTable aria-label={sampleLabel} items={preview.sample} columns={sampleColumns} getKey={(row) => preview.sample.indexOf(row)} />
        </div>
      )}

      <Card padding="lg" className="flex flex-wrap items-end gap-4">
        <Field label="Source name" optional hint={nameHint} className="min-w-64 flex-1">
          <Input value={name} onChange={(event) => onNameChange(event.target.value)} onBlur={onNameBlur} placeholder={namePlaceholder} />
        </Field>
        <Button onClick={onImport} loading={importing} disabled={missing.length > 0 || preview.jobCount === 0 || importDisabled}>
          Import {preview.jobCount} {preview.jobCount === 1 ? 'link' : 'links'}
        </Button>
      </Card>
    </div>
  );
}

/**
 * How an import went: v31 ADMINWEB: its run queued the links (the answer's `links` note, LINK2's, says which column was
 * read and which were ignored), then how far TailorIT got reading them (`run:<runId>`); or that it continues in the
 * background; a failure's sentence.
 */
export function ImportResultNotice({
  result,
  error,
  noun,
  onShowRuns,
}: {
  result: ImportResult | null;
  error: unknown;
  /** What was imported: "file" or "tab". */
  noun: 'file' | 'tab';
  onShowRuns: (sourceId: number) => void;
}) {
  const failed = result?.run?.status === 'failed';
  return (
    <>
      {error ? (
        <Notice tone="error" className="mt-6">
          {userMessage(error)}
        </Notice>
      ) : null}
      {result && (
        <div className="mt-6 flex flex-col gap-4" data-import-result={result.runId}>
          <Notice
            tone={!result.run ? 'info' : failed ? 'error' : result.run.status === 'partial' ? 'warning' : 'success'}
            title={!result.run ? `Importing into ${result.source.name}` : failed ? 'The import failed' : `Imported into ${result.source.name}`}
            action={
              <Button variant="outline" size="sm" onClick={() => onShowRuns(result.source.id)}>
                See the run
              </Button>
            }
          >
            {!result.run
              ? noun === 'file'
                ? 'This file is large, so it is importing in the background. Its run shows the progress.'
                : 'This tab is importing in the background. Its run shows the progress.'
              : failed
                ? (result.run.error ?? 'Its run says why.')
                : (result.links?.message ?? `TailorIT reads each posting from its link; the other columns of this ${noun} are ignored.`)}
          </Notice>
          {!failed && (
            <Card padding="md">
              <LinkProgress batchId={runBatchId(result.runId)} />
            </Card>
          )}
        </div>
      )}
    </>
  );
}
