'use client';

import type { AdminCompanyField } from '@tailorit/shared/companies';
import { useState, type FormEvent } from 'react';
import { focusSoon } from '@/lib/focusLater';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { LockSimpleIcon, PencilSimpleIcon, WarningCircleIcon } from '@/components/ui/icons';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { userMessage } from '@/lib/api';
import type { TooLongText } from '@/lib/constants';
import { LockSimpleOpenIcon } from '@/features/companies/icons';
import { draftChanged, draftOf, FIELD_SPECS, formatFieldValue, parseFieldDraft, sourceKindLabel, type FieldSpec } from './fields';

// v30 E0-WEB: one field of the company editor (13-company-enrichment.md §6.4): its value in use, where it came from and
// how sure, whether people see it, locked or not, a conflict between sources, and the other candidates. Saving a value
// locks it (no automated source changes it); Unlock hands it back to its sources.

/** "From Wikidata · 80% sure", "Set by an admin", "No source". */
export function fieldSourceLine(entry: Pick<AdminCompanyField, 'sourceKind' | 'confidence' | 'locked'>): string {
  if (entry.sourceKind === 'admin') return 'Set by an admin';
  if (!entry.sourceKind) return 'No source';
  const sure = entry.confidence !== null ? ` · ${entry.confidence}% sure` : '';
  return `From ${sourceKindLabel(entry.sourceKind)}${sure}`;
}

const YES_NO = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

function DraftInput({ spec, draft, onChange, id }: { spec: FieldSpec; draft: string; onChange: (value: string) => void; id: string }) {
  switch (spec.kind) {
    case 'textarea':
    case 'links':
      return <Textarea id={id} value={draft} rows={spec.kind === 'links' ? 3 : 5} maxLength={spec.max} onChange={(event) => onChange(event.target.value)} />;
    case 'enum':
      return (
        <Select
          id={id}
          options={spec.options ?? []}
          value={draft || null}
          placeholder="None"
          onValueChange={onChange}
          className="w-full max-w-sm"
        />
      );
    case 'bool':
      return <Select id={id} options={YES_NO} value={draft || null} placeholder="Unknown" onValueChange={onChange} className="w-40" />;
    default:
      return (
        <Input
          id={id}
          value={draft}
          inputMode={spec.kind === 'int' ? 'numeric' : spec.kind === 'url' ? 'url' : undefined}
          maxLength={spec.max}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

export function FieldRow({
  entry,
  busy,
  tooLong,
  onSave,
  onLock,
}: {
  entry: AdminCompanyField;
  busy: boolean;
  tooLong: TooLongText;
  /** Sets the value (locked once saved); rejects with the server's words. */
  onSave: (value: unknown) => Promise<void>;
  onLock: (locked: boolean) => void;
}) {
  const spec = FIELD_SPECS[entry.field];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showCandidates, setShowCandidates] = useState(false);
  const inputId = `company-field-${entry.field}`;
  const shown = formatFieldValue(entry.field, entry.value);
  // v30 FIX-WEB (REV-UX UX-5): Save is off until the draft changes the value (a save locks the field).
  const changed = draftChanged(entry.field, entry.value, draft);
  // v30 FIX-WEB (REV-UX UX-4): where focus goes as the form opens and closes, so a keyboard keeps its place.
  const editButton = `[data-company-field="${entry.field}"] [data-field-edit]`;

  const begin = () => {
    setDraft(draftOf(entry.field, entry.value));
    setError(null);
    setEditing(true);
    focusSoon([`#${inputId}`]);
  };

  const stop = () => {
    setEditing(false);
    // After a save the page re-renders in a later task and Edit is disabled until the editor is no longer busy.
    focusSoon([editButton]);
  };

  const save = async (value: unknown) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(value);
      if (editing) stop();
    } catch (failure) {
      setError(userMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    const parsed = parseFieldDraft(entry.field, draft, tooLong);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    void save(parsed.value);
  };

  return (
    <li className="flex flex-col gap-2 py-3.5" data-company-field={entry.field}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-[13px] leading-5 font-medium text-muted-foreground">
            {spec.label}
            {entry.locked && (
              <Badge tone="neutral" icon={<LockSimpleIcon size={12} />}>
                Locked
              </Badge>
            )}
            {/* v30 FIX-WEB (REV-UX UX-14): the name is always shown (the company page's title, every card's company line). */}
            {!entry.shown && shown && entry.field !== 'displayName' && <Badge tone="warning">Not shown</Badge>}
            {entry.conflict && (
              <Badge tone="destructive" icon={<WarningCircleIcon size={12} />}>
                Sources disagree
              </Badge>
            )}
          </p>
          {!editing && (
            <p className={shown ? 'mt-0.5 text-sm leading-5 break-words whitespace-pre-line text-foreground' : 'mt-0.5 text-sm leading-5 text-muted-foreground'}>
              {shown || 'None'}
            </p>
          )}
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{fieldSourceLine(entry)}</p>
        </div>
        {!editing && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              icon={<PencilSimpleIcon size={14} />}
              disabled={busy}
              onClick={begin}
              aria-label={`Edit ${spec.label}`}
              data-field-edit=""
            >
              Edit
            </Button>
            {entry.locked ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<LockSimpleOpenIcon size={14} />}
                disabled={busy}
                onClick={() => onLock(false)}
                aria-label={`Unlock ${spec.label}`}
              >
                Unlock
              </Button>
            ) : (
              <Button size="sm" variant="ghost" icon={<LockSimpleIcon size={14} />} disabled={busy} onClick={() => onLock(true)} aria-label={`Lock ${spec.label}`}>
                Lock
              </Button>
            )}
          </div>
        )}
      </div>

      {editing && (
        <form onSubmit={submit} className="flex flex-col gap-3 rounded-card border border-border bg-surface-low p-3" aria-label={`Edit ${spec.label}`}>
          <Field label={spec.label} hint={spec.hint ?? 'Saving locks the field: no source changes it until it is unlocked.'} error={error ?? undefined} id={inputId}>
            <DraftInput spec={spec} draft={draft} onChange={setDraft} id={inputId} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={saving} disabled={busy || !changed} focusableWhenDisabled>
              Save and lock
            </Button>
            <Button size="sm" variant="outline" disabled={saving} onClick={stop}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {entry.candidates.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={showCandidates}
            onClick={() => setShowCandidates((open) => !open)}
            className="min-h-6 text-xs font-medium text-primary-ink hover:underline"
          >
            {showCandidates ? 'Hide the other values' : `Other values (${entry.candidates.length})`}
          </button>
          {showCandidates && (
            <ul className="mt-2 flex flex-col gap-2" aria-label={`Other values of ${spec.label}`}>
              {entry.candidates.map((candidate) => (
                <li
                  key={`${candidate.sourceId}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-border px-3 py-2"
                  data-company-candidate={candidate.sourceId}
                >
                  <span className="min-w-0 text-sm">
                    <span className="block break-words whitespace-pre-line text-foreground">{formatFieldValue(entry.field, candidate.value) || 'None'}</span>
                    <span className="block text-xs text-muted-foreground">
                      {sourceKindLabel(candidate.sourceKind)} · {candidate.confidence}% sure
                    </span>
                  </span>
                  <Button size="sm" variant="outline" disabled={busy || saving} onClick={() => void save(candidate.value)}>
                    Use this
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {!editing && error && <p className="mt-1 text-xs text-danger">{error}</p>}
        </div>
      )}
    </li>
  );
}
