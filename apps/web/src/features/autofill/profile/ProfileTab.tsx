'use client';

import {
  EMPTY_AUTOFILL_SENSITIVE,
  type AutofillProfileEnvelope,
  type AutofillResumeList,
  type AutofillSensitiveEnvelope,
  type PutAutofillProfileResponse,
} from '@tailorit/shared/autofill';
import { isResumeTemplateId, RESUME_TEMPLATES } from '@tailorit/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react';
import { useLimitDialog } from '@/components/limits';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { ApiError, isProfileRefusal, userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { useAiTask } from '@/lib/useAiTask';
import {
  autofillKeys,
  fetchAutofillProfile,
  fetchAutofillResumes,
  fetchAutofillSeed,
  fetchAutofillSensitive,
  saveAutofillProfile,
  startAutofillSeed,
} from '../api';
import { cleanDraft, type AutofillDraft } from '../draft';
import { mergeSeed } from '../mergeSeed';
import { SectionHeadingLevel } from '../Section';
import { validateAutofillProfile } from '../validate';
import { ProfileFormProvider, SensitiveFields, useProfileFormState, type SensitiveGate } from './form';
import { CertificationsSection, EducationSection, ExperienceSection, LanguagesSkillsSection } from './HistorySections';
import { ContactSection, LinksSection, NameSection } from './PersonalSections';
import { ImportStep, OtherStepsNotice, ProfileStepper, ReviewStep, StepHeader, WizardFooter } from './ProfileWizard';
import {
  AnythingElseSection,
  OnceChecklistSection,
  OtherQuestionsSection,
  ResumeSection,
  ScreeningSection,
  SelfIdentificationSection,
  WorkAuthorizationSection,
} from './QuestionSections';
import { SectionLinkContext } from './sectionLink';
import { NotShared, OWN_ACCESS, refusedRead, type ProfileAccess } from '../../sharing/access'; // v33 SHARE-7
import { LetterTemplateSection, ResumeTemplateSection, useLetterTemplates } from './TemplateSections';
import {
  messagesIn,
  messagesUpTo,
  neighbourStep,
  planAdvance,
  planSave,
  readWizardStep,
  stepOfSection,
  stepsWithMessages,
  type SummaryNames,
  type WizardStepId,
} from './wizard';

/** v32 FILL: an uploaded file the AI is reading for "Fill from my resume" (its task), and the resume asked for. */
interface SeedReading {
  taskId: string;
  resumeId: string | null;
}

/**
 * v33 SHARE-7 (review: security 2): what a save leaves as the sensitive part's cached copy. Where the sensitive answers
 * are not shared with the person (`hidden`) nothing: whatever the answer carries is never kept (null: remove the copy).
 * Else the part the answer carries (a session gets it back), or the one that was sent.
 */
export function sensitiveAfterSave(
  gate: SensitiveGate,
  apiVersion: AutofillSensitiveEnvelope['apiVersion'],
  saved: Pick<PutAutofillProfileResponse, 'revision' | 'updatedAt' | 'sensitive'>,
  sent: AutofillSensitiveEnvelope['sensitive'],
): AutofillSensitiveEnvelope | null {
  if (gate === 'hidden') return null;
  return { apiVersion, revision: saved.revision, updatedAt: saved.updatedAt, sensitive: saved.sensitive ?? sent };
}

/**
 * What outlives the form between saves: a save gives both queries new data, and the form starts again from it (a new
 * mount), so where focus goes next is kept here, above it.
 */
interface WizardMemory {
  /** The step whose heading (or `anchor`'s card) takes focus once it shows. */
  focus: WizardStepId | null;
  anchor: string | null;
}

/**
 * Settings › Autofill › Profile (v1.4 E, decision 19): the answers the extension fills applications with, both parts
 * saved together, as a step-by-step wizard like jobright.ai's profile onboarding. The step is in the address
 * (`&step=`); a profile never saved starts on the import, one already saved on the Review.
 */
export function ProfileTab({
  access = OWN_ACCESS,
  sensitiveAccess = OWN_ACCESS,
}: {
  /** v33 SHARE-7: the owner's Autofill info boxes on a shared profile (the person's own: everything). */
  access?: ProfileAccess;
  /** v33 SHARE-7: the owner's Sensitive answers boxes: without See the sensitive part is never asked for. */
  sensitiveAccess?: ProfileAccess;
} = {}) {
  const queryClient = useQueryClient();
  // v33 SHARE-7: the sensitive part is asked for, kept and drawn only with the owner's Sensitive answers See box.
  const sensitiveAsked = access.see && sensitiveAccess.see;
  const profile = useQuery({
    queryKey: autofillKeys.profile,
    queryFn: ({ signal }) => fetchAutofillProfile(signal),
    enabled: access.see, // v33 SHARE-7
  });
  const sensitive = useQuery({
    queryKey: autofillKeys.sensitive,
    queryFn: ({ signal }) => fetchAutofillSensitive(signal),
    enabled: sensitiveAsked, // v33 SHARE-7
  });
  const resumes = useQuery({ queryKey: autofillKeys.resumes, queryFn: ({ signal }) => fetchAutofillResumes(signal) });
  const memoryRef = useRef<WizardMemory>({ focus: null, anchor: null });
  const [savedThisVisit, setSavedThisVisit] = useState(false);
  // v32 FILL: kept above the form, so a save while the AI reads (Next) does not lose what the reading fills.
  const [reading, setReading] = useState<SeedReading | null>(null);

  // v33 SHARE-7: a sensitive part read before the owner took the See box away is dropped from the cache.
  useEffect(() => {
    if (!sensitiveAsked) queryClient.removeQueries({ queryKey: autofillKeys.sensitive, exact: true });
  }, [sensitiveAsked, queryClient]);

  const reload = () => {
    void profile.refetch();
    // v33 SHARE-7: refetch() ignores `enabled`: never asked for without the See box.
    if (sensitiveAsked) void sensitive.refetch();
  };

  // v33 SHARE-7: a sensitive read refused anyway (the owner unticked its See box since the list was read) hides the
  // sensitive answers only; the rest of the profile still shows.
  const sensitiveShown = sensitiveAsked && !(sensitive.isError && refusedRead(sensitive.error));
  const sensitiveGate: SensitiveGate = !sensitiveShown ? 'hidden' : sensitiveAccess.change && access.change ? 'shown' : 'readOnly';

  // v33 SHARE-7: not shared with the person, or a read refused because of it.
  if (!access.see || (profile.isError && refusedRead(profile.error))) {
    return <NotShared owner={access.owner} />;
  }
  if (profile.isError || (sensitiveShown && sensitive.isError)) {
    return (
      <Notice
        tone="error"
        title="Your autofill profile didn't load."
        action={
          <Button variant="outline" size="sm" onClick={reload}>
            Try again
          </Button>
        }
      >
        {userMessage(profile.error ?? sensitive.error, 'Please try again in a moment.')}
      </Notice>
    );
  }
  if (profile.isPending || (sensitiveShown && sensitive.isPending)) return <ProfileSkeleton />;
  // v33 SHARE-7: without the Sensitive answers See box the sensitive part is not read (and a cached one is never used):
  // an empty one stands in, never drawn (its sections say "Not shared with you.") and never sent.
  const sensitiveData: AutofillSensitiveEnvelope = (sensitiveShown ? sensitive.data : undefined) ?? {
    apiVersion: profile.data.apiVersion,
    revision: profile.data.revision,
    updatedAt: profile.data.updatedAt,
    sensitive: EMPTY_AUTOFILL_SENSITIVE,
  };
  return (
    <ProfileForm
      // A save (or a reload after a conflict) gives both queries new data: the form starts again from it.
      key={`${profile.dataUpdatedAt}:${sensitiveShown ? sensitive.dataUpdatedAt : 0}`}
      profile={profile.data}
      sensitive={sensitiveData}
      access={access}
      sensitiveGate={sensitiveGate}
      sensitiveOwner={sensitiveAccess.owner}
      resumes={resumes.data ?? null}
      onReload={reload}
      memoryRef={memoryRef}
      savedThisVisit={savedThisVisit}
      onSaved={() => setSavedThisVisit(true)}
      reading={reading}
      setReading={setReading}
    />
  );
}

/** What a save does once it is through. */
type AfterSave = { kind: 'move'; to: WizardStepId } | { kind: 'exit' } | { kind: 'stay' };

interface SaveRequest {
  draft: AutofillDraft;
  from: WizardStepId;
  after: AfterSave;
}

function ProfileForm({
  profile,
  sensitive,
  access,
  sensitiveGate,
  sensitiveOwner,
  resumes,
  onReload,
  memoryRef,
  savedThisVisit,
  onSaved,
  reading,
  setReading,
}: {
  profile: AutofillProfileEnvelope;
  sensitive: AutofillSensitiveEnvelope;
  access: ProfileAccess;
  /** v33 SHARE-7: the sensitive answers on this profile (the person's own: shown). */
  sensitiveGate: SensitiveGate;
  /** v33 SHARE-7: who did not share them (the owner's name), for "Not shared with you.". */
  sensitiveOwner: string | null;
  resumes: AutofillResumeList | null;
  onReload: () => void;
  memoryRef: RefObject<WizardMemory>;
  savedThisVisit: boolean;
  onSaved: () => void;
  reading: SeedReading | null;
  setReading: Dispatch<SetStateAction<SeedReading | null>>;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = usePublicConstants();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initial = useMemo<AutofillDraft>(
    () => ({ profile: profile.profile, sensitive: sensitive.sensitive }),
    [profile, sensitive],
  );
  const [state, dispatch] = useProfileFormState(initial);
  // Bumped by Discard, so the fields' own state (a value set aside, half-typed chips) starts again too.
  const [generation, setGeneration] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  // The page's own checks refused the last move or save: the notice above the footer counts this step's fields.
  const [checksRefused, setChecksRefused] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [pickedResume, setPickedResume] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // The two parts load apart: a save is made from the older revision, so either one being stale is refused.
  const revision = Math.min(profile.revision, sensitive.revision);
  const step = readWizardStep(searchParams.get('step'), revision);
  const dirty = JSON.stringify(state.draft) !== JSON.stringify(initial);
  const seedResumeId = pickedResume ?? resumes?.defaultResumeId ?? resumes?.items[0]?.id ?? null;
  const errorSteps = stepsWithMessages(Object.keys(state.errors));

  /** Goes to a step (and a card on it): the address says which, and its heading (or the card) takes focus. */
  const goTo = useCallback(
    (next: WizardStepId, anchor: string | null = null) => {
      memoryRef.current = { focus: next, anchor };
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', 'profile');
      params.set('step', next);
      router.replace(`${pathname}?${params.toString()}${anchor ? `#${anchor}` : ''}`, { scroll: false });
    },
    [memoryRef, pathname, router, searchParams],
  );

  // The step (or the card) asked for takes focus once it shows; a step shown on arrival is left alone. The step's top
  // comes into view when Next was pressed at the bottom of a long step.
  useEffect(() => {
    const wanted = memoryRef.current;
    if (wanted.focus !== step) return;
    const card = wanted.anchor ? document.getElementById(wanted.anchor) : null;
    if (card) {
      card.scrollIntoView({ block: 'start' });
      card.focus({ preventScroll: true });
    } else {
      const top = topRef.current;
      if (top && top.getBoundingClientRect().top < 72) top.scrollIntoView({ block: 'start' });
      headingRef.current?.focus({ preventScroll: true });
    }
    // Next's save mounts the form again with the saved data, maybe just after this: that mount takes focus too (this
    // heading is then gone). Only then is the move done.
    const timer = window.setTimeout(() => {
      if (memoryRef.current === wanted) memoryRef.current = { focus: null, anchor: null };
    }, 800);
    return () => window.clearTimeout(timer);
  }, [step, memoryRef]);

  // An "Answer" link: the card's step, then the card. On this step already: straight to the card.
  const linkToSection = useCallback(
    (section: string) => {
      const target = stepOfSection(section);
      if (target && target !== step) {
        goTo(target, section);
        return;
      }
      const card = document.getElementById(section);
      if (!card) return;
      window.history.replaceState(window.history.state, '', `#${section}`);
      card.scrollIntoView({ block: 'start' });
      card.focus({ preventScroll: true });
    },
    [goTo, step],
  );

  // v33 SHARE-7: without the owner's Autofill info Change box everything is shown, nothing changes (every control is
  // off, as while a save runs); the sensitive part is sent only when it was read and may be changed (never the empty
  // stand-in).
  const readOnly = !access.change;
  const save = useMutation({
    mutationFn: ({ draft }: SaveRequest) =>
      saveAutofillProfile({
        revision,
        profile: draft.profile,
        ...(sensitiveGate === 'shown' ? { sensitive: draft.sensitive } : {}),
      }),
    onSuccess: (saved, { draft, from, after }) => {
      const flagged = saved.anythingElseFlaggedLines.length > 0;
      if (after.kind === 'move') {
        // A note that now states a sensitive answer: the step stays, so its warning is read.
        const noteChanged = draft.profile.anythingElse !== initial.profile.anythingElse;
        if (from === 'questions' && flagged && noteChanged) {
          toast.info('Saved. Check your note', 'Some lines of it state a sensitive answer, so the AI never reads them.');
        } else {
          goTo(after.to);
        }
      } else {
        toast.success(
          'Autofill profile saved',
          flagged && after.kind === 'stay' ? 'Some lines of your note state a sensitive answer: see Questions & preferences.' : undefined,
        );
        if (after.kind === 'exit') goTo('review');
      }
      onSaved();
      queryClient.setQueryData<AutofillProfileEnvelope>(autofillKeys.profile, {
        apiVersion: profile.apiVersion,
        revision: saved.revision,
        updatedAt: saved.updatedAt,
        profile: saved.profile,
        anythingElseFlaggedLines: saved.anythingElseFlaggedLines,
      });
      // The Settings session always gets the sensitive part back; a token without profile:sensitive does not. v33
      // SHARE-7: not shared with the person, whatever the answer carries is never kept or drawn.
      const kept = sensitiveAfterSave(sensitiveGate, sensitive.apiVersion, saved, draft.sensitive);
      if (kept) queryClient.setQueryData<AutofillSensitiveEnvelope>(autofillKeys.sensitive, kept);
      else queryClient.removeQueries({ queryKey: autofillKeys.sensitive, exact: true });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'revision_conflict') {
        setConflict(true);
        return;
      }
      // v33 SHARE-7: a shared profile's refusal is the shell's one alert, not a form error too.
      if (isProfileRefusal(error)) return;
      if (error instanceof ApiError && error.fields) {
        dispatch({ type: 'refused', messages: error.fields });
        setAttempts((count) => count + 1);
      }
      setFormError(userMessage(error, 'Your autofill profile could not be saved. Please try again.'));
    },
  });

  // v32 FILL: a profile never saved shows the sign-in address as its email (GET /profile fills an empty one): that is
  // no answer of the person's, so a fill puts the resume's over it while it is untouched.
  const defaults = useMemo(
    () => (revision === 0 && initial.profile.contact.email ? { 'contact.email': initial.profile.contact.email } : {}),
    [revision, initial],
  );

  // v32 INT-1 (E4): a limit is an alert when the person acts (the day's AI use spent: Get extra credit / Not now).
  const limits = useLimitDialog();
  // v32 FILL: POST answers the seed, or the task of the AI reading an uploaded file (followed below).
  const fill = useMutation({
    mutationFn: (resumeId: string | null) => startAutofillSeed(resumeId),
    // Merged in the reducer, into the draft as it stands now.
    onSuccess: (answer, resumeId) => {
      if ('taskId' in answer) {
        setReading({ taskId: answer.taskId, resumeId });
        return;
      }
      dispatch({ type: 'fill', seed: answer, defaults });
      // v32 INT-1 (E4): an upload the AI did not read because today's AI use is spent: the contact details still fill
      // (above), and the limit's alert says so with its action.
      if (answer.unread?.code === 'ai_usage_exhausted') {
        limits.show({ kind: 'ai_usage_exhausted', message: answer.unread.message, subscribe: false, buyCredit: true });
      }
    },
    onError: (error) => {
      if (isProfileRefusal(error)) return; // v33 SHARE-7: the shell's one alert
      if (!limits.show(error)) toast.error('Your resume could not be read', userMessage(error));
    },
  });

  // The reading's end: the seed it gives. A reading that failed says why, and the file's contact details still fill.
  const readingTask = useAiTask(reading?.taskId ?? null, { kind: 'resume_import' });
  const readingDone = readingTask.isSucceeded || readingTask.isFailed;
  const readingError = readingTask.isFailed ? readingTask.errorMessage : null;
  // Each reading ends once here (a toast changes `toast`, which runs the effect again).
  const endedReading = useRef<string | null>(null);
  useEffect(() => {
    if (!reading || !readingDone || endedReading.current === reading.taskId) return;
    endedReading.current = reading.taskId;
    if (readingError !== null) toast.error('Your resume could not be read', readingError);
    queryClient
      .fetchQuery({
        queryKey: autofillKeys.seed(reading.resumeId),
        queryFn: ({ signal }) => fetchAutofillSeed(reading.resumeId, signal),
        staleTime: 0,
      })
      .then(
        (seed) => dispatch({ type: 'fill', seed, defaults }),
        (error: unknown) => toast.error('Your resume could not be read', userMessage(error)),
      )
      .finally(() => setReading((current) => (current?.taskId === reading.taskId ? null : current)));
  }, [reading, readingDone, readingError, setReading, queryClient, dispatch, toast, defaults]);
  const filling = fill.isPending || reading !== null;

  // v32 FILL: the fields that kept the person's answer though the resume's differs, offered for their yes.
  const kept = useMemo(
    () => (state.lastSeed ? mergeSeed(state.draft.profile, state.lastSeed, [], defaults).kept : []),
    [state.lastSeed, state.draft.profile, defaults],
  );
  const applyResume = () => {
    if (state.lastSeed) dispatch({ type: 'fill', seed: state.lastSeed, replace: kept });
  };

  // Each fill is announced once: showing a toast changes `toast` itself, which runs this effect again.
  const { lastFill } = state;
  const announcedFill = useRef(lastFill);
  useEffect(() => {
    if (!lastFill || announcedFill.current === lastFill) return;
    announcedFill.current = lastFill;
    const from = lastFill.label ? `"${lastFill.label}"` : 'your settings';
    const fields = `${lastFill.count} ${lastFill.count === 1 ? 'field' : 'fields'}`;
    if (lastFill.replaced) toast.success(`Used ${from} for ${fields}`, 'Check them in the next steps.');
    else if (lastFill.count === 0 && lastFill.kept) toast.info('Your answers were kept', "Choose Use the resume's to replace them.");
    else if (lastFill.count === 0) toast.info('Nothing to fill', `Every field ${from} covers already has an answer.`);
    else toast.success(`Filled ${fields} from ${from}`, 'Check them in the next steps.');
  }, [lastFill, toast]);

  // After a refused move or save, bring the first field with a message on this step into view.
  useEffect(() => {
    if (attempts === 0) return;
    const first = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], [data-field-error]');
    if (!first) return;
    first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (first.matches('input, textarea, button')) first.focus({ preventScroll: true });
  }, [attempts]);

  /** The draft as it would be saved, and the page's own checks of all of it. */
  const check = () => {
    setFormError(null);
    setChecksRefused(false);
    setConflict(false);
    const cleaned = cleanDraft(state.draft);
    dispatch({ type: 'cleaned', draft: cleaned });
    const messages = validateAutofillProfile(
      cleaned,
      (max) => t('MSG_TEXT_TOO_LONG', { max }),
      (max) => t('MSG_LIST_TOO_LONG', { max }),
    );
    const changed = JSON.stringify(cleaned) !== JSON.stringify(initial);
    return { cleaned, messages, changed };
  };

  const refuse = (messages: Record<string, string>) => {
    dispatch({ type: 'refused', messages });
    setChecksRefused(true);
    setAttempts((value) => value + 1);
  };

  /** Next: this step's checks, then a save of the draft with the profile's revision, then the next step. */
  const advance = (to: WizardStepId) => {
    const { cleaned, messages, changed } = check();
    const plan = planAdvance({ from: step, to, dirty: changed, messages });
    switch (plan.kind) {
      case 'fix-here':
        // This step's fields and the earlier steps': the steps not reached yet are checked when they are.
        refuse(messagesUpTo(step, messages));
        return;
      case 'move':
        goTo(plan.to);
        return;
      case 'save':
        save.mutate({ draft: cleaned, from: step, after: { kind: 'move', to: plan.to } });
        return;
      case 'move-unsaved':
        // The later step's messages wait for it; the draft is saved once it passes.
        dispatch({ type: 'refused', messages });
        goTo(plan.to);
        return;
      case 'fix-elsewhere':
        refuse(messages);
        return;
    }
  };

  /** Save & exit (and the Review's Save changes): the whole draft is checked and saved, then the Review shows. */
  const saveAll = (after: AfterSave) => {
    const { cleaned, messages, changed } = check();
    const plan = planSave({ from: step, dirty: changed, messages });
    switch (plan.kind) {
      case 'fix-here':
      case 'fix-elsewhere':
        refuse(messages);
        return;
      case 'nothing':
        if (after.kind === 'exit') goTo('review');
        return;
      case 'save':
        save.mutate({ draft: cleaned, from: step, after });
        return;
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending) return;
    if (step === 'review') saveAll({ kind: 'stay' });
    else advance(neighbourStep(step, 1) ?? 'review');
  };

  const back = () => {
    const previous = neighbourStep(step, -1);
    if (previous) goTo(previous);
  };

  // A dot goes to its step at once, the draft kept as it is (unsaved changes stay marked): Next is what saves.
  const select = (target: WizardStepId) => {
    if (target !== step) goTo(target);
  };

  const discard = () => {
    dispatch({ type: 'discard', draft: initial });
    setGeneration((value) => value + 1);
    setFormError(null);
    setChecksRefused(false);
    setConflict(false);
  };

  // Counted from this step's messages still shown, so an edit or a fill that clears the last one takes the notice away.
  const needChange = checksRefused ? Object.keys(messagesIn(step, state.errors)).length : 0;
  const otherSteps = errorSteps.filter((other) => other !== step && other !== 'review');

  const letterTemplates = useLetterTemplates();
  const names: SummaryNames = {
    resume: (id) => resumes?.items.find((resume) => resume.id === id)?.label ?? null,
    resumeTemplate: (id) => (isResumeTemplateId(id) ? RESUME_TEMPLATES[id].name : null),
    letterTemplate: (id) => letterTemplates.data?.items.find((template) => template.id === id)?.name ?? null,
  };

  let content: ReactNode;
  switch (step) {
    case 'import':
      content = (
        <ImportStep
          resumes={resumes}
          seedResumeId={seedResumeId}
          onPickResume={setPickedResume}
          filling={filling}
          reading={reading !== null}
          busy={save.isPending || readOnly}
          onFill={() => fill.mutate(seedResumeId)}
          notes={state.notes}
          kept={kept}
          onUseResume={applyResume}
        />
      );
      break;
    case 'personal':
      content = (
        <>
          <NameSection />
          <ContactSection />
          <LinksSection />
        </>
      );
      break;
    case 'education':
      content = <EducationSection />;
      break;
    case 'experience':
      content = <ExperienceSection />;
      break;
    case 'skills':
      content = (
        <>
          <LanguagesSkillsSection />
          <CertificationsSection />
        </>
      );
      break;
    case 'authorization':
      // v33 SHARE-7: every answer of this step is sensitive: shown with the owner's Sensitive answers See box (changed
      // only with its Change box); else "Not shared with you." (the checklist counts them: not shown either).
      content =
        sensitiveGate === 'hidden' ? (
          <NotShared owner={sensitiveOwner} />
        ) : (
          <>
            <OnceChecklistSection />
            <SensitiveFields>
              <WorkAuthorizationSection />
              <SelfIdentificationSection />
            </SensitiveFields>
          </>
        );
      break;
    case 'questions':
      content = (
        <>
          {/* v33 SHARE-7: its sensitive answers (18 or older, a conviction, the expected pay) follow the boxes inside. */}
          <OtherQuestionsSection />
          {/* v33 SHARE-7: the screening answers are sensitive, all of them. */}
          {sensitiveGate === 'hidden' ? (
            <NotShared owner={sensitiveOwner} />
          ) : (
            <SensitiveFields>
              <ScreeningSection />
            </SensitiveFields>
          )}
          {/* The saved note and its flagged lines, from the last save or the page's load. */}
          <AnythingElseSection flagged={{ note: profile.profile.anythingElse, lines: profile.anythingElseFlaggedLines }} />
        </>
      );
      break;
    case 'documents':
      content = (
        <>
          <ResumeSection resumes={resumes} />
          <ResumeTemplateSection />
          <LetterTemplateSection />
        </>
      );
      break;
    case 'review':
      content = (
        <ReviewStep
          draft={state.draft}
          errorSteps={errorSteps}
          names={names}
          onEdit={(target) => goTo(target)}
          reach={{ sensitive: sensitiveGate !== 'hidden' }}
        />
      );
      break;
  }

  return (
    <ProfileFormProvider state={state} dispatch={dispatch} busy={save.isPending || readOnly} sensitive={sensitiveGate}>
      <SectionLinkContext.Provider value={linkToSection}>
        <SectionHeadingLevel.Provider value={3}>
          <form ref={formRef} onSubmit={submit} noValidate className="flex flex-col gap-6" data-profile-wizard={step}>
            <div ref={topRef} className="scroll-mt-20">
              <ProfileStepper
                current={step}
                draft={state.draft}
                errorSteps={errorSteps}
                onSelect={select}
                reach={{ sensitive: sensitiveGate !== 'hidden' }}
              />
            </div>
            <StepHeader step={step} headingRef={headingRef} />

            <div key={generation} className="flex flex-col gap-6">
              {content}
            </div>

            {conflict && (
              <Notice
                tone="warning"
                title="This profile changed in another tab."
                action={
                  <Button variant="outline" size="sm" onClick={onReload}>
                    Reload
                  </Button>
                }
              >
                Your changes here are not saved.
              </Notice>
            )}
            {needChange > 0 && (
              <Notice tone="error">
                {needChange === 1 ? 'One field needs a change before this can be saved.' : `${needChange} fields need a change before this can be saved.`}
              </Notice>
            )}
            <OtherStepsNotice steps={otherSteps} onGo={(target) => goTo(target)} />
            {formError && <Notice tone="error">{formError}</Notice>}

            <WizardFooter
              step={step}
              dirty={dirty}
              saving={save.isPending}
              savedThisVisit={savedThisVisit}
              onBack={back}
              onDiscard={discard}
              onSaveAndExit={() => saveAll({ kind: 'exit' })}
            />
          </form>
          {limits.dialog}
        </SectionHeadingLevel.Provider>
      </SectionLinkContext.Provider>
    </ProfileFormProvider>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading your autofill profile">
      <div className="flex items-center justify-between gap-2">
        {Array.from({ length: 9 }, (_, index) => (
          <Skeleton key={index} className="size-7" rounded="full" />
        ))}
      </div>
      <Skeleton className="h-7 w-64" />
      {[0, 1].map((index) => (
        <div key={index} className="rounded-card border border-border bg-surface p-6 shadow-card">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-2 h-4 w-72" />
          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <Skeleton className="h-9 w-full" rounded="control" />
            <Skeleton className="h-9 w-full" rounded="control" />
          </div>
        </div>
      ))}
    </div>
  );
}
