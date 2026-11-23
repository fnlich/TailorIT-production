'use client';

import type { JobImportPreview } from '@tailorit/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { DialogFooter } from '@/components/ui/Dialog';
import { PlusIcon } from '@/components/ui/icons';
import { usePublicConstants } from '@/lib/constants';
import type { StartedImport } from '../../imports/api';
import { FileImport } from '../../imports/FileImport';
import { ImportResults } from '../../imports/ImportResults';
import { SheetImport } from '../../imports/SheetImport';
import { jobsKeys } from '../api';
import type { LatestImport } from './latest';
import { ADD_JOB_COPY, importLimitsText } from './outcome';

// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §3): Jobs › Add job › File and › Google Sheet: the mapping preview, the
// person's rows left today and the per-file limit (JOB_IMPORT_ROWS_MAX), Import, then its results. The jobs are saved
// to the Job Tracker of the profile in use. Closing the dialog while it runs is fine: the bell says when an import of
// more than JOB_IMPORT_NOTICE_MIN_ROWS rows finishes, and reopening Add job shows the latest import's results
// (latest.ts).

/** The tracker's React Query keys all start with 'tracker'. */
const TRACKER_KEY = ['tracker'] as const;

export interface ImportPanelProps {
  way: 'file' | 'sheet';
  /** The latest import remembered (of either way): its results show on its own way's tab. */
  latest: LatestImport | null;
  onLatest: (next: LatestImport | null) => void;
  /** "Open job" on a row: the page shows it (the dialog closes). */
  onOpenJob: (jobId: number) => void;
  onClose: () => void;
}

export function ImportPanel({ way, latest, onLatest, onOpenJob, onClose }: ImportPanelProps) {
  const client = useQueryClient();
  const { get, t } = usePublicConstants();
  const shown = latest && latest.way === way ? latest : null;
  const limits = (preview: JobImportPreview) => importLimitsText(get('JOB_IMPORT_ROWS_MAX'), preview.rowsLeftToday ?? null, t);
  const refresh = () =>
    void Promise.all([client.invalidateQueries({ queryKey: jobsKeys.all }), client.invalidateQueries({ queryKey: TRACKER_KEY })]);
  const started = (startedImport: StartedImport) => {
    onLatest({ id: startedImport.id, way, startedAt: Date.now() });
    refresh();
  };

  if (shown) {
    return (
      <div className="flex min-w-0 flex-col" data-add-job-import-results={shown.id}>
        <ImportResults
          key={shown.id}
          audience="people"
          id={shown.id}
          onOpenJob={(jobId) => {
            onOpenJob(jobId);
            onClose();
          }}
          onFinished={refresh}
          onGone={() => onLatest(null)}
          focusHeading
        />
        <DialogFooter>
          <Button variant="outline" icon={<PlusIcon size={16} />} onClick={() => onLatest(null)} data-import-new="">
            {ADD_JOB_COPY.newImport}
          </Button>
          <Button onClick={onClose}>{ADD_JOB_COPY.done}</Button>
        </DialogFooter>
      </div>
    );
  }
  return way === 'file' ? (
    <FileImport audience="people" limits={limits} onStarted={started} />
  ) : (
    <SheetImport audience="people" offLine={ADD_JOB_COPY.sheetsOff} limits={limits} onStarted={started} />
  );
}
