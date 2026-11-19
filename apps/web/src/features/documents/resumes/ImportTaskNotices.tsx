'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { limitOfTaskError, useLimitDialog, type LimitInfo } from '@/components/limits';
import { Button, buttonClasses } from '@/components/ui/Button';
import { useAiTask } from '@/lib/useAiTask';
import { readImportResult, resumeEditorHref, resumeKeys } from '../../resume-editor/api';
import { StatusLine } from '../core/StatusLine';

export interface ImportTask {
  /** Unique per notice (the task id when there is one). */
  key: string;
  /** The AI import being made; null when it could not start (`error` says why). */
  taskId: string | null;
  /** The uploaded resume the copy is made from. */
  label: string;
  /** Why the editable copy could not start (the upload is kept either way). */
  error?: string | null;
}

/**
 * The editable copies being made (Upload with "Make an editable copy with AI" for one file, or "Make editable copy" on
 * an upload): each is polled until it finishes, then offers to open the new resume (or says why it could not be made,
 * or that it was cancelled). A copy that could not even start says so at once. The copies of several files are
 * followed by EditableCopiesNotices instead. v32 COPY (E4): each is one compact status line (a "?" holds the details).
 * v32 INT-2 (E4): a copy whose task ended on a limit (today's AI use spent, the resume limit) is the limit alert, its
 * line dismissed; the alert lives here, so it stays up when the last line goes.
 */
export function ImportTaskNotices({ tasks, onDismiss }: { tasks: readonly ImportTask[]; onDismiss: (key: string) => void }) {
  const limits = useLimitDialog();
  return (
    <>
      {limits.dialog}
      {tasks.length > 0 && (
        <div className="mb-5 flex flex-col gap-2">
          {tasks.map((task) =>
            task.taskId ? (
              <ImportTaskNotice
                key={task.key}
                taskId={task.taskId}
                label={task.label}
                onDismiss={() => onDismiss(task.key)}
                onLimit={limits.show}
              />
            ) : (
              <StatusLine
                key={task.key}
                tone="warning"
                title={`The editable copy of ${task.label} could not start`}
                details={<>{task.error || 'Try "Make editable copy" on the upload.'} Your upload is kept as it is.</>}
                actions={<DismissButton onClick={() => onDismiss(task.key)} />}
              />
            ),
          )}
        </div>
      )}
    </>
  );
}

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick}>
      Dismiss
    </Button>
  );
}

function ImportTaskNotice({
  taskId,
  label,
  onDismiss,
  onLimit,
}: {
  taskId: string;
  label: string;
  onDismiss: () => void;
  /** Shows a limit as the limit alert (v32 INT-2, E4). */
  onLimit: (limit: LimitInfo) => void;
}) {
  const queryClient = useQueryClient();
  const ai = useAiTask(taskId, { kind: 'resume_import' });
  const resumeId = ai.isSucceeded ? readImportResult(ai.task?.result) : null;
  // v32 INT-2 (E4): ended on a limit: the alert says it (once), and this line goes.
  const limit = ai.isFailed ? limitOfTaskError(ai.task?.error) : null;
  const limitShown = useRef(false);
  useEffect(() => {
    if (!limit || limitShown.current) return;
    limitShown.current = true;
    onLimit(limit);
    onDismiss();
  }, [limit, onLimit, onDismiss]);

  // The new resume joins the list once it exists.
  const refreshed = useRef(false);
  useEffect(() => {
    if (!resumeId || refreshed.current) return;
    refreshed.current = true;
    void queryClient.invalidateQueries({ queryKey: resumeKeys.all });
  }, [resumeId, queryClient]);

  const dismiss = <DismissButton onClick={onDismiss} />;

  if (resumeId) {
    return (
      <StatusLine
        tone="success"
        title="Your editable copy is ready"
        details={`The AI read ${label} into a resume you can edit.`}
        actions={
          <>
            <Link href={resumeEditorHref(resumeId)} className={buttonClasses({ size: 'sm' })}>
              Open the resume
            </Link>
            {dismiss}
          </>
        }
      />
    );
  }
  // Cancelled is finished too: it never turns into a copy.
  if (ai.status === 'cancelled') {
    return (
      <StatusLine
        tone="warning"
        title={`The editable copy of ${label} was cancelled`}
        details='Make it again with "Make editable copy" on the upload.'
        actions={dismiss}
      />
    );
  }
  if (limit) return null;
  if (ai.isFailed || (ai.isSucceeded && !resumeId)) {
    return (
      <StatusLine
        tone="error"
        title={`The editable copy of ${label} could not be made`}
        details={ai.errorMessage ?? 'Try "Make editable copy" on the upload again.'}
        actions={dismiss}
      />
    );
  }
  return (
    <StatusLine
      tone="busy"
      title={`Making an editable copy of ${label}`}
      details={`${ai.message ?? 'Reading your resume...'} This can take a minute.`}
    />
  );
}
