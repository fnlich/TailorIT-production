'use client';

import type { ResumeSummary } from '@tailorit/shared/resume';
import { DocumentsZipBodySchema, type DocumentsZipBody } from '@tailorit/shared/resume';
import {
  ResumeZipAcceptedSchema,
  ResumeZipBuildSchema,
  type ResumeZipAccepted,
  type ResumeZipBuild,
} from '@tailorit/shared/tracker';
import { useState, useSyncExternalStore } from 'react';
// Relative, not '@/': the web tests draw these views.
import { LIMIT_COPY, LIMIT_TITLES, LockedFeatureDialog, useLimitDialog } from '../../../components/limits';
import { Button } from '../../../components/ui/Button';
import { DownloadSimpleIcon, LockSimpleIcon } from '../../../components/ui/icons';
import { useToast } from '../../../components/ui/Toast';
import { isFeatureLocked, useAccount } from '../../../lib/account';
import { ApiError, api, userMessage } from '../../../lib/api';
import { usePublicConstants } from '../../../lib/constants';
import { downloadFrom } from '../../resume-editor/files';
import {
  buildingProgress,
  createStore,
  failedBuildError,
  RESUME_ZIP_PATH,
  ZIP_POLL_FAILURES,
  ZIP_POLL_MS,
  type ZipRunState,
} from '../../tracker/zip/resumeZip';

// v20 P10 (DECISIONS A28): Documents › Resumes' batch download. With two or more resumes selected, the selection bar
// shows Download immediately left of Delete. A Free account sees a lock on it, and pressing it opens the locked-feature
// dialog (MSG_BATCH_DOWNLOAD_PAID with Subscribe) without asking the server; the server refuses Free anyway (403
// `paid_feature`, shown with the same limit dialog). A Paid account's press asks the server for a ZIP of the selection
// (POST …/resume-zip/documents), then follows the Tracker zip's own build: a waiting toast with "2 of 5 ready", then
// the file, saved under the server's name. Inside: "<shown name>/<First>_<Last>_resume.pdf" per resume.

/** POST: the selection's ZIP (the Tracker zip's poll and download routes follow). */
export const DOCUMENTS_ZIP_PATH = `${RESUME_ZIP_PATH}/documents`;
/** Download shows from this many selected resumes (one resume has its own Download PDF). */
export const BATCH_DOWNLOAD_MIN = 2;

export function showsBatchDownload(selected: number): boolean {
  return selected >= BATCH_DOWNLOAD_MIN;
}

/** The request: the selected resumes in display order, and this browser's offset east of UTC. */
export function documentsZipBody(ids: readonly string[], now: Date = new Date()): DocumentsZipBody {
  // getTimezoneOffset is west of UTC (300 in New York in winter); `|| 0` turns UTC's -0 into 0.
  return DocumentsZipBodySchema.parse({ resumeIds: [...ids], tzOffsetMinutes: -now.getTimezoneOffset() || 0 });
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The waiting toast's title. */
export function batchTitle(count: number): string {
  return `Downloading ${plural(count, 'resume', 'resumes')}...`;
}

/** The "Resumes ready" toast's text: what the zip holds, and what is not a PDF or not in it (SKIPPED.txt). */
export function batchOutcomeText(
  build: Pick<ResumeZipBuild, 'counts' | 'fileName'>,
  selected: ReadonlyArray<Pick<ResumeSummary, 'kind' | 'fileKind'>>,
): string {
  const { included, word, skipped } = build.counts;
  const parts = [`${plural(included, 'resume', 'resumes')} in ${build.fileName}.`];
  const uploadedWord = selected.filter((resume) => resume.kind === 'uploaded' && resume.fileKind === 'docx').length;
  if (uploadedWord > 0) {
    parts.push(`${plural(uploadedWord, 'uploaded Word file is', 'uploaded Word files are')} in as ${uploadedWord === 1 ? 'it is' : 'they are'}.`);
  }
  if (word > 0) parts.push(`${plural(word, 'resume is a Word file', 'resumes are Word files')}: PDFs could not be made.`);
  if (skipped > 0) parts.push(`${plural(skipped, 'resume is', 'resumes are')} not in it: see SKIPPED.txt.`);
  return parts.join(' ');
}

/** What a press of Download does: the locked dialog (Free), nothing (already building), a refusal (too many), or the build. */
export type BatchDownloadPress = { kind: 'locked' } | { kind: 'busy' } | { kind: 'too_many'; max: number } | { kind: 'start' };

export function batchDownloadPress(state: { locked: boolean; running: boolean; count: number; max: number }): BatchDownloadPress {
  // The plan first: a Free account is never asked to wait or to select fewer for a feature it cannot use.
  if (state.locked) return { kind: 'locked' };
  if (state.running) return { kind: 'busy' };
  if (state.count > state.max) return { kind: 'too_many', max: state.max };
  return { kind: 'start' };
}

// ----------------------------------------------------------------------------------------------- the running build

/** The batch download this tab waits for (outside the page: it keeps going when Documents is left). */
export const batchDownloadRun = createStore<ZipRunState>({ running: false, build: null });

function useBatchDownloadRun(): ZipRunState {
  return useSyncExternalStore(batchDownloadRun.subscribe, batchDownloadRun.get, batchDownloadRun.get);
}

/** The waiting toast's line, kept current as the build reports progress. */
function BatchProgressLine() {
  return <>{buildingProgress(useBatchDownloadRun().build)}</>;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A status read that may be tried again: the server did not answer, or answered with a 5xx while restarting. */
function isPassing(error: unknown): boolean {
  return error instanceof ApiError && (error.isUnreachable || error.status >= 500);
}

export interface BatchRun {
  ids: readonly string[];
  /** The server took the request (202): the build runs. A refusal (403, 400, 404, 409...) never gets here. */
  onAccepted?: () => void;
  onProgress?: (build: ResumeZipBuild) => void;
  signal?: AbortSignal;
  /** Tests: the wait between two status reads, and how the file is saved. */
  pollMs?: number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  save?: (url: string, fallbackName: string) => Promise<void>;
}

/**
 * Builds the selection's zip and saves it: POST, then the build's status every second until it is ready, then the file
 * (the Tracker zip's own routes). Resolves to the ready build. Throws the server's refusal as an ApiError (403
 * `paid_feature`, 400, 404, 409, 413, 429), the failed build's sentence, or the last error when the server stops answering.
 */
export async function runBatchDownload(run: BatchRun): Promise<ResumeZipBuild> {
  const { signal } = run;
  const wait = run.wait ?? delay;
  const pollMs = run.pollMs ?? ZIP_POLL_MS;
  const accepted = await api.post<ResumeZipAccepted>(DOCUMENTS_ZIP_PATH, documentsZipBody(run.ids), {
    schema: ResumeZipAcceptedSchema,
    signal,
  });
  run.onAccepted?.();
  const path = `${RESUME_ZIP_PATH}/${encodeURIComponent(accepted.buildId)}`;
  let failures = 0;
  for (;;) {
    signal?.throwIfAborted();
    let build: ResumeZipBuild;
    try {
      build = await api.get<ResumeZipBuild>(path, { schema: ResumeZipBuildSchema, signal });
      failures = 0;
    } catch (error) {
      failures += 1;
      if (!isPassing(error) || failures >= ZIP_POLL_FAILURES) throw error;
      await wait(pollMs, signal);
      continue;
    }
    run.onProgress?.(build);
    if (build.status === 'failed') throw failedBuildError(build);
    if (build.status === 'ready') {
      await (run.save ?? downloadFrom)(`${path}/file`, build.fileName);
      return build;
    }
    await wait(pollMs, signal);
  }
}

// ------------------------------------------------------------------------------------------------------ the button

export interface BatchDownloadViewProps {
  /** How many resumes are selected (the view shows from two). */
  count: number;
  /** A Free account: the lock icon, and the press opens the locked-feature dialog. */
  locked: boolean;
  running: boolean;
  lockOpen: boolean;
  onLockOpenChange: (open: boolean) => void;
  onPress: () => void;
  /** The locked button's hint (MSG_BATCH_DOWNLOAD_PAID; v2.0 fix REQ-3: the constant's words, not the web's). */
  lockedHint?: string;
}

/** The Download button (a lock on it for Free) and its locked-feature dialog. No state of its own. */
export function BatchDownloadView({ count, locked, running, lockOpen, onLockOpenChange, onPress, lockedHint }: BatchDownloadViewProps) {
  if (!showsBatchDownload(count)) return null;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        icon={locked ? <LockSimpleIcon size={14} data-lock-icon="" /> : <DownloadSimpleIcon size={14} />}
        loading={running}
        onClick={onPress}
        title={locked ? (lockedHint ?? LIMIT_TITLES.paid_feature) : `Download the ${count} selected resumes as a ZIP`}
        data-batch-download=""
        data-locked={locked ? '' : undefined}
      >
        Download
        {/* v2.0 fix (UX-15): announced as locked before it is pressed. */}
        {locked && <span className="sr-only"> ({LIMIT_COPY.paidOnly})</span>}
      </Button>
      <LockedFeatureDialog feature="batch_download" open={lockOpen} onOpenChange={onLockOpenChange} />
    </>
  );
}

/** Documents › Resumes' Download for the selected resumes (in display order): the selection bar's bulk action. */
export function BatchDownloadButton({ resumes }: { resumes: readonly ResumeSummary[] }) {
  const account = useAccount().data;
  const { get, t } = usePublicConstants();
  const limits = useLimitDialog();
  const toast = useToast();
  const running = useBatchDownloadRun().running;
  const [lockOpen, setLockOpen] = useState(false);
  const locked = isFeatureLocked(account, 'batch_download');

  const start = async (selected: readonly ResumeSummary[]) => {
    batchDownloadRun.set({ running: true, build: null });
    // The waiting toast once the server took the request: a refusal shows alone (the limit dialog, or an error toast).
    let waiting: string | null = null;
    const done = () => {
      if (waiting !== null) toast.dismiss(waiting);
    };
    try {
      const ready = await runBatchDownload({
        ids: selected.map((resume) => resume.id),
        onAccepted: () => {
          waiting = toast.toast({ type: 'info', title: batchTitle(selected.length), description: <BatchProgressLine />, timeout: 0 });
        },
        onProgress: (build) => batchDownloadRun.set({ running: true, build }),
      });
      done();
      toast.toast({ type: 'success', title: 'Resumes ready', description: batchOutcomeText(ready, selected), timeout: 10_000 });
    } catch (error) {
      done();
      // A 403 `paid_feature` (or another limit) shows in the limit dialog; anything else is a toast.
      if (!limits.show(error)) toast.error("We couldn't download your resumes", userMessage(error, 'Please try again.'));
    } finally {
      batchDownloadRun.set({ running: false, build: batchDownloadRun.get().build });
    }
  };

  const onPress = () => {
    const press = batchDownloadPress({
      locked,
      running: batchDownloadRun.get().running,
      count: resumes.length,
      max: get('BATCH_DOWNLOAD_MAX_RESUMES'),
    });
    if (press.kind === 'locked') setLockOpen(true);
    else if (press.kind === 'too_many') {
      // v2.0 fix (REQ-3): the A28 cap's words are MSG_BATCH_DOWNLOAD_MAX's (the server says the same).
      toast.error(t('MSG_BATCH_DOWNLOAD_MAX', { max: press.max }));
    } else if (press.kind === 'start') void start([...resumes]);
  };

  return (
    <>
      <BatchDownloadView
        count={resumes.length}
        locked={locked}
        running={running}
        lockOpen={lockOpen}
        onLockOpenChange={setLockOpen}
        onPress={onPress}
        lockedHint={t('MSG_BATCH_DOWNLOAD_PAID')}
      />
      {limits.dialog}
    </>
  );
}
