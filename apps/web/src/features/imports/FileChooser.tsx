'use client';

import { clsx } from 'clsx';
import { useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { HelpTip } from '@/components/ui/HelpTip';
import { FileTextIcon, UploadSimpleIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { usePublicConstants } from '@/lib/constants';
import { IMPORT_FILE_ACCEPT, IMPORT_FILE_TYPES_TEXT, fileProblem, fileProblemText, fileSizeText, type FileProblem } from './mapping';

// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §1 "Choose a file"): a drop zone with Choose file, for the types an import
// reads (.csv, .tsv, .txt, .json, .xlsx) up to UPLOAD_MAX_MB (the limit is shown). Anything else is refused here, before
// it is sent, with what to do. Shared by Admin › Import › File and Jobs › Add job › File.

/**
 * v37 TRANSFER (SP v37 PLAN T2): another kind of file than a job import's (Admin › Sources › Import takes a .json sources
 * file): the endings it takes, the input's accept list and its words. Absent: an import's files.
 */
export interface FileChooserAccept {
  /** The file name endings it takes (".json"). */
  endings: readonly string[];
  /** The file input's accept list. */
  accept: string;
  /** The types in words ("JSON"). */
  typesText: string;
  /** The file input's name ("Sources file"). */
  label: string;
  /** The "?" beside the zone's words: what the file holds. */
  help: string;
  /** What an empty file should hold ("a source"), for its refusal. */
  holds: string;
}

/** v37 TRANSFER: why a file of `accept`'s kind is refused before it is sent (as fileProblem for an import's), or null. */
export function acceptedFileProblem(file: Pick<File, 'name' | 'size'>, maxMb: number, accept: FileChooserAccept): FileProblem | null {
  if (!accept.endings.some((ending) => file.name.toLowerCase().endsWith(ending))) return 'type';
  if (file.size === 0) return 'empty';
  if (file.size > maxMb * 1024 * 1024) return 'size';
  return null;
}

/** v37 TRANSFER: a refused file's sentence for `accept`'s kind, with what to do (the size's words are MSG_FILE_TOO_LARGE's). */
export function acceptedFileProblemText(problem: FileProblem, file: Pick<File, 'name'>, accept: FileChooserAccept, tooLarge: string): string {
  if (problem === 'size') return tooLarge;
  if (problem === 'empty') return `${file.name} is empty: choose a file with ${accept.holds} in it.`;
  return `TailorIT can't read ${file.name}: choose a ${accept.typesText} file.`;
}

export interface FileChooserProps {
  file: File | null;
  /** A file that passed the checks. */
  onFile: (file: File) => void;
  /** The server's word on the file (it could not read it), under the zone. */
  error?: ReactNode;
  /** While the file's preview is read. */
  busy?: boolean;
  disabled?: boolean;
  /** v37 TRANSFER: another kind of file than an import's (a sources file); absent: an import's. */
  accept?: FileChooserAccept;
}

export function FileChooser({ file, onFile, error, busy = false, disabled = false, accept }: FileChooserProps) {
  const { t, get } = usePublicConstants();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const maxMb = get('UPLOAD_MAX_MB');

  const choose = (chosen: File | null | undefined) => {
    if (!chosen) return;
    const problem = accept ? acceptedFileProblem(chosen, maxMb, accept) : fileProblem(chosen, maxMb); // v37 TRANSFER
    if (problem) {
      const tooLarge = t('MSG_FILE_TOO_LARGE', { name: chosen.name, max_mb: maxMb });
      setRefused(accept ? acceptedFileProblemText(problem, chosen, accept, tooLarge) : fileProblemText(problem, chosen, tooLarge));
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
        accept={accept?.accept ?? IMPORT_FILE_ACCEPT} // v37 TRANSFER
        className="sr-only"
        aria-label={accept?.label ?? 'Job file'}
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
                {accept?.help ?? 'A row for each job with its link; other columns may give the company, title, description, rate and location.'}
              </HelpTip>
            )}
          </p>
          <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground" data-import-file-limit="">
            {file ? fileSizeText(file.size) : `${accept?.typesText ?? IMPORT_FILE_TYPES_TEXT}. ${t('MSG_UPLOAD_SIZE_HINT', { max_mb: maxMb })}`}
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
