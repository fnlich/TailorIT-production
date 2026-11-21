'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_TEMPLATE_ID,
  emptyEditorDocument,
  isResumeTemplateId,
  LEGACY_TEMPLATE_IDS,
  MAX_RESUME_TITLE_LENGTH,
  RESUME_TEMPLATES,
  resumeLabel,
  type ResumeDocument,
  type ResumeTemplateId,
} from '@tailorit/shared';
import { EditorBar, EditorBarButton } from '@/components/shell/EditorBar';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { Button, buttonClasses } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import {
  ArrowUUpLeftIcon,
  ArrowUUpRightIcon,
  ArrowsDownUpIcon,
  DownloadSimpleIcon,
  EyeIcon,
  PaletteIcon,
  PencilSimpleIcon,
  SquaresFourIcon,
} from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { PageSpinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { ApiError, userMessage } from '@/lib/api';
import { useAccount } from '@/lib/auth';
import { isActing, localCopyScope } from '@/lib/profile';
import { usePublicConstants } from '@/lib/constants';
import { NEW_RESUME_HREF, RESUMES_TAB_HREF, newResumeHref, renameResume, resumeEditorHref, resumeKeys } from '../api';
import { RESUME_DEPENDENT_KEYS, putResumeInList } from '../cache';
import { EmptyFieldsBar } from '../check/EmptyFieldsBar';
import { emptyVisibleFields } from '../check/emptyFields';
import { DatePickerPopover } from '../dates/DatePickerPopover';
import { FieldBridgeContext } from '../fields/bridge';
import { FormatPopup } from '../fields/FormatPopup';
import { EDIT_FIELD_CSS, EDIT_SLOTS } from '../fields/fields';
import { ResumeCanvas } from '../pages/ResumeCanvas';
import { DesignPanel } from '../panels/DesignPanel';
import { RearrangeDialog } from '../panels/RearrangeDialog';
import { TemplatesPanel } from '../panels/TemplatesPanel';
import { EditorFieldProvider } from '../../roles/EditorField'; // v33 ROLES
import { PhoneBottomBar } from '../phone/PhoneBottomBar';
import { PhonePage } from '../phone/PhonePage';
import { PHONE_PAGE_CSS, PHONE_SLOTS } from '../phone/phoneSlots';
import { PHONE_MAIN_CLASS, usePhoneLayout } from '../phone/usePhoneLayout';
import { PhotoDialog } from '../photo/PhotoDialog';
import { EditorToolbars } from '../toolbars/EditorToolbars';
import type { SaveStatus } from '../save/saveQueue';
import { setTemplate } from '../store/actions';
import { editorKeys, fetchEditorResume, type EditorResume } from './api';
import { DownloadDialog } from './DownloadDialog';
import { ImportStartDialog } from './ImportStartDialog';
import { NewResumeChooser } from './NewResumeChooser';
import { useEditorSession, type EditorStart } from './useEditorSession';
import { LimitNotice } from '@/components/limits'; // v20 P8
import { Badge } from '@/components/ui/Badge';
import { useResumeLimitGate } from '../../documents/resumes/resumeLimit'; // v20 P8
import { StatusLine } from '../../documents/core/StatusLine';
import { SHARED_READ_ONLY_NOTE, useChangeAccess } from '../../sharing/access'; // v33 FIX-1

/**
 * The resume editor (Enhancv's on-page editor) for a stored, built resume at /resumes/[id]. It opens the resume as the
 * server upgrades it (an older resume of the retired form editor is stored in this editor's format only once it is
 * changed) and draws it with its template; it is edited on the page and saves itself.
 */
export function ResumeWorkspacePage({ resumeId, opened }: { resumeId: string; opened?: EditorResume }) {
  // Read afresh every time the editor opens: autosave starts from the revision read here. A resume already stored in
  // this editor's format comes with the page's own read of it just now (`opened`), so it is not read twice.
  const query = useQuery({
    queryKey: editorKeys.resume(resumeId),
    queryFn: ({ signal }) => fetchEditorResume(resumeId, signal),
    initialData: opened,
    gcTime: 0,
    staleTime: Infinity,
    retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
  });

  if (query.isPending) {
    return (
      <>
        <EditorBar name="Resume" documentsHref={RESUMES_TAB_HREF} />
        <PageSpinner label="Loading the resume..." />
      </>
    );
  }
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <>
        <EditorBar name="Resume" documentsHref={RESUMES_TAB_HREF} />
        <main className={clsx('mx-auto w-full max-w-xl pt-16', PAGE_GUTTER)}>
          <Notice
            tone={missing ? 'warning' : 'error'}
            title={missing ? 'That resume was not found' : "This resume didn't load."}
            action={
              <Link href={RESUMES_TAB_HREF} className={buttonClasses({ variant: 'outline', size: 'sm' })}>
                Back to Documents
              </Link>
            }
          >
            {missing ? 'It may have been deleted.' : userMessage(query.error, 'Please try again in a moment.')}
          </Notice>
        </main>
      </>
    );
  }
  // A reload (another tab saved first) brings a newer revision, and with it a new session.
  // v33 ROLES: the editor's words and the Templates panel follow the resume's field.
  return (
    <EditorFieldProvider resumeId={resumeId}>
      <Workspace
        key={`${query.data.id}:${query.data.documentRevision}`}
        start={query.data}
        title={query.data.title}
        onReload={() => void query.refetch()}
      />
    </EditorFieldProvider>
  );
}

const DRAFT_ID = /^[a-z0-9-]{8,64}$/;
/** A stored resume's id, as `&tailor=` may name one. */
const RESUME_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The template a new-resume address names: one of the six, or a retired one's id (an older link) as its successor. */
function startTemplateOf(value: string | null): ResumeTemplateId | null {
  if (isResumeTemplateId(value)) return value;
  return value && Object.hasOwn(LEGACY_TEMPLATE_IDS, value) ? (LEGACY_TEMPLATE_IDS[value] ?? null) : null;
}

/**
 * A new resume (/resumes/new): the template chooser, then (?template=) a blank page on that template. Nothing is
 * stored until the first change, which creates the resume; the address then becomes the resume's own without the
 * page remounting, so the caret stays where it is. The draft's id is in the address too, so a reload before that
 * first save offers the changes this browser kept.
 */
export function NewResumeWorkspacePage() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <NewResume />
    </Suspense>
  );
}

function NewResume() {
  const params = useSearchParams();
  // Taken once, when the address first names a template (from the chooser, or on arrival): after that the address
  // changes under the page (the draft id, then the resume's own address), and nothing may restart it.
  const [start, setStart] = useState<{
    templateId: ResumeTemplateId;
    draftId: string;
    document: ResumeDocument;
    /** "Import your existing resume" first: not when coming back to a draft already begun. */
    offerImport: boolean;
    /** v1.4 E: the stored resume the draft started from (`&tailor=`), kept in the address until the first save. */
    tailorId: string | null;
  } | null>(null);
  const template = startTemplateOf(params.get('template'));
  // v1.4 E: `&tailor=<resumeId>`: the draft starts from that resume's content (a tailored resume's Edit, the owner's
  // /resumes/new?template=…&draft=…&tailor=… links), on the template the address names (else the resume's own).
  const tailorParam = params.get('tailor');
  const tailorId = tailorParam && RESUME_ID.test(tailorParam) ? tailorParam : null;
  const source = useQuery({
    queryKey: ['resumes', 'tailor-source', tailorId],
    queryFn: ({ signal }) => fetchEditorResume(tailorId!, signal),
    enabled: tailorId !== null && start === null,
    gcTime: 0,
    staleTime: Infinity,
    retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
  });
  if (!start && (template || source.data)) {
    const draft = params.get('draft');
    const resumed = Boolean(draft && DRAFT_ID.test(draft));
    const draftId = resumed ? draft! : crypto.randomUUID();
    if (!tailorId && template) {
      setStart({
        templateId: template,
        draftId,
        document: emptyEditorDocument({ templateId: template }),
        offerImport: !resumed,
        tailorId: null,
      });
    } else if (tailorId && source.data) {
      const templateId = template ?? source.data.document.templateId ?? DEFAULT_TEMPLATE_ID;
      setStart({
        templateId,
        draftId,
        document: setTemplate(source.data.document, templateId).document,
        offerImport: false,
        tailorId,
      });
    }
  }

  // The draft id joins the address once, while it is still the new-resume page: once the first save has given the
  // resume its own address, the search parameters change again and this must not take the page back.
  useEffect(() => {
    if (!start || window.location.pathname !== NEW_RESUME_HREF) return;
    const search = new URLSearchParams(window.location.search);
    if (
      search.get('template') === start.templateId &&
      search.get('draft') === start.draftId &&
      search.get('tailor') === start.tailorId
    ) {
      return;
    }
    window.history.replaceState(null, '', newResumeHref(start.templateId, start.draftId, start.tailorId ?? undefined));
  }, [start]);

  if (!start && tailorId) {
    if (source.isError) {
      const missing = source.error instanceof ApiError && source.error.status === 404;
      return (
        <>
          <EditorBar name="Resume" documentsHref={RESUMES_TAB_HREF} />
          <main className={clsx('mx-auto w-full max-w-xl pt-16', PAGE_GUTTER)}>
            <Notice
              tone={missing ? 'warning' : 'error'}
              title={missing ? 'The resume to start from was not found' : "The resume to start from didn't load."}
              action={
                <Link href={RESUMES_TAB_HREF} className={buttonClasses({ variant: 'outline', size: 'sm' })}>
                  Back to Documents
                </Link>
              }
            >
              {missing ? 'It may have been deleted.' : userMessage(source.error, 'Please try again in a moment.')}
            </Notice>
          </main>
        </>
      );
    }
    return (
      <>
        <EditorBar name="Resume" documentsHref={RESUMES_TAB_HREF} />
        <PageSpinner label="Loading the resume..." />
      </>
    );
  }
  if (!start) return <NewResumeChooser />;
  return (
    <>
      <Workspace
        key={start.draftId}
        start={{ id: null, draftId: start.draftId, documentRevision: 0, document: start.document }}
        title={null}
        onReload={() => window.location.reload()}
        onCreated={(id) => window.history.replaceState(null, '', resumeEditorHref(id))}
      />
      <ImportStartDialog
        open={start.offerImport}
        templateId={start.templateId}
        layout="categorized"
        templateName={RESUME_TEMPLATES[start.templateId].name}
        onStartBlank={() => setStart({ ...start, offerImport: false })}
      />
    </>
  );
}

/** What the bar says about saving. */
function SaveStatusText({ status, onRetry }: { status: SaveStatus; onRetry(): void }) {
  const retry = (
    <button type="button" className="ml-1 font-medium text-foreground underline" onClick={onRetry}>
      Retry
    </button>
  );
  switch (status.state) {
    case 'idle':
      return null;
    case 'unsaved':
    case 'saving':
      return <span>Saving...</span>;
    case 'saved':
      return <span>Saved</span>;
    case 'offline':
      return <span>Offline, your changes are kept on this device{retry}</span>;
    case 'failed':
      return <span>Not saved{retry}</span>;
    case 'conflict':
      return <span>Loading the latest version...</span>;
    case 'stopped':
      return <span>{status.message}</span>;
    case 'limited': // v20 P8
      return <span>Read-only: not saved</span>;
    case 'gone':
      return <span>This resume was deleted</span>;
    case 'signed-out':
      return <span>Signed out, sign in again to save</span>;
  }
}

function Workspace({
  start,
  title,
  onReload,
  onCreated,
}: {
  start: EditorStart;
  /** The name given with Rename; null: the resume is named after what it prints (resumeLabel). */
  title: string | null;
  onReload(): void;
  onCreated?(id: string): void;
}) {
  const account = useAccount();
  const toast = useToast();
  const { t } = usePublicConstants();
  const queryClient = useQueryClient();
  // The name Rename gave the resume, if any.
  const [customTitle, setCustomTitle] = useState(title);
  // v33 SHARE-4: the browser copy is this account's on this profile (lib/profile.ts localCopyScope); on a shared profile
  // a newer version is someone else's (its owner, or another person they share it with), not only another tab's.
  const session = useEditorSession(start, localCopyScope(account?.id ?? 'signed-out'), {
    onConflict() {
      toast.info(isActing() ? 'Someone else changed this resume.' : 'Edited in another tab', 'Loading the latest version.');
      onReload();
    },
    onSignedOut() {
      toast.error('You were signed out', 'Your changes are kept on this device. Sign in again to save them.');
    },
    onCreated,
  });
  // The resume's name in the documents list, as the list words it: the name Rename gave it, else what it prints (its
  // title, else the person's name), so the bar follows the typing.
  const name = resumeLabel(session.document, customTitle);
  // Rename (the ✎ in the bar) once there is a resume to rename: the name in the documents list, not the one it prints.
  // The id is read, not kept in state: a new resume's first save re-renders the page with its status anyway, and one
  // more render while the person types into the next field would be one more chance to lose a keystroke.
  const savedId = session.resumeId();
  // v33 FIX-1: no Rename either on a profile shared without Documents' Change (sharedReadOnly, below).
  const canChange = useChangeAccess('documents:edit').change;
  const rename = savedId && canChange
    ? async (next: string) => {
        const saved = await renameResume(savedId, next);
        setCustomTitle(saved.summary ? saved.summary.title : next);
        putResumeInList(queryClient, saved.summary);
        // The list and what names the resume elsewhere are read again, never this page's own read: a newer revision
        // from it would start the editor over.
        void queryClient.invalidateQueries({ queryKey: resumeKeys.list() });
        for (const queryKey of RESUME_DEPENDENT_KEYS) void queryClient.invalidateQueries({ queryKey });
      }
    : undefined;
  // Preview draws what prints (the static view): no placeholders, no empty fields, no empty sections.
  const [previewChosen, setPreviewing] = useState(false);
  // v20 P8: at the Free resume limit a resume's document cannot be saved (the server refuses it), so the editor opens
  // read-only: the static view, no editing tools, the limit's message above the page. Download still works.
  const resumeGate = useResumeLimitGate();
  const limited = session.status.state === 'limited' ? session.status.message : null;
  // v33 FIX-1 (PLAN-sharing §9): on a profile shared without Documents' Change (or before its boxes are read) the editor
  // is read-only too: every save was refused, and what was typed was lost.
  const sharedReadOnly = !canChange;
  const readOnly = resumeGate.info !== null || limited !== null || sharedReadOnly;
  const previewing = previewChosen || readOnly;
  const [downloading, setDownloading] = useState(false);
  const [rearranging, setRearranging] = useState(false);
  // The empty fields the page shows (the Download check), and their bar and yellow highlight once asked for.
  const emptyCount = useMemo(() => emptyVisibleFields(session.document).length, [session.document]);
  const [showEmptyBar, setShowEmptyBar] = useState(false);
  const [highlightEmpty, setHighlightEmpty] = useState(false);
  // One docked panel at a time beside the page.
  const [panel, setPanel] = useState<'templates' | 'design' | null>(null);
  const canvas = useRef<HTMLDivElement | null>(null);
  // Below 768 px the phone's way: the page is tapped, not typed on; its parts are edited in full-screen forms, and the
  // bar keeps the name and the save status (the rest is in the bar along the bottom).
  const phone = usePhoneLayout();
  const saveStatus = <SaveStatusText status={session.status} onRetry={session.retrySave} />;
  const desktopActions = readOnly ? (
    // v20 P8: read-only, only Download.
    <EditorBarButton label="Download" icon={<DownloadSimpleIcon size={16} />} onClick={() => setDownloading(true)} data-download="" />
  ) : (
    <>
      <IconButton
        label={session.undoLabel ? `Undo ${session.undoLabel}` : 'Undo'}
        icon={<ArrowUUpLeftIcon size={18} />}
        variant="ghost"
        disabled={!session.canUndo}
        onClick={session.undo}
      />
      <IconButton
        label={session.redoLabel ? `Redo ${session.redoLabel}` : 'Redo'}
        icon={<ArrowUUpRightIcon size={18} />}
        variant="ghost"
        disabled={!session.canRedo}
        onClick={session.redo}
      />
      <EditorBarButton
        label="Rearrange"
        icon={<ArrowsDownUpIcon size={16} />}
        variant="ghost"
        onClick={() => setRearranging(true)}
        data-rearrange=""
      />
      <EditorBarButton
        label="Templates"
        icon={<SquaresFourIcon size={16} />}
        variant={panel === 'templates' ? 'secondary' : 'ghost'}
        aria-pressed={panel === 'templates'}
        onClick={() => setPanel((open) => (open === 'templates' ? null : 'templates'))}
        data-panel-toggle="templates"
      />
      <EditorBarButton
        label="Design & Font"
        shortLabel="Design"
        icon={<PaletteIcon size={16} />}
        variant={panel === 'design' ? 'secondary' : 'ghost'}
        aria-pressed={panel === 'design'}
        onClick={() => setPanel((open) => (open === 'design' ? null : 'design'))}
        data-panel-toggle="design"
      />
      <EditorBarButton
        label={previewing ? 'Back to editing' : 'Preview'}
        icon={previewing ? <PencilSimpleIcon size={16} /> : <EyeIcon size={16} />}
        variant="outline"
        aria-pressed={previewing}
        onClick={() => setPreviewing((on) => !on)}
        data-preview-toggle=""
      />
      <EditorBarButton
        label="Download"
        icon={<DownloadSimpleIcon size={16} />}
        onClick={() => setDownloading(true)}
        data-download=""
      />
    </>
  );
  return (
    <>
      <EditorBar
        name={name}
        documentsHref={RESUMES_TAB_HREF}
        onRename={rename}
        validateName={(next) =>
          next.length > MAX_RESUME_TITLE_LENGTH ? t('MSG_TEXT_TOO_LONG', { max: MAX_RESUME_TITLE_LENGTH }) : null
        }
        maxNameLength={MAX_RESUME_TITLE_LENGTH}
        info={savedId ? 'Only for your documents list; the page prints its own name.' : undefined}
        status={phone ? undefined : saveStatus}
        crowded // v31 FIX-WEB: seven actions; the usage chip's words wait for 1536 px, the name keeps its room
        actions={
          phone ? (
            // The bar's own status line is hidden at a phone's width; this one stays.
            <div role="status" className="max-w-[40vw] text-right text-xs leading-4 text-muted-foreground">
              {saveStatus}
            </div>
          ) : (
            desktopActions
          )
        }
      />
      {readOnly ? ( // v20 P8
        <div className={clsx('mx-auto flex w-full max-w-[816px] flex-wrap items-center gap-2 pt-6', PAGE_GUTTER)} data-resume-read-only="">
          {/* v32 COPY (E4): the state is a tag and the limit's chip (its "?" says why), never a banner. */}
          <Badge tone="neutral">Read-only</Badge>
          {sharedReadOnly && resumeGate.info === null && limited === null ? (
            <span className="text-sm leading-5 text-muted-foreground" data-resume-read-only-shared="">
              {SHARED_READ_ONLY_NOTE}
            </span>
          ) : (
          <LimitNotice
            limit={
              resumeGate.info ?? {
                kind: 'resume_limit_reached',
                message: limited ?? '',
                subscribe: true,
                buyCredit: false,
              }
            }
          >
            Changes are not saved until you have fewer resumes; you can still download it.
          </LimitNotice>
          )}
          {phone && (
            <Button size="sm" variant="outline" icon={<DownloadSimpleIcon size={16} />} onClick={() => setDownloading(true)}>
              Download
            </Button>
          )}
        </div>
      ) : null}
      {session.restore ? (
        <div className={clsx('mx-auto w-full max-w-[816px] pt-6', PAGE_GUTTER)}>
          {/* v32 COPY (E4): a compact line with its two buttons; the details are its "?". */}
          <StatusLine
            tone={session.restore.offer.stale ? 'warning' : 'info'}
            title="This browser kept changes that were never saved"
            details={
              session.restore.offer.stale
                ? 'It was saved from somewhere else since; restoring puts these changes over that save.'
                : 'Restore them to pick up where you left off.'
            }
            actions={
              <>
                <Button size="sm" onClick={session.restore.accept}>
                  Restore them
                </Button>
                <Button size="sm" variant="outline" onClick={session.restore.discard}>
                  Discard
                </Button>
              </>
            }
          />
        </div>
      ) : null}
      <main className={clsx('flex w-full items-start justify-center gap-6', phone ? PHONE_MAIN_CLASS : ['py-8', PAGE_GUTTER])}>
        <div className="flex w-full max-w-[816px] min-w-0 flex-col gap-4">
          {!previewing && showEmptyBar ? (
            <EmptyFieldsBar
              document={session.document}
              highlighted={highlightEmpty}
              onHighlightedChange={setHighlightEmpty}
              onHide={() => setShowEmptyBar(false)}
            />
          ) : null}
          <div
            ref={canvas}
            role="region"
            aria-label="Resume"
            className="relative w-full min-w-0"
            data-resume-mode={previewing ? 'static' : 'edit'}
          >
            {previewing ? null : phone ? (
              <PhonePage session={session} canvas={canvas} />
            ) : (
              <EditorToolbars session={session} canvas={canvas} onRearrange={() => setRearranging(true)} />
            )}
            <FieldBridgeContext.Provider value={session.bridge}>
              <ResumeCanvas
                key={previewing ? 'static' : 'edit'}
                document={session.document}
                mode={previewing ? 'static' : 'edit'}
                slots={previewing ? undefined : phone ? PHONE_SLOTS : EDIT_SLOTS}
                extraCss={previewing ? '' : phone ? PHONE_PAGE_CSS : EDIT_FIELD_CSS}
              />
            </FieldBridgeContext.Provider>
          </div>
        </div>
        {panel === 'templates' && !previewing && !phone ? (
          <TemplatesPanel document={session.document} store={session.store} onClose={() => setPanel(null)} />
        ) : null}
        {panel === 'design' && !previewing && !phone ? (
          <DesignPanel document={session.document} store={session.store} onClose={() => setPanel(null)} />
        ) : null}
      </main>
      {phone && !readOnly /* v20 P8 */ ? (
        <PhoneBottomBar
          session={session}
          canvas={canvas}
          previewing={previewing}
          onPreview={() => setPreviewing((on) => !on)}
          onDownload={() => setDownloading(true)}
          onRearrange={() => setRearranging(true)}
        />
      ) : null}
      <DatePickerPopover
        target={session.date.target}
        onPeriod={session.date.onPeriod}
        onDate={session.date.onDate}
        onClose={session.date.close}
      />
      <PhotoDialog open={session.photo.open} onClose={session.photo.close} onAccepted={session.photo.accept} />
      {rearranging ? (
        <RearrangeDialog open onClose={() => setRearranging(false)} document={session.document} store={session.store} />
      ) : null}
      {downloading ? (
        <DownloadDialog
          open
          onClose={() => setDownloading(false)}
          document={session.document}
          emptyFields={emptyCount}
          onShowEmpty={() => {
            setHighlightEmpty(true);
            setShowEmptyBar(true);
          }}
          flush={session.flush}
          resumeId={session.resumeId}
        />
      ) : null}
      {previewing || phone ? null : <FormatPopup />}
      <div aria-live="polite" className="sr-only">
        {session.announcement}
      </div>
    </>
  );
}
