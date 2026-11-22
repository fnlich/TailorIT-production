'use client';

import { FileArrowUpIcon } from '@phosphor-icons/react/FileArrowUp';
import { DEFAULT_TEMPLATE_ID, type ResumeSummary, type ResumeTemplateId } from '@tailorit/shared/resume';
import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { HelpTip } from '@/components/ui/HelpTip';
import { CheckCircleIcon, ClockIcon, FileTextIcon, WarningCircleIcon, XIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { Spinner } from '@/components/ui/Spinner';
import { fetchResumes, resumeKeys, uploadResume } from '../../resume-editor/api';
import { usePublicConstants } from '@/lib/constants';
import { RESUME_FILE_ACCEPT } from '../../resume-editor/files';
import { StatusLine } from '../core/StatusLine';
import { copyChoiceFixed, newCopyBatchId } from './copies';
import { CopyTemplateField } from './CopyTemplateField';
import { uploadTitle } from './list';
import {
  browserRefusal,
  haltText,
  leftOutText,
  queueCounts,
  queueStatusText,
  retryButtonText,
  rowStatusText,
  uploadButtonText,
  type UploadRow,
} from './uploadQueue';
import { useUploadQueue, type RunOutcome, type UploadedResume } from './useUploadQueue';

export type { RunOutcome, UploadedResume } from './useUploadQueue';

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * The "Upload resumes" dialog, for one resume or many (PDF, DOC or DOCX up to 5 MB each; dropped or chosen, up to 50
 * at a time). One file has a name for the documents list, and its editable copy starts at once. Several files are each
 * named after their file; they go two at a time with a status per file, the dialog stays open while they are sent,
 * and their copies wait in the server's line, made one at a time and followed by one notice on the Resumes tab. Either
 * way "Make an editable copy with AI" is unticked unless the person ticks it, and the copies start on the editor's
 * template picked under it (Double Column unless another is picked). Once a file of the upload is on the server, the
 * box and the template stay as they are: Try again and files added later go with the same choice. On a short screen
 * the form scrolls between the title and the buttons. Uploads are kept exactly as they are.
 * `onUploaded` hears of each stored upload; `onFinished` of the end of each run (Upload, Try again).
 */
export function UploadResumeDialog({
  open,
  onOpenChange,
  onUploaded,
  onFinished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded: (result: UploadedResume) => void;
  onFinished: (outcome: RunOutcome) => void;
}) {
  // True while files are being sent: Escape, the backdrop and the corner ✕ do not close the dialog then.
  const busyRef = useRef(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busyRef.current) return;
        onOpenChange(next);
      }}
    >
      {open && <UploadForm busyRef={busyRef} onClose={() => onOpenChange(false)} onUploaded={onUploaded} onFinished={onFinished} />}
    </Dialog>
  );
}

function UploadForm({
  busyRef,
  onClose,
  onUploaded,
  onFinished,
}: {
  busyRef: { current: boolean };
  onClose: () => void;
  onUploaded: (result: UploadedResume) => void;
  onFinished: (outcome: RunOutcome) => void;
}) {
  const queryClient = useQueryClient();
  // v30 ST5: the caps and their words are the constants' (UPLOAD_BATCH_MAX_FILES, UPLOAD_MAX_MB, MSG_UPLOAD_*).
  const { t, get } = usePublicConstants();
  const maxFiles = get('UPLOAD_BATCH_MAX_FILES');
  const maxMb = get('UPLOAD_MAX_MB');
  const [name, setName] = useState('');
  const [parse, setParse] = useState(false);
  // The copies of every run of several files in this dialog (Try again included) share one notice.
  const [batchId] = useState(newCopyBatchId);
  const [copyTemplate, setCopyTemplate] = useState<ResumeTemplateId>(DEFAULT_TEMPLATE_ID);
  const [pickError, setPickError] = useState<string | null>(null);
  const [leftOut, setLeftOut] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const rowList = useRef<HTMLUListElement>(null);

  const upload = useUploadQueue({
    send: (file, options) =>
      uploadResume(file, {
        title: options.mode === 'single' ? options.title : undefined,
        parse: options.copy !== null,
        templateId: options.copy?.templateId ?? undefined,
        batch: options.mode === 'multi' ? options.copy?.batchId : undefined,
      }),
    list: () => fetchResumes(),
    knownIds: () => {
      const items = queryClient.getQueryData<ResumeSummary[]>(resumeKeys.list());
      return items ? new Set(items.map((item) => item.id)) : null;
    },
    onUploaded,
    onRunEnd: (outcome) => {
      onFinished(outcome);
      if (outcome.allDone) onClose();
    },
  });

  const { queue, now } = upload;
  const { rows } = queue;
  const counts = queueCounts(queue);
  const running = queue.phase === 'running';
  // Several files, or what is left of a run of several: the list of rows. One file: the dialog as it always was.
  const several = rows.length > 1 || counts.done > 0;
  const only = several ? null : (rows[0] ?? null);
  // A file of this upload is on the server, or may be: the box and the template stay as they are.
  const choiceFixed = copyChoiceFixed(queue);

  useEffect(() => {
    busyRef.current = running;
    return () => {
      busyRef.current = false;
    };
  }, [busyRef, running]);

  // A run that ends with files not uploaded: the first of them comes into view (the list may be scrolled past it).
  useEffect(() => {
    if (queue.phase !== 'finished') return;
    rowList.current
      ?.querySelector('[data-upload-status="failed"], [data-upload-status="stopped"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [queue.phase, queue.run]);

  // Closing or reloading the tab while files are being sent: the browser asks first.
  useEffect(() => {
    if (!running) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers need a value to show their prompt.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [running]);

  const take = (picked: FileList | null | undefined) => {
    const files = picked ? Array.from(picked) : [];
    if (files.length === 0 || running) return;
    setPickError(null);
    setLeftOut(null);
    // One file into an empty dialog that cannot be sent: said as before, and nothing is added.
    const first = files[0];
    if (files.length === 1 && rows.length === 0 && first) {
      const refusal = browserRefusal(first, maxMb, t);
      if (refusal) {
        setPickError(refusal);
        return;
      }
    }
    const outcome = upload.add(files, maxFiles, maxMb, t);
    if (outcome.leftOut > 0) setLeftOut(leftOutText(outcome.leftOut, maxFiles, t));
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    take(event.dataTransfer.files);
  };

  const begin = () => {
    if (running) return;
    if (counts.sendable === 0) {
      if (rows.length === 0) setPickError('Choose a file to upload.');
      return;
    }
    setPickError(null);
    // What the box and the picker show. They cannot change once a file of this upload is on the server, so Try again
    // and files added later ask for the same copy (in the dialog's one batch) as the files already uploaded.
    const copy = parse ? { templateId: copyTemplate } : null;
    upload.start(
      only ? { mode: 'single', title: uploadTitle(name, only.file.name), copy } : { mode: 'multi', copy: copy && { ...copy, batchId } },
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    begin();
  };

  const remove = (row: UploadRow<File>) => {
    setPickError(null);
    setLeftOut(null);
    upload.remove(row.key);
  };

  const chooseLink = (text: string) => (
    <button
      type="button"
      disabled={running}
      className="font-medium text-primary hover:underline disabled:pointer-events-none disabled:opacity-50"
      onClick={() => input.current?.click()}
    >
      {text}
    </button>
  );

  const limits = t('MSG_UPLOAD_HINT', { max_mb: maxMb, max: maxFiles });
  let zone: ReactNode;
  if (only) {
    zone = (
      <>
        <div className="flex w-full max-w-sm items-center gap-3 rounded-control border border-border bg-surface px-3 py-2.5 text-left shadow-card">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-primary-soft text-primary">
            <FileTextIcon size={18} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-semibold text-foreground">{only.file.name}</span>
            <span className={clsx('text-[13px]', only.status.kind === 'waiting' ? 'text-warning' : 'text-muted-foreground')}>
              {sizeText(only.file.size)}
              {only.status.kind === 'waiting' ? ` · ${rowStatusText(only, now)}` : ''}
            </span>
          </span>
          <button
            type="button"
            aria-label="Remove the file"
            disabled={running}
            onClick={() => remove(only)}
            className="inline-flex size-7 items-center justify-center rounded-tag text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-50"
          >
            <XIcon size={14} />
          </button>
        </div>
        <p className="text-[13px] text-muted-foreground">Drag more here, or {chooseLink('add more files')}.</p>
      </>
    );
  } else if (several) {
    zone = <p className="text-sm text-foreground">Drag more files here, or {chooseLink('choose files')}</p>;
  } else {
    zone = (
      <>
        <span className="flex size-12 items-center justify-center rounded-card bg-primary-soft text-primary">
          <FileArrowUpIcon size={22} />
        </span>
        <p className="text-sm text-foreground">Drag files here, or {chooseLink('choose files')}</p>
      </>
    );
  }

  const failure = pickError ?? (only?.status.kind === 'failed' ? only.status.message : null);
  const stopNote = several ? haltText(queue.halt) : null;
  const statusLine = several ? queueStatusText(queue, now) : '';
  const allStopped = rows.filter((row) => row.status.kind === 'stopped').length === counts.sendable;

  let footer: ReactNode;
  if (!several) {
    const inFlight = counts.uploading > 0;
    footer = (
      <>
        <Button
          variant="outline"
          disabled={inFlight}
          onClick={() => {
            // Waiting to try again (nothing in flight): Cancel stops that too.
            if (running) upload.stop();
            onClose();
          }}
        >
          Cancel
        </Button>
        <Button type="submit" loading={running} disabled={counts.sendable === 0}>
          {running ? 'Uploading...' : 'Upload'}
        </Button>
      </>
    );
  } else if (running) {
    footer = (
      <>
        <Button variant="outline" disabled={queue.halt !== null} onClick={upload.stop}>
          {queue.halt ? 'Stopping...' : 'Stop'}
        </Button>
        <Button loading>Uploading...</Button>
      </>
    );
  } else if (queue.phase === 'finished') {
    footer = (
      <>
        <Button variant={counts.sendable > 0 ? 'outline' : 'primary'} onClick={onClose}>
          Done
        </Button>
        {counts.sendable > 0 && (
          <Button onClick={begin}>{allStopped ? uploadButtonText(counts.sendable) : retryButtonText(counts.sendable)}</Button>
        )}
      </>
    );
  } else {
    footer = (
      <>
        <Button variant="outline" onClick={onClose}>
          {counts.done > 0 ? 'Close' : 'Cancel'}
        </Button>
        <Button type="submit" disabled={counts.sendable === 0}>
          {uploadButtonText(counts.sendable)}
        </Button>
      </>
    );
  }

  return (
    <DialogContent
      title={t('LABEL_DOCS_UPLOAD_RESUMES')}
      help={several ? 'Each resume is named after its file; you can rename it later.' : 'Keep your own resumes with your documents.'}
      size="lg"
      showClose={!running}
    >
      <form onSubmit={submit} className="mt-4 flex min-h-0 flex-col">
        {/* On a short screen the fields scroll between the title and the buttons, which stay in view with the notices. */}
        <div className="relative -mx-6 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pt-1">
          {several ? null : (
            <Field label="File name" hint="Leave it empty to use the file's own name." optional>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ex. John_Doe_Finance"
                maxLength={120}
                disabled={running}
              />
            </Field>
          )}

          <div
            onDragOver={(event) => {
              event.preventDefault();
              if (!running) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={clsx(
              // A drop zone: the stitch (1.5 px dashed) on white; denim over a denim wash while files are dragged over it.
              'flex flex-col items-center justify-center gap-2 rounded-card border-[1.5px] border-dashed px-4 text-center transition-colors duration-150',
              several ? 'py-4' : 'py-7',
              dragging ? 'border-primary bg-primary-50' : 'border-border-strong bg-surface',
            )}
          >
            {zone}
            <p className="text-[13px] text-muted-foreground">{limits}</p>
            <input
              ref={input}
              type="file"
              multiple
              accept={RESUME_FILE_ACCEPT}
              className="sr-only"
              tabIndex={-1}
              aria-label="Resume file"
              onChange={(event) => {
                take(event.target.files);
                event.target.value = '';
              }}
            />
          </div>

          {several && (
            // The list gives up height before the fields scroll, but never below two rows (with the line above them,
            // one and a half), so how each file is doing stays in view.
            <div className={clsx('flex flex-col gap-2', rows.length > 1 && 'min-h-[7.75rem]')}>
              {statusLine && (
                <p role="status" className="text-[13px] leading-5 font-medium text-foreground">
                  {statusLine}
                </p>
              )}
              <ul ref={rowList} aria-label="Files to upload" className="-mr-1 flex max-h-[min(18rem,40vh)] flex-col gap-2 overflow-y-auto pr-1">
                {rows.map((row) => (
                  <FileRow key={row.key} row={row} now={now} onRemove={() => remove(row)} />
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5">
              <Checkbox
                checked={parse}
                onCheckedChange={(checked) => setParse(checked)}
                disabled={running || choiceFixed}
                label="Make an editable copy with AI"
              />
              {/* v32 COPY (E5): what the copy is, in the "?". */}
              <HelpTip label="Make an editable copy with AI">
                {several
                  ? 'AI reads each file into a resume you can edit, one at a time; the files stay as uploaded.'
                  : 'AI reads the file into a resume you can edit; the file stays as uploaded.'}
              </HelpTip>
            </span>
            {choiceFixed && (
              <p className="pl-7 text-[13px] leading-5 text-muted-foreground">This choice applies to every file of this upload.</p>
            )}
            {parse && (
              <div className="mt-2 pl-7">
                <CopyTemplateField
                  several={several}
                  value={copyTemplate}
                  onChange={setCopyTemplate}
                  disabled={running || choiceFixed}
                />
              </div>
            )}
          </div>
        </div>

        {(leftOut || stopNote || failure) && (
          <div className="mt-5 flex flex-col gap-5">
            {/* v32 COPY (E4): what was left out or stopped is a short line; a failure stays an error by the form. */}
            {leftOut && <StatusLine tone="warning" title={leftOut} />}
            {stopNote && <StatusLine tone="warning" title={stopNote} />}
            {failure && <Notice tone="error">{failure}</Notice>}
          </div>
        )}

        <DialogFooter flush className="mt-5 pt-1">
          {footer}
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/** One file of several: its name, size and status, and ✕ to take it out (not while it is sent, nor once stored). */
function FileRow({ row, now, onRemove }: { row: UploadRow<File>; now: number; onRemove: () => void }) {
  const { status } = row;
  const tone =
    status.kind === 'failed'
      ? 'text-danger'
      : status.kind === 'done'
        ? 'text-success'
        : status.kind === 'waiting'
          ? 'text-warning'
          : 'text-muted-foreground';
  let mark: ReactNode = null;
  if (status.kind === 'uploading') mark = <Spinner size={16} className="text-primary" />;
  else if (status.kind === 'done') mark = <CheckCircleIcon size={18} weight="fill" className="text-success" />;
  else if (status.kind === 'failed') mark = <WarningCircleIcon size={18} weight="fill" className="text-danger" />;
  else if (status.kind === 'waiting') mark = <ClockIcon size={18} className="text-warning" />;
  return (
    <li
      data-upload-row={row.file.name}
      data-upload-status={status.kind}
      className="flex items-center gap-3 rounded-control border border-border bg-surface px-3 py-2"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-primary-soft text-primary">
        <FileTextIcon size={16} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm leading-5 font-semibold text-foreground" title={row.file.name}>
          {row.file.name}
        </span>
        <span className={clsx('text-[13px] leading-5 [overflow-wrap:anywhere]', tone)}>
          {sizeText(row.file.size)} · {rowStatusText(row, now)}
        </span>
      </span>
      {mark && <span className="flex shrink-0">{mark}</span>}
      {status.kind !== 'done' && (
        <button
          type="button"
          aria-label={`Remove ${row.file.name}`}
          disabled={status.kind === 'uploading'}
          onClick={onRemove}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-tag text-muted-foreground hover:bg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <XIcon size={14} />
        </button>
      )}
    </li>
  );
}
