'use client';

import type { ResumeSummary } from '@tailorit/shared/resume';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { BriefcaseIcon, FileTextIcon, PlusIcon, StarIcon, UploadSimpleIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { useStoredValue } from '@/lib/storage';
import { useNow } from '@/lib/useNow';
import {
  ActionMenu,
  DocumentCard,
  DocumentCollection,
  NewTile,
  matchesQuery,
  type DocumentColumn,
} from '../core';
import { createPollClock } from '../../resume-editor/analysis';
import { BatchDownloadButton } from './BatchDownload'; // v20 P10
import { NEW_RESUME_HREF, bulkDeleteResumes, fetchResumes, resumeEditorHref, resumeKeys } from '../../resume-editor/api';
import { dropResumesFromList, invalidateResumes, putResumeInList } from '../../resume-editor/cache';
import { tabCan, tabDeletes, useTabProfile } from '../../sharing/access'; // v33 FIX-1; FIX-2: tabDeletes
import { EditableCopiesNotices } from './EditableCopiesNotices';
import { ImportTaskNotices, type ImportTask } from './ImportTaskNotices';
import {
  dateTiles,
  emptyFolderCopy,
  folderSummary,
  folderTiles,
  itemsAt,
  itemsShown,
  readLocation,
  showsFolders,
  withLocation,
  type FolderLocation,
  type TailoredMode,
} from './folders';
import {
  bulkDeleteNote,
  bulkDeleteResult,
  cardMeta,
  editedShort,
  editedText,
  fileBadge,
  profileLine,
  readingsPending,
  searchFieldsOf,
  sortResumes,
  templateNameOf,
  uploadsFinishedToast,
} from './list';
import { FolderHeader, FolderPathLink, FolderTiles, useFolderFocus } from './ResumeFolders';
import { ResumeThumb } from './ResumeThumb';
import { UploadResumeDialog, type RunOutcome, type UploadedResume } from './UploadResumeDialog';
import { openResumeFile, resumeDetailsHref, useResumeActions } from './useResumeActions';
import { LimitNotice } from '@/components/limits'; // v20 P8
import { useRegisterUpload } from '../headerUpload'; // v31 FIX-DOCS
import { useResumeLimitGate } from './resumeLimit'; // v20 P8

const NOUN = { one: 'resume', many: 'resumes' };

/** Where Tailored resumes opens from the folders: the switch's last choice, remembered in this browser. */
const TAILORED_MODE_KEY = 'tailorit.documents.resumes.tailoredMode';
const readTailoredMode = (raw: string | null): TailoredMode => (raw === 'date' ? 'date' : 'total');

/**
 * Documents › Resumes: two views (Grid and List) of a person's resumes, in three folders (v1.5 W,
 * decision 6): Uploaded resumes, Edited resumes and Tailored resumes (Total, or By date: a folder per local day).
 * The folders are tiles (Grid) or rows (List), each with how many it holds and when one last changed; the place is in
 * the address (`?folder=tailored&mode=date&date=2026-11-09`), with breadcrumbs and Back. Inside a folder, Grid: a
 * dashed "New resume" (or "Upload a resume") tile, then each resume's first page with its label, the ★ Default /
 * Uploaded / PDF badges under it, "Edited … · {template}", what TailorIT read from it ("8 yrs · React, TypeScript,
 * Node.js +9") and ⋮. List: rows of Resume (the label, its badges and the same reading under it) | Name on resume |
 * Template | Edited | ⋮ with checkboxes for bulk delete. Search (labels, names, templates and main skills) spans every
 * folder and names each result's folder, with the "1 of 3 resumes match." line; Upload (one file or many); the view
 * is remembered. While a reading is still to come the list is read again, less and less often, for up to ten minutes.
 */
export function ResumesTab() {
  const toast = useToast();
  const { t, get } = usePublicConstants();
  const queryClient = useQueryClient();
  const now = useNow();
  const router = useRouter();
  const params = useSearchParams().toString();
  const location = useMemo(() => readLocation(new URLSearchParams(params)), [params]);
  const [tailoredMode, setTailoredMode] = useStoredValue<TailoredMode>(TAILORED_MODE_KEY, readTailoredMode);
  const [query, setQuery] = useState('');
  const [uploading, setUploading] = useState(false);
  const [tasks, setTasks] = useState<ImportTask[]>([]);
  const [readingPoll] = useState(createPollClock);
  // v33 FIX-1 (PLAN-sharing §9): no New, Upload or Delete on a profile shared without Documents' Change. v33 FIX-2: no
  // Delete on any shared profile (tabDeletes: Documents' Change never deletes).
  const tab = useTabProfile();
  const canEdit = tabCan(tab, 'documents:edit');
  const canDelete = canEdit && tabDeletes(tab);

  const listQuery = useQuery({
    queryKey: resumeKeys.list(),
    queryFn: ({ signal }) => fetchResumes(signal),
    refetchInterval: (current) => readingPoll.next(readingsPending(current.state.data), Date.now()),
  });
  const all = useMemo(() => sortResumes(listQuery.data ?? []), [listQuery.data]);
  // v1.5 W: the place's own resumes; a search finds them in every folder.
  const searching = query.trim() !== '';
  const atFolders = showsFolders(location);
  const here = useMemo(() => itemsAt(all, location), [all, location]);
  const items = useMemo(() => itemsShown(all, location, searching), [all, location, searching]);
  const searchFields = (resume: ResumeSummary) => searchFieldsOf(resume, templateNameOf(resume), resume.analysis?.hardSkills);
  const visibleIds = items.filter((item) => matchesQuery(query, searchFields(item))).map((item) => item.id);

  // v1.5 W: every folder is a link to its own address (the page's other parameters kept); focus follows a move.
  const hrefOf = useCallback((place: FolderLocation) => withLocation(params, place), [params]);
  const onModeChange = (mode: TailoredMode) => {
    setTailoredMode(mode);
    router.push(withLocation(params, { folder: 'tailored', mode, date: null }), { scroll: false });
  };
  const headingRef = useFolderFocus(location);

  const addTask = (task: ImportTask) => setTasks((current) => [...current.filter((item) => item.key !== task.key), task]);
  // v20 P8: the Free resume limit: a notice above the list, and New and Upload say it when pressed.
  const resumeGate = useResumeLimitGate();
  const upload = () => !resumeGate.blocks() && setUploading(true);
  // v31 FIX-DOCS: the page header's Upload opens this section's upload.
  useRegisterUpload('resumes', upload);
  const actions = useResumeActions({
    visibleIds,
    onTaskStarted: ({ taskId, label }) => addTask({ key: taskId, taskId, label }),
  });

  // Each stored upload shows at once. One file's editable copy that started is followed here, one that could not start
  // is said, and the upload stays either way; the copies of several files carry no task (EditableCopiesNotices
  // follows them).
  const onUploaded = (result: UploadedResume) => {
    putResumeInList(queryClient, result.summary);
    if (result.taskId) addTask({ key: result.taskId, taskId: result.taskId, label: result.label });
    else if (result.copyError) {
      addTask({ key: `copy:${result.id ?? result.label}`, taskId: null, label: result.label, error: result.copyError });
    }
  };

  // The end of an upload run: the list is read once (with what TailorIT read from each), and the copies of several
  // files with it; one toast sums it up.
  const onUploadsFinished = (outcome: RunOutcome) => {
    readingPoll.reset();
    void invalidateResumes(queryClient);
    const summary = uploadsFinishedToast(outcome);
    if (summary) toast.success(summary.title, summary.description);
  };

  // v31 FIX-DOCS: the empty states' own upload (the page header has "Upload"; this one says what it uploads).
  const uploadButton = (
    <Button variant="outline" icon={<UploadSimpleIcon size={16} />} onClick={upload /* v20 P8 */}>
      Upload a resume
    </Button>
  );

  const columns: DocumentColumn<ResumeSummary>[] = [
    {
      key: 'resume',
      header: 'Resume',
      track: 'minmax(0,2.2fr)',
      cell: (resume) => <ResumeNameCell resume={resume} />,
    },
    // v1.5 W: a search's results come from every folder; each says which.
    ...(searching
      ? [
          {
            key: 'folder',
            header: 'Folder',
            track: 'minmax(0,1.4fr)',
            cell: (resume: ResumeSummary) => <FolderPathLink resume={resume} hrefOf={hrefOf} onNavigate={() => setQuery('')} />,
          },
        ]
      : []),
    {
      key: 'name',
      header: 'Name on resume',
      track: 'minmax(0,1.4fr)',
      cell: (resume) => <span className="block truncate text-foreground">{resume.nameOnResume || '-'}</span>,
    },
    {
      key: 'template',
      header: 'Template',
      track: 'minmax(0,1.4fr)',
      cell: (resume) => <span className="block truncate text-foreground">{templateNameOf(resume) || '-'}</span>,
    },
    {
      key: 'edited',
      header: 'Edited',
      track: '10rem',
      cell: (resume) => <span className="block truncate text-muted-foreground">{editedShort(resume, now)}</span>,
    },
  ];

  // v1.5 W: the folders of the place (the three, or Tailored resumes' days), what the place holds, and its tile.
  const tiles = location.folder === null ? folderTiles(all, tailoredMode) : dateTiles(all, now);
  const summary = folderSummary(location, here, now);
  const folderEmpty = location.folder ? emptyFolderCopy(location) : null;
  const newTile =
    searching || atFolders || !canEdit ? undefined : location.folder === 'edited' ? (
      // v20 P8: at the resume limit, New says why instead of opening the editor.
      resumeGate.info ? (
        <NewTile kind="resume" label="New resume" hint="Start from a template" onClick={resumeGate.blocks} />
      ) : (
        <NewTile kind="resume" label="New resume" hint="Start from a template" href={NEW_RESUME_HREF} />
      )
    ) : location.folder === 'uploaded' ? (
      <NewTile
        kind="resume"
        label="Upload a resume"
        hint={t('MSG_UPLOAD_TILE_HINT', { max_mb: get('UPLOAD_MAX_MB') })}
        onClick={upload /* v20 P8 */}
      />
    ) : undefined;
  const emptyAction = (action: ReturnType<typeof emptyFolderCopy>['action']) =>
    action === 'upload' ? (
      uploadButton
    ) : action === 'new' ? (
      <Link href={NEW_RESUME_HREF} className={buttonClasses()} data-new-fallback="resume">
        <PlusIcon size={16} weight="bold" />
        New resume
      </Link>
    ) : action === 'jobs' ? (
      <Link href="/jobs" className={buttonClasses({ variant: 'outline' })}>
        <BriefcaseIcon size={16} />
        Find a job to tailor for
      </Link>
    ) : (
      <Link href={hrefOf({ folder: 'tailored', mode: 'date', date: null })} scroll={false} className={buttonClasses({ variant: 'outline' })}>
        Show every day
      </Link>
    );

  return (
    <>
      {resumeGate.info && <LimitNotice limit={resumeGate.info} className="mb-4" /> /* v20 P8 */}
      <EditableCopiesNotices />
      <ImportTaskNotices tasks={tasks} onDismiss={(key) => setTasks((current) => current.filter((task) => task.key !== key))} />
      {/* v1.5 W: the folders' heading at the top (for the page's outline), the folder's own inside one (v31 FIX-DOCS: h3s
          under the Documents panel's h2). */}
      {location.folder === null ? (
        <h3 ref={headingRef} tabIndex={-1} className="sr-only">
          {searching ? 'Results from all folders' : 'Resume folders'}
        </h3>
      ) : (
        <FolderHeader
          location={location}
          hrefOf={hrefOf}
          searching={searching}
          summary={summary}
          onModeChange={onModeChange}
          headingRef={headingRef}
        />
      )}
      <DocumentCollection<ResumeSummary>
        kind="resume"
        variant="cards"
        noun={NOUN}
        aria-label="Resumes"
        items={items}
        getId={(resume) => resume.id}
        getLabel={(resume) => resume.label}
        searchFields={searchFields}
        query={query}
        onQueryChange={setQuery}
        searchPlaceholder="Search all resumes"
        views={['grid', 'list']}
        defaultView="grid"
        viewStorageKey="tailorit.documents.resumes.view"
        columns={columns}
        renderActions={(resume) => <ActionMenu items={actions.itemsFor(resume)} label={`Actions for ${resume.label}`} />}
        folders={
          atFolders && all.length > 0 && (location.folder === null || here.length > 0)
            ? (view) => (
                <FolderTiles
                  tiles={tiles}
                  view={view}
                  now={now}
                  hrefOf={hrefOf}
                  label={location.folder === null ? 'Resume folders' : 'Tailored resumes by date'}
                />
              )
            : undefined
        }
        renderCard={(resume, selection) => {
          const badge = fileBadge(resume);
          return (
            <DocumentCard
              kind="resume"
              id={resume.id}
              label={resume.label}
              href={resume.kind === 'built' ? resumeEditorHref(resume.id) : undefined}
              onOpen={resume.kind === 'uploaded' ? () => openResumeFile(resume.id) : undefined}
              onPreview={resume.kind === 'built' ? () => actions.preview(resume) : undefined}
              thumb={<ResumeThumb resume={resume} title={`${resume.label} preview`} />}
              badges={
                resume.isDefault || resume.kind === 'uploaded' ? (
                  <>
                    {resume.isDefault && (
                      <Badge tone="primary" icon={<StarIcon size={12} weight="fill" />} data-default-resume>
                        Default
                      </Badge>
                    )}
                    {resume.kind === 'uploaded' && <Badge>Uploaded</Badge>}
                    {resume.kind === 'uploaded' && badge && <Badge>{badge}</Badge>}
                  </>
                ) : undefined
              }
              meta={[
                cardMeta(editedText(resume, now), templateNameOf(resume)),
                <ProfileLine key="profile" resume={resume} />,
                ...(searching ? [<FolderPathLink key="folder" resume={resume} hrefOf={hrefOf} onNavigate={() => setQuery('')} />] : []),
              ]}
              menuItems={actions.itemsFor(resume)}
              selectable={selection.selectable}
              selected={selection.selected}
              onSelectedChange={selection.onSelectedChange}
            />
          );
        }}
        newTile={newTile}
        selectable={searching || !atFolders}
        bulkDeleteNote={(selected) => bulkDeleteNote(selected)}
        bulkActions={(selected) => <BatchDownloadButton resumes={selected} />} // v20 P10 (A28): Download, left of Delete
        onBulkDelete={!canDelete ? undefined : async (ids) => {
          const result = await bulkDeleteResumes(ids);
          dropResumesFromList(queryClient, ids.filter((id) => !result.skippedIds.includes(id)));
          void invalidateResumes(queryClient);
          toast.success(bulkDeleteResult(result));
        }}
        loading={listQuery.isPending}
        error={
          listQuery.isError ? (
            <Notice
              tone="error"
              title="Your resumes didn't load."
              action={
                <Button variant="outline" size="sm" loading={listQuery.isFetching} onClick={() => void listQuery.refetch()}>
                  Try again
                </Button>
              }
            >
              {userMessage(listQuery.error, 'Please try again in a moment.')}
            </Notice>
          ) : undefined
        }
        empty={
          folderEmpty
            ? { title: folderEmpty.title, description: folderEmpty.description, action: emptyAction(folderEmpty.action) }
            : {
                // v31 FIX-DOCS (REQ-3): the constants' words.
                title: t('MSG_DOCS_RESUMES_EMPTY_TITLE'),
                description: t('MSG_DOCS_RESUMES_EMPTY_TEXT'),
                icon: <FileTextIcon size={24} />,
                action: (
                  <>
                    <Link href={NEW_RESUME_HREF} className={buttonClasses()} data-new-fallback="resume">
                      <PlusIcon size={16} weight="bold" />
                      New resume
                    </Link>
                    {uploadButton}
                  </>
                ),
              }
        }
      />
      {actions.dialogs}
      {resumeGate.dialog /* v20 P8 */}
      <UploadResumeDialog open={uploading} onOpenChange={setUploading} onUploaded={onUploaded} onFinished={onUploadsFinished} />
    </>
  );
}

/**
 * What TailorIT read from a resume, on one line: "8 yrs · React, TypeScript, Node.js +9" (a small spinner first while
 * the AI reads it), "Finding skills...", "Waiting for the AI reading" or "No skills found". An upload's line opens its
 * page at that reading. Nothing known yet: an empty line that keeps its place.
 */
function ProfileLine({ resume }: { resume: ResumeSummary }) {
  const { t } = usePublicConstants();
  const line = profileLine(resume.analysis, t);
  if (!line.text) {
    return (
      <span aria-hidden="true" data-profile-line="">
        &nbsp;
      </span>
    );
  }
  const content = (
    <>
      {line.refining && (
        <>
          <Spinner size={12} className="mr-1.5 inline-block align-[-1px]" />
          <span className="sr-only">Reading it with AI. </span>
        </>
      )}
      {line.text}
    </>
  );
  if (resume.kind === 'uploaded' && line.hasReading) {
    return (
      <Link
        href={resumeDetailsHref(resume.id)}
        data-profile-line=""
        title={line.text}
        className="hover:text-foreground hover:underline hover:underline-offset-2"
      >
        {content}
      </Link>
    );
  }
  return (
    <span data-profile-line="" title={line.text}>
      {content}
    </span>
  );
}

/** The list's main cell: the label (a link to the editor, or the file for an upload), its badges and its reading. */
function ResumeNameCell({ resume }: { resume: ResumeSummary }) {
  const badge = fileBadge(resume);
  const nameClasses = 'min-w-0 truncate text-left text-sm font-semibold text-foreground hover:underline hover:underline-offset-2';
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex min-w-0 items-center gap-2">
        {resume.kind === 'built' ? (
          <Link href={resumeEditorHref(resume.id)} className={nameClasses} title={resume.label}>
            {resume.label}
          </Link>
        ) : (
          <button type="button" onClick={() => openResumeFile(resume.id)} className={nameClasses} title={resume.label}>
            {resume.label}
          </button>
        )}
        {resume.isDefault && (
          <Badge tone="primary" icon={<StarIcon size={12} weight="fill" />} data-default-resume>
            Default
          </Badge>
        )}
        {resume.kind === 'uploaded' && <Badge>Uploaded</Badge>}
        {badge && <Badge>{badge}</Badge>}
      </span>
      <span className="mt-0.5 block min-h-5 truncate text-[13px] leading-5 text-muted-foreground">
        <ProfileLine resume={resume} />
      </span>
    </span>
  );
}
