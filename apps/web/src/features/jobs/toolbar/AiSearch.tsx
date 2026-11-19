'use client';

import type { JobsQuery } from '@tailorit/shared/jobs';
import { useMutation } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { LimitDialog, LockedFeatureDialog, type LimitInfo } from '@/components/limits';
import { Button } from '@/components/ui/Button';
import { LockSimpleIcon, SparkleIcon, WarningCircleIcon, XIcon } from '@/components/ui/icons';
import { SearchPill } from '@/components/ui/SearchPill';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { isFeatureLocked, useAccount } from '@/lib/account';
import { isLimitError, userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { useAiTask } from '@/lib/useAiTask';
import { HelpTip } from '@/components/ui/HelpTip';
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
// the state through useAiSearch: Classic or AI, the sentence, its task, and the summary of the filters the AI set.
// v32 JOBS2 (E4): nothing of it is a banner any more. A Free account pressing Ask AI gets an alert (the reason in one
// sentence, Not now / Subscribe) and the mode stays Keywords; a refused request (the AI unavailable, the day's AI use
// spent) opens the kit's limit dialog; a sentence the AI could not use is a short error line by the search box.

interface Applied {
  /** The filters the AI set, to tell whether the address still holds them. */
  key: string;
  parts: string[];
  explanation: string;
}

export function useAiSearch({ query, onReplace }: { query: JobsQuery; onReplace: (query: JobsQuery) => void }) {
  const { data: account } = useAccount();
  const { get } = usePublicConstants();
  const toast = useToast();
  const [mode, setModeState] = useState<SearchMode>('classic');
  const [text, setText] = useState('');
  const [gateOpen, setGateOpen] = useState(false);
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
      setFailure(task.isSucceeded ? AI_SEARCH_COPY.unreadable : task.errorMessage);
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
      // A Free account: the Paid-only alert, and the mode stays Keywords. No request is made.
      setGateOpen(true);
      return;
    }
    setFailure(null);
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
    /** A Free account pressed Ask AI: the Paid-only alert is open. */
    gateOpen,
    closeGate: () => setGateOpen(false),
    /** A refused request (LIMIT_ERROR_CODES): the limit dialog is open. */
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
        aria-invalid={tooLong || state.failure !== null || undefined}
        aria-describedby={state.failure !== null ? AI_SEARCH_ERROR_ID : undefined}
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

/** The error line's id: the AI box points its description at it. */
const AI_SEARCH_ERROR_ID = 'ai-search-error';

/** The search mode's selected tab (Keywords while the alert is up): where focus goes back to when it closes. */
function selectedModeTab(): HTMLElement | boolean {
  return document.querySelector<HTMLElement>(`[role="tablist"][aria-label="${AI_SEARCH_COPY.modeLabel}"] [role="tab"][aria-selected="true"]`) ?? true;
}

/**
 * v32 JOBS2 (E4): the alert a Free account gets on pressing Ask AI: why in one sentence (MSG_PAID_AI_SEARCH), Not now,
 * and Subscribe. v32 INT-1: the kit's locked-feature alert (components/limits, one alert style app-wide): Subscribe
 * closes it and opens the Subscribe dialog. Focus starts on Not now and goes back to the selected mode, Keywords: the
 * mode tabs select on focus, so focus on Ask AI would ask again.
 */
export function PaidSearchAlert({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return <LockedFeatureDialog feature="ai_job_search" open={open} onOpenChange={onOpenChange} finalFocus={selectedModeTab} />;
}

/**
 * Under the toolbar: the AI reading the sentence, a sentence it could not use (an error line, next to the box), or the
 * summary of what it set; and the AI search's dialogs (the Paid-only alert, a refusal's limit dialog).
 */
export function AiSearchStatus({ state, onEditFilters }: { state: AiSearchState; onEditFilters: () => void }) {
  let line = null;
  if (state.mode === 'ai' && state.running) {
    line = (
      <p role="status" className="flex items-center gap-2 text-sm leading-5 text-muted-foreground" data-ai-search-status="running">
        <Spinner size={14} />
        {state.progress}
      </p>
    );
  } else if (state.mode === 'ai' && state.failure) {
    line = (
      <p id={AI_SEARCH_ERROR_ID} role="alert" className="flex items-start gap-1.5 text-sm leading-5 text-danger" data-ai-search-status="failed">
        <WarningCircleIcon size={16} weight="fill" className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          <span className="font-semibold">{AI_SEARCH_COPY.failed}.</span> {state.failure}
        </span>
      </p>
    );
  } else if (state.mode === 'ai' && state.applied) {
    line = (
      <AiSearchSummaryRow
        parts={state.applied.parts}
        explanation={state.applied.explanation}
        onEdit={onEditFilters}
        onDismiss={state.dismissApplied}
      />
    );
  }
  return (
    <>
      {line}
      <PaidSearchAlert open={state.gateOpen} onOpenChange={(open) => !open && state.closeGate()} />
      <LimitDialog limit={state.limit} open={state.limit !== null} onOpenChange={(open) => !open && state.clearLimit()} />
    </>
  );
}

/** "AI search: remote · Senior · React · $150k+", its "?" (how the AI read the sentence), Edit filters, and ✕. */
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
      {/* v32 JOBS2 (E5): how the AI read the sentence, behind the summary's "?". */}
      {explanation && <HelpTip label={AI_SEARCH_COPY.summaryTip}>{explanation}</HelpTip>}
      <Button variant="link" size="sm" onClick={onEdit}>
        {AI_SEARCH_COPY.editFilters}
      </Button>
    </div>
  );
}
