'use client';

import { useCallback, useEffect, useState } from 'react';
import { cleanDownloadStem, defaultResumeDownloadStem, type ResumeDocument, type ResumeDownloadExtension } from '@tailorit/shared';
import type { PagePlan } from '@tailorit/resume-templates';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { api, userMessage } from '@/lib/api';
import { ResumeCanvas } from '../pages/ResumeCanvas';

// Enhancv's Download: first the empty fields the page still shows (the person may go back and fill them, or go on),
// then the file's name (First_Last_Resume, theirs to change) and its format. For a PDF the page count is the PDF's
// own: the resume is laid out here as it prints, off screen, and the server measures its PDF against that plan
// (POST /:id/layout), so the dialog never promises a page count the file does not have. An older resume nobody has
// edited yet is still stored in the form editor's format: the server prints it as the editor shows it (`upgraded=1`),
// upgraded as it is read, and stores nothing.

const FORMATS: ReadonlyArray<{ value: ResumeDownloadExtension; label: string; hint: string }> = [
  { value: 'pdf', label: 'PDF', hint: 'Best for applying: it prints exactly as you see it.' },
  { value: 'docx', label: 'Word', hint: 'Plain text in Word, for forms that ask for a .docx.' },
  { value: 'txt', label: 'TXT', hint: 'Plain text, to paste into application forms.' },
];

/** The most boxes POST /api/resumes/:id/layout compares (a longer resume sends its breaks alone). */
const MAX_CHECKED_BOXES = 500;

function startDownload(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

export interface DownloadDialogProps {
  open: boolean;
  onClose(): void;
  document: ResumeDocument;
  /** Shown but empty fields of the page; 0 skips the check. */
  emptyFields: number;
  /** "Back to editing": the empty fields are highlighted. */
  onShowEmpty(): void;
  /** Saves every change; the download prints what is stored. */
  flush(): Promise<void>;
  resumeId(): string | null;
}

export function DownloadDialog(props: DownloadDialogProps) {
  const { open, onClose, document, emptyFields, onShowEmpty, flush, resumeId } = props;
  const [step, setStep] = useState<'check' | 'file'>(emptyFields > 0 ? 'check' : 'file');
  const [stem, setStem] = useState(() => defaultResumeDownloadStem(document.name));
  const [format, setFormat] = useState<ResumeDownloadExtension>('pdf');
  const [pages, setPages] = useState<number | null>(null);
  const [plan, setPlan] = useState<{ pages: PagePlan; heights: Readonly<Record<string, number>> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The PDF's page count, once the resume is saved and laid out as it prints.
  useEffect(() => {
    if (!open || !plan || format !== 'pdf') return;
    let cancelled = false;
    void (async () => {
      try {
        await flush();
        const id = resumeId();
        if (!id || cancelled) return;
        const breaks = {
          main: (plan.pages.breaks.main ?? []).map((item) => item.before),
          side: (plan.pages.breaks.side ?? []).map((item) => item.before),
        };
        // The heights too, so a drift in a box's height is logged even where the pages still break alike.
        const heights = Object.keys(plan.heights).length <= MAX_CHECKED_BOXES ? { heights: plan.heights } : {};
        const answer = (await api.post(`/api/resumes/${encodeURIComponent(id)}/layout`, {
          pageCount: plan.pages.pageCount,
          breaks,
          ...heights,
        })) as { pageCount?: unknown };
        if (!cancelled && typeof answer.pageCount === 'number') setPages(answer.pageCount);
      } catch {
        // The note is a nicety: the download works without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, plan, format, flush, resumeId]);

  const onPlan = useCallback(
    (pages: PagePlan, heights: Readonly<Record<string, number>>) => setPlan({ pages, heights }),
    [],
  );

  const download = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await flush();
      const id = resumeId();
      if (!id) {
        setProblem('There is nothing to download yet: add something to your resume first.');
        return;
      }
      const name = cleanDownloadStem(stem) || defaultResumeDownloadStem(document.name);
      startDownload(`/api/resumes/${encodeURIComponent(id)}/export?format=${format}&name=${encodeURIComponent(name)}&upgraded=1`);
      onClose();
    } catch (error) {
      setProblem(userMessage(error, 'The download did not start. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent title={step === 'check' ? `Empty fields detected: ${emptyFields}` : 'Download your resume'} size="md">
        {step === 'check' ? (
          <>
            <p className="text-[15px] text-muted-foreground">
              Some fields on your resume are shown but still empty. Fill them in, or hide them in the entry&apos;s Settings, so
              they do not leave gaps. Empty fields are left out of the download.
            </p>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  onShowEmpty();
                  onClose();
                }}
              >
                Back to editing
              </Button>
              <Button onClick={() => setStep('file')}>Continue</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">File name</span>
                <Input value={stem} maxLength={100} onChange={(event) => setStem(event.target.value)} aria-describedby="download-name-hint" />
                <span id="download-name-hint" className="text-[13px] text-muted-foreground">
                  {(cleanDownloadStem(stem) || defaultResumeDownloadStem(document.name)) + '.' + format}
                </span>
              </label>
              <RadioGroup
                aria-label="Format"
                value={format}
                onValueChange={setFormat}
                options={FORMATS.map((item) => ({ value: item.value, label: item.label, description: item.hint }))}
              />
              {format === 'pdf' && pages !== null ? (
                <p className="text-[13px] text-muted-foreground">
                  The PDF has {pages} {pages === 1 ? 'page' : 'pages'}.
                </p>
              ) : null}
              {problem ? <Notice tone="error">{problem}</Notice> : null}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button loading={busy} onClick={() => void download()} data-download-start="">
                Download
              </Button>
            </DialogFooter>
          </>
        )}
        {open ? (
          // The resume as it prints, off screen: its plan is checked against the PDF's.
          <div aria-hidden="true" inert className="pointer-events-none fixed top-0 -left-[10000px] w-[816px] opacity-0">
            <ResumeCanvas document={document} mode="static" onPlan={onPlan} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
