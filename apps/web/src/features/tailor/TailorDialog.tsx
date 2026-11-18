'use client';

import { RESUME_TEMPLATE_IDS, RESUME_TEMPLATES, TAILOR_POLL_MS, resumeExportFileName, type TailorResult } from '@tailorit/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CheckIcon,
  DownloadSimpleIcon,
  EyeIcon,
  FileTextIcon,
  PencilSimpleIcon,
  SparkleIcon,
} from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';
import { TapeMeter } from '@/components/ui/TapeMeter';
import { useToast } from '@/components/ui/Toast';
import { ApiError, userMessage } from '@/lib/api';
import { useAiTask } from '@/lib/useAiTask';
import { autofillKeys, fetchAutofillProfile } from '../autofill/api';
import { LetterPreviewDialog } from '../documents/preview/LetterPreviewDialog';
import { ResumePreviewDialog } from '../documents/preview/ResumePreviewDialog';
import { downloadFile, fetchTemplates, letterExportPath, templateKeys } from '../letter-editor/data';
import { fetchResumes, readImportResult, resumeEditorHref, resumeExportHref, resumeKeys, startEditableCopy } from '../resume-editor/api';
import { downloadFrom } from '../resume-editor/files';
import { fetchTailorTask, startTailor, tailorKeys } from './api';
import {
  initialChoices,
  missingKeywords,
  problemOfError,
  problemOfTask,
  problemText,
  progressPercent,
  scoreBand,
  scoreChange,
  stepRows,
  tailorBody,
  trackerEntryHref,
  type TailorChoices,
  type TailorProblem,
  type TailorTarget,
} from './tailor';

/** v31 FIX-WEB (REV-REQ REQ-3): the dialog's title and its button. */
export const TAILOR_TITLE = 'Tailor a resume';

// v1.4 E (decision 16): tailoring a resume to a job (the Jobs detail's tailor section, the tracker's Documents tab).
// The dialog asks which resume to start from and the templates (the profile's by default) and whether to write a cover
// letter too, then follows the task step by step, then shows what it made: the ATS score and the keywords still
// missing, the tailored resume and its letter with Preview (full page), Edit and Download, and the tracker entry they
// are linked to ("Used for this application"). An upload with no editable copy is offered the existing "Make an
// editable copy" first; the hourly limit and an unavailable AI are said plainly.

/** The tailoring started for each job or tracker entry during this visit: closing the dialog never loses it. */
const startedTasks = new Map<string, string>();
const targetKey = (target: TailorTarget) => (target.applicationId ? `app:${target.applicationId}` : `job:${target.jobId ?? 0}`);

const OWN_TEMPLATE = 'own';
const NO_TEMPLATE = 'none';
const MAX_MISSING_SHOWN = 14;

export function TailorDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: TailorTarget;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <TailorWindow target={target} onClose={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function TailorWindow({ target, onClose }: { target: TailorTarget; onClose: () => void }) {
  const queryClient = useQueryClient();
  const key = targetKey(target);
  const [taskId, setTaskId] = useState<string | null>(() => startedTasks.get(key) ?? null);
  const [problem, setProblem] = useState<TailorProblem | null>(null);
  const [choices, setChoices] = useState<TailorChoices | null>(null);
  const [copyReady, setCopyReady] = useState(false);
  // "Tailor again" after a result: a new tailoring, not the same one answered again (the server's day-long dedupe).
  const [force, setForce] = useState(false);

  const profile = useQuery({ queryKey: autofillKeys.profile, queryFn: ({ signal }) => fetchAutofillProfile(signal) });
  const resumes = useQuery({ queryKey: resumeKeys.list(), queryFn: ({ signal }) => fetchResumes(signal) });
  const letterTemplates = useQuery({ queryKey: templateKeys.all, queryFn: fetchTemplates, staleTime: 60_000 });

  // The choices start once the profile and the resumes are known (a profile that cannot be read leaves the defaults).
  const ready = resumes.isSuccess && (profile.isSuccess || profile.isError);
  if (ready && choices === null) {
    setChoices(initialChoices({ profileDocuments: profile.data?.profile.documents ?? null, resumes: resumes.data }));
  }

  const task = useQuery({
    queryKey: tailorKeys.task(taskId ?? ''),
    queryFn: ({ signal }) => fetchTailorTask(taskId!, signal),
    enabled: taskId !== null,
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'succeeded' || status === 'failed' || status === 'cancelled' ? false : TAILOR_POLL_MS;
    },
    refetchIntervalInBackground: true,
  });

  const start = useMutation({
    mutationFn: () => startTailor(tailorBody(target, choices!, force)),
    onSuccess: ({ taskId: started }) => {
      startedTasks.set(key, started);
      setTaskId(started);
    },
    onError: (error) => setProblem(problemOfError(error instanceof ApiError ? error : null)),
  });

  const result = task.data?.status === 'succeeded' ? task.data.result : null;
  const taskProblem = task.data ? problemOfTask(task.data) : null;
  // A task remembered from earlier in the visit that the server no longer has (another account since, a reset): the
  // dialog starts over.
  const gone = task.error instanceof ApiError && task.error.status === 404;
  if (gone && taskId !== null) {
    startedTasks.delete(key);
    setTaskId(null);
  }
  const pollProblem: TailorProblem | null =
    task.isError && !task.data && !gone ? { kind: 'failed', message: userMessage(task.error, 'This tailoring could not be read.') } : null;

  // What it made shows everywhere at once: the resumes, the letters, the tracker entry and the job's keyword card.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!result || announced.current === taskId) return;
    announced.current = taskId;
    for (const root of [['resumes'], ['cover-letters'], ['tracker'], ['jobs']]) {
      void queryClient.invalidateQueries({ queryKey: root });
    }
  }, [result, taskId, queryClient]);

  const again = () => {
    startedTasks.delete(key);
    setTaskId(null);
    setProblem(null);
  };

  const shownProblem = problem ?? taskProblem ?? pollProblem;
  let body: ReactNode;
  // v31 FIX-WEB (REV-REQ REQ-3): TailorIT's words, as the job page's "Tailor a resume" (never the copied CTA).
  let title = TAILOR_TITLE;
  if (shownProblem) {
    body = (
      <ProblemView
        problem={shownProblem}
        resumeId={choices?.resumeId ?? null}
        onCopied={(copyId) => {
          setChoices((current) => (current ? { ...current, resumeId: copyId } : current));
          setCopyReady(true);
          void queryClient.invalidateQueries({ queryKey: resumeKeys.all });
          again();
        }}
        onBack={again}
        onClose={onClose}
      />
    );
  } else if (result) {
    title = 'Your tailored resume is ready';
    body = (
      <ResultView
        result={result}
        onAgain={() => {
          setForce(true);
          again();
        }}
        onClose={onClose}
      />
    );
  } else if (taskId) {
    title = 'Tailoring your resume';
    body = <ProgressView step={task.data?.step ?? null} message={task.data?.message ?? null} onClose={onClose} />;
  } else {
    body = (
      <SetupView
        target={target}
        choices={choices}
        resumes={resumes.data ?? null}
        resumesError={resumes.isError ? userMessage(resumes.error, 'Your resumes could not be listed.') : null}
        letterTemplates={letterTemplates.data?.items ?? null}
        copyReady={copyReady}
        starting={start.isPending}
        onChange={setChoices}
        onStart={() => start.mutate()}
        onClose={onClose}
      />
    );
  }

  return (
    <DialogContent title={title} description={`${target.title} at ${target.company}`} size="xl">
      <div className="mt-5" data-tailor-dialog={shownProblem ? 'problem' : result ? 'done' : taskId ? 'running' : 'setup'}>
        {body}
      </div>
    </DialogContent>
  );
}

// ------------------------------------------------------------------------------------------------------- setup --

export function SetupView({
  target,
  choices,
  resumes,
  resumesError,
  letterTemplates,
  copyReady,
  starting,
  onChange,
  onStart,
  onClose,
}: {
  target: TailorTarget;
  choices: TailorChoices | null;
  resumes: ReadonlyArray<{ id: string; label: string; kind: 'built' | 'uploaded'; isDefault: boolean }> | null;
  resumesError: string | null;
  letterTemplates: ReadonlyArray<{ id: string; name: string; isSystem: boolean }> | null;
  copyReady: boolean;
  starting: boolean;
  onChange: (choices: TailorChoices) => void;
  onStart: () => void;
  onClose: () => void;
}) {
  const resumeOptions = (resumes ?? []).map((resume) => ({
    value: resume.id,
    label: `${resume.label}${resume.isDefault ? ' (Default)' : ''}${resume.kind === 'uploaded' ? ' · Uploaded' : ''}`,
  }));
  const templateOptions = [
    { value: OWN_TEMPLATE, label: "My resume's own template" },
    ...RESUME_TEMPLATE_IDS.map((id) => ({ value: id as string, label: RESUME_TEMPLATES[id].name })),
  ];
  const letterOptions = [
    { value: NO_TEMPLATE, label: 'No template (TailorIT layout)' },
    ...(letterTemplates ?? []).map((template) => ({ value: template.id, label: template.name })),
  ];
  const known = (value: string | null, options: ReadonlyArray<{ value: string }>, empty: string) =>
    value !== null && options.some((option) => option.value === value) ? value : empty;

  if (resumesError) return <Notice tone="error">{resumesError}</Notice>;
  if (!choices || !resumes) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-9 w-full" rounded="control" />
        <Skeleton className="h-9 w-full" rounded="control" />
        <Skeleton className="h-5 w-48" />
      </div>
    );
  }
  if (resumes.length === 0) {
    return (
      <>
        <Notice tone="info" title="Add a resume first">
          Tailoring writes a new resume for this job from one of yours.
        </Notice>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Link href="/resumes/new" className={buttonClasses()}>
            Create a resume
          </Link>
        </DialogFooter>
      </>
    );
  }
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        onStart();
      }}
    >
      <p className="text-sm leading-5 text-foreground">
        TailorIT writes a new resume for {target.company} from the one you choose, matched to the job&apos;s keywords, and
        saves it with your documents. Your resume itself is never changed.
      </p>
      {copyReady && <Notice tone="success">Your editable copy is ready: tailoring starts from it.</Notice>}
      <Field label="Resume to start from">
        <Select
          options={resumeOptions}
          value={choices.resumeId}
          onValueChange={(resumeId) => onChange({ ...choices, resumeId })}
          disabled={starting}
        />
      </Field>
      <Field label="Resume template" hint="Defaults from Settings › Autofill › Documents & templates.">
        <Select
          options={templateOptions}
          value={known(choices.resumeTemplateId, templateOptions, OWN_TEMPLATE)}
          onValueChange={(value) => onChange({ ...choices, resumeTemplateId: value === OWN_TEMPLATE ? null : value })}
          disabled={starting}
        />
      </Field>
      <div className="flex flex-col gap-3 rounded-control border border-border p-4">
        <Checkbox
          label="Also write a cover letter"
          checked={choices.coverLetter}
          disabled={starting}
          onCheckedChange={(coverLetter) => onChange({ ...choices, coverLetter })}
        />
        {choices.coverLetter && (
          <Field label="Cover letter template">
            <Select
              options={letterOptions}
              value={known(choices.coverLetterTemplateId, letterOptions, NO_TEMPLATE)}
              onValueChange={(value) => onChange({ ...choices, coverLetterTemplateId: value === NO_TEMPLATE ? null : value })}
              disabled={starting || letterTemplates === null}
            />
          </Field>
        )}
      </div>
      <DialogFooter flush>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" icon={<SparkleIcon size={16} weight="fill" />} loading={starting} disabled={!choices.resumeId}>
          {TAILOR_TITLE}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------- progress --

export function ProgressView({ step, message, onClose }: { step: Parameters<typeof stepRows>[0]; message: string | null; onClose: () => void }) {
  const rows = stepRows(step);
  const percent = progressPercent(step);
  return (
    <>
      <div className="flex flex-col gap-4">
        <TapeMeter label="Tailoring" value={percent} kind="progress" tone="primary" showValue={false} />
        <ol className="flex flex-col gap-2.5" aria-label="Steps">
          {rows.map((row) => (
            <li
              key={row.step}
              data-tailor-step={row.step}
              data-state={row.state}
              aria-current={row.state === 'current' ? 'step' : undefined}
              className="flex items-center gap-3 text-sm leading-5"
            >
              {row.state === 'done' ? (
                <span className="flex size-6 items-center justify-center rounded-full bg-primary text-on-primary">
                  <CheckIcon size={14} weight="bold" />
                </span>
              ) : row.state === 'current' ? (
                <span className="flex size-6 items-center justify-center">
                  <Spinner size={18} />
                </span>
              ) : (
                <span aria-hidden="true" className="size-6 rounded-full border-[1.5px] border-dashed border-control-strong" />
              )}
              <span className={clsx(row.state === 'current' ? 'font-semibold text-foreground' : row.state === 'done' ? 'text-foreground' : 'text-muted-foreground')}>
                {row.label}
              </span>
            </li>
          ))}
        </ol>
        <p role="status" className="min-h-5 text-[13px] leading-5 text-foreground" data-tailor-message="">
          {message ?? 'Starting...'}
        </p>
        <p className="text-[13px] leading-5 text-muted-foreground">
          This takes a minute or two. You can close this window: tailoring goes on, and the new resume appears with your
          documents.
        </p>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

// ------------------------------------------------------------------------------------------------------ result --

/** The band's tone on the tape: high success, medium warning, low danger. */
const SCORE_TONE = { high: 'success', medium: 'warning', low: 'danger' } as const;

/** The ATS score as a measurement: the number in the measurement face over a strip of tape filled to it. */
function ScoreTape({ score }: { score: number }) {
  return (
    <div className="flex w-full shrink-0 flex-col gap-2 sm:w-40" role="img" aria-label={`ATS score ${score} out of 100`}>
      <span aria-hidden="true" className="flex items-baseline gap-1.5">
        <span className="num text-[32px] leading-9 text-foreground" data-ats-score="">
          {score}
        </span>
        <span className="text-[11px] leading-4 font-semibold tracking-[0.06em] text-muted-foreground uppercase">ATS</span>
      </span>
      <span aria-hidden="true">
        <TapeMeter label="ATS score" value={score} tone={SCORE_TONE[scoreBand(score)]} size="lg" showValue={false} />
      </span>
    </div>
  );
}

function DocumentRow({
  kind,
  title,
  meta,
  onPreview,
  editHref,
  onDownload,
}: {
  kind: string;
  title: string;
  meta?: string;
  onPreview: () => void;
  editHref: string;
  onDownload: () => void;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-control border border-border bg-surface px-4 py-3 sm:flex-row sm:items-center" data-tailored={kind}>
      <span className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-primary-soft text-primary-ink">
          <FileTextIcon size={18} />
        </span>
        <span className="min-w-0">
          <span className="block text-xs leading-4 text-muted-foreground">{kind === 'resume' ? 'Resume' : 'Cover letter'}</span>
          <span className="block truncate text-sm leading-5 font-semibold text-foreground">{title}</span>
          {meta && <span className="block truncate text-xs leading-4 text-muted-foreground">{meta}</span>}
        </span>
      </span>
      <span className="flex shrink-0 flex-wrap items-center gap-1.5">
        <Button variant="outline" size="sm" icon={<EyeIcon size={14} />} onClick={onPreview} aria-label={`Preview the ${kind === 'resume' ? 'resume' : 'cover letter'}`}>
          Preview
        </Button>
        <Link href={editHref} className={buttonClasses({ variant: 'outline', size: 'sm' })} aria-label={`Edit the ${kind === 'resume' ? 'resume' : 'cover letter'}`}>
          <PencilSimpleIcon size={14} />
          Edit
        </Link>
        <Button variant="ghost" size="sm" icon={<DownloadSimpleIcon size={14} />} onClick={onDownload} aria-label={`Download the ${kind === 'resume' ? 'resume' : 'cover letter'} as a PDF`}>
          PDF
        </Button>
      </span>
    </li>
  );
}

export function ResultView({ result, onAgain, onClose }: { result: TailorResult; onAgain: () => void; onClose: () => void }) {
  const toast = useToast();
  const [previewing, setPreviewing] = useState<'resume' | 'letter' | null>(null);
  const missing = useMemo(() => (result.ats ? missingKeywords(result.ats) : []), [result.ats]);
  const templateName = (RESUME_TEMPLATES as Record<string, { name: string } | undefined>)[result.resumeTemplateId]?.name;
  const change = result.ats ? scoreChange(result.ats) : null;

  const download = async (what: 'resume' | 'letter') => {
    try {
      if (what === 'resume') await downloadFrom(resumeExportHref(result.resumeId, 'pdf'), resumeExportFileName(result.title, 'pdf'));
      else if (result.coverLetterId) await downloadFile(letterExportPath(result.coverLetterId, 'pdf'), `${result.title} - Cover letter.pdf`);
    } catch (error) {
      toast.error('Download failed', userMessage(error, 'The download did not work. Please try again.'));
    }
  };

  return (
    <>
      <div className="flex flex-col gap-5">
        {result.ats ? (
          <section aria-label="ATS score" className="flex flex-col gap-4 rounded-card border border-primary-200 bg-primary-50 p-4 sm:flex-row sm:items-center">
            <ScoreTape score={result.ats.score} />
            <div className="min-w-0 flex-1">
              <p className="text-base leading-6 font-semibold text-foreground">
                ATS score {result.ats.score}
                {change && <span className="ml-2 text-sm font-medium text-success">{change}</span>}
              </p>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13px] leading-5 text-foreground">
                <li>
                  Hard skills {result.ats.hardSkills.matched} of {result.ats.hardSkills.total}
                </li>
                <li>
                  Soft skills {result.ats.softSkills.matched} of {result.ats.softSkills.total}
                </li>
                <li>Job title {result.ats.jobTitle.found ? 'found' : 'not on the resume'}</li>
              </ul>
            </div>
          </section>
        ) : (
          <Notice tone="info">
            The posting had too little text to read keywords from, so there is no ATS score: the new resume is yours,
            titled for this job.
          </Notice>
        )}

        {result.ats && (
          <section aria-labelledby="tailor-missing-heading" className="flex flex-col gap-2">
            <h3 id="tailor-missing-heading" className="text-sm leading-5 font-semibold text-foreground">
              {missing.length === 0 ? 'No keywords missing' : `Keywords still missing (${missing.length})`}
            </h3>
            {missing.length === 0 ? (
              <p className="flex items-center gap-1.5 text-[13px] leading-5 text-foreground">
                <CheckCircleIcon size={16} weight="fill" className="text-success" /> The resume uses every keyword the job asks for.
              </p>
            ) : (
              <>
                <ul className="flex flex-wrap gap-1.5" aria-label="Keywords still missing">
                  {missing.slice(0, MAX_MISSING_SHOWN).map((keyword) => (
                    <li key={keyword} className="inline-flex h-7 items-center rounded-control border border-border-strong bg-surface px-2.5 text-[13px] font-medium text-foreground" data-missing-keyword="">
                      {keyword}
                    </li>
                  ))}
                  {missing.length > MAX_MISSING_SHOWN && (
                    <li className="inline-flex h-7 items-center px-1 text-[13px] text-muted-foreground">and {missing.length - MAX_MISSING_SHOWN} more</li>
                  )}
                </ul>
                <p className="text-[13px] leading-5 text-muted-foreground">Add the ones that are true of you in the editor.</p>
              </>
            )}
          </section>
        )}

        <section aria-labelledby="tailor-documents-heading" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="tailor-documents-heading" className="text-sm leading-5 font-semibold text-foreground">
              Your documents for this job
            </h3>
            {result.applicationId && (
              <span className="flex items-center gap-2">
                <Badge tone="tint" icon={<CheckIcon size={12} weight="bold" />} data-used-for-application="">
                  Used for this application
                </Badge>
                <Link href={trackerEntryHref(result.applicationId)} className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">
                  Job Tracker
                  <ArrowSquareOutIcon size={12} />
                </Link>
              </span>
            )}
          </div>
          <ul className="flex flex-col gap-2">
            <DocumentRow
              kind="resume"
              title={result.title}
              meta={templateName ? `On ${templateName}` : undefined}
              onPreview={() => setPreviewing('resume')}
              editHref={resumeEditorHref(result.resumeId)}
              onDownload={() => void download('resume')}
            />
            {result.coverLetterId && (
              <DocumentRow
                kind="letter"
                title={`${result.title} - Cover letter`}
                onPreview={() => setPreviewing('letter')}
                editHref={`/cover-letter/${encodeURIComponent(result.coverLetterId)}`}
                onDownload={() => void download('letter')}
              />
            )}
          </ul>
          {result.applicationId && (
            <p className="text-[13px] leading-5 text-muted-foreground">
              The TailorIT extension attaches them when you apply to this job.
            </p>
          )}
        </section>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onAgain}>
          Tailor again
        </Button>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
      <ResumePreviewDialog
        open={previewing === 'resume'}
        onOpenChange={(open) => !open && setPreviewing(null)}
        resumeId={result.resumeId}
        label={result.title}
      />
      {result.coverLetterId && (
        <LetterPreviewDialog
          open={previewing === 'letter'}
          onOpenChange={(open) => !open && setPreviewing(null)}
          letterId={result.coverLetterId}
          title={`${result.title} - Cover letter`}
        />
      )}
    </>
  );
}

// ----------------------------------------------------------------------------------------------------- problem --

export function ProblemView({
  problem,
  resumeId,
  onCopied,
  onBack,
  onClose,
}: {
  problem: TailorProblem;
  resumeId: string | null;
  onCopied: (copyId: string) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const text = problemText(problem);
  const [copyTask, setCopyTask] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copy = useAiTask(copyTask, { kind: 'resume_import' });
  const copyId = copy.isSucceeded ? readImportResult(copy.task?.result) : null;

  const reported = useRef(false);
  useEffect(() => {
    if (!copyId || reported.current) return;
    reported.current = true;
    onCopied(copyId);
  }, [copyId, onCopied]);

  const makeCopy = async () => {
    if (!resumeId) return;
    setCopyError(null);
    try {
      setCopyTask(await startEditableCopy(resumeId));
    } catch (error) {
      setCopyError(userMessage(error, 'The editable copy could not start. Please try again.'));
    }
  };

  const copying = copyTask !== null && copy.isRunning;
  const copyFailed = copyTask !== null && (copy.isFailed || copy.status === 'cancelled' || (copy.isSucceeded && !copyId));
  return (
    <>
      <div className="flex flex-col gap-4" data-tailor-problem={problem.kind}>
        <Notice tone={problem.kind === 'needs_editable_copy' ? 'info' : 'error'} title={text.title}>
          {text.body}
        </Notice>
        {copying && (
          <div role="status" className="flex items-center gap-3 rounded-control border-l-[3px] border-info bg-info-soft px-3.5 py-3 text-sm text-info-ink">
            <Spinner size={16} />
            <span>
              <span className="font-semibold">Making an editable copy.</span> {copy.message ?? 'Reading your resume...'} This can
              take a minute.
            </span>
          </div>
        )}
        {(copyError || copyFailed) && (
          <Notice tone="error">{copyError ?? copy.errorMessage ?? 'The editable copy could not be made. Please try again.'}</Notice>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={problem.kind === 'needs_editable_copy' ? onBack : onClose}>
          {problem.kind === 'needs_editable_copy' ? 'Choose another resume' : 'Close'}
        </Button>
        {problem.kind === 'needs_editable_copy' ? (
          <Button icon={<SparkleIcon size={16} />} loading={copying} disabled={!resumeId} onClick={() => void makeCopy()}>
            Make an editable copy
          </Button>
        ) : problem.kind === 'failed' || problem.kind === 'not_found' || problem.kind === 'ai_busy' ? (
          <Button onClick={onBack}>Try again</Button>
        ) : null}
      </DialogFooter>
    </>
  );
}
