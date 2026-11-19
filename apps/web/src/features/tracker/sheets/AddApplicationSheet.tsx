'use client';

import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import type { ApplicationDetail, ApplicationStatus, CreateApplicationBody, EmploymentType } from '@tailorit/shared';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { Sheet, SheetContent } from '@/components/ui/Sheet';
import { BriefcaseIcon } from '@/components/ui/icons';
import { ADD_JOB_COPY, linkInput } from '@/features/jobs/add/outcome';
import { LinkSimpleIcon } from '@/features/jobs/icons';
import { api, isApiError, userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { CompanyInput } from '../CompanyInput';
import { localToday, trackerApi, useResumeOptions } from '../data';
import { DEFAULT_NEW_STATUS } from '../state';
import { statusOptions } from '../status';

const FORM_ID = 'add-application-form';

export const JOB_TYPE_OPTIONS: Array<{ value: EmploymentType; label: string }> = [
  { value: 'internship', label: 'Internship' },
  { value: 'full_time', label: 'Full-Time' },
  { value: 'part_time', label: 'Part-Time' },
];

const NO_RESUME = 'none';

/** v31 JOBSWEB: the sheet's words for the link-first add (docs/design/v3.1/21-jobs-from-links.md §3, Tracker). */
export const ADD_APPLICATION_COPY = {
  linkHint: 'The title and company are read from the posting.',
  noLink: 'Add it without a link',
  withLink: 'Add a link instead',
  typedNote: 'Without a link, only you see it.',
  unreadNote: 'Type the title and company below: only you will see them.',
} as const;

/**
 * The job type an untouched field shows: Internship for someone who only looks for internships (Settings › Job
 * preferences), else Full-Time.
 */
function usePreferredJobType(): EmploymentType {
  const preferences = useQuery({
    queryKey: ['me', 'preferences'],
    queryFn: ({ signal }) => api.get<{ jobTypes?: unknown }>('/api/me/preferences', { signal }),
    staleTime: 60_000,
    retry: false,
  });
  const types = Array.isArray(preferences.data?.jobTypes) ? (preferences.data.jobTypes as unknown[]) : [];
  return types.includes('internship') && !types.includes('full_time') ? 'internship' : 'full_time';
}

const FIELD_NAMES = ['postingUrl', 'title', 'companyName', 'location', 'employmentType', 'status', 'resumeId'] as const;
type FieldName = (typeof FIELD_NAMES)[number];
type FieldErrors = Partial<Record<FieldName, string>>;

/**
 * How the entry is added: by its posting's link (the server reads the title and company), typed with no link, or
 * typed beside a link TailorIT could not read (the typed words stay the person's own).
 */
export type AddMode = 'link' | 'typed' | 'unread';

/** Whether a refusal of an entry sent with its link alone asks for the typed title and company (MSG_JOB_ADD_NEEDS_DETAILS). */
export function needsTypedDetails(error: unknown): boolean {
  return isApiError(error) && error.status === 400 && Boolean(error.fields?.title || error.fields?.companyName);
}

/** The body of POST /api/applications for the sheet's mode: the link alone, the typed words alone, or both. */
export function createBodyOf(
  mode: AddMode,
  fields: { url: string; title: string; companyName: string; location: string; employmentType: EmploymentType },
  rest: Pick<CreateApplicationBody, 'status' | 'resumeId' | 'occurredOn'>,
): CreateApplicationBody {
  const typed = mode !== 'link';
  return {
    ...(mode !== 'typed' ? { postingUrl: fields.url } : {}),
    ...(typed
      ? { title: fields.title.trim(), companyName: fields.companyName.trim(), location: fields.location.trim(), employmentType: fields.employmentType }
      : {}),
    ...rest,
  };
}

function AddApplicationForm({
  onSavingChange,
  onAdded,
}: {
  onSavingChange: (saving: boolean) => void;
  onAdded: (application: ApplicationDetail, fromLink: boolean) => void;
}) {
  const resumes = useResumeOptions(true);
  const { t } = usePublicConstants();
  const preferredType = usePreferredJobType();
  const [mode, setMode] = useState<AddMode>('link');
  const [link, setLink] = useState('');
  const [title, setTitle] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [location, setLocation] = useState('');
  const [chosenType, setChosenType] = useState<EmploymentType | null>(null);
  const [status, setStatus] = useState<ApplicationStatus>(DEFAULT_NEW_STATUS);
  /** The person's pick (a resume id, or NO_RESUME for "None"); null until they touch the select. */
  const [chosenResume, setChosenResume] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  /** The server's words for a link it could not read (unread mode). */
  const [unreadMessage, setUnreadMessage] = useState<string | null>(null);

  // An untouched job type shows the preferred one. An untouched resume shows the placeholder and is not sent: the
  // application is added with no resume, and only a resume the person picks (or "None") counts as their choice.
  const employmentType = chosenType ?? preferredType;
  const resumeItems = resumes.data?.items ?? [];
  const noResumes = resumes.isSuccess && resumeItems.length === 0;
  const resumeValue = chosenResume ?? (noResumes ? NO_RESUME : null);
  const withLink = mode !== 'typed';
  const typed = mode !== 'link';

  /** A field's error goes as soon as the field changes (submitting checks it again). */
  const clearError = (field: FieldName) =>
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });

  const switchMode = (next: AddMode) => {
    setMode(next);
    setErrors({});
    setFailure(null);
    setUnreadMessage(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const url = withLink ? linkInput(link) : '';
    const next: FieldErrors = {};
    if (withLink && !url) next.postingUrl = ADD_JOB_COPY.linkRequired;
    if (typed && !title.trim()) next.title = 'Required';
    if (typed && !companyName.trim()) next.companyName = 'Required';
    setErrors(next);
    setFailure(null);
    if (Object.keys(next).length > 0) return;
    const body = createBodyOf(
      mode,
      { url, title, companyName, location, employmentType },
      {
        status,
        ...(chosenResume !== null ? { resumeId: chosenResume === NO_RESUME ? null : chosenResume } : {}),
        occurredOn: localToday(),
      },
    );
    onSavingChange(true);
    try {
      const created = await trackerApi.create(body);
      onAdded(created, mode === 'link');
    } catch (error) {
      if (mode === 'link' && needsTypedDetails(error)) {
        // TailorIT could not read the link: the person types the title and company, kept as their own.
        setMode('unread');
        setUnreadMessage(userMessage(error));
        return;
      }
      if (isApiError(error) && error.fields) {
        const fields = error.fields;
        setErrors(Object.fromEntries(FIELD_NAMES.filter((name) => fields[name]).map((name) => [name, fields[name]])));
      }
      setFailure(userMessage(error, "We couldn't add the application. Please try again."));
    } finally {
      onSavingChange(false);
    }
  };

  return (
    <form id={FORM_ID} onSubmit={submit} noValidate className="flex flex-col gap-5" data-add-mode={mode}>
      {mode === 'unread' && unreadMessage && (
        <Notice tone="warning">
          {unreadMessage} {ADD_APPLICATION_COPY.unreadNote}
        </Notice>
      )}
      {mode === 'typed' && (
        <p className="flex flex-wrap items-center gap-x-2 text-[13px] leading-5 text-muted-foreground" data-typed-note="">
          {ADD_APPLICATION_COPY.typedNote}
          <Button variant="link" size="sm" onClick={() => switchMode('link')}>
            {ADD_APPLICATION_COPY.withLink}
          </Button>
        </p>
      )}
      {withLink && (
        <div className="flex flex-col gap-2">
          <Field
            label={ADD_JOB_COPY.linkLabel}
            required
            error={errors.postingUrl}
            hint={mode === 'link' ? ADD_APPLICATION_COPY.linkHint : undefined}
          >
            <Input
              type="url"
              inputMode="url"
              value={link}
              placeholder={ADD_JOB_COPY.linkPlaceholder}
              autoComplete="off"
              spellCheck={false}
              maxLength={2000}
              autoFocus={mode === 'link'}
              leading={<LinkSimpleIcon size={16} aria-hidden="true" />}
              onChange={(event) => {
                setLink(event.target.value);
                clearError('postingUrl');
                // A new link may be one TailorIT reads: it is asked again before typed words are.
                if (mode === 'unread') switchMode('link');
              }}
            />
          </Field>
          {mode === 'link' && (
            <Button variant="link" size="sm" className="self-start" onClick={() => switchMode('typed')} data-add-without-link="">
              {ADD_APPLICATION_COPY.noLink}
            </Button>
          )}
        </div>
      )}
      {typed && (
        <>
          <Field label={t('LABEL_TRACKER_FIELD_TITLE')} required error={errors.title}>
            <Input
              value={title}
              placeholder="Title"
              autoComplete="off"
              maxLength={200}
              autoFocus
              onChange={(event) => {
                setTitle(event.target.value);
                clearError('title');
              }}
            />
          </Field>
          <Field label="Company" required error={errors.companyName}>
            <CompanyInput
              value={companyName}
              onValueChange={(value) => {
                setCompanyName(value);
                clearError('companyName');
              }}
            />
          </Field>
          <Field label="Location" error={errors.location}>
            <Input
              value={location}
              placeholder="Location"
              autoComplete="off"
              maxLength={200}
              onChange={(event) => {
                setLocation(event.target.value);
                clearError('location');
              }}
            />
          </Field>
          <Field label="Job Type" required error={errors.employmentType}>
            <Select
              options={JOB_TYPE_OPTIONS}
              value={employmentType}
              onValueChange={(value) => {
                setChosenType(value);
                clearError('employmentType');
              }}
            />
          </Field>
        </>
      )}
      <Field label={t('LABEL_TRACKER_COL_STAGE')} error={errors.status}>
        <Select
          options={statusOptions()}
          value={String(status)}
          onValueChange={(value) => {
            setStatus(Number(value) as ApplicationStatus);
            clearError('status');
          }}
        />
      </Field>
      <Field label="Resume used" error={errors.resumeId}>
        <Select
          options={[
            { value: NO_RESUME, label: resumeItems.length > 0 ? 'None' : 'No resumes found' },
            ...resumeItems.map((resume) => ({
              value: resume.id,
              label: resume.isDefault ? `${resume.label} (Default)` : resume.label,
              textValue: resume.label,
            })),
          ]}
          value={resumeValue}
          placeholder="Resume used for this application"
          disabled={resumeItems.length === 0}
          onValueChange={(value) => {
            setChosenResume(value);
            clearError('resumeId');
          }}
        />
        {resumes.isError && (
          <p className="text-[13px] leading-5 text-muted-foreground">Your resumes can&apos;t be listed now. Link one later.</p>
        )}
      </Field>
      {failure && <Notice tone="error">{failure}</Notice>}
    </form>
  );
}

/**
 * "Track an application" (v31 FIX-DOCS: MSG_TRACKER_ADD_TITLE): a right sheet with a briefcase tile. v31 JOBSWEB: it asks for the posting's link first, and
 * TailorIT's server reads the title and company from it (POST /api/applications with the link alone); the typed fields
 * show only with no link ("Add it without a link") or when the link cannot be read, and stay the person's own. Saving
 * opens the new application's detail (in edit mode when its words were typed, to add the pay and description).
 */
export function AddApplicationSheet({
  open,
  onOpenChange,
  onAdded,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `fromLink`: TailorIT read the entry's title and company from its link. */
  onAdded: (application: ApplicationDetail, fromLink: boolean) => void;
  /**
   * v31 FIX-DOCS (REV-UX UX-3): where focus goes when the sheet closes without adding (Cancel, Escape, ×): the button
   * that opened it. The sheet has no trigger of its own, so without this focus fell to the page.
   */
  returnFocus?: () => HTMLElement | null;
}) {
  const [saving, setSaving] = useState(false);
  const { t } = usePublicConstants();
  const added = useRef(false);
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) added.current = false;
        onOpenChange(next);
      }}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen || added.current) return;
        // After the sheet has gone (its fields took focus with them): back to the button that opened it.
        window.requestAnimationFrame(() => {
          const active = document.activeElement;
          if (active && active !== document.body && active.isConnected && !active.closest('[role="dialog"]')) return;
          returnFocus?.()?.focus();
        });
      }}
    >
      <SheetContent
        title={t('MSG_TRACKER_ADD_TITLE')}
        icon={<BriefcaseIcon size={20} />}
        size="3xl"
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form={FORM_ID} loading={saving}>
              Add
            </Button>
          </>
        }
      >
        {open && (
          <AddApplicationForm
            onSavingChange={setSaving}
            onAdded={(application, fromLink) => {
              added.current = true;
              onOpenChange(false);
              onAdded(application, fromLink);
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
