'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { FileTextIcon, UploadSimpleIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { SegmentedControl, TabPanel } from '@/components/ui/SegmentedControl';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { adminKeys, importJobs, previewImport } from '../api';
import { ImportColumns, ImportResultNotice } from './ImportColumns';
import { AdminResourceTab } from '@/components/admin';
import { SheetImport, type SheetPrefill } from './SheetImport';
import { fetchSourceSettings, sourceKeys, type SourceSettings } from '../sources/api';
import { sheetOf } from '../sources/sources';
import type { ImportField, ImportMapping, ImportPreview, ImportResult } from '../types';

type ImportMode = 'file' | 'sheet';

const MODES: ReadonlyArray<{ value: ImportMode; label: string }> = [
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
 * Admin > Import jobs: postings from a CSV or JSON file, or from one tab of a Google Sheet (read once, never written).
 * `sourceId` (Sources > Import the sheet again) opens the Google Sheet mode with that source's tab and settings.
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
  const mode = chosenMode ?? (prefill || waiting ? 'sheet' : 'file');

  return (
    <AdminResourceTab
      title="Import jobs"
      description="Add postings from a CSV or JSON file, or from a tab of a Google Sheet. Each file or tab becomes a source; importing it again under the same name updates it."
      body={
        <SegmentedControl aria-label="Import from" items={MODES} value={mode} onValueChange={setChosenMode}>
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
 * A CSV or JSON file of postings (free_tailor's job sheet columns are recognised: Date, Company, Job Title, Job Link,
 * Job Description). Choose the file, check which column is which, then import it as a source.
 */
function FileImport({ onShowRuns }: { onShowRuns: (sourceId: number) => void }) {
  const queryClient = useQueryClient();
  const { t, get } = usePublicConstants();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
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
      <div className="rounded-surface border border-border bg-surface p-6 shadow-soft">
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
          <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary-container text-primary-ink">
            {file ? <FileTextIcon size={22} /> : <UploadSimpleIcon size={22} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-foreground">{file ? file.name : 'Choose a CSV or JSON file'}</p>
            <p className="text-sm text-muted-foreground">
              {file
                ? `${Math.max(1, Math.round(file.size / 1024))} KB`
                : `One posting per row (CSV) or per object (JSON). ${t('MSG_UPLOAD_SIZE_HINT', { max_mb: get('UPLOAD_MAX_MB') })}`}
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
