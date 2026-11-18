'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useMemo, useRef, useState } from 'react';
import { AdminResourceTab } from '@/components/admin';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FileTextIcon, UploadSimpleIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { SegmentedControl, TabPanel } from '@/components/ui/SegmentedControl';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { adminKeys, importJobs, previewImport } from '../api';
import { AddLinksForm } from '../links/AddLinksForm';
import { fetchSourceSettings, sourceKeys, type SourceSettings } from '../sources/api';
import { sheetOf } from '../sources/sources';
import type { ImportField, ImportMapping, ImportPreview, ImportResult } from '../types';
import { ImportColumns, ImportResultNotice } from './ImportColumns';
import { SheetImport, type SheetPrefill } from './SheetImport';

// v31 ADMINWEB: Admin › Import links (was Import jobs; docs/design/v3.1/21-jobs-from-links.md §5). Every import is a
// list of links: TailorIT reads each posting from its link and keeps nothing else a list says. Three ways in: pasted
// links (POST /api/admin/jobs/add), a CSV or JSON file, and a tab of a Google Sheet (the import routes, which say which
// column they read and which they ignore). Each shows how far TailorIT got reading the links.

type ImportMode = 'links' | 'file' | 'sheet';

const MODES: ReadonlyArray<{ value: ImportMode; label: string }> = [
  { value: 'links', label: 'Paste links' },
  { value: 'file', label: 'File' },
  { value: 'sheet', label: 'Google Sheet' },
];

/** The settings of a Google Sheet source to read again, or null (not a sheet source, or not loaded yet). */
function prefillOf(source: SourceSettings | undefined): SheetPrefill | null {
  const sheet = source ? sheetOf({ kind: 'csv', config: source.config }) : null;
  if (!source || !sheet) return null;
  return { sourceId: source.id, url: sheet.url, gid: sheet.gid, headerRow: sheet.headerRow, postedAtFromTab: sheet.postedAt !== null, name: source.name };
}

/**
 * Admin › Import links: job links pasted, from a CSV or JSON file, or from one tab of a Google Sheet (read once, never
 * written). `sourceId` (Sources › Import the sheet again) opens the Google Sheet mode with that source's tab and
 * settings.
 */
export function ImportTab({ sourceId = null, onShowRuns }: { sourceId?: number | null; onShowRuns: (sourceId: number) => void }) {
  const [chosenMode, setChosenMode] = useState<ImportMode | null>(null);
  // v30 S1-WEB: the one source asked for (Sources holds 80,000 rows, so its list is never read here).
  const source = useQuery({
    queryKey: sourceKeys.detail(sourceId ?? 0),
    queryFn: ({ signal }) => fetchSourceSettings(sourceId!, signal),
    enabled: sourceId !== null,
  });
  const prefill = useMemo(() => (sourceId === null ? null : prefillOf(source.data)), [sourceId, source.data]);
  const waiting = sourceId !== null && source.isPending;
  const mode = chosenMode ?? (prefill || waiting ? 'sheet' : 'links');

  return (
    <AdminResourceTab
      title="Import links"
      description="Add jobs by their links: paste them, or import the link column of a CSV or JSON file or a Google Sheet tab. TailorIT reads each posting from its own link; nothing else a list says is kept."
      sectionProps={{ 'data-import-links': '' }}
      body={
        <SegmentedControl aria-label="Import from" items={MODES} value={mode} onValueChange={setChosenMode}>
          <TabPanel value="links" keepMounted className="mt-5">
            <Card padding="lg">
              <AddLinksForm actions={(submit) => <div className="flex justify-end">{submit}</div>} />
            </Card>
          </TabPanel>
          <TabPanel value="file" keepMounted className="mt-5">
            <FileImport onShowRuns={onShowRuns} />
          </TabPanel>
          <TabPanel value="sheet" keepMounted className="mt-5">
            <SheetImport key={prefill ? `source-${prefill.sourceId}` : 'sheet'} prefill={prefill} onShowRuns={onShowRuns} />
          </TabPanel>
        </SegmentedControl>
      }
    />
  );
}

/**
 * A CSV or JSON file with a column of job links (free_tailor's job sheet columns are recognised: Job Link). Choose or
 * drop the file, check which column holds the links, then import it as a source: its run queues each row's link.
 */
function FileImport({ onShowRuns }: { onShowRuns: (sourceId: number) => void }) {
  const queryClient = useQueryClient();
  const { t, get } = usePublicConstants();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [over, setOver] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const read = useMutation({
    mutationFn: ({ chosen, map }: { chosen: File; map?: ImportMapping }) => previewImport(chosen, map),
    onSuccess: (answer) => {
      setPreview(answer);
      setMapping(answer.mapping);
    },
  });

  const save = useMutation({
    mutationFn: () => importJobs(file!, mapping!, name),
    onSuccess: (answer) => {
      setResult(answer);
      void queryClient.invalidateQueries({ queryKey: adminKeys.sources });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'runs'] });
    },
  });

  const choose = (chosen: File | null) => {
    setResult(null);
    setPreview(null);
    setMapping(null);
    save.reset();
    setFile(chosen);
    if (chosen) read.mutate({ chosen });
  };

  const remap = (field: ImportField, column: string | null) => {
    if (!mapping || !file) return;
    const next = { ...mapping, [field]: column };
    setMapping(next);
    read.mutate({ chosen: file, map: next });
  };

  return (
    <div>
      {/* A drop zone (the stitch over white): drop a file on it, or choose one with the button. */}
      <div
        className={clsx('stitch rounded-card p-6 transition-colors', over ? 'border-primary bg-primary-50' : 'bg-surface')}
        data-import-drop=""
        onDragOver={(event) => {
          if (![...event.dataTransfer.types].includes('Files')) return;
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          const dropped = event.dataTransfer.files[0];
          if (dropped) choose(dropped);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.tsv,.txt,.json,text/csv,application/json"
          className="sr-only"
          aria-label="Job file"
          data-testid="import-file"
          onChange={(event) => {
            choose(event.target.files?.[0] ?? null);
            event.target.value = '';
          }}
        />
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-card bg-primary-soft text-primary-ink">
            {file ? <FileTextIcon size={22} /> : <UploadSimpleIcon size={22} />}
          </span>
          <div className="min-w-0 flex-1 basis-56">
            <p className="text-[15px] leading-5 font-semibold break-words text-foreground">
              {file ? file.name : 'Drop a CSV or JSON file here, or choose a file'}
            </p>
            <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
              {file
                ? `${Math.max(1, Math.round(file.size / 1024))} KB`
                : `A column of job links, one row each (CSV) or one object each (JSON). ${t('MSG_UPLOAD_SIZE_HINT', { max_mb: get('UPLOAD_MAX_MB') })}`}
            </p>
          </div>
          <Button variant={file ? 'outline' : 'primary'} icon={<UploadSimpleIcon size={16} />} onClick={() => inputRef.current?.click()}>
            {file ? 'Choose another file' : 'Choose file'}
          </Button>
        </div>
        {read.isError && (
          <Notice tone="error" className="mt-5">
            {userMessage(read.error)}
          </Notice>
        )}
      </div>

      {preview && mapping && (
        <div className="mt-6">
          <ImportColumns
            preview={preview}
            mapping={mapping}
            onRemap={remap}
            countLabel={preview.format.toUpperCase()}
            sampleLabel="First rows of the file"
            noneLabel="Not in this file"
            name={name}
            onNameChange={setName}
            namePlaceholder={preview.fileName}
            nameHint={`Defaults to ${preview.fileName}.`}
            importing={save.isPending}
            importDisabled={read.isPending}
            onImport={() => save.mutate()}
          />
        </div>
      )}

      <ImportResultNotice result={result} error={save.error} noun="file" onShowRuns={onShowRuns} />
    </div>
  );
}
