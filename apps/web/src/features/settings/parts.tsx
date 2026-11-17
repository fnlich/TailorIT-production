import { clsx } from 'clsx';
import { useId, type ReactNode } from 'react';
// Relative, not '@/': the web tests draw these views.
import { Chip } from '../../components/ui/Chip';
import { CheckIcon } from '../../components/ui/icons';
import { Switch } from '../../components/ui/Switch';

/** A Settings card: its title, one line under it, then its content. `id` is its anchor (/settings#prepare). */
export function Section({
  title,
  description,
  children,
  id,
  actions,
  className,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
  id?: string;
  /** Beside the title (a button). */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={clsx('scroll-mt-[79px] rounded-surface border border-border bg-surface p-6 shadow-soft', className)}
      aria-label={title}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-base leading-6 font-semibold text-foreground">{title}</h2>
          <div className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{description}</div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** One row of a settings list: the label on the left (above on a phone), the value and its actions on the right. */
export function SettingRow({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex flex-col gap-1.5 py-3.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-6', className)}>
      <dt className="text-sm leading-5 text-muted-foreground sm:w-44 sm:shrink-0">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2 text-sm leading-5 text-foreground">{children}</dd>
    </div>
  );
}

/** A setting that is on or off: its name and one line on the left, the switch on the right. */
export function SwitchRow({
  title,
  hint,
  checked,
  disabled,
  onCheckedChange,
  children,
}: {
  title: string;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Under the hint (a link, a notice, the Custom filter's words). */
  children?: ReactNode;
}) {
  // v2.0 fix (UX-13): the switch is described by its hint, so a screen reader hears what it does (the Location
  // mismatch's "An office address doesn't count").
  const hintId = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm leading-5 font-medium text-foreground">{title}</p>
          {hint && (
            <p id={hintId} className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
              {hint}
            </p>
          )}
        </div>
        <Switch
          aria-label={title}
          aria-describedby={hint ? hintId : undefined}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
          className="mt-0.5"
        />
      </div>
      {children}
    </div>
  );
}

/** Toggle chips, any number on (Job preferences, the Prepare filters). */
export function ChoiceGroup<V extends string>({
  label,
  options,
  selected,
  onToggle,
  hint,
}: {
  label: string;
  hint?: ReactNode;
  options: readonly { value: V; label: string }[];
  selected: readonly V[];
  onToggle: (value: V) => void;
}) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-2.5">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span id={labelId} className="text-sm leading-5 font-medium text-foreground">
          {label}
        </span>
        {hint && <span className="text-[13px] leading-5 text-muted-foreground">{hint}</span>}
      </span>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const on = selected.includes(option.value);
          return (
            <Chip
              key={option.value}
              selected={on}
              onClick={() => onToggle(option.value)}
              icon={on ? <CheckIcon size={14} weight="bold" /> : undefined}
            >
              {option.label}
            </Chip>
          );
        })}
      </div>
    </div>
  );
}

/** "120 / 1000", in the warning colour past the limit. */
export function CharacterCount({ length, max }: { length: number; max: number }) {
  return (
    <span className={clsx('tabular-nums', length > max && 'font-semibold text-[#c62a29]')} data-count={length}>
      {length} / {max}
    </span>
  );
}
