'use client';

import { SHEET_MAX_ROWS, type JobImportDetail, type JobImportRowOutcome } from '@tailorit/shared';
import { usePublicConstants } from '@/lib/constants';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AdminResourceTab } from '@/components/admin';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PlusIcon } from '@/components/ui/icons';
import { SegmentedControl, TabPanel } from '@/components/ui/SegmentedControl';
import type { StartedImport } from '../../../imports/api';
import { FileImport } from '../../../imports/FileImport';
import { ImportResults } from '../../../imports/ImportResults';
import { importReviewLanes } from '../../../imports/results';
import { SheetImport } from '../../../imports/SheetImport';
import { reviewKeys } from '../review/api';
import { importModeSearch, importSearch, modeOfSearch, runOfSearch, runsImportSearch, type ImportMode } from './address';
import { adminSearch } from '../sources/links';
import { adminImportKeys } from './api';
import { ManyLinks } from './ManyLinks';
import { OneLinkImport } from './OneLinkImport';
import { RecentImports } from './RecentImports';

// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §2; PLAN H1, H2, H6): Admin › Import (the tab once called "Import
// links"). Four ways: One link (its details shown directly), Many links (pasted; rows copied from a spreadsheet show
// the mapping preview), a File (.csv .tsv .txt .json .xlsx) and a Google Sheet tab. Each import is one run on Runs.
// After Import, its results (features/imports/ImportResults: counts as chips, rows, Download these rows) with "See it
// on Runs" and, while rows wait for a review, Review › Couldn't verify filtered to it. Recent imports lists every
// import (Open, and a sheet's Import again). One import's results are the address ?tab=import&run=<runId> (Runs' "Open
// results" opens it too). v35 INT-B: "See it on Runs" is ?tab=runs&run=<runId> (Runs opens that run).
// v35 FIX-WEB (the final review): the rows' reasons are the API's words (an admin's import: Review's wording, item 10);
// "Review in Couldn't verify" names no number that goes stale once rows are decided (L9); an import that is not there
// says so with New import and Recent imports (L11); the way in is the address's `mode=` (decision 7: the Admin header's
// Add links opens ?tab=import&mode=many, focus in its box).

/** v35 FIX-WEB (L9): the words of the import's ways to Review. */
export const IMPORT_REVIEW_LINK = { unverified: "Review in Couldn't verify", new_job: 'Review in New jobs' } as const;

const MODES: ReadonlyArray<{ value: ImportMode; label: string }> = [
  { value: 'link', label: 'One link' },
  { value: 'many', label: 'Many links' },
  { value: 'file', label: 'File' },
  { value: 'sheet', label: 'Google Sheet' },
];

export function ImportTab() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const runId = runOfSearch(searchParams.get('run'));
  // v35 FIX-WEB (decision 7): the way in is the address's (`mode=`), so the Admin header's Add links opens Many links
  // from any tab, an import's results included.
  const mode = modeOfSearch(searchParams.get('mode'));
  const setMode = (next: ImportMode) => router.replace(`${pathname}${importModeSearch(next)}`, { scroll: false });
  const { t } = usePublicConstants();
  // The limits of a file or a sheet (an admin's: SHEET_MAX_ROWS).
  const fileLimits = () => t('MSG_JOB_IMPORT_ROWS_UP_TO', { max: SHEET_MAX_ROWS.toLocaleString('en-US') });

  const open = (run: number | null) => {
    router.replace(`${pathname}${importSearch(run, mode)}`, { scroll: false });
  };
  const started = (startedImport: StartedImport) => {
    void queryClient.invalidateQueries({ queryKey: adminImportKeys.recent });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'runs'] });
    open(startedImport.id);
  };
  const finished = () => {
    void queryClient.invalidateQueries({ queryKey: adminImportKeys.recent });
    // Rows that wait for a review land in Review's lanes: their counts are read again.
    void queryClient.invalidateQueries({ queryKey: reviewKeys.all });
  };

  const resultActions = (detail: JobImportDetail, rows: readonly JobImportRowOutcome[]) => (
    <>
      {runId !== null && (
        <Link href={`${pathname}${runsImportSearch(runId)}`} className={buttonClasses({ variant: 'outline', size: 'sm' })} data-import-runs="">
          See it on Runs
        </Link>
      )}
      {/* v35 FIX-WEB (L9): no number (the import's count stays as it was once rows are decided; the lanes count), and
          New jobs too when rows wait there (FIX-PIPE's D4: a reopened New jobs review is To review as well). */}
      {runId !== null &&
        importReviewLanes(detail.counts, rows).map((lane) => (
          <Link
            key={lane}
            href={`${pathname}${adminSearch({ tab: 'review', lane, run: runId })}`}
            className={buttonClasses({ variant: 'outline', size: 'sm' })}
            data-import-review={lane}
          >
            {IMPORT_REVIEW_LINK[lane]}
          </Link>
        ))}
      <Button size="sm" icon={<PlusIcon size={14} />} onClick={() => open(null)} data-import-new="">
        New import
      </Button>
    </>
  );

  return (
    <AdminResourceTab
      title="Import"
      description="Import job links one at a time, pasted, from a file or from a Google Sheet; TailorIT reads each posting from its link."
      sectionProps={{ 'data-import-links': '' }}
      body={
        <div className="flex flex-col gap-8">
          {runId !== null ? (
            <Card padding="lg" data-import-open-run={runId}>
              <ImportResults
                key={runId}
                audience="admin"
                id={runId}
                actions={resultActions}
                onFinished={finished}
                goneActions={
                  <>
                    <Button size="sm" icon={<PlusIcon size={14} />} onClick={() => open(null)} data-import-new="">
                      New import
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => document.getElementById('recent-imports-heading')?.focus()}>
                      Recent imports
                    </Button>
                  </>
                }
                focusHeading
              />
            </Card>
          ) : (
            <SegmentedControl aria-label="Import from" items={MODES} value={mode} onValueChange={setMode} listClassName="max-sm:h-11">
              <TabPanel value="link" className="mt-5">
                <Card padding="lg">
                  <OneLinkImport onStarted={started} />
                </Card>
              </TabPanel>
              <TabPanel value="many" className="mt-5">
                <Card padding="lg">
                  <ManyLinks onStarted={started} focusOnShow={searchParams.get('mode') === 'many'} />
                </Card>
              </TabPanel>
              <TabPanel value="file" className="mt-5">
                <Card padding="lg">
                  <FileImport audience="admin" limits={fileLimits} onStarted={started} />
                </Card>
              </TabPanel>
              <TabPanel value="sheet" className="mt-5">
                <Card padding="lg">
                  <SheetImport
                    audience="admin"
                    offLine="Google Sheet import is off: this server has no Google service account key (SETUP.md says how to add one)."
                    limits={fileLimits}
                    onStarted={started}
                  />
                </Card>
              </TabPanel>
            </SegmentedControl>
          )}
          <RecentImports onOpen={open} onStarted={started} openRunId={runId} />
        </div>
      }
    />
  );
}
