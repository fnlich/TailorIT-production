'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { JOB_LINK_MAX_CHARS, type AddJobBody, type AddJobResult, type JobAddDetails } from '@tailorit/shared';
import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { PlusIcon } from '@/components/ui/icons';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { jobsKeys } from '../api';
import { LinkSimpleIcon } from '../icons';
import { addJobByLink } from './api';
import { ADD_JOB_COPY, addOutcomeView, linkInput, type AddOutcomeView } from './outcome';

// v31 JOBSWEB: "Add job" on the Jobs page (docs/design/v3.1/21-jobs-from-links.md §3, the plan's D1-D2). The person
// pastes a posting's link; TailorIT's server reads the posting itself (POST /api/jobs/add) and the dialog says what came
// of it, with the next step:
//   published            everyone sees it now                         Open the job | Add another
//   waiting_admin        an admin approves it next; it is saved       Open the job | Add another
//   private_unverified   TailorIT could not read the link (why):
//                        - with no job yet, the title and company typed here make the person's own job (only they
//                          see it, "From your browser, not verified")  Back | Save for me only
//                        - their own job                             Open the job | Add another
//   refused              closed, not a job link, rejected            Try another link | Close
// The job is saved to the person's Job Tracker by the server.

/** The tracker's React Query keys all start with 'tracker'. */
const TRACKER_KEY = ['tracker'] as const;

const FORM_ID = 'add-job-form';
const DETAILS_FORM_ID = 'add-job-details-form';

type Step =
  | { kind: 'link' }
  | { kind: 'details'; url: string; view: AddOutcomeView }
  | { kind: 'outcome'; view: AddOutcomeView };

interface DetailErrors {
  title?: string;
  company?: string;
}

export interface AddJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Open the job": the page shows it. */
  onOpenJob: (jobId: number) => void;
  /** v31 FIX-JOBS (REV-UX UX-3): where focus goes when the dialog closes (the "Add job" button). */
  finalFocus?: RefObject<HTMLElement | null>;
}

export function AddJobDialog({ open, onOpenChange, onOpenJob, finalFocus }: AddJobDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={ADD_JOB_COPY.title} size="lg" finalFocus={finalFocus}>
        {open && <AddJobFlow onClose={() => onOpenChange(false)} onOpenJob={onOpenJob} />}
      </DialogContent>
    </Dialog>
  );
}

function AddJobFlow({ onClose, onOpenJob }: { onClose: () => void; onOpenJob: (jobId: number) => void }) {
  const client = useQueryClient();
  const { t } = usePublicConstants();
  const [step, setStep] = useState<Step>({ kind: 'link' });
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [details, setDetails] = useState<JobAddDetails>({ title: '', company: '', location: '', description: '' });
  const [detailErrors, setDetailErrors] = useState<DetailErrors>({});
  const linkRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  const add = useMutation({
    mutationFn: (body: AddJobBody) => addJobByLink(body),
    onSuccess: (result: AddJobResult, body) => {
      const view = addOutcomeView(result, t);
      if (view.next === 'details' && !body.details) setStep({ kind: 'details', url: result.url ?? body.url, view });
      else setStep({ kind: 'outcome', view });
      if (result.jobId !== null) {
        void Promise.all([
          client.invalidateQueries({ queryKey: jobsKeys.all }),
          client.invalidateQueries({ queryKey: TRACKER_KEY }),
        ]);
      }
    },
  });

  // Each step puts focus where the person goes next: the link, the title, or the outcome's main button.
  useEffect(() => {
    if (step.kind === 'link') linkRef.current?.focus();
    else if (step.kind === 'details') titleRef.current?.focus();
    else nextRef.current?.focus();
  }, [step]);

  const submitLink = (event: FormEvent) => {
    event.preventDefault();
    const url = linkInput(link);
    if (!url) {
      setLinkError(ADD_JOB_COPY.linkRequired);
      return;
    }
    setLinkError(null);
    add.mutate({ url });
  };

  const submitDetails = (event: FormEvent) => {
    event.preventDefault();
    if (step.kind !== 'details') return;
    const errors: DetailErrors = {};
    if (!details.title.trim()) errors.title = 'Required';
    if (!details.company.trim()) errors.company = 'Required';
    setDetailErrors(errors);
    if (errors.title || errors.company) return;
    add.mutate({
      url: step.url,
      details: {
        title: details.title.trim(),
        company: details.company.trim(),
        ...(details.location?.trim() ? { location: details.location.trim() } : {}),
        ...(details.description?.trim() ? { description: details.description.trim() } : {}),
      },
    });
  };

  const restart = (keepLink: boolean) => {
    add.reset();
    if (!keepLink) setLink('');
    setDetails({ title: '', company: '', location: '', description: '' });
    setDetailErrors({});
    setStep({ kind: 'link' });
  };

  const failure = add.isError ? userMessage(add.error, ADD_JOB_COPY.failed) : null;

  if (step.kind === 'outcome') {
    const { view } = step;
    return (
      <div className="mt-5 flex flex-col" data-add-job-outcome={view.tone}>
        <OutcomeNotice view={view} />
        <DialogFooter>
          {view.next === 'retry' ? (
            <>
              <Button variant="outline" onClick={onClose}>
                {ADD_JOB_COPY.close}
              </Button>
              <Button ref={nextRef} onClick={() => restart(true)}>
                {ADD_JOB_COPY.tryAnother}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" icon={<PlusIcon size={16} />} onClick={() => restart(false)}>
                {ADD_JOB_COPY.addAnother}
              </Button>
              {view.jobId !== null && (
                <Button
                  ref={nextRef}
                  onClick={() => {
                    onOpenJob(view.jobId!);
                    onClose();
                  }}
                >
                  {ADD_JOB_COPY.openJob}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </div>
    );
  }

  if (step.kind === 'details') {
    return (
      <form id={DETAILS_FORM_ID} onSubmit={submitDetails} noValidate className="mt-5 flex flex-col gap-4" data-add-job-details="">
        <OutcomeNotice view={step.view} />
        <p className="text-[13px] leading-5 text-muted-foreground">{ADD_JOB_COPY.detailsLead}</p>
        <Field label="Job title" required error={detailErrors.title}>
          <Input
            ref={titleRef}
            value={details.title}
            maxLength={300}
            autoComplete="off"
            onChange={(event) => {
              setDetails((current) => ({ ...current, title: event.target.value }));
              setDetailErrors((current) => ({ ...current, title: undefined }));
            }}
          />
        </Field>
        <Field label="Company" required error={detailErrors.company}>
          <Input
            value={details.company}
            maxLength={200}
            autoComplete="organization"
            onChange={(event) => {
              setDetails((current) => ({ ...current, company: event.target.value }));
              setDetailErrors((current) => ({ ...current, company: undefined }));
            }}
          />
        </Field>
        <Field label="Location" optional>
          <Input
            value={details.location ?? ''}
            maxLength={300}
            autoComplete="off"
            onChange={(event) => setDetails((current) => ({ ...current, location: event.target.value }))}
          />
        </Field>
        <Field label="Description" optional hint="Paste the posting's text to tailor to it.">
          <Textarea
            value={details.description ?? ''}
            rows={4}
            maxLength={20_000}
            onChange={(event) => setDetails((current) => ({ ...current, description: event.target.value }))}
          />
        </Field>
        {failure && <Notice tone="error">{failure}</Notice>}
        <DialogFooter flush className="mt-2">
          <Button variant="outline" onClick={() => restart(true)} disabled={add.isPending}>
            {ADD_JOB_COPY.back}
          </Button>
          <Button type="submit" form={DETAILS_FORM_ID} loading={add.isPending}>
            {ADD_JOB_COPY.saveForMe}
          </Button>
        </DialogFooter>
      </form>
    );
  }

  return (
    <form id={FORM_ID} onSubmit={submitLink} noValidate className="flex flex-col" data-add-job-link="">
      <DialogDescription className="mt-1.5">{ADD_JOB_COPY.description}</DialogDescription>
      <Field label={ADD_JOB_COPY.linkLabel} required error={linkError} hint={ADD_JOB_COPY.linkHint} className="mt-5">
        <Input
          ref={linkRef}
          type="url"
          inputMode="url"
          value={link}
          placeholder={ADD_JOB_COPY.linkPlaceholder}
          maxLength={JOB_LINK_MAX_CHARS}
          autoComplete="off"
          spellCheck={false}
          leading={<LinkSimpleIcon size={16} aria-hidden="true" />}
          readOnly={add.isPending}
          onChange={(event) => {
            setLink(event.target.value);
            setLinkError(null);
            if (add.isError) add.reset();
          }}
        />
      </Field>
      {add.isPending && (
        <p role="status" className="mt-3 text-[13px] leading-5 text-muted-foreground">
          {ADD_JOB_COPY.adding}
        </p>
      )}
      {failure && (
        <Notice tone="error" className="mt-4">
          {failure}
        </Notice>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={add.isPending}>
          Cancel
        </Button>
        <Button type="submit" form={FORM_ID} loading={add.isPending}>
          {ADD_JOB_COPY.add}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The outcome's notice: its title, the server's words, and why TailorIT could not read the link. */
function OutcomeNotice({ view }: { view: AddOutcomeView }) {
  return (
    <Notice tone={view.tone} title={view.title}>
      <p data-add-job-message="">{view.body}</p>
      {view.why && (
        <p className="mt-1" data-add-job-why="">
          {view.why}
        </p>
      )}
    </Notice>
  );
}

/** The page's "Add job" button and its dialog. */
export function AddJobButton({ onOpenJob, className }: { onOpenJob: (jobId: number) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  // v31 FIX-JOBS (REV-UX UX-3): the dialog has no trigger of its own (it is controlled), so Cancel, Escape and ×
  // give focus back to this button by name, never to the page's body.
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={button}
        icon={<PlusIcon size={16} weight="bold" />}
        onClick={() => setOpen(true)}
        className={className}
        data-add-job-button=""
      >
        {ADD_JOB_COPY.add}
      </Button>
      <AddJobDialog open={open} onOpenChange={setOpen} onOpenJob={onOpenJob} finalFocus={button} />
    </>
  );
}
