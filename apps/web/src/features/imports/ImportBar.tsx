'use client';

import type { JobImportPreview, JobRowMapping } from '@tailorit/shared';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { HelpTip } from '@/components/ui/HelpTip';
import { Notice } from '@/components/ui/Notice';
import { usePublicConstants } from '@/lib/constants';
import { hasLinkColumn, importRowsText } from './mapping';

// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §1-§3): the foot of every import: its limits in a line (a person's rows
// left today, the most rows an import takes), and Import, which stays off until a column is the link (a "?" beside it
// says why), while the import has more rows than it takes, or while a person has no rows left today (a line says so).
// v35 FIX-WEB (the final ux review's M1, decision 11): rows past a person's room today are not imported; when only some
// of the file's rows fit, a warning line says so before Import (MSG_JOB_IMPORT_OVER_TODAY), and the none-left line is a
// public constant in the results' own words (MSG_JOB_IMPORT_NONE_LEFT_TODAY: "in 24 hours").

export type ImportBlock = { kind: 'no_link' | 'too_many' | 'none_left'; text: string };

/** Why Import is off, or null: no link column, more rows than an import takes, no row left today. */
export function importBlocked(
  preview: Pick<JobImportPreview, 'rowCount' | 'maxRows' | 'rowsLeftToday'>,
  mapping: Partial<JobRowMapping> | null,
  words: { noLink: string; tooMany: string; noneLeft: string },
): ImportBlock | null {
  if (!hasLinkColumn(mapping)) return { kind: 'no_link', text: words.noLink };
  if (preview.rowCount > preview.maxRows) return { kind: 'too_many', text: words.tooMany };
  if (preview.rowsLeftToday === 0) return { kind: 'none_left', text: words.noneLeft };
  return null;
}

/**
 * v35 FIX-WEB (M1): how many of the rows to read fit in a person's room today, when not all do: `fit` are imported, the
 * other `over` are not (null: they all fit, there is no limit, or none is left: Import is off then). The rows to read are
 * the preview's `linkCount` (a row with no link or a repeat is never read, so it takes no room).
 */
export function overToday(preview: Pick<JobImportPreview, 'linkCount' | 'rowsLeftToday'>): { fit: number; over: number } | null {
  const left = preview.rowsLeftToday;
  if (left === null || left === undefined || left === 0 || preview.linkCount <= left) return null;
  return { fit: left, over: preview.linkCount - left };
}

export interface ImportBarProps {
  preview: JobImportPreview;
  mapping: JobRowMapping | null;
  /** A preview is being read (Import waits for it). */
  busy: boolean;
  importing: boolean;
  onImport: () => void;
  /** The limits' line ("Up to 200 rows a file or sheet. You can import 80 more rows today."). */
  limits?: ReactNode;
}

export function ImportBar({ preview, mapping, busy, importing, onImport, limits }: ImportBarProps) {
  const { t } = usePublicConstants();
  const blocked = importBlocked(preview, mapping, {
    noLink: t('MSG_JOB_IMPORT_NO_LINK_COLUMN'),
    tooMany: t('MSG_JOB_IMPORT_TOO_MANY_ROWS', { max: preview.maxRows, rows: preview.rowCount }),
    noneLeft: t('MSG_JOB_IMPORT_NONE_LEFT_TODAY'),
  });
  const over = blocked ? null : overToday(preview);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-divider-soft pt-4" data-import-bar="">
      <div className="min-w-0 flex-1 basis-64 text-[13px] leading-5 text-muted-foreground" data-import-limits="">
        {limits}
      </div>
      <span className="flex items-center gap-1.5">
        {blocked?.kind === 'no_link' && (
          <HelpTip label="Why Import is off" side="top" align="end">
            {blocked.text}
          </HelpTip>
        )}
        <Button onClick={onImport} loading={importing} disabled={Boolean(blocked) || busy} data-import-start="">
          {importRowsText(preview.rowCount)}
        </Button>
      </span>
      {blocked && blocked.kind !== 'no_link' && (
        <p className="w-full text-[13px] leading-5 font-medium text-danger-ink" data-import-blocked={blocked.kind}>
          {blocked.text}
        </p>
      )}
      {/* v35 FIX-WEB (M1): said before Import, as an alert (it changes what Import does). */}
      {over && (
        <div className="w-full" data-import-over-today={over.over}>
          <Notice tone="warning">{t('MSG_JOB_IMPORT_OVER_TODAY', { fit: over.fit.toLocaleString('en-US'), over: over.over.toLocaleString('en-US') })}</Notice>
        </div>
      )}
    </div>
  );
}
