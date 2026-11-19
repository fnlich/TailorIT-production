'use client';

import {
  JOB_SOURCE_PURGE_REASON_LABEL,
  JOB_SOURCE_PURGE_REASONS,
  type AdminSourceRow,
  type JobSourcePurge,
} from '@tailorit/shared/sourcing';
import { useState } from 'react';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Field } from '@/components/ui/Field';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { Select } from '@/components/ui/Select';
import { startPurge } from './api';
import { EMPTY_PURGE_DRAFT, appliedTextsAllowed, purgeRequestOf, type PurgeDraft } from './purges';

// v30 S1-WEB: "Purge source" (11 §8.5, 12 §8.5): a licence ended, the terms changed, or an admin's call. The server
// queues the purge and works it in batches; Purges (the Sources tab's button) follows it.

const REASON_OPTIONS = JOB_SOURCE_PURGE_REASONS.map((value) => ({ value, label: JOB_SOURCE_PURGE_REASON_LABEL[value] }));

export function PurgeDialog({
  source,
  open,
  onOpenChange,
  onStarted,
}: {
  source: AdminSourceRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (purge: JobSourcePurge) => void;
}) {
  const [draft, setDraft] = useState<PurgeDraft>(EMPTY_PURGE_DRAFT);
  const set = (patch: Partial<PurgeDraft>) => setDraft((previous) => ({ ...previous, ...patch }));
  const appliedAllowed = appliedTextsAllowed(draft);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setDraft(EMPTY_PURGE_DRAFT);
        onOpenChange(next);
      }}
      title="Purge source"
      description={
        source
          ? `${source.name} pauses; the jobs only it lists close and their raw data is deleted. No undo.`
          : undefined
      }
      confirmLabel="Purge"
      busyLabel="Queuing..."
      onConfirm={async () => {
        if (!source) return;
        const made = purgeRequestOf(draft, source);
        if (!made.ok) throw new Error(made.error);
        onStarted(await startPurge(made.request));
        setDraft(EMPTY_PURGE_DRAFT);
      }}
    >
      {source && (
        <div className="flex flex-col gap-4">
          {source.companyId !== null && (
            <Field label="What to purge">
              <RadioGroup
                aria-label="What to purge"
                value={draft.scope}
                onValueChange={(scope) => set({ scope })}
                options={[
                  { value: 'source', label: 'This source only' },
                  { value: 'company', label: `Every source of ${source.companyName ?? 'its company'}` },
                ]}
              />
            </Field>
          )}
          <Field label="Reason">
            <Select
              aria-label="Reason"
              options={REASON_OPTIONS}
              value={draft.reason}
              onValueChange={(reason) => set({ reason, deleteAppliedTexts: reason === 'contract_end' ? draft.deleteAppliedTexts : false })}
            />
          </Field>
          <Checkbox
            checked={draft.deleteTexts}
            onCheckedChange={(on) => set({ deleteTexts: on, deleteAppliedTexts: on ? draft.deleteAppliedTexts : false })}
            label="Also delete the posting texts (applications keep theirs)"
          />
          <Checkbox
            checked={appliedAllowed && draft.deleteAppliedTexts}
            disabled={!appliedAllowed}
            onCheckedChange={(on) => set({ deleteAppliedTexts: on })}
            label="Delete applied jobs' texts too (only when a contract demands it)"
          />
        </div>
      )}
    </ConfirmDialog>
  );
}
