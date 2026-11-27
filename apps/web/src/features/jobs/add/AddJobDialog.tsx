'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { JOB_LINK_MAX_CHARS, type AddJobBody, type JobAddDetails } from '@tailorit/shared';
import type { ProfileChoice } from '@tailorit/shared/sharing';
import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useDocumentProfile, useProfile } from '@/components/shell/profile';
import { Checkbox } from '@/components/ui/Checkbox';
import { HelpTip } from '@/components/ui/HelpTip';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { CaretDownIcon, PlusIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { SegmentedControl, TabPanel } from '@/components/ui/SegmentedControl';
import { isProfileRefusal, userMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePublicConstants } from '@/lib/constants';
import { EMPTY_LINK_DETAILS, OneLinkFields, filledDetails, type LinkDetailLimits, type LinkDetails } from '../../imports/OneLinkFields';
import { fetchJob, jobsKeys } from '../api'; // v38 FIX-APP (ux L7): fetchJob
import { LinkSimpleIcon } from '../icons';
import { addJobOnProfiles, type AddOnProfiles } from './api';
import { ImportPanel } from './ImportPanel';
import { fetchLatestImport, importKeys } from '../../imports/api'; // v35 FIX-WEB
import { latestImportKey, latestOfSummary, latestShown, openingTab, readLatestImport, writeLatestImport, type LatestImport } from './latest';
import { ADD_JOB_COPY, addOutcomeView, alsoSavedLine, linkInput, readJobLine, refusedHereView, savedToLine, type AddOutcomeView } from './outcome';
import { FANOUT_COPY } from '../../sharing/fanout/copy'; // v34 FANWEB
import { refusalText } from '../../sharing/fanout/results';
import { missingReason } from '../../sharing/fanout/targets';
import { refreshAfterFanoutSave, useFanoutChoices } from '../../sharing/fanout/useFanout';

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
//                        v37: the site asked TailorIT to slow down   Close (a warning: try again at the time said)
// The job is saved to the person's Job Tracker by the server.
// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §3; PLAN H1, H2): three tabs, One link | File | Google Sheet. One link keeps
// the flow above and offers "Add details (optional)" up front (Company, Job title, Description, Rate, Location): used
// only if TailorIT cannot read the link (a title and company make the person's own job at once; fewer are kept for the
// details step); Rate is the pay when the posting states none. File and Google Sheet import many rows (ImportPanel). On
// a shared profile the dialog names the profile the jobs are saved to. "Also save to…" stays on One link.

/** The tracker's React Query keys all start with 'tracker'. */
const TRACKER_KEY = ['tracker'] as const;

const FORM_ID = 'add-job-form';
const DETAILS_FORM_ID = 'add-job-details-form';
const COMPANY_FORM_ID = 'add-job-company-form'; // v38 FIX-APP (D1)

/** v38 FIX-APP (REVIEW38-ux L4): on a phone the dialog's buttons are 44 px tall (as Add source's, v38 INT). */
const PHONE_TALL = 'max-sm:h-11';

/** Add job's own details' limits (JobAddDetailsSchema: a person's job of their own). */
const DETAIL_LIMITS: LinkDetailLimits = { company: 200, title: 300, description: 20_000, rate: 120, location: 300 };

type AddTab = 'link' | 'file' | 'sheet';

type Step =
  | { kind: 'link' }
  | { kind: 'details'; url: string; view: AddOutcomeView }
  // v38 FIX-APP (SP v38 FIXES-38 D1): TailorIT read the posting, which names no company: the person types it.
  | { kind: 'company'; url: string; view: AddOutcomeView }
  | { kind: 'outcome'; view: AddOutcomeView; also: string | null };

type DetailErrors = Partial<Record<keyof LinkDetails, string>>;

/** The details as POST /api/jobs/add takes them: only with a title and a company; the rest when given. */
export function addDetailsOf(details: LinkDetails): JobAddDetails | null {
  const given = filledDetails(details);
  if (!given.title || !given.company) return null;
  return {
    title: given.title,
    company: given.company,
    ...(given.location ? { location: given.location } : {}),
    ...(given.description ? { description: given.description } : {}),
    ...(given.rate ? { rate: given.rate } : {}),
  };
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
      {/* v38 FIX-APP (REVIEW38-ux L4): a 44 px ✕ on a phone, as Add source's. */}
      <DialogContent title={ADD_JOB_COPY.title} size="xl" finalFocus={finalFocus} closeClassName="max-sm:top-2.5 max-sm:right-2.5 max-sm:size-11">
        {open && <AddJobTabs onClose={() => onOpenChange(false)} onOpenJob={onOpenJob} />}
      </DialogContent>
    </Dialog>
  );
}

const TABS: ReadonlyArray<{ value: AddTab; label: string }> = [
  { value: 'link', label: ADD_JOB_COPY.oneLink },
  { value: 'file', label: ADD_JOB_COPY.file },
  { value: 'sheet', label: ADD_JOB_COPY.sheet },
];

/**
 * v35 FIX-WEB (the fix list's item 9): the profile's latest import, from the API (every device). The Jobs page's Add job
 * reads it before the dialog opens, so the dialog opens on it at once.
 */
export function useLatestImport() {
  const profileKey = useDocumentProfile();
  return useQuery({
    queryKey: importKeys.latest(profileKey),
    queryFn: ({ signal }) => fetchLatestImport(signal),
    staleTime: 15_000,
    retry: false,
  });
}

/** v35 IMPORTWEB: the dialog's tabs, the profile line on a shared profile, and the latest import remembered. */
function AddJobTabs({ onClose, onOpenJob }: { onClose: () => void; onOpenJob: (jobId: number) => void }) {
  const { account } = useAuth();
  const profileKey = useDocumentProfile();
  const { acting, label } = useProfile();
  const client = useQueryClient();
  const storeKey = account ? latestImportKey(account.id, profileKey) : null;
  // v35 FIX-WEB: the API's latest import; this browser's hint only while that request runs (or if it fails).
  const server = useLatestImport();
  const [hint] = useState<LatestImport | null>(() => readLatestImport(storeKey));
  const serverLatest = server.isSuccess ? latestOfSummary(server.data) : undefined;
  const [latest, setLatest] = useState<LatestImport | null>(() => latestShown(serverLatest, hint));
  const [tab, setTab] = useState<AddTab>(() => openingTab(latest, Date.now()));
  // A tab's import is drawn once it was opened, then kept (switching tabs keeps a chosen file and its preview).
  const [opened, setOpened] = useState<ReadonlySet<AddTab>>(() => new Set([tab]));
  // The person's own choice (a tab, an import started or put aside) wins over an answer that comes later.
  const chosen = useRef(false);
  const serverId = serverLatest === undefined ? 'pending' : (serverLatest?.id ?? 'none');
  useEffect(() => {
    if (serverLatest === undefined || chosen.current) return;
    const next = latestShown(serverLatest, hint);
    setLatest(next);
    const nextTab = openingTab(next, Date.now());
    setTab(nextTab);
    setOpened((current) => (current.has(nextTab) ? current : new Set([...current, nextTab])));
    if (next) writeLatestImport(storeKey, next);
    // Only when the API's answer names another import (a refetch of the same one changes nothing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);
  const remember = (next: LatestImport | null) => {
    chosen.current = true;
    // New import puts the shown one aside in this browser (the API still lists it as the latest).
    writeLatestImport(storeKey, next ?? (latest ? { ...latest, dismissed: true } : null));
    setLatest(next);
    if (next) void client.invalidateQueries({ queryKey: importKeys.latest(profileKey) });
  };
  const choose = (next: AddTab) => {
    chosen.current = true;
    setTab(next);
    setOpened((current) => (current.has(next) ? current : new Set([...current, next])));
  };
  return (
    <div className="flex min-w-0 flex-col" data-add-job-tabs="">
      {acting && label && (
        <p className="mt-1 text-[13px] leading-5 font-medium text-foreground" data-add-job-profile="">
          {savedToLine(label)}
        </p>
      )}
      <SegmentedControl aria-label={ADD_JOB_COPY.tabs} items={TABS} value={tab} onValueChange={choose} className="mt-4" listClassName="max-sm:h-11">
        <TabPanel value="link" keepMounted className="mt-1">
          <AddJobFlow onClose={onClose} onOpenJob={onOpenJob} focusOnStart={tab === 'link'} />
        </TabPanel>
        <TabPanel value="file" keepMounted className="mt-5">
          {opened.has('file') && <ImportPanel way="file" latest={latest} onLatest={remember} onOpenJob={onOpenJob} onClose={onClose} />}
        </TabPanel>
        <TabPanel value="sheet" keepMounted className="mt-5">
          {opened.has('sheet') && <ImportPanel way="sheet" latest={latest} onLatest={remember} onOpenJob={onOpenJob} onClose={onClose} />}
        </TabPanel>
      </SegmentedControl>
    </div>
  );
}

function AddJobFlow({ onClose, onOpenJob, focusOnStart }: { onClose: () => void; onOpenJob: (jobId: number) => void; focusOnStart: boolean }) {
  const client = useQueryClient();
  const { t } = usePublicConstants();
  const detailsId = useId();
  const [step, setStep] = useState<Step>({ kind: 'link' });
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [details, setDetails] = useState<LinkDetails>(EMPTY_LINK_DETAILS);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailErrors, setDetailErrors] = useState<DetailErrors>({});
  const linkRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const companyRef = useRef<HTMLInputElement>(null); // v38 FIX-APP (ux L5; D1's company step)
  const [company, setCompany] = useState(''); // v38 FIX-APP (D1)
  const [companyError, setCompanyError] = useState<string | null>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  // v34 FANWEB (PLAN G4): "Also save to" the other profiles (shown only with a shared profile; off without its box).
  const choices = useFanoutChoices(['tracker:edit']);
  const otherProfiles = choices.profiles.filter((profile) => !profile.current);
  const [also, setAlso] = useState<ReadonlySet<ProfileChoice>>(() => new Set());
  const alsoChosen = otherProfiles.filter((profile) => profile.allowed && also.has(profile.choice)).map((profile) => profile.choice);

  const add = useMutation({
    mutationFn: (body: AddJobBody) => addJobOnProfiles(body, choices.tab, alsoChosen),
    onSuccess: ({ result, refused, others }: AddOnProfiles, body) => {
      const also = alsoSavedLine(others, choices.profiles, choices.label);
      if (!result) {
        // v34 FANWEB fix (sharing L7): refused on this profile, the other profiles' adds still said.
        const why = refused ? refusalText(choices.profiles, refused, choices.label) : ADD_JOB_COPY.failed;
        setStep({ kind: 'outcome', view: refusedHereView(why), also });
      } else {
        const view = addOutcomeView(result, t);
        if (view.next === 'company' && !body.company) setStep({ kind: 'company', url: result.url ?? body.url, view }); // v38 FIX-APP (D1)
        else if (view.next === 'details' && !body.details) setStep({ kind: 'details', url: result.url ?? body.url, view });
        else setStep({ kind: 'outcome', view, also });
      }
      if ((result && result.jobId !== null) || others.length > 0) {
        void Promise.all([
          client.invalidateQueries({ queryKey: jobsKeys.all }),
          client.invalidateQueries({ queryKey: TRACKER_KEY }),
          others.length > 0 ? refreshAfterFanoutSave(client) : undefined,
        ]);
      }
    },
  });

  // Each step puts focus where the person goes next: the link, the title, or the outcome's main button. The link at
  // the start only while its tab is the one shown (Add job opens on an import's results for an hour after it started).
  const focusLink = useRef(focusOnStart);
  useEffect(() => {
    if (step.kind === 'link') {
      if (focusLink.current) linkRef.current?.focus();
      focusLink.current = true;
    } else if (step.kind === 'details') {
      // v38 FIX-APP (REVIEW38-ux L5): the first empty required field (Company comes first), else the title.
      (details.company.trim() ? titleRef : companyRef).current?.focus();
    } else if (step.kind === 'company') companyRef.current?.focus();
    else nextRef.current?.focus();
    // Only when the step changes (typing never moves the focus).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const submitLink = (event: FormEvent) => {
    event.preventDefault();
    const url = linkInput(link);
    if (!url) {
      setLinkError(ADD_JOB_COPY.linkRequired);
      return;
    }
    setLinkError(null);
    // v35 IMPORTWEB: details given up front go with the link when they hold a title and a company (used only if
    // TailorIT cannot read it); fewer wait for the details step, filled in there.
    const given = detailsOpen ? addDetailsOf(details) : null;
    add.mutate(given ? { url, details: given } : { url });
  };

  const submitDetails = (event: FormEvent) => {
    event.preventDefault();
    if (step.kind !== 'details') return;
    const errors: DetailErrors = {};
    if (!details.title.trim()) errors.title = 'Required';
    if (!details.company.trim()) errors.company = 'Required';
    setDetailErrors(errors);
    const given = addDetailsOf(details);
    if (!given) return;
    add.mutate({ url: step.url, details: given });
  };

  // v38 FIX-APP (SP v38 FIXES-38 D1): the company of a posting TailorIT read that names none; the job is added with it.
  const submitCompany = (event: FormEvent) => {
    event.preventDefault();
    if (step.kind !== 'company') return;
    const typed = company.trim();
    if (!typed) {
      setCompanyError(ADD_JOB_COPY.companyRequired);
      companyRef.current?.focus();
      return;
    }
    setCompanyError(null);
    add.mutate({ url: step.url, company: typed });
  };

  const restart = (keepLink: boolean) => {
    add.reset();
    setCompany(''); // v38 FIX-APP (D1)
    setCompanyError(null);
    if (!keepLink) {
      setLink('');
      setDetails(EMPTY_LINK_DETAILS);
      setDetailsOpen(false);
    }
    setDetailErrors({});
    setStep({ kind: 'link' });
  };

  const failure = add.isError && !isProfileRefusal(add.error) ? userMessage(add.error, ADD_JOB_COPY.failed) : null;

  if (step.kind === 'outcome') {
    const { view } = step;
    return (
      <div className="mt-5 flex flex-col" data-add-job-outcome={view.tone}>
        <OutcomeNotice view={view} also={step.also} />
        <DialogFooter>
          {view.next === 'later' ? (
            // v37 FIX-REV (REVIEW361-ux L10): the site asked TailorIT to slow down: nothing to change, try again later.
            <Button ref={nextRef} onClick={onClose} className={PHONE_TALL}>
              {ADD_JOB_COPY.close}
            </Button>
          ) : view.next === 'retry' ? (
            <>
              <Button variant="outline" onClick={onClose} className={PHONE_TALL}>
                {ADD_JOB_COPY.close}
              </Button>
              <Button ref={nextRef} onClick={() => restart(true)} className={PHONE_TALL}>
                {ADD_JOB_COPY.tryAnother}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" icon={<PlusIcon size={16} />} onClick={() => restart(false)} className={PHONE_TALL}>
                {ADD_JOB_COPY.addAnother}
              </Button>
              {view.jobId !== null && (
                <Button
                  ref={nextRef}
                  className={PHONE_TALL}
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

  if (step.kind === 'company') {
    // v38 FIX-APP (SP v38 FIXES-38 D1): TailorIT read the posting; it names no company. The person types it and the job
    // is added (everyone sees it as any posting TailorIT read); the read is kept, so the posting is not read again.
    return (
      <form id={COMPANY_FORM_ID} onSubmit={submitCompany} noValidate className="mt-5 flex flex-col gap-4" data-add-job-company="">
        <OutcomeNotice view={step.view} />
        <Field label={ADD_JOB_COPY.companyLabel} required hint={ADD_JOB_COPY.companyHint} error={companyError}>
          <Input
            ref={companyRef}
            value={company}
            maxLength={DETAIL_LIMITS.company}
            autoComplete="organization"
            disabled={add.isPending}
            onChange={(event) => {
              setCompany(event.target.value);
              setCompanyError(null);
            }}
          />
        </Field>
        {failure && <Notice tone="error">{failure}</Notice>}
        <DialogFooter flush className="mt-2">
          <Button variant="outline" onClick={() => restart(true)} disabled={add.isPending} className={PHONE_TALL}>
            {ADD_JOB_COPY.back}
          </Button>
          <Button type="submit" form={COMPANY_FORM_ID} loading={add.isPending} className={PHONE_TALL}>
            {ADD_JOB_COPY.add}
          </Button>
        </DialogFooter>
      </form>
    );
  }

  if (step.kind === 'details') {
    return (
      <form id={DETAILS_FORM_ID} onSubmit={submitDetails} noValidate className="mt-5 flex flex-col gap-4" data-add-job-details="">
        <OutcomeNotice view={step.view} />
        <p className="text-[13px] leading-5 text-muted-foreground">{ADD_JOB_COPY.detailsLead}</p>
        <OneLinkFields
          details={details}
          onChange={(next) => {
            setDetails(next);
            setDetailErrors((current) => ({
              ...current,
              ...(next.title !== details.title ? { title: undefined } : {}),
              ...(next.company !== details.company ? { company: undefined } : {}),
            }));
          }}
          limits={DETAIL_LIMITS}
          required={['title', 'company']}
          errors={detailErrors}
          titleRef={titleRef}
          companyRef={companyRef}
          disabled={add.isPending}
        />
        {failure && <Notice tone="error">{failure}</Notice>}
        <DialogFooter flush className="mt-2">
          <Button variant="outline" onClick={() => restart(true)} disabled={add.isPending} className={PHONE_TALL}>
            {ADD_JOB_COPY.back}
          </Button>
          <Button type="submit" form={DETAILS_FORM_ID} loading={add.isPending} className={PHONE_TALL}>
            {ADD_JOB_COPY.saveForMe}
          </Button>
        </DialogFooter>
      </form>
    );
  }

  return (
    <form id={FORM_ID} onSubmit={submitLink} noValidate className="flex flex-col" data-add-job-link="">
      <DialogDescription className="mt-4">{ADD_JOB_COPY.description}</DialogDescription>
      <Field label={ADD_JOB_COPY.linkLabel} required error={linkError} hint={ADD_JOB_COPY.linkHint} className="mt-4">
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
      {/* v35 IMPORTWEB: the details up front, behind a disclosure (each field shown directly once it is open). */}
      <div className="mt-3 flex flex-col gap-3" data-add-job-details-up-front="">
        <span className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 max-sm:h-11"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            trailingIcon={<CaretDownIcon size={14} className={detailsOpen ? 'rotate-180' : undefined} aria-hidden="true" />}
            onClick={() => setDetailsOpen((current) => !current)}
          >
            {ADD_JOB_COPY.addDetails}
          </Button>
          <HelpTip label={ADD_JOB_COPY.addDetails}>{ADD_JOB_COPY.detailsUpFront}</HelpTip>
        </span>
        <div id={detailsId} hidden={!detailsOpen}>
          {detailsOpen && <OneLinkFields details={details} onChange={setDetails} limits={DETAIL_LIMITS} disabled={add.isPending} />}
        </div>
      </div>
      {choices.available && otherProfiles.length > 0 && (
        // v34 FANWEB: the job added on other profiles too, in the same request.
        <fieldset className="mt-4 flex min-w-0 flex-col gap-2 border-0 p-0" data-add-job-also="">
          {/* v34 FANWEB fix (spec L9): the description is a "?" beside the group's name (v3.2), not screen-reader-only
              text; the legend names the group once (the "?" sits outside it, so it is not read into the name). */}
          <legend className="sr-only">{FANOUT_COPY.alsoSaveTo}</legend>
          <span className="mb-2 flex items-center gap-1.5 text-sm leading-5 font-medium text-foreground">
            <span aria-hidden="true">{FANOUT_COPY.alsoSaveTo}</span>
            <HelpTip label={FANOUT_COPY.alsoSaveTo}>{FANOUT_COPY.alsoSaveToHelp}</HelpTip>
          </span>
          {otherProfiles.map((profile) => {
            const reason = profile.allowed ? null : missingReason(profile, choices.label);
            return (
              <Checkbox
                key={profile.choice}
                checked={profile.allowed && also.has(profile.choice)}
                disabled={!profile.allowed || add.isPending}
                onCheckedChange={(on) =>
                  setAlso((current) => {
                    const next = new Set(current);
                    if (on) next.add(profile.choice);
                    else next.delete(profile.choice);
                    return next;
                  })
                }
                label={
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm text-foreground">{profile.label}</span>
                    {reason && <span className="text-xs leading-4 text-muted-foreground">{reason}</span>}
                  </span>
                }
              />
            );
          })}
        </fieldset>
      )}
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
        <Button variant="outline" onClick={onClose} disabled={add.isPending} className={PHONE_TALL}>
          Cancel
        </Button>
        <Button type="submit" form={FORM_ID} loading={add.isPending} className={PHONE_TALL}>
          {ADD_JOB_COPY.add}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The outcome's notice: its title, the server's words, why TailorIT could not read the link, and the other profiles.
 * v38 FIX-APP (REVIEW38-ux L7): a job TailorIT read (published, or waiting for an admin) says what it read first:
 * "Senior Robotics Engineer at Acme Robotics", so the person sees the right posting was read.
 */
function OutcomeNotice({ view, also = null }: { view: AddOutcomeView; also?: string | null }) {
  const read = view.next === 'open' && (view.tone === 'success' || view.tone === 'info') ? view.jobId : null;
  const job = useQuery({
    queryKey: jobsKeys.detail(read ?? 0),
    queryFn: ({ signal }) => fetchJob(read!, signal),
    enabled: read !== null,
    staleTime: 30_000,
    retry: false,
  });
  const line = read !== null ? readJobLine(job.data) : null;
  return (
    <Notice tone={view.tone} title={view.title}>
      {line && (
        <p className="font-medium" data-add-job-read="">
          {line}
        </p>
      )}
      <p data-add-job-message="">{view.body}</p>
      {view.why && (
        <p className="mt-1" data-add-job-why="">
          {view.why}
        </p>
      )}
      {also && (
        <p className="mt-1" data-add-job-also-result="">
          {also}
        </p>
      )}
    </Notice>
  );
}

/** The page's "Add job" button and its dialog. */
export function AddJobButton({ onOpenJob, className }: { onOpenJob: (jobId: number) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  // v35 FIX-WEB: the latest import read before the dialog opens (the dialog opens on its results at once).
  useLatestImport();
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
