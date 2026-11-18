'use client';

import type { JobsQuery } from '@tailorit/shared/jobs';
import { useMutation } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { LimitNotice, paidFeatureLimit, type LimitInfo } from '@/components/limits';
import { Button } from '@/components/ui/Button';
import { LockSimpleIcon, SparkleIcon, XIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { SearchPill } from '@/components/ui/SearchPill';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { isFeatureLocked, useAccount } from '@/lib/account';
import { isLimitError, userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { useAiTask } from '@/lib/useAiTask';
import {
  AI_SEARCH_COPY,
  aiSearchSummary,
  filtersKey,
  queryFromAiResult,
  readAiSearchResult,
  startAiSearch,
  type SearchMode,
} from './aiSearchModel';

// v2.0 (A16): the Jobs search's AI mode (docs/design/v2.0/08-ui.md, "Jobs: the AI search mode"). The toolbar holds
// the state through useAiSearch: Classic or AI, the sentence, its task, the limit message (a Free account picking AI,
// or a refusal), and the summary of the filters the AI set.

interface Applied {
  /** The filters the AI set, to tell whether the address still holds them. */
  key: string;
  parts: string[];
  explanation: string;
}

export function useAiSearch({ query, onReplace }: { query: JobsQuery; onReplace: (query: JobsQuery) => void }) {
  const { data: account } = useAccount();
  const { t, get } = usePublicConstants();
  const toast = useToast();
  const [mode, setModeState] = useState<SearchMode>('classic');
  const [text, setText] = useState('');
  const [limit, setLimit] = useState<LimitInfo | Error | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const task = useAiTask(taskId, { kind: 'job_search' });
  const locked = isFeatureLocked(account, 'ai_job_search');
  const maxChars = get('AI_SEARCH_TEXT_MAX_CHARS');

  const start = useMutation({
    mutationFn: (sentence: string) => startAiSearch(sentence),
    onSuccess: (accepted) => setTaskId(accepted.taskId),
    onError: (error) => {
      if (isLimitError(error)) setLimit(error);
      else toast.error(AI_SEARCH_COPY.failed, userMessage(error));
    },
  });

  // The task's answer is read once (state adjusted while rendering, not in an effect); its filters then go into the
  // address from an effect, as a navigation must.
  const [handledTask, setHandledTask] = useState<string | null>(null);
  const [toApply, setToApply] = useState<{ taskId: string; query: JobsQuery } | null>(null);
  if (taskId && handledTask !== taskId && (task.isSucceeded || task.isFailed)) {
    setHandledTask(taskId);
    const result = task.isSucceeded ? readAiSearchResult(task.task?.result) : null;
    if (result) {
      const next = queryFromAiResult(query, result);
      setApplied({ key: filtersKey(next), parts: aiSearchSummary(next), explanation: result.explanation });
      setToApply({ taskId, query: next });
    } else {
      setFailure(task.isSucceeded ? 'The AI answered something TailorIT could not read. Try other words.' : task.errorMessage);
    }
  }
  const replaced = useRef<string | null>(null);
  useEffect(() => {
    if (!toApply || replaced.current === toApply.taskId) return;
    replaced.current = toApply.taskId;
    onReplace(toApply.query);
  }, [toApply, onReplace]);

  const setMode = (next: SearchMode) => {
    if (next === 'ai' && locked) {
      // A Free account: the Paid-only message, and the mode stays Classic. No request is made.
      setLimit(paidFeatureLimit(t, 'ai_job_search'));
      return;
    }
    setLimit(null);
    setModeState(next);
  };

  const submit = () => {
    const sentence = text.trim();
    if (!sentence || sentence.length > maxChars || start.isPending || task.isRunning) return;
    setLimit(null);
    setFailure(null);
    start.mutate(sentence);
  };

  return {
    mode,
    setMode,
    text,
    setText,
    submit,
    running: start.isPending || task.isRunning,
    progress: task.message ?? AI_SEARCH_COPY.reading,
    locked,
    maxChars,
    limit,
    clearLimit: () => setLimit(null),
    failure,
    // The summary shows while the address still holds the AI's filters.
    applied: applied && applied.key === filtersKey(query) ? applied : null,
    dismissApplied: () => setApplied(null),
  };
}

export type AiSearchState = ReturnType<typeof useAiSearch>;

/** Keywords | Ask AI (v31 FIX-JOBS: the constants' words), before the search box; a Free account sees "Paid" on Ask AI. */
export function SearchModeControl({ state }: { state: AiSearchState }) {
  const { t } = usePublicConstants();
  return (
    <SegmentedControl<SearchMode>
      size="sm"
      aria-label={AI_SEARCH_COPY.modeLabel}
      value={state.mode}
      onValueChange={state.setMode}
      items={[
        { value: 'classic', label: t('LABEL_JOBS_MODE_KEYWORDS') },
        {
          value: 'ai',
          icon: <SparkleIcon size={14} weight={state.mode === 'ai' ? 'fill' : 'regular'} />,
          label: (
            <>
              {t('LABEL_JOBS_MODE_AI')}
              {/* v31 JOBSWEB: a Free account's mark, a small lock on the tape (its word read out), to keep the row short. */}
              {state.locked && (
                <span
                  className="ml-0.5 inline-flex size-[18px] items-center justify-center rounded-tag bg-tape text-foreground"
                  title={AI_SEARCH_COPY.paid}
                  data-paid-badge=""
                >
                  <LockSimpleIcon size={11} weight="bold" aria-hidden="true" />
                  <span className="sr-only">{AI_SEARCH_COPY.paid}</span>
                </span>
              )}
            </>
          ),
        },
      ]}
    />
  );
}

/** The AI mode's box: Enter sends the sentence; a spinner while the AI reads it. */
export function AiSearchInput({ state, className }: { state: AiSearchState; className?: string }) {
  const tooLong = state.text.trim().length > state.maxChars;
  return (
    <div className={clsx('relative min-w-0', className)} data-ai-search="">
      <SearchPill
        value={state.text}
        onValueChange={state.setText}
        placeholder={AI_SEARCH_COPY.placeholder}
        label={AI_SEARCH_COPY.label}
        maxLength={state.maxChars}
        clearable={!state.running}
        aria-busy={state.running}
        aria-invalid={tooLong || undefined}
        readOnly={state.running}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          state.submit();
        }}
      />
      {state.running && <Spinner size={16} className="pointer-events-none absolute top-2.5 right-3" />}
    </div>
  );
}

/** Under the toolbar: the limit message, the AI reading the sentence, a failure, or the summary of what it set. */
export function AiSearchStatus({ state, onEditFilters }: { state: AiSearchState; onEditFilters: () => void }) {
  if (state.limit) return <LimitNotice limit={state.limit} />;
  if (state.mode !== 'ai') return null;
  if (state.running) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm leading-5 text-muted-foreground" data-ai-search-status="running">
        <Spinner size={14} />
        {state.progress}
      </p>
    );
  }
  if (state.failure) {
    return (
      <Notice tone="error" title={AI_SEARCH_COPY.failed}>
        {state.failure}
      </Notice>
    );
  }
  if (!state.applied) return null;
  return <AiSearchSummaryRow parts={state.applied.parts} explanation={state.applied.explanation} onEdit={onEditFilters} onDismiss={state.dismissApplied} />;
}

/** "AI search: remote · Senior · React · $150k+", Edit filters, and ✕ (drawn statically by the tests). */
export function AiSearchSummaryRow({
  parts,
  explanation,
  onEdit,
  onDismiss,
}: {
  parts: readonly string[];
  explanation: string;
  onEdit: () => void;
  onDismiss: () => void;
}) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-ai-search-summary="">
      <span className="inline-flex min-w-0 items-center gap-1.5 rounded-control border border-primary-200 bg-primary-soft py-1 pr-1 pl-2.5 text-sm leading-5 text-primary-ink">
        <SparkleIcon size={14} weight="fill" aria-hidden="true" />
        <span className="font-semibold">{AI_SEARCH_COPY.summary}</span>
        <span className="min-w-0 truncate">{parts.length > 0 ? parts.join(' · ') : AI_SEARCH_COPY.noFilters}</span>
        <button
          type="button"
          aria-label={AI_SEARCH_COPY.dismiss}
          onClick={onDismiss}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-tag hover:bg-hover"
        >
          <XIcon size={12} weight="bold" />
        </button>
      </span>
      <Button variant="link" size="sm" onClick={onEdit}>
        {AI_SEARCH_COPY.editFilters}
      </Button>
      {explanation && <span className="basis-full text-[13px] leading-5 text-muted-foreground">{explanation}</span>}
    </div>
  );
}
