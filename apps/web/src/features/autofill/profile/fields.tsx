'use client';

import { FileTextIcon } from '@phosphor-icons/react/FileText';
import type { SensitiveAnswer } from '@tailorit/shared/autofill';
import { clsx } from 'clsx';
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Chip } from '@/components/ui/Chip';
import { Field } from '@/components/ui/Field';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/IconButton';
import { Input, Textarea, type InputProps } from '@/components/ui/Input';
import { RadioGroup, type RadioOption } from '@/components/ui/RadioGroup';
import { Select, type SelectOption } from '@/components/ui/Select';
import { usePublicConstants } from '@/lib/constants';
import { useNow } from '@/lib/useNow';
import { useProfileForm, type ProfileForm } from './form';

// The Profile tab's fields. Each one needs only its key (draft.ts): it reads its value, writes its changes, and shows
// its message and its "From your resume" mark through the form context.

/** What a filled field says until it is edited. */
export function FromResumeHint() {
  return (
    <span className="inline-flex items-center gap-1 text-primary-ink">
      <FileTextIcon size={14} />
      From your resume
    </span>
  );
}

/** The field's own hint, or the "From your resume" mark while it has one. */
export function hintOf(form: ProfileForm, path: string, hint: ReactNode): ReactNode {
  return form.isFromResume(path) ? <FromResumeHint /> : hint;
}

/** A message under a group of controls (a Field draws its own). */
export function GroupMessage({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} data-field-error="" className="text-[13px] leading-5 text-danger">
      {children}
    </p>
  );
}

/** Labelled controls that are not one input (dates, chips, an answer and its mode). */
export function FieldGroup({
  label,
  error,
  hint,
  required,
  children,
  className,
}: {
  label: ReactNode;
  error?: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={[error ? `${id}-error` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined}
      className={clsx('flex flex-col gap-1.5', className)}
    >
      <span id={`${id}-label`} className="text-sm leading-5 font-medium text-foreground">
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-danger">
            *
          </span>
        )}
      </span>
      {children}
      {error ? <GroupMessage id={`${id}-error`}>{error}</GroupMessage> : null}
      {hint ? (
        <p id={`${id}-hint`} className="text-[13px] leading-5 text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

type TextInputProps = Omit<InputProps, 'value' | 'onChange' | 'onValueChange' | 'className' | 'size'>;

export function TextField({
  path,
  label,
  required,
  hint,
  className,
  ...input
}: TextInputProps & {
  path: string;
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  className?: string;
}) {
  const form = useProfileForm();
  return (
    <Field label={label} required={required} error={form.error(path)} hint={hintOf(form, path, hint)} className={className}>
      <Input
        {...input}
        value={form.text(path)}
        disabled={form.busy || input.disabled}
        onChange={(event) => form.set(path, event.target.value)}
      />
    </Field>
  );
}

export function TextareaField({
  path,
  label,
  hint,
  maxLength,
  rows = 4,
  className,
}: {
  path: string;
  label: ReactNode;
  hint?: ReactNode;
  maxLength: number;
  rows?: number;
  className?: string;
}) {
  const form = useProfileForm();
  const value = form.text(path);
  return (
    <Field
      label={label}
      error={form.error(path)}
      hint={hintOf(form, path, hint ?? `${value.length.toLocaleString('en-US')} / ${maxLength.toLocaleString('en-US')}`)}
      className={className}
    >
      <Textarea
        value={value}
        rows={rows}
        maxLength={maxLength}
        disabled={form.busy}
        onChange={(event) => form.set(path, event.target.value)}
      />
    </Field>
  );
}

/** The Select value that stands for "nothing chosen". */
const NONE = '__none__';

export function SelectField<V extends string>({
  path,
  label,
  options,
  placeholder,
  emptyLabel,
  emptyValue = null,
  required,
  hint,
  disabled,
  className,
}: {
  path: string;
  label: ReactNode;
  options: readonly SelectOption<V>[];
  placeholder?: string;
  /** Adds a first option that clears the value (to `emptyValue`). */
  emptyLabel?: string;
  emptyValue?: null | '';
  required?: boolean;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const form = useProfileForm();
  const raw = form.read(path);
  const value = typeof raw === 'string' && raw !== '' ? raw : emptyLabel ? NONE : null;
  const choices: SelectOption<string>[] = emptyLabel ? [{ value: NONE, label: emptyLabel }, ...options] : [...options];
  return (
    <Field label={label} required={required} error={form.error(path)} hint={hintOf(form, path, hint)} className={className}>
      <Select
        options={choices}
        value={value}
        placeholder={placeholder}
        disabled={form.busy || disabled}
        onValueChange={(next) => form.set(path, next === NONE ? emptyValue : next)}
      />
    </Field>
  );
}

/** A number or nothing. `zeroIsEmpty`: 0 stands for "not typed yet" (an amount that must be above 0). */
export function NumberField({
  path,
  label,
  min,
  max,
  step = 1,
  zeroIsEmpty = false,
  placeholder,
  hint,
  disabled,
  className,
}: {
  path: string;
  label: ReactNode;
  min?: number;
  max?: number;
  step?: number | 'any';
  zeroIsEmpty?: boolean;
  placeholder?: string;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const form = useProfileForm();
  const raw = form.read(path);
  const value = typeof raw === 'number' && !(zeroIsEmpty && raw === 0) ? raw : '';
  return (
    <Field label={label} error={form.error(path)} hint={hintOf(form, path, hint)} className={className}>
      <Input
        type="number"
        inputMode={step === 1 ? 'numeric' : 'decimal'}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        value={value}
        disabled={form.busy || disabled}
        onChange={(event) => {
          const text = event.target.value;
          const number = text === '' ? null : Number(text);
          form.set(path, number === null || Number.isNaN(number) ? (zeroIsEmpty ? 0 : null) : number);
        }}
      />
    </Field>
  );
}

export function CheckboxField({ path, label, disabled }: { path: string; label: ReactNode; disabled?: boolean }) {
  const form = useProfileForm();
  const hint = hintOf(form, path, null);
  return (
    <div className="flex flex-col gap-1">
      <Checkbox
        label={label}
        checked={form.read(path) === true}
        disabled={form.busy || disabled}
        onCheckedChange={(checked) => form.set(path, checked)}
      />
      {hint && <p className="pl-7 text-[13px] leading-5">{hint}</p>}
    </div>
  );
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const FIRST_YEAR = 1950;

/**
 * A month and year ("2021-09"), or a year alone ("2021"), or nothing: the contract's YearMonth. A month picked
 * without a year takes this year, as the resume editor's picker does.
 */
export function MonthYearField({ path, label, disabled }: { path: string; label: ReactNode; disabled?: boolean }) {
  const form = useProfileForm();
  const now = useNow();
  const raw = form.read(path);
  const match = typeof raw === 'string' ? /^(\d{4})(?:-(\d{2}))?$/.exec(raw) : null;
  const year = match?.[1] ?? NONE;
  const month = match?.[2] ?? NONE;
  const lastYear = new Date(now).getFullYear() + 6;
  const years: SelectOption<string>[] = [{ value: NONE, label: 'No date' }];
  for (let value = lastYear; value >= FIRST_YEAR; value -= 1) years.push({ value: String(value), label: String(value) });
  if (year !== NONE && !years.some((option) => option.value === year)) years.splice(1, 0, { value: year, label: year });
  const months: SelectOption<string>[] = [
    { value: NONE, label: 'No month' },
    ...MONTHS.map((name, index) => ({ value: String(index + 1).padStart(2, '0'), label: name })),
  ];
  const write = (nextYear: string, nextMonth: string) =>
    form.set(path, nextYear === NONE ? null : nextMonth === NONE ? nextYear : `${nextYear}-${nextMonth}`);
  const text = typeof label === 'string' ? label : 'Date';
  const off = form.busy || disabled;
  return (
    <FieldGroup label={label} error={form.error(path)} hint={hintOf(form, path, null)}>
      <div className="grid grid-cols-2 gap-2">
        <Select
          aria-label={`${text}: month`}
          options={months}
          value={month}
          disabled={off}
          onValueChange={(next) => write(year === NONE ? String(new Date(now).getFullYear()) : year, next)}
        />
        <Select aria-label={`${text}: year`} options={years} value={year} disabled={off} onValueChange={(next) => write(next, month)} />
      </div>
    </FieldGroup>
  );
}

/** A list of short texts as chips: type one and press Enter (or Add); each chip's ✕ removes it. */
export function ChipListField({
  path,
  label,
  placeholder,
  max,
  maxLength,
  hint,
}: {
  path: string;
  label: ReactNode;
  placeholder: string;
  max: number;
  maxLength: number;
  hint?: ReactNode;
}) {
  const form = useProfileForm();
  const { t } = usePublicConstants();
  const [draft, setDraft] = useState('');
  const raw = form.read(path);
  const items = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
  const full = items.length >= max;
  const text = typeof label === 'string' ? label : 'item';
  const add = () => {
    const value = draft.replace(/\s+/g, ' ').trim();
    if (!value) return;
    if (!items.some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase())) form.set(path, [...items, value]);
    setDraft('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      add();
    }
  };
  return (
    <FieldGroup label={label} error={form.errorWithin(path)} hint={hintOf(form, path, hint)}>
      {items.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={text}>
          {items.map((item, index) => (
            <li key={`${index}:${item}`} className="max-w-full">
              <Chip
                tone="neutral"
                disabled={form.busy}
                onRemove={() => form.set(path, items.filter((_, other) => other !== index))}
                removeLabel={`Remove ${item}`}
              >
                {item}
              </Chip>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          aria-label={`Add to ${text}`}
          placeholder={full ? t('MSG_LIST_FULL', { max }) : placeholder}
          value={draft}
          maxLength={maxLength}
          disabled={form.busy || full}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button variant="outline" icon={<PlusIcon size={16} />} disabled={form.busy || full || !draft.trim()} onClick={add}>
          Add
        </Button>
      </div>
    </FieldGroup>
  );
}

// -------------------------------------------------------------------------------------------- sensitive answers

/** What every sensitive answer offers besides a value. */
export const DECLINED_LABEL = 'Prefer not to say';
export const NOT_ANSWERED_LABEL = 'Not answered';

type Mode = 'value' | 'declined' | 'not_provided';

const MODE_OPTIONS: RadioOption<Mode>[] = [
  { value: 'value', label: 'Answer' },
  { value: 'declined', label: DECLINED_LABEL },
  { value: 'not_provided', label: NOT_ANSWERED_LABEL },
];

/** The sensitive answer at `path` (not provided when the draft has none there). */
export function answerAt<T>(read: (key: string) => unknown, path: string): SensitiveAnswer<T> {
  const raw = read(path) as SensitiveAnswer<T> | undefined;
  return raw && typeof raw === 'object' && 'state' in raw ? raw : { state: 'not_provided' };
}

/** A yes-or-no answer: Yes / No / Prefer not to say / Not answered. */
export function SensitiveBooleanField({
  path,
  label,
  yes = 'Yes',
  no = 'No',
  hint,
}: {
  path: string;
  label: ReactNode;
  yes?: string;
  no?: string;
  hint?: ReactNode;
}) {
  const form = useProfileForm();
  const answer = answerAt<boolean>(form.read, path);
  const value = answer.state === 'value' ? (answer.value ? 'yes' : 'no') : answer.state;
  return (
    <Field label={label} error={form.errorWithin(path)} hint={hint}>
      <RadioGroup
        orientation="horizontal"
        disabled={form.busy}
        options={[
          { value: 'yes', label: yes },
          { value: 'no', label: no },
          { value: 'declined', label: DECLINED_LABEL },
          { value: 'not_provided', label: NOT_ANSWERED_LABEL },
        ]}
        value={value}
        onValueChange={(next) =>
          form.set(
            path,
            next === 'yes' || next === 'no' ? { state: 'value', value: next === 'yes' } : { state: next },
          )
        }
      />
    </Field>
  );
}

/**
 * An answer with its own editor: the mode (Answer / Prefer not to say / Not answered) and, while answering, the
 * editor. A value set aside by switching the mode comes back when Answer is chosen again.
 */
export function AnswerField<T>({
  path,
  label,
  blank,
  children,
}: {
  path: string;
  label: ReactNode;
  /** The value Answer starts from. */
  blank: () => T;
  children: (value: T, update: (next: T) => void) => ReactNode;
}) {
  const form = useProfileForm();
  const [setAside, setSetAside] = useState<T | null>(null);
  const answer = answerAt<T>(form.read, path);
  const choose = (mode: Mode) => {
    if (mode === answer.state) return;
    if (answer.state === 'value') setSetAside(answer.value);
    form.set(path, mode === 'value' ? { state: 'value', value: setAside ?? blank() } : { state: mode });
  };
  return (
    <div className="flex flex-col gap-3">
      <Field label={label} error={answer.state === 'value' ? undefined : form.errorWithin(path)}>
        <RadioGroup orientation="horizontal" disabled={form.busy} options={MODE_OPTIONS} value={answer.state} onValueChange={choose} />
      </Field>
      {answer.state === 'value' && (
        <div className="border-l-2 border-border pl-4">
          {children(answer.value, (next) => form.set(path, { state: 'value', value: next }))}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------------------------- entry cards

/** One entry of a repeatable list, with Move up, Move down and Remove. */
export function EntryCard({
  title,
  position,
  count,
  onMove,
  onRemove,
  children,
}: {
  title: string;
  position: number;
  count: number;
  onMove?: (delta: -1 | 1) => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const { busy } = useProfileForm();
  return (
    <div className="rounded-control border border-border p-4" role="group" aria-label={title}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-semibold text-foreground">{title}</p>
        <div className="flex shrink-0 items-center gap-1">
          {onMove && (
            <>
              <IconButton
                label={`Move ${title} up`}
                tooltip="Move up"
                size="sm"
                icon={<ArrowUpIcon size={16} />}
                disabled={busy || position === 0}
                onClick={() => onMove(-1)}
              />
              <IconButton
                label={`Move ${title} down`}
                tooltip="Move down"
                size="sm"
                icon={<ArrowDownIcon size={16} />}
                disabled={busy || position === count - 1}
                onClick={() => onMove(1)}
              />
            </>
          )}
          <IconButton
            label={`Remove ${title}`}
            tooltip="Remove"
            size="sm"
            icon={<TrashIcon size={16} />}
            disabled={busy}
            onClick={onRemove}
          />
        </div>
      </div>
      {children}
    </div>
  );
}

/** "Add education" under a list, or why there is no room for another. */
export function AddButton({ label, onAdd, full }: { label: string; onAdd: () => void; full: boolean }) {
  const { busy } = useProfileForm();
  return (
    <Button variant="outline" icon={<PlusIcon size={16} />} disabled={busy || full} onClick={onAdd}>
      {label}
    </Button>
  );
}

/** A new entry id: the contract takes 1-40 of A-Z, a-z, 0-9, _ and -. */
export function newEntryId(): string {
  return crypto.randomUUID();
}
