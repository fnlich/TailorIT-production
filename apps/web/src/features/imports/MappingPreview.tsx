'use client';

import type { JobImportPreview, JobRowMapping } from '@tailorit/shared';
import { clsx } from 'clsx';
import { useId, type ReactNode } from 'react';
import { ScrollRegion } from '@/components/admin';
import { HelpTip } from '@/components/ui/HelpTip';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { COLUMN_USES, COLUMN_USE_LABEL, previewCountText, columnUseOf, withColumnUse, type ColumnUse } from './mapping';

// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §1 "The mapping preview"; PLAN H1): the first rows of a file, a sheet's
// tab or pasted rows as a table, with a select above each column (Link, Company, Title, Description, Rate, Location, Not
// used) holding the API's guess; "First row is a header" as a switch when the API was unsure (mapping.ts headerUnsure).
// Each cell is shown as text. At a phone's width the table scrolls inside its own box. Nothing is saved.

/** The problems listed under the table (the API names the first 20). */
const PROBLEMS_SHOWN = 5;

export interface MappingPreviewProps {
  preview: JobImportPreview;
  /** The mapping shown (the preview's, or the one just chosen while its preview loads). */
  mapping: JobRowMapping;
  onMappingChange: (next: JobRowMapping) => void;
  /** "First row is a header": shown when given (the caller decides when the API was unsure). */
  header?: { checked: boolean; onChange: (checked: boolean) => void } | null;
  /** While a new preview is read: the selects wait. */
  busy?: boolean;
  /** Above the columns: a file's sheet choice, a sheet's tab choice. */
  lead?: ReactNode;
}

export function MappingPreview({ preview, mapping, onMappingChange, header = null, busy = false, lead }: MappingPreviewProps) {
  const headingId = useId();
  const options = COLUMN_USES.map((use) => ({ value: use, label: COLUMN_USE_LABEL[use] }));
  const numbers = preview.rows.map((row) => row.row);
  const problems = preview.problems;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4" data-import-mapping="" aria-busy={busy || undefined}>
      {lead}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="flex items-center gap-1.5">
          <h3 id={headingId} className="text-[15px] leading-5 font-semibold text-foreground">
            Columns
          </h3>
          <HelpTip label="Columns">
            Only the link is required; the other columns are used when TailorIT can&apos;t read the link.
          </HelpTip>
        </span>
        <p className="text-[13px] leading-5 text-muted-foreground" aria-live="polite" data-import-count="">
          {previewCountText(preview)}
        </p>
      </div>
      {header && (
        <div data-import-header="">
          <Switch checked={header.checked} onCheckedChange={header.onChange} disabled={busy} label="First row is a header" />
        </div>
      )}
      <ScrollRegion label={`First rows of ${preview.name}`} className="rounded-card border border-border bg-surface shadow-card">
        <table className="w-full border-collapse text-left" aria-label={`First rows of ${preview.name}`} data-import-sample="">
          <thead>
            <tr className="border-b border-border bg-surface-low align-bottom">
              <th scope="col" className="w-14 px-3 py-2.5 text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
                Row
              </th>
              {preview.columns.map((column) => {
                const use: ColumnUse = columnUseOf(mapping, column);
                return (
                  <th key={column} scope="col" className="min-w-40 px-3 py-2.5 align-bottom font-normal" data-import-column={column}>
                    <span className="mb-1.5 block truncate text-[13px] leading-5 font-semibold text-foreground" title={column}>
                      {column}
                    </span>
                    <Select
                      aria-label={`What "${column}" holds`}
                      options={options}
                      value={use}
                      disabled={busy}
                      size="sm"
                      className={clsx('w-full', use === 'link' && 'border-primary')}
                      onValueChange={(next) => onMappingChange(withColumnUse(mapping, column, next))}
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-divider-soft">
            {preview.sample.map((cells, index) => (
              <tr key={numbers[index] ?? index} className="align-top">
                <th scope="row" className="num px-3 py-2.5 text-[13px] leading-5 font-normal text-muted-foreground">
                  {numbers[index] ?? index + 1}
                </th>
                {preview.columns.map((column) => (
                  <td key={column} className="max-w-72 px-3 py-2.5 text-[13px] leading-5 break-words text-foreground">
                    <span className="line-clamp-3">{cells[column] || '-'}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      {problems.length > 0 && (
        <Notice tone="warning" title={problems.length === 1 ? 'A row will be skipped' : 'Some rows will be skipped'}>
          <ul className="list-disc pl-5" data-import-problems="">
            {problems.slice(0, PROBLEMS_SHOWN).map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          {problems.length > PROBLEMS_SHOWN && <p className="mt-1">And {problems.length - PROBLEMS_SHOWN} more.</p>}
        </Notice>
      )}
    </section>
  );
}
