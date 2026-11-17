'use client';

import { readBullets, type BulletsRequest, type BulletsTask } from '@tailorit/shared/resume';
import { useEffect, useRef, useState } from 'react';
import { api, userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { useAiTask } from '@/lib/useAiTask';
import { requestBullets } from '../api';

// Write with AI's run, shared by the form editor's bullets box and the on-page editor's popover: the request (202
// { taskId }), the polling, the answer handed over once when it arrives, and a run still going cancelled when the
// component that asked goes away, so an answer never lands where nobody is looking. `meta` travels with the run (what
// the form editor's Undo puts back, the entry the page's answer is for).

export interface BulletsAiRun<M> {
  /** Null while the request itself is on its way. */
  taskId: string | null;
  task: BulletsTask;
  meta: M;
  /** The request failed: the task never started. */
  error: string | null;
}

export interface BulletsAi<M> {
  run: BulletsAiRun<M> | null;
  /** The finished run's bullets; null until it succeeds. */
  answer: string[] | null;
  running: boolean;
  /** Why the last run gave nothing; null otherwise. */
  failure: string | null;
  /** The staged progress line while it runs. */
  progress: string | null;
  ask(request: BulletsRequest, meta: M): Promise<void>;
  /** Forgets the run (and cancels it when it is still going). */
  dismiss(): void;
}

const cancelTask = (taskId: string) =>
  void api.delete(`/api/ai/tasks/${encodeURIComponent(taskId)}`).catch(() => undefined);

export function useBulletsAi<M>(onAnswer: (bullets: string[], meta: M) => void): BulletsAi<M> {
  const [run, setRun] = useState<BulletsAiRun<M> | null>(null);
  const { t } = usePublicConstants();
  const ai = useAiTask(run?.taskId ?? null, { kind: 'entry_bullets' });
  const answer = run?.taskId && ai.isSucceeded ? readBullets(ai.task?.result) : null;
  const running = run !== null && run.error === null && (run.taskId === null || ai.isRunning);
  const failure =
    run?.error ??
    (run?.taskId && ai.isFailed ? (ai.errorMessage ?? t('MSG_WRITE_WITH_AI_FAILED')) : null) ??
    (answer && answer.length === 0 ? 'The answer held no bullets. Please try again.' : null);

  // The answer is handed over once, when it arrives.
  const handler = useRef(onAnswer);
  const applied = useRef<string | null>(null);
  useEffect(() => {
    handler.current = onAnswer;
  });
  useEffect(() => {
    if (!run?.taskId || !answer || answer.length === 0 || applied.current === run.taskId) return;
    applied.current = run.taskId;
    handler.current(answer, run.meta);
  }, [run, answer]);

  // A run still going when the component goes is cancelled.
  const live = useRef<{ taskId: string | null; running: boolean }>({ taskId: null, running: false });
  useEffect(() => {
    live.current = { taskId: run?.taskId ?? null, running };
  });
  useEffect(
    () => () => {
      const { taskId, running: stillRunning } = live.current;
      if (taskId && stillRunning) cancelTask(taskId);
    },
    [],
  );

  return {
    run,
    answer,
    running,
    failure,
    progress: running ? ai.message : null,
    async ask(request, meta) {
      if (running) return;
      const ticket: BulletsAiRun<M> = { taskId: null, task: request.task, meta, error: null };
      setRun(ticket);
      try {
        const taskId = await requestBullets(request);
        setRun((current) => (current === ticket ? { ...ticket, taskId } : current));
      } catch (caught) {
        const error = userMessage(caught, 'Write with AI could not start. Please try again.');
        setRun((current) => (current === ticket ? { ...ticket, error } : current));
      }
    },
    dismiss() {
      if (run?.taskId && running) cancelTask(run.taskId);
      setRun(null);
    },
  };
}
