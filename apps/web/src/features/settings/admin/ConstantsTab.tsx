'use client';

import type { AdminConstantList } from '@tailorit/shared/constants';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Chip } from '@/components/ui/Chip';
import { Combobox } from '@/components/ui/Combobox';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { LockSimpleIcon, MagnifyingGlassIcon } from '@/components/ui/icons';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { ApiError, userMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { PUBLIC_CONSTANTS_QUERY_KEY, usePublicConstants } from '@/lib/constants';
import { formatDate } from '@/lib/format';
import { timeZoneChoices } from '../location';
import { adminKeys, clearAdminConstant, fetchAdminConstants, setAdminConstant } from './api';
import {
  DURATION_CHOICES,
  GROUP_TITLE,
  HALF_HOURS,
  draftOf,
  durationChoiceOf,
  durationWords,
  groupRows,
  hasOverride,
  insertPlaceholder,
  matchesSearch,
  changedByText,
  messagePreview,
  previewParams,
  resetTarget,
  sourceBadge,
  valueOfDraft,
  type ConstantDraft,
  type ConstantRow,
} from './constants';
import { AdminResourceTab } from '@/components/admin';

// v2.0: Admin › Constants (docs/design/v2.0/08-ui.md, "Constants"): every business number and user-facing message,
// grouped, each with its value, where it comes from (an admin override, .env, or the default) and a typed editor. An
// override applies at once (the API reads it again on its next use; the web reads the public ones again here). Reset
// removes the override. Rows .env alone may set show a lock.

export function ConstantsTab() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const constants = useQuery({ queryKey: adminKeys.constants, queryFn: ({ signal }) => fetchAdminConstants(signal) });
  const { account } = useAuth();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ConstantRow | null>(null);
  const [resetting, setResetting] = useState<ConstantRow | null>(null);

  const groups = useMemo(
    () => groupRows((constants.data?.items ?? []).filter((row) => matchesSearch(row, search))),
    [constants.data, search],
  );

  /** A changed row goes into the list, and the web's public constants are read again (no restart, no wait). */
  const applied = (row: ConstantRow) => {
    queryClient.setQueryData<AdminConstantList>(adminKeys.constants, (current) =>
      current ? { ...current, items: current.items.map((item) => (item.key === row.key ? row : item)) } : current,
    );
    void queryClient.invalidateQueries({ queryKey: adminKeys.constants });
    void queryClient.invalidateQueries({ queryKey: PUBLIC_CONSTANTS_QUERY_KEY });
  };

  return (
    <AdminResourceTab
      title="Constants"
      description="Every limit, price, time and message TailorIT uses. A value comes from your override first, then .env, then the default. An override applies at once, with no restart."
      lead={
        <div className="mb-6 max-w-md">
          <Input
            type="search"
            aria-label="Search constants"
            placeholder="Search by name, key or value"
            leading={<MagnifyingGlassIcon size={16} />}
            className="pl-9"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      }
      items={constants.data ? groups : undefined}
      error={constants.error}
      errorTitle="The constants could not be loaded"
      errorAction={
        <Button variant="outline" size="sm" onClick={() => void constants.refetch()}>
          Try again
        </Button>
      }
      empty={{ title: 'No constant matches', description: 'Try another word, or clear the search.', card: false }}
      skeletonRows={8}
      renderItems={(shown) => (
        <div className="flex flex-col gap-8">
          {shown.map(({ group, rows }) => (
            <section key={group} aria-labelledby={`constants-${group}`}>
              <h3 id={`constants-${group}`} className="mb-2 text-base leading-6 font-semibold text-foreground">
                {GROUP_TITLE[group]}
              </h3>
              <ul className="divide-y divide-border overflow-hidden rounded-surface border border-border bg-surface shadow-soft">
                {rows.map((row) => (
                  <ConstantRowView
                    key={row.key}
                    row={row}
                    me={account}
                    onEdit={() => setEditing(row)}
                    onReset={() => setResetting(row)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    >
      {editing && (
        <ConstantEditDialog
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={(row) => {
            applied(row);
            setEditing(null);
            toast.success(`${row.label} saved`, `Now ${row.display}.`);
          }}
        />
      )}
      <ConfirmDialog
        open={resetting !== null}
        onOpenChange={(open) => !open && setResetting(null)}
        title="Remove the override?"
        description={resetting ? `${resetting.label} goes back to ${resetTarget(resetting)}.` : undefined}
        confirmLabel="Remove override"
        busyLabel="Removing..."
        tone="primary"
        onConfirm={async () => {
          if (!resetting) return;
          const row = await clearAdminConstant(resetting.key);
          applied(row);
          toast.success(`${row.label} reset`, `Now ${row.display}.`);
        }}
      />
    </AdminResourceTab>
  );
}

/** One constant: its label, key and help; its value and source; Edit and Reset (or the lock of a .env-only one). */
export function ConstantRowView({
  row,
  onEdit,
  onReset,
  me = null,
}: {
  row: ConstantRow;
  onEdit: () => void;
  onReset: () => void;
  /** The signed-in admin (their own changes read as their email). */
  me?: { id: string; email: string } | null;
}) {
  const badge = sourceBadge(row);
  const changedBy = changedByText(row.updatedBy, me);
  const message = row.kind === 'message';
  return (
    <li data-constant={row.key} className="flex flex-col gap-3 px-4 py-3.5 md:flex-row md:items-start md:gap-6">
      <div className="min-w-0 md:w-[38%] md:shrink-0">
        <p className="text-sm leading-5 font-semibold text-foreground">{row.label}</p>
        <p className="mt-0.5 font-mono text-xs leading-4 break-all text-muted-foreground">{row.key}</p>
        <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{row.help}</p>
      </div>
      <div className="min-w-0 flex-1">
        <p
          className={clsx(
            'text-sm leading-5 text-foreground',
            message ? 'line-clamp-3 whitespace-pre-line' : 'font-semibold tabular-nums',
          )}
          title={message ? row.display : undefined}
        >
          {row.display}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Badge tone={badge.tone} data-source={row.invalidOverride ? 'invalid' : row.source}>
            {badge.label}
          </Badge>
          {row.source === 'db' && row.updatedAt && (
            <span className="text-xs leading-4 text-muted-foreground">
              {changedBy ? `${changedBy}, ` : ''}
              {formatDate(row.updatedAt)}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 md:justify-end">
        {row.adminEditable ? (
          <>
            {hasOverride(row) && (
              <Button variant="ghost" size="sm" onClick={onReset} aria-label={`Reset ${row.label}`}>
                Reset
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onEdit} aria-label={`Edit ${row.label}`}>
              Edit
            </Button>
          </>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[13px] leading-5 text-muted-foreground">
            <LockSimpleIcon size={14} aria-hidden="true" />
            Set in .env
          </span>
        )}
      </div>
    </li>
  );
}

function ConstantEditDialog({
  row,
  onClose,
  onSaved,
}: {
  row: ConstantRow;
  onClose: () => void;
  onSaved: (row: ConstantRow) => void;
}) {
  const [draft, setDraft] = useState<ConstantDraft>(() => draftOf(row));
  const [serverError, setServerError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const result = valueOfDraft(row, draft);
  const save = useMutation({
    mutationFn: (value: unknown) => setAdminConstant(row.key, value),
    onSuccess: onSaved,
    onError: (error) => setServerError(error instanceof ApiError ? (error.fields?.value ?? error.message) : userMessage(error)),
  });
  const change = (next: Partial<ConstantDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setTouched(true);
    setServerError(null);
  };
  const error = serverError ?? (touched && !result.ok ? result.error : null);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={`Edit ${row.label}`}
        description={
          <>
            <span className="font-mono text-xs">{row.key}</span> · now {row.display} ({sourceBadge(row).label.toLowerCase()})
          </>
        }
        size={row.kind === 'message' || row.kind === 'prices' ? 'xl' : 'md'}
      >
        <form
          className="mt-5 flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);
            if (result.ok) save.mutate(result.value);
          }}
        >
          <ConstantEditor row={row} draft={draft} error={error} onChange={change} />
          <p className="text-[13px] leading-5 text-muted-foreground">{row.help}</p>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button type="submit" loading={save.isPending} disabled={touched && !result.ok}>
              {save.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The typed editor of each kind. */
function ConstantEditor({
  row,
  draft,
  error,
  onChange,
}: {
  row: ConstantRow;
  draft: ConstantDraft;
  error: string | null;
  onChange: (next: Partial<ConstantDraft>) => void;
}) {
  const label = 'Value';
  const unlimited =
    row.kind === 'limit' || row.kind === 'usd_limit' ? (
      <Checkbox
        checked={draft.unlimited}
        onCheckedChange={(checked) => onChange({ unlimited: checked })}
        label="Unlimited"
      />
    ) : null;
  switch (row.kind) {
    case 'int':
    case 'limit':
      return (
        <div className="flex flex-col gap-2.5">
          <Field label={label} error={error ?? undefined} hint={rangeHint(row)}>
            <Input
              inputMode="numeric"
              value={draft.unlimited ? '' : draft.text}
              disabled={draft.unlimited}
              placeholder={draft.unlimited ? 'Unlimited' : undefined}
              onChange={(event) => onChange({ text: event.target.value })}
              className="max-w-48"
            />
          </Field>
          {unlimited}
        </div>
      );
    case 'usd':
    case 'usd_limit':
      return (
        <div className="flex flex-col gap-2.5">
          <Field label={`${label} (USD)`} error={error ?? undefined} hint="Up to 6 decimal places, such as 0.10.">
            <Input
              inputMode="decimal"
              value={draft.unlimited ? '' : draft.text}
              disabled={draft.unlimited}
              placeholder={draft.unlimited ? 'Unlimited' : '0.10'}
              leading={<span aria-hidden="true">$</span>}
              className="max-w-48 pl-7"
              onChange={(event) => onChange({ text: event.target.value })}
            />
          </Field>
          {unlimited}
        </div>
      );
    case 'ratio':
      return (
        <Field label={label} error={error ?? undefined} hint="A share above 0 and at most 1: 0.98 is 98%.">
          <Input inputMode="decimal" value={draft.text} className="max-w-48" onChange={(event) => onChange({ text: event.target.value })} />
        </Field>
      );
    case 'bool':
      return (
        <Field label={label} error={error ?? undefined}>
          <Switch
            checked={draft.text === 'true'}
            label={draft.text === 'true' ? 'On' : 'Off'}
            onCheckedChange={(on) => onChange({ text: on ? 'true' : 'false' })}
          />
        </Field>
      );
    case 'time_of_day':
      return (
        <Field label={label} error={error ?? undefined}>
          <Select
            options={HALF_HOURS.some((hour) => hour.value === draft.text) ? HALF_HOURS : [...HALF_HOURS, { value: draft.text, label: draft.text }]}
            value={draft.text}
            onValueChange={(text) => onChange({ text })}
            className="max-w-48"
          />
        </Field>
      );
    case 'time_zone':
      return (
        <Field label={label} error={error ?? undefined}>
          <Combobox options={timeZoneChoices(draft.text || null)} value={draft.text || null} onValueChange={(text) => onChange({ text: text ?? '' })} />
        </Field>
      );
    case 'duration': {
      const choice = durationChoiceOf(draft.text);
      return (
        <div className="flex flex-col gap-2.5">
          <Field label={label} error={choice === 'custom' ? undefined : (error ?? undefined)}>
            <Select
              options={DURATION_CHOICES}
              value={choice}
              onValueChange={(next) => onChange({ text: next === 'custom' ? draft.text : next })}
              className="max-w-48"
            />
          </Field>
          {choice === 'custom' && (
            <Field
              label="Custom length"
              error={error ?? undefined}
              hint={`An ISO length of one unit: P30D (30 days), P2M (2 months), P1Y (1 year).${draft.text ? ` Now: ${durationWords(draft.text)}.` : ''}`}
            >
              <Input value={draft.text} className="max-w-48 font-mono" onChange={(event) => onChange({ text: event.target.value.toUpperCase() })} />
            </Field>
          )}
        </div>
      );
    }
    case 'date':
      return (
        <Field label={label} error={error ?? undefined}>
          <Input type="date" value={draft.text} className="max-w-48" onChange={(event) => onChange({ text: event.target.value })} />
        </Field>
      );
    case 'email':
      return (
        <Field label={label} error={error ?? undefined} hint="Leave it empty for none.">
          <Input type="email" value={draft.text} onChange={(event) => onChange({ text: event.target.value })} />
        </Field>
      );
    case 'text':
      return row.choices ? (
        <Field label={label} error={error ?? undefined}>
          <Select
            options={row.choices.map((value) => ({ value, label: value }))}
            value={draft.text}
            onValueChange={(text) => onChange({ text })}
            className="max-w-48"
          />
        </Field>
      ) : (
        <Field label={label} error={error ?? undefined} hint={row.maxLength ? `At most ${row.maxLength} characters.` : undefined}>
          <Input value={draft.text} maxLength={row.maxLength} onChange={(event) => onChange({ text: event.target.value })} />
        </Field>
      );
    case 'message':
      return <MessageEditor row={row} draft={draft} error={error} onChange={onChange} />;
    case 'prices':
      return (
        <Field label={label} error={error ?? undefined} hint='USD per million tokens by model: {"<model>": {"input", "output", "cacheRead", "cacheWrite"}, "*": {...}}.'>
          <Textarea rows={12} value={draft.text} className="font-mono text-xs" onChange={(event) => onChange({ text: event.target.value })} />
        </Field>
      );
  }
}

function rangeHint(row: ConstantRow): string | undefined {
  if (row.min !== undefined && row.max !== undefined) return `A whole number from ${row.min} to ${row.max}.`;
  if (row.min !== undefined) return `A whole number of ${row.min} or more.`;
  return undefined;
}

/** A message: the words, its placeholders as chips that insert themselves at the cursor, and a live preview. */
function MessageEditor({
  row,
  draft,
  error,
  onChange,
}: {
  row: ConstantRow;
  draft: ConstantDraft;
  error: string | null;
  onChange: (next: Partial<ConstantDraft>) => void;
}) {
  const box = useRef<HTMLTextAreaElement | null>(null);
  const max = row.maxLength;
  const { values } = usePublicConstants();
  const sample = previewParams({ time: values.DAY_RESET_TIME, zoneLabel: values.DAY_RESET_ZONE_LABEL });
  return (
    <div className="flex flex-col gap-3">
      <Field
        label="Message"
        error={error ?? undefined}
        hint={max ? `${draft.text.length} / ${max} characters` : undefined}
      >
        <Textarea ref={box} rows={4} value={draft.text} onChange={(event) => onChange({ text: event.target.value })} />
      </Field>
      {row.placeholders.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Insert a placeholder">
          <span className="text-[13px] leading-5 text-muted-foreground">Insert:</span>
          {row.placeholders.map((name) => (
            <Chip
              key={name}
              size="sm"
              onClick={() => {
                const element = box.current;
                const selection = element ? { start: element.selectionStart, end: element.selectionEnd } : null;
                const next = insertPlaceholder(draft.text, name, selection);
                onChange({ text: next.text });
                requestAnimationFrame(() => {
                  element?.focus();
                  element?.setSelectionRange(next.cursor, next.cursor);
                });
              }}
            >
              {`{${name}}`}
            </Chip>
          ))}
        </div>
      )}
      <div>
        <p className="text-[13px] leading-5 font-medium text-foreground">Preview</p>
        <p
          className="mt-1 rounded-control bg-surface-low px-3 py-2.5 text-sm leading-5 whitespace-pre-line text-foreground"
          data-message-preview=""
        >
          {messagePreview(draft.text, sample) || ' '}
        </p>
      </div>
    </div>
  );
}
