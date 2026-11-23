'use client';

import { clsx } from 'clsx';
import { useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { HelpTip } from '@/components/ui/HelpTip';
import { FileTextIcon, UploadSimpleIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { usePublicConstants } from '@/lib/constants';
import { IMPORT_FILE_ACCEPT, IMPORT_FILE_TYPES_TEXT, fileProblem, fileProblemText, fileSizeText } from './mapping';

// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §1 "Choose a file"): a drop zone with Choose file, for the types an import
// reads (.csv, .tsv, .txt, .json, .xlsx) up to UPLOAD_MAX_MB (the limit is shown). Anything else is refused here, before
// it is sent, with what to do. Shared by Admin › Import › File and Jobs › Add job › File.

export interface FileChooserProps {
  file: File | null;
  /** A file that passed the checks. */
  onFile: (file: File) => void;
  /** The server's word on the file (it could not read it), under the zone. */
  error?: ReactNode;
  /** While the file's preview is read. */
  busy?: boolean;
  disabled?: boolean;
}

export function FileChooser({ file, onFile, error, busy = false, disabled = false }: FileChooserProps) {
  const { t, get } = usePublicConstants();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const maxMb = get('UPLOAD_MAX_MB');

  const choose = (chosen: File | null | undefined) => {
    if (!chosen) return;
    const problem = fileProblem(chosen, maxMb);
    if (problem) {
      setRefused(fileProblemText(problem, chosen, t('MSG_FILE_TOO_LARGE', { name: chosen.name, max_mb: maxMb })));
      return;
    }
    setRefused(null);
    onFile(chosen);
  };

  const shownError = refused ?? error ?? null;
  return (
    <div
      className={clsx('stitch rounded-card p-4 transition-colors sm:p-6', over ? 'border-primary bg-primary-50' : 'bg-surface')}
      data-import-drop=""
      onDragOver={(event) => {
        if (disabled || ![...event.dataTransfer.types].includes('Files')) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        if (!disabled) choose(event.dataTransfer.files[0]);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={IMPORT_FILE_ACCEPT}
        className="sr-only"
        aria-label="Job file"
        data-testid="import-file"
        tabIndex={-1}
        disabled={disabled}
        onChange={(event) => {
          choose(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      <div className="flex flex-wrap items-center gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-card bg-primary-soft text-primary-ink" aria-hidden="true">
          {file ? <FileTextIcon size={22} /> : <UploadSimpleIcon size={22} />}
        </span>
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex items-center gap-1.5 text-[15px] leading-5 font-semibold break-words text-foreground" data-import-file-name="">
            {file ? file.name : 'Drop a file here, or choose one'}
            {!file && (
              <HelpTip label="The file">
                A row for each job with its link; other columns may give the company, title, description, rate and location.
              </HelpTip>
            )}
          </p>
          <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground" data-import-file-limit="">
            {file ? fileSizeText(file.size) : `${IMPORT_FILE_TYPES_TEXT}. ${t('MSG_UPLOAD_SIZE_HINT', { max_mb: maxMb })}`}
          </p>
        </div>
        <Button
          variant={file ? 'outline' : 'primary'}
          icon={<UploadSimpleIcon size={16} />}
          onClick={() => inputRef.current?.click()}
          loading={busy}
          disabled={disabled}
          data-import-choose=""
        >
          {file ? 'Choose another file' : 'Choose file'}
        </Button>
      </div>
      {shownError ? (
        <Notice tone="error" className="mt-4">
          {shownError}
        </Notice>
      ) : null}
    </div>
  );
}
