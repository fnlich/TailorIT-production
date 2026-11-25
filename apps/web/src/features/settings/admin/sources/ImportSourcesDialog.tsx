'use client';

import { ADMIN_SOURCES_IMPORT_OUTCOMES, type AdminSourcesImportOutcome, type AdminSourcesImportResult } from '@tailorit/shared/sourcing';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ScrollRegion } from '@/components/admin';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Notice } from '@/components/ui/Notice';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select'; // v37 FIX-37B (TRANSFER's open item, ux L13)
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { FileChooser } from '../../../imports/FileChooser';
import { importSourcesFile, previewSourcesFile } from './api';
import { counted } from './bulk';
import { IMPORT_OUTCOME_LABEL, IMPORT_OUTCOME_TONE, SOURCES_FILE, entryDetail, entryName, entryTerms, importAdds, importCountsText } from './transfer';

// v37 TRANSFER (SP v37 PLAN T2): Admin › Sources › Import. Choose a sources file (Export's .json); the server previews what
// it would do with each entry (new, already there, renamed, not valid, with why); Import adds the new ones, each off and
// waiting for an admin, and the outcome shows above the sources (SourcesTab's notice). Nothing is turned on here.
// v37 FIX-37B (SP v37 FIXES-37 E3): each new source's terms show under it (a file's are kept as written: "from the file");
// on a phone the outcome filter is a select (its tabs ran off the edge: TRANSFER's open item, the ux review's L13), and
// a file with no sources says so once (L11).

/** The preview's rows shown at first, and added by each "Show more". */
const ROWS_SHOWN = 50;

type Shown = 'all' | AdminSourcesImportOutcome;

export function ImportSourcesDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The import's answer (the dialog closes). */
  onImported: (result: AdminSourcesImportResult) => void;
}) {
  const { t, get } = usePublicConstants();
  const [file, setFile] = useState<File | null>(null);
  const [shown, setShown] = useState<Shown>('all');
  const [rows, setRows] = useState(ROWS_SHOWN);
  const preview = useMutation({ mutationFn: (chosen: File) => previewSourcesFile(chosen) });
  const run = useMutation({
    mutationFn: (chosen: File) => importSourcesFile(chosen),
    onSuccess: (result) => {
      onImported(result);
      onOpenChange(false);
    },
  });

  const choose = (chosen: File) => {
    setFile(chosen);
    setShown('all');
    setRows(ROWS_SHOWN);
    run.reset();
    preview.mutate(chosen);
  };
  const result = preview.data && preview.variables === file ? preview.data : null;
  const adds = result ? importAdds(result) : 0;
  const entries = result ? result.entries.filter((entry) => shown === 'all' || entry.outcome === shown) : [];
  const filterItems: Array<{ value: Shown; label: string }> = result
    ? [
        { value: 'all', label: `All (${result.total.toLocaleString('en-US')})` },
        ...ADMIN_SOURCES_IMPORT_OUTCOMES.filter((outcome) => result.counts[outcome] > 0).map((outcome) => ({
          value: outcome,
          label: `${IMPORT_OUTCOME_LABEL[outcome]} (${result.counts[outcome].toLocaleString('en-US')})`,
        })),
      ]
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Import sources"
        description="Each source it adds is off and waits for an admin; sources already here stay as they are."
        help="Export in Admin › Sources saves a file of the sources it shows: import it here, or on another TailorIT."
        size="xl"
      >
        <div className="relative mt-4 flex min-h-0 flex-col gap-3 overflow-y-auto" data-sources-import="">
          <FileChooser
            file={file}
            onFile={choose}
            accept={SOURCES_FILE}
            busy={preview.isPending}
            disabled={run.isPending}
            error={preview.isError && preview.variables === file ? userMessage(preview.error) : undefined}
          />
          <p className="text-[13px] leading-5 text-muted-foreground" data-sources-import-limit="">
            {t('MSG_ADMIN_SOURCES_FILE_UP_TO', { max: get('ADMIN_SOURCES_IMPORT_MAX').toLocaleString('en-US') })}
          </p>

          <div aria-live="polite">
            {result && (
              <p className="text-sm font-semibold text-foreground" data-sources-import-counts="">
                {importCountsText(result)}
              </p>
            )}
          </div>
          {result && result.total > 0 && (
            <>
              <SegmentedControl
                aria-label="Show entries"
                size="sm"
                items={filterItems}
                value={shown}
                onValueChange={(next) => {
                  setShown(next);
                  setRows(ROWS_SHOWN);
                }}
                className="max-w-full overflow-x-auto max-sm:hidden"
              />
              {/* v37 FIX-37B (L13): four outcomes do not fit a phone's width as tabs: a select there, as Review's filter. */}
              <Select
                aria-label="Show entries"
                className="w-full shrink-0 max-sm:h-11 sm:hidden" // its column scrolls: it keeps its 44 px (no shrink)
                size="lg"
                options={filterItems}
                value={shown}
                onValueChange={(next) => {
                  setShown(next);
                  setRows(ROWS_SHOWN);
                }}
              />
              <ScrollRegion label={`Entries of ${result.fileName}`} className="max-h-[22rem] overflow-y-auto rounded-card border border-border bg-surface">
                {/* A phone fits the three columns (each entry's result in view); long names wrap anywhere. */}
                <table className="w-full border-collapse text-left sm:min-w-[30rem]" aria-label={`Entries of ${result.fileName}`} data-sources-import-rows="">
                  <thead className="sticky top-0 z-10">
                    <tr className="h-10 border-b border-border bg-surface-low">
                      {['Entry', 'Source', 'Result'].map((head) => (
                        <th key={head} scope="col" className="px-2 text-[11px] leading-4 font-semibold tracking-[0.06em] whitespace-nowrap text-subtle-foreground uppercase sm:px-3">
                          {head}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-divider-soft">
                    {entries.slice(0, rows).map((entry) => {
                      const detail = entryDetail(entry);
                      const terms = entryTerms(entry); // v37 FIX-37B (E3)
                      return (
                        <tr key={entry.index} className="align-top" data-sources-import-entry={entry.index} data-sources-import-outcome={entry.outcome}>
                          <th scope="row" className="num px-2 py-2.5 text-[13px] leading-5 font-normal text-muted-foreground sm:px-3">
                            {entry.index}
                          </th>
                          <td className="px-2 py-2.5 text-[13px] leading-5 sm:px-3">
                            <span className="block font-semibold [overflow-wrap:anywhere] text-foreground">{entryName(entry)}</span>
                            <span className="block text-muted-foreground">{entry.kindLabel || 'No kind'}</span>
                            {detail && <span className="mt-0.5 block [overflow-wrap:anywhere] text-muted-foreground">{detail}</span>}
                            {terms && (
                              <span className="mt-0.5 block text-muted-foreground" data-sources-import-terms={entry.terms?.fromFile ? 'file' : 'kind'}>
                                {terms}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2.5 sm:px-3">
                            <Badge tone={IMPORT_OUTCOME_TONE[entry.outcome]} wrap>
                              {IMPORT_OUTCOME_LABEL[entry.outcome]}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </ScrollRegion>
              {entries.length > rows && (
                <div className="flex justify-center">
                  <Button variant="outline" size="sm" className="max-sm:h-11" onClick={() => setRows((count) => count + ROWS_SHOWN)}>
                    {`Show more (${(entries.length - rows).toLocaleString('en-US')} left)`}
                  </Button>
                </div>
              )}
            </>
          )}
          {result && result.total > 0 && adds === 0 && (
            <Notice tone="info" title="Nothing to import">
              Every source in this file is here already or not valid.
            </Notice>
          )}
          {run.isError && (
            <Notice tone="error" title="The sources were not imported">
              {userMessage(run.error)}
            </Notice>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" className="max-sm:h-11" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="max-sm:h-11"
            disabled={!result || !file || adds === 0}
            loading={run.isPending}
            onClick={() => file && run.mutate(file)}
            data-sources-import-confirm=""
          >
            {adds > 0 ? `Import ${counted(adds, 'source', 'sources')}` : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
