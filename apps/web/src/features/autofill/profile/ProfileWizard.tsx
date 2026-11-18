'use client';

import type { AutofillResumeList } from '@tailorit/shared/autofill';
import { clsx } from 'clsx';
import type { ReactNode, Ref } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { CaretLeftIcon, CaretRightIcon, CheckCircleIcon, PencilSimpleIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { WizardStepper, type WizardStepperStep } from '@/components/ui/Stepper';
import type { AutofillDraft } from '../draft';
import { Section } from '../Section';
import { OnceChecklistSection } from './QuestionSections';
import {
  WIZARD_STEPS,
  stepIndex,
  stepNames,
  stepSummary,
  wizardStep,
  type SummaryNames,
  type WizardStepId,
} from './wizard';

// v1.4 E (decision 19): what the profile wizard draws around the existing cards: the stepper, each step's heading, the
// import step, the Review, and the footer with Back, Save & exit and Next (sticky, so it stays in reach on a phone and
// on the long steps).

/** The stepper's dots: the current step, the steps with a field to fix, and the ones already filled in. */
export function ProfileStepper({
  current,
  draft,
  errorSteps,
  onSelect,
}: {
  current: WizardStepId;
  draft: AutofillDraft;
  errorSteps: readonly WizardStepId[];
  onSelect: (step: WizardStepId) => void;
}) {
  const steps: WizardStepperStep[] = WIZARD_STEPS.map((step) => ({
    key: step.id,
    label: step.label,
    state: errorSteps.includes(step.id) ? 'error' : step.id !== 'review' && stepSummary(step.id, draft).filled ? 'complete' : 'upcoming',
  }));
  return (
    <WizardStepper
      aria-label="Profile steps"
      steps={steps}
      current={current}
      onSelect={(key) => onSelect(key as WizardStepId)}
    />
  );
}

/** "Step 3 of 9", the step's title (focused when the step changes) and what it is for. */
export function StepHeader({ step, headingRef }: { step: WizardStepId; headingRef: Ref<HTMLHeadingElement> }) {
  const info = wizardStep(step);
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs leading-4 font-semibold tracking-[0.06em] text-primary-ink uppercase">
        Step {stepIndex(step) + 1} of {WIZARD_STEPS.length}
      </p>
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="scroll-mt-24 font-display text-xl leading-7 font-semibold tracking-[-0.01em] text-foreground outline-none"
        data-step-heading=""
      >
        {info.title}
      </h2>
      <p className="text-sm leading-5 text-muted-foreground">{info.description}</p>
    </div>
  );
}

/** Step 1: "Fill from my resume", and what to check once it has filled the form. */
export function ImportStep({
  resumes,
  seedResumeId,
  onPickResume,
  filling,
  busy,
  onFill,
  notes,
}: {
  resumes: AutofillResumeList | null;
  seedResumeId: string | null;
  onPickResume: (id: string | null) => void;
  filling: boolean;
  busy: boolean;
  onFill: () => void;
  notes: readonly string[];
}) {
  const options = (resumes?.items ?? []).map((resume) => ({ value: resume.id, label: resume.label }));
  return (
    <>
      <Notice tone="info">
        Your autofill profile fills job applications through the TailorIT extension. It is separate from your resume.
      </Notice>
      <Section
        title="Fill from my resume"
        description="Fills only the fields that are still empty. Nothing is saved until you go on with Next or save."
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Resume to fill from" className="min-w-0 flex-1 sm:max-w-sm">
              <Select
                options={options}
                value={seedResumeId}
                placeholder={resumes && resumes.items.length === 0 ? 'No resumes yet' : 'Choose a resume'}
                disabled={options.length === 0}
                onValueChange={onPickResume}
              />
            </Field>
            <Button variant="secondary" loading={filling} disabled={busy} onClick={onFill}>
              Fill from my resume
            </Button>
          </div>
          {notes.length > 0 && (
            <Notice tone="info" title="Check these">
              <ul className="list-disc pl-5">
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </Notice>
          )}
          <p className="text-[13px] leading-5 text-muted-foreground">
            No resume to fill from? Go on with Next and type your answers in.
          </p>
        </div>
      </Section>
    </>
  );
}

/** The steps the Review lists: every step that edits something. */
const REVIEWED: readonly WizardStepId[] = WIZARD_STEPS.filter((step) => step.places.length > 0).map((step) => step.id);

/** The last step: "Answer these once", then every step in a few lines with its Edit button. */
export function ReviewStep({
  draft,
  errorSteps,
  names,
  onEdit,
}: {
  draft: AutofillDraft;
  errorSteps: readonly WizardStepId[];
  names: SummaryNames;
  onEdit: (step: WizardStepId) => void;
}) {
  return (
    <>
      <OnceChecklistSection />
      <section aria-label="Your profile, step by step" className="rounded-card border border-border bg-surface shadow-card">
        <ul className="divide-y divide-divider-soft">
          {REVIEWED.map((id) => {
            const step = wizardStep(id);
            const summary = stepSummary(id, draft, names);
            const needsChange = errorSteps.includes(id);
            return (
              <li
                key={id}
                data-review-step={id}
                className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-6"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[15px] leading-6 font-semibold text-foreground">{step.title}</h3>
                    {needsChange ? (
                      <Badge tone="destructive">Needs a change</Badge>
                    ) : summary.filled ? (
                      <CheckCircleIcon size={18} weight="fill" className="text-success" aria-label="Filled in" role="img" />
                    ) : id === 'documents' ? (
                      // Its defaults are choices too: the best match, the resume's own template, no letter template.
                      <Badge tone="neutral">Defaults</Badge>
                    ) : (
                      <Badge tone="neutral">Not filled in yet</Badge>
                    )}
                  </div>
                  {summary.lines.length > 0 ? (
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {summary.lines.map((line, index) => (
                        <li key={index} className="text-[13px] leading-5 break-words text-foreground">
                          {line}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-[13px] leading-5 text-muted-foreground">Nothing here yet.</p>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  icon={<PencilSimpleIcon size={14} />}
                  aria-label={`Edit ${step.title}`}
                  onClick={() => onEdit(id)}
                  className="self-start"
                >
                  Edit
                </Button>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

/** "Not saved yet: Education has a field that needs a change.", with a way there. */
export function OtherStepsNotice({ steps, onGo }: { steps: readonly WizardStepId[]; onGo: (step: WizardStepId) => void }) {
  if (steps.length === 0) return null;
  const first = steps[0]!;
  return (
    <Notice
      tone="error"
      title="Your changes are not saved yet"
      action={
        <Button variant="outline" size="sm" onClick={() => onGo(first)}>
          Go to {wizardStep(first).label}
        </Button>
      }
    >
      {stepNames(steps)} {steps.length === 1 ? 'has' : 'have'} a field that needs a change first.
    </Notice>
  );
}

/**
 * Back, the save status, Discard changes, Save & exit and Next (Save changes on the Review), in a bar that sticks to
 * the bottom of the window (from 1024 px a card floating just over it). On a phone the status and Discard go on a line of their own above the buttons.
 */
export function WizardFooter({
  step,
  dirty,
  saving,
  savedThisVisit,
  onBack,
  onDiscard,
  onSaveAndExit,
}: {
  step: WizardStepId;
  dirty: boolean;
  saving: boolean;
  savedThisVisit: boolean;
  onBack: () => void;
  onDiscard: () => void;
  onSaveAndExit: () => void;
}) {
  const first = stepIndex(step) === 0;
  const review = step === 'review';
  const status: ReactNode = saving ? 'Saving...' : dirty ? 'Unsaved changes' : savedThisVisit ? (
    <span className="inline-flex items-center gap-1">
      <CheckCircleIcon size={14} weight="fill" className="text-success" />
      All changes saved
    </span>
  ) : null;
  const discard = (
    <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={onDiscard}>
      Discard changes
    </Button>
  );
  return (
    <div
      data-wizard-footer=""
      className={clsx(
        'sticky bottom-0 z-20 -mx-4 border-t border-border bg-surface/95 px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] backdrop-blur-sm',
        // v31 FIX-WEB (REV-UX UX-11): from 1024 px a whole card (four edges, all corners) that floats 12 px over the
        // window's bottom, so it reads as one bar whether it is stuck there or sits under a short step.
        'sm:-mx-6 sm:px-6 lg:bottom-3 lg:mx-0 lg:rounded-card lg:border lg:px-5 lg:shadow-popover',
      )}
    >
      {/* A phone's line: the status and Discard. */}
      {(dirty || status) && (
        <div className="mb-2 flex min-h-8 items-center justify-between gap-3 sm:hidden">
          <p role="status" className="truncate text-[13px] leading-5 text-muted-foreground">
            {status}
          </p>
          {dirty && discard}
        </div>
      )}
      <div className="flex items-center gap-2 sm:gap-3">
        <Button variant="outline" icon={<CaretLeftIcon size={14} />} disabled={first || saving} onClick={onBack}>
          Back
        </Button>
        <p role="status" className="hidden min-w-0 flex-1 truncate text-[13px] leading-5 text-muted-foreground sm:block">
          {status}
        </p>
        <span className="flex-1 sm:hidden" />
        <span className="hidden sm:contents">{dirty && discard}</span>
        {!review && (
          <Button variant="outline" disabled={saving} onClick={onSaveAndExit}>
            Save &amp; exit
          </Button>
        )}
        {review ? (
          <Button type="submit" loading={saving} disabled={!dirty}>
            {saving ? 'Saving...' : 'Save changes'}
          </Button>
        ) : (
          <Button type="submit" loading={saving} trailingIcon={<CaretRightIcon size={14} />}>
            Next
          </Button>
        )}
      </div>
    </div>
  );
}
