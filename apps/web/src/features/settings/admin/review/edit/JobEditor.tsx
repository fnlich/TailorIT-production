'use client';

import {
  JOB_EDIT_FIELD_LABEL,
  JOB_EDIT_LIMITS, // v38 FIX-APP (ux L11)
  type AdminJobEditor,
  type AdminJobRead,
  type JobEditDuplicate,
  type JobEditField,
  type JobEditValues,
} from '@tailorit/shared/reviews';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { ArrowCounterClockwiseIcon, ArrowsClockwiseIcon, CheckIcon } from '@/components/ui/icons';
import { Input, Textarea } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { Sheet, SheetContent } from '@/components/ui/Sheet';
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { ApiError, userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { RichTextEditor } from '@/features/tracker/RichTextEditor';
import { fetchJobEditor, jobEditKey, readJobLink, restoreJobField, saveJobEdit } from './api';
import { EditedBadge } from './EditedBadge';
import {
  EDIT_COPY,
  EMPLOYMENT_OPTIONS,
  PERIOD_OPTIONS,
  VISIBILITY_TEXT,
  UNSET,
  WORK_MODE_OPTIONS,
  changedSinceText, // v38 FIX-APP (ux M4)
  changesOf,
  draftOf,
  rebaseDraft, // v38 FIX-APP (ux M4)
  draftProblems,
  duplicateText,
  editedFieldsText,
  readOutcomeText,
  savedText,
  serverProblems,
  valuesOfDraft,
  type JobEditDraft,
} from './copy';

// v38 REVEDIT (SP v38 PLAN.md E1-E6): Admin › Review's "Edit job", a sheet over the lane (or over a review's evidence
// sheet): every field an admin sees on the job's details (the link, the Apply link of a job whose link was added, title,
// company, the description as rich text, places, work mode, employment type, salary, posted date). Save sends only what
// changed, on the version opened; a changed link is read at once ("Read this link", also a button); a link another job
// TailorIT has holds says so and offers to open it (nothing saved). Each field an admin edited says "Edited by an admin"
// with "Use the posting's text again". The words: ./copy.ts.

/** The job the editor opens: its id and its row's name (the sheet's line under its title). */
export interface JobEditTarget {
  jobId: number;
  name: string;
}

/** A button's 44 px touch target on a phone. */
const TOUCH = 'max-sm:h-11';

export function JobEditor({
  target,
  open,
  onOpenChange,
  onChanged,
  onLive,
}: {
  target: JobEditTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After a save, a read or a restore: the lanes read again. */
  onChanged: () => void;
  /** The pane's live region (what happened, said once). */
  onLive?: (text: string) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {target && <EditorContent key={target.jobId} target={target} onChanged={onChanged} onLive={onLive} onClose={() => onOpenChange(false)} />}
    </Sheet>
  );
}

type Busy = 'save' | 'read' | `restore:${JobEditField}` | null;

function EditorContent({
  target,
  onChanged,
  onLive,
  onClose,
}: {
  target: JobEditTarget;
  onChanged: () => void;
  onLive?: (text: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const { t } = usePublicConstants();
  const queryClient = useQueryClient();
  // "Read this link" may hand the job over to the shared job it gave way to: the editor follows it.
  const [jobId, setJobId] = useState(target.jobId);
  const editor = useQuery({
    queryKey: jobEditKey(jobId),
    queryFn: ({ signal }) => fetchJobEditor(jobId, signal),
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const [draft, setDraft] = useState<JobEditDraft | null>(null);
  const [shownVersion, setShownVersion] = useState<string | null>(null);
  const [problems, setProblems] = useState<Partial<Record<JobEditField, string>>>({});
  const [duplicate, setDuplicate] = useState<JobEditDuplicate | null>(null);
  const [read, setRead] = useState<AdminJobRead | null>(null);
  // v38 FIX-APP (REVIEW38-ux M4): a Save that met a newer version: the fields changed elsewhere (the notice names them),
  // and what the admin had (the version they opened, their draft) until the newest version is put under it.
  const [stale, setStale] = useState<JobEditField[] | null>(null);
  const [rebase, setRebase] = useState<{ base: JobEditValues; draft: JobEditDraft } | null>(null);
  const linkRef = useRef<HTMLInputElement>(null); // v38 FIX-APP (ux L16): the editor opens on the Job link
  const [busy, setBusy] = useState<Busy>(null);
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);

  // The form shows the job's values; a new version (saved, read, restored, changed elsewhere) loads afresh (state set
  // while rendering, React's way to follow a value: no effect, no extra paint of the old draft).
  const data = editor.data;
  if (data && data.version !== shownVersion) {
    setShownVersion(data.version);
    if (rebase) {
      // v38 FIX-APP (REVIEW38-ux M4): the newest values, the admin's own changes put back on top.
      const next = rebaseDraft(rebase.base, rebase.draft, data.values, data.ownApplyLink);
      setDraft(next.draft);
      setStale(next.elsewhere);
      setRebase(null);
    } else setDraft(draftOf(data.values));
    setProblems({});
  }

  // v38 FIX-APP (REVIEW38-ux L16): once the job is drawn, focus goes to its first field (the Job link), not the ✕.
  const focused = useRef(false);
  useEffect(() => {
    if (!data || focused.current) return;
    focused.current = true;
    requestAnimationFrame(() => linkRef.current?.focus());
  }, [data]);

  const put = (next: AdminJobEditor) => queryClient.setQueryData(jobEditKey(next.jobId), next);
  const say = (text: string) => onLive?.(text);

  const readNow = async (): Promise<void> => {
    setBusy('read');
    setDuplicate(null);
    try {
      const answer = await readJobLink(jobId);
      setRead(answer);
      const words = readOutcomeText(answer);
      say(`${words.title}. ${words.body}`);
      if (answer.editor) {
        put(answer.editor);
        if (answer.jobId !== jobId) setJobId(answer.jobId);
      }
      onChanged();
    } catch (error) {
      toast.error(EDIT_COPY.readError, userMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!data || !draft) return;
    const found = draftProblems(draft, t);
    setProblems(found);
    if (Object.keys(found).length > 0) {
      focusFirstProblem(formRef.current);
      return;
    }
    const changes = changesOf(data.values, valuesOfDraft(draft, data.values), data.ownApplyLink);
    if (Object.keys(changes).length === 0) {
      toast.info(EDIT_COPY.nothing);
      return;
    }
    setBusy('save');
    setDuplicate(null);
    setRead(null);
    setStale(null);
    let readAfter = false;
    try {
      const answer = await saveJobEdit(jobId, { version: data.version, changes });
      if (!answer.saved) {
        setDuplicate(answer.duplicate);
        say(`${EDIT_COPY.duplicateTitle}. ${duplicateText(answer.duplicate).body}`);
        return;
      }
      put(answer.editor);
      // v38 FIX-APP (REVIEW38-ux L15): a link kept without its private parameters says so, and the field shows the link
      // as kept; a link that cleans to the job's own changes nothing ("Nothing to save"), the field showing it again.
      const cleaned = changes.link !== undefined && answer.editor.values.link !== changes.link;
      if (answer.changed.length === 0) {
        setDraft(draftOf(answer.editor.values));
        toast.info(EDIT_COPY.nothing, cleaned ? EDIT_COPY.linkCleaned : undefined);
        say(`${EDIT_COPY.nothing}${cleaned ? ` ${EDIT_COPY.linkCleaned}` : ''}`);
        return;
      }
      const body = cleaned ? `${savedText(answer.changed)} ${EDIT_COPY.linkCleaned}` : savedText(answer.changed);
      toast.success(EDIT_COPY.saved, body);
      say(`${EDIT_COPY.saved}. ${body}`);
      onChanged();
      readAfter = answer.changed.includes('link');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // v38 FIX-APP (REVIEW38-ux M4): keep what the admin typed; the newest version is put under it once read.
        setRebase({ base: data.values, draft });
        setStale([]);
        await editor.refetch();
      } else if (error instanceof ApiError && error.status === 400 && error.fields) {
        setProblems(serverProblems(error.fields));
        focusFirstProblem(formRef.current);
      } else {
        toast.error(EDIT_COPY.saveError, userMessage(error));
      }
    } finally {
      setBusy(null);
    }
    // E3: a changed link is read at once.
    if (readAfter) await readNow();
  };

  const restore = async (field: JobEditField) => {
    setBusy(`restore:${field}`);
    try {
      const next = await restoreJobField(jobId, field);
      put(next);
      toast.success("The posting's text is back", JOB_EDIT_FIELD_LABEL[field]);
      say(`The posting's text is back: ${JOB_EDIT_FIELD_LABEL[field]}`);
      onChanged();
    } catch (error) {
      toast.error(EDIT_COPY.restoreError, userMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const footer = (
    <div className="flex w-full flex-wrap items-center justify-end gap-2" data-job-editor-actions="">
      <Button variant="outline" className={TOUCH} onClick={onClose}>
        {EDIT_COPY.cancel}
      </Button>
      <Button
        variant="outline"
        className={TOUCH}
        icon={<ArrowsClockwiseIcon size={14} weight="bold" aria-hidden="true" />}
        loading={busy === 'read'}
        disabled={!data || busy !== null || data.visibility === 'closed'}
        focusableWhenDisabled
        onClick={() => void readNow()}
        data-job-editor-read=""
      >
        {busy === 'read' ? EDIT_COPY.reading : EDIT_COPY.read}
      </Button>
      <Button
        type="submit"
        form={formId}
        className={TOUCH}
        icon={<CheckIcon size={14} weight="bold" aria-hidden="true" />}
        loading={busy === 'save'}
        disabled={!draft || busy !== null}
        focusableWhenDisabled
        data-job-editor-save=""
      >
        {busy === 'save' ? EDIT_COPY.saving : EDIT_COPY.save}
      </Button>
    </div>
  );

  return (
    <SheetContent
      title={EDIT_COPY.title}
      description={target.name}
      help={EDIT_COPY.help}
      footer={footer}
      className="sm:max-w-[640px]!"
      wrapTitle
      closeClassName="max-sm:size-11" // v38 FIX-APP (REVIEW38-ux L16)
    >
      {editor.isError && !data ? (
        <Notice
          tone="error"
          title={EDIT_COPY.loadError}
          action={
            <Button variant="outline" size="sm" onClick={() => void editor.refetch()}>
              Try again
            </Button>
          }
        >
          {userMessage(editor.error)}
        </Notice>
      ) : !data || !draft ? (
        <div aria-busy="true" aria-label="Loading the job" className="flex flex-col gap-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
          <SkeletonText lines={4} />
        </div>
      ) : (
        <form
          id={formId}
          ref={formRef}
          noValidate
          className="flex flex-col gap-5"
          data-job-editor={data.jobId}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <EditorNotices
            editor={data}
            stale={stale}
            duplicate={duplicate}
            read={read}
            onOpenDuplicate={onClose}
          />
          <EditorFields
            editor={data}
            linkRef={linkRef}
            draft={draft}
            problems={problems}
            busy={busy}
            onChange={(next) => setDraft((current) => (current ? { ...current, ...next } : current))}
            onRestore={(field) => void restore(field)}
          />
        </form>
      )}
    </SheetContent>
  );
}

/** Focuses the first control the form marks invalid. */
function focusFirstProblem(form: HTMLFormElement | null) {
  requestAnimationFrame(() => form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
}

/** The editor's state lines: who sees the job, which fields an admin edited, and what Save or Read came to. */
function EditorNotices({
  editor,
  stale,
  duplicate,
  read,
  onOpenDuplicate,
}: {
  editor: AdminJobEditor;
  stale: JobEditField[] | null;
  duplicate: JobEditDuplicate | null;
  read: AdminJobRead | null;
  onOpenDuplicate: () => void;
}) {
  const edited = editedFieldsText(editor.edited);
  const readWords = read ? readOutcomeText(read) : null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] leading-5 text-muted-foreground" data-job-editor-visibility={editor.visibility}>
        {VISIBILITY_TEXT[editor.visibility]}
      </p>
      {edited && (
        <p className="flex flex-wrap items-center gap-2 text-[13px] leading-5 text-foreground" data-job-editor-edited="">
          <EditedBadge />
          <span>{edited}</span>
        </p>
      )}
      {stale && (
        <Notice tone="warning">
          <span data-job-editor-stale="">{changedSinceText(stale)}</span>
        </Notice>
      )}
      {duplicate && (
        <Notice
          tone="warning"
          title={EDIT_COPY.duplicateTitle}
          action={
            <Link
              href={duplicateText(duplicate).href}
              onClick={onOpenDuplicate}
              className="inline-flex min-h-11 items-center text-sm font-medium text-primary-ink underline underline-offset-2 sm:min-h-0"
              data-job-editor-duplicate={duplicate.jobId}
            >
              {EDIT_COPY.openDuplicate}
            </Link>
          }
        >
          {duplicateText(duplicate).body}
        </Notice>
      )}
      {readWords && (
        <Notice tone={readWords.tone} title={readWords.title}>
          <span data-job-editor-read-outcome={read?.outcome}>{readWords.body}</span>
        </Notice>
      )}
    </div>
  );
}

function EditorFields({
  editor,
  linkRef,
  draft,
  problems,
  busy,
  onChange,
  onRestore,
}: {
  editor: AdminJobEditor;
  linkRef?: RefObject<HTMLInputElement | null>;
  draft: JobEditDraft;
  problems: Partial<Record<JobEditField, string>>;
  busy: Busy;
  onChange: (next: Partial<JobEditDraft>) => void;
  onRestore: (field: JobEditField) => void;
}) {
  const marks = new Set(editor.edited.map((mark) => mark.field));
  const restoreOf = (field: JobEditField) =>
    marks.has(field) ? <RestoreLine field={field} busy={busy} onRestore={onRestore} /> : null;
  const descriptionLabel = useId();
  return (
    <div className="flex flex-col gap-5" data-job-editor-fields="">
      <FieldBlock restore={restoreOf('link')}>
        <Field label={JOB_EDIT_FIELD_LABEL.link} hint={EDIT_COPY.linkHelp} error={problems.link}>
          <Input
            ref={linkRef}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={draft.link}
            onChange={(event) => onChange({ link: event.target.value })}
          />
        </Field>
      </FieldBlock>
      {editor.ownApplyLink && (
        <FieldBlock restore={restoreOf('applyUrl')}>
          <Field label={JOB_EDIT_FIELD_LABEL.applyUrl} optional hint={EDIT_COPY.applyHelp} error={problems.applyUrl}>
            <Input
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={draft.applyUrl}
              onChange={(event) => onChange({ applyUrl: event.target.value })}
            />
          </Field>
        </FieldBlock>
      )}
      <FieldBlock restore={restoreOf('title')}>
        <Field label={JOB_EDIT_FIELD_LABEL.title} required error={problems.title}>
          {/* v38 FIX-APP (REVIEW38-ux L11): the field takes what the job keeps. */}
          <Input value={draft.title} maxLength={JOB_EDIT_LIMITS.title} onChange={(event) => onChange({ title: event.target.value })} />
        </Field>
      </FieldBlock>
      <FieldBlock restore={restoreOf('company')}>
        <Field label={JOB_EDIT_FIELD_LABEL.company} required error={problems.company}>
          <Input value={draft.company} maxLength={JOB_EDIT_LIMITS.company} onChange={(event) => onChange({ company: event.target.value })} />
        </Field>
      </FieldBlock>
      <FieldBlock restore={restoreOf('description')}>
        <div className="flex flex-col gap-1.5" data-job-editor-description="">
          <p id={descriptionLabel} className="text-sm leading-5 font-medium text-foreground">
            {JOB_EDIT_FIELD_LABEL.description}
          </p>
          <RichTextEditor
            key={editor.version}
            value={draft.descriptionHtml}
            onChange={(html) => onChange({ descriptionHtml: html })}
            placeholder="The posting's description"
            label={JOB_EDIT_FIELD_LABEL.description}
            minHeight={180}
            className="max-h-[420px] overflow-y-auto"
          />
          {problems.description && <p className="text-[13px] leading-5 text-danger">{problems.description}</p>}
        </div>
      </FieldBlock>
      <FieldBlock restore={restoreOf('locations')}>
        <Field label={JOB_EDIT_FIELD_LABEL.locations} hint={EDIT_COPY.placesHelp} error={problems.locations}>
          <Textarea rows={3} autoGrow value={draft.places} onChange={(event) => onChange({ places: event.target.value })} />
        </Field>
      </FieldBlock>
      <div className="grid gap-5 sm:grid-cols-2">
        <FieldBlock restore={restoreOf('workArrangement')}>
          <Field label={JOB_EDIT_FIELD_LABEL.workArrangement}>
            <Select
              options={WORK_MODE_OPTIONS}
              value={draft.workArrangement || UNSET}
              onValueChange={(value) => onChange({ workArrangement: value === UNSET ? '' : value })}
              className="w-full max-sm:h-11"
            />
          </Field>
        </FieldBlock>
        <FieldBlock restore={restoreOf('employmentType')}>
          <Field label={JOB_EDIT_FIELD_LABEL.employmentType}>
            <Select
              options={EMPLOYMENT_OPTIONS}
              value={draft.employmentType || UNSET}
              onValueChange={(value) => onChange({ employmentType: value === UNSET ? '' : value })}
              className="w-full max-sm:h-11"
            />
          </Field>
        </FieldBlock>
      </div>
      <FieldBlock restore={restoreOf('salary')}>
        <fieldset className="flex min-w-0 flex-col gap-1.5" data-job-editor-salary="">
          <legend className="mb-1.5 text-sm leading-5 font-medium text-foreground">{JOB_EDIT_FIELD_LABEL.salary}</legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="From">
              <Input inputMode="decimal" value={draft.salaryMin} onChange={(event) => onChange({ salaryMin: event.target.value })} />
            </Field>
            <Field label="To">
              <Input inputMode="decimal" value={draft.salaryMax} onChange={(event) => onChange({ salaryMax: event.target.value })} />
            </Field>
            <Field label="Currency">
              <Input maxLength={3} autoComplete="off" value={draft.currency} onChange={(event) => onChange({ currency: event.target.value })} />
            </Field>
            <Field label="Period">
              <Select
                options={PERIOD_OPTIONS}
                value={draft.period || UNSET}
                onValueChange={(value) => onChange({ period: value === UNSET ? '' : value })}
                className="w-full max-sm:h-11"
              />
            </Field>
          </div>
          {problems.salary && <p className="text-[13px] leading-5 text-danger" role="alert">{problems.salary}</p>}
        </fieldset>
      </FieldBlock>
      <FieldBlock restore={restoreOf('postedAt')}>
        <Field label={JOB_EDIT_FIELD_LABEL.postedAt} optional error={problems.postedAt}>
          <Input type="date" value={draft.postedAt} onChange={(event) => onChange({ postedAt: event.target.value })} className="sm:max-w-48" />
        </Field>
      </FieldBlock>
    </div>
  );
}

/** A field and, when an admin edited it, its mark and "Use the posting's text again". */
function FieldBlock({ children, restore }: { children: ReactNode; restore: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {children}
      {restore}
    </div>
  );
}

function RestoreLine({ field, busy, onRestore }: { field: JobEditField; busy: Busy; onRestore: (field: JobEditField) => void }) {
  return (
    <p className="flex flex-wrap items-center gap-2" data-job-editor-mark={field}>
      <EditedBadge />
      <Button
        variant="ghost"
        size="sm"
        className={TOUCH}
        icon={<ArrowCounterClockwiseIcon size={14} aria-hidden="true" />}
        loading={busy === `restore:${field}`}
        disabled={busy !== null}
        focusableWhenDisabled
        aria-label={`${EDIT_COPY.restore}: ${JOB_EDIT_FIELD_LABEL[field]}`}
        onClick={() => onRestore(field)}
      >
        {EDIT_COPY.restore}
      </Button>
    </p>
  );
}
