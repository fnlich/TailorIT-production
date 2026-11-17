'use client';

import { clsx } from 'clsx';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { CheckIcon, WarningCircleIcon } from './icons';

export interface StepperStep {
  key: string;
  label: ReactNode;
  /** Reached steps draw the filled dot and a tinted connector towards the next reached step. */
  reached: boolean;
  /** A line under the dot, e.g. the date reached ("10/22/26"). */
  caption?: ReactNode;
}

export type StepperTone = 'primary' | 'success' | 'muted';

const TONE: Record<StepperTone, { ring: string; dot: string; line: string }> = {
  primary: { ring: 'bg-primary-container', dot: 'bg-primary-ink', line: 'bg-primary-container' },
  success: { ring: 'bg-success-container', dot: 'bg-success', line: 'bg-success-container' },
  muted: { ring: 'bg-muted', dot: 'bg-subtle-foreground', line: 'bg-muted' },
};

/**
 * Simplify's horizontal progress stepper (tracker list rows): label above each 24 px dot, the date below; reached
 * dots are a #08758c centre in a #ccf6ff ring, the rest white with a #d7d7d7 border, joined by 4 px connectors.
 * `tone` turns it green (Offer/Accepted) or grey (Rejected/Withdrawn/Ghosted).
 */
export function Stepper({
  steps,
  tone = 'primary',
  'aria-label': ariaLabel,
  className,
}: {
  steps: readonly StepperStep[];
  tone?: StepperTone;
  'aria-label': string;
  className?: string;
}) {
  const colors = TONE[tone];
  return (
    // Full width unless the caller sizes it (no class merging: a width in `className` replaces the default).
    <ol aria-label={ariaLabel} className={clsx('flex items-start', className ?? 'w-full')}>
      {steps.map((step, index) => {
        const next = steps[index + 1];
        return (
          <li key={step.key} className="relative flex min-w-0 flex-1 flex-col items-center">
            <span className="mb-3 text-xs leading-4 whitespace-nowrap text-foreground">{step.label}</span>
            <span className="relative flex h-6 w-full items-center justify-center">
              {next && (
                <span
                  aria-hidden="true"
                  className={clsx(
                    'absolute top-1/2 left-1/2 h-1 w-full -translate-y-1/2',
                    step.reached && next.reached ? colors.line : 'bg-border',
                  )}
                />
              )}
              <span
                aria-hidden="true"
                className={clsx(
                  'relative z-[1] flex size-6 items-center justify-center rounded-full',
                  step.reached ? colors.ring : 'border-2 border-control-strong bg-surface',
                )}
              >
                {step.reached && <span className={clsx('size-3.5 rounded-full', colors.dot)} />}
              </span>
            </span>
            <span className="mt-3 min-h-4 text-xs leading-4 whitespace-nowrap text-foreground">{step.caption}</span>
            <span className="sr-only">{step.reached ? ', reached' : ', not reached'}</span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// v1.4 E: the wizard variant (Settings › Autofill › Profile). Each step is a button: the current one says so with
// aria-current="step"; done steps show a check, steps with a field to fix a warning mark. The arrow keys, Home and End
// move between the steps; Enter or Space goes to one.

export type WizardStepState = 'complete' | 'error' | 'upcoming';

export interface WizardStepperStep {
  key: string;
  label: string;
  state: WizardStepState;
}

const STATE_WORDS: Record<WizardStepState, string> = {
  complete: 'filled in',
  error: 'has a field that needs a change',
  upcoming: 'not filled in yet',
};

/**
 * A clickable progress stepper: numbered 28 px dots joined by 2 px connectors, teal up to the current step, each with
 * its label under it from the small breakpoint up (below it the page says the step's name). Every dot is a button named
 * "Step 3 of 9: Education, filled in" (an aria-label: the browser would put a space before the comma of a name read
 * from its parts).
 */
export function WizardStepper({
  steps,
  current,
  onSelect,
  'aria-label': ariaLabel,
  className,
}: {
  steps: readonly WizardStepperStep[];
  current: string;
  onSelect: (key: string) => void;
  'aria-label': string;
  className?: string;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const currentIndex = steps.findIndex((step) => step.key === current);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = steps.length - 1;
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? Math.min(index + 1, last)
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? Math.max(index - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    buttons.current[next]?.focus();
  };

  return (
    <nav aria-label={ariaLabel} className={className} data-wizard-stepper="">
      <ol className="flex items-start">
        {steps.map((step, index) => {
          const isCurrent = index === currentIndex;
          const reached = index <= currentIndex;
          return (
            <li key={step.key} className="relative flex min-w-0 flex-1 justify-center">
              {index > 0 && (
                <span
                  aria-hidden="true"
                  className={clsx(
                    'absolute top-[14px] right-1/2 h-0.5 w-full -translate-y-1/2',
                    reached ? 'bg-primary' : 'bg-border',
                  )}
                />
              )}
              <button
                ref={(element) => {
                  buttons.current[index] = element;
                }}
                type="button"
                aria-label={`Step ${index + 1} of ${steps.length}: ${step.label}, ${isCurrent ? 'current step' : STATE_WORDS[step.state]}`}
                aria-current={isCurrent ? 'step' : undefined}
                data-step={step.key}
                data-state={isCurrent ? 'current' : step.state}
                onClick={() => onSelect(step.key)}
                onKeyDown={(event) => onKeyDown(event, index)}
                className="group relative z-[1] flex min-w-0 flex-col items-center gap-1.5 rounded-control px-0.5 pb-0.5"
              >
                <span
                  aria-hidden="true"
                  className={clsx(
                    'flex size-7 items-center justify-center rounded-full text-xs leading-none font-semibold transition-[background-color,box-shadow] duration-150',
                    isCurrent
                      ? clsx('bg-primary-ink text-white ring-4', step.state === 'error' ? 'ring-destructive-container' : 'ring-primary-container')
                      : step.state === 'error'
                        ? 'border border-[#f3c2c2] bg-destructive-container text-[#c62a29]'
                        : step.state === 'complete'
                          ? 'bg-primary-container text-primary-ink group-hover:bg-primary-200'
                          : 'border-2 border-control-strong bg-surface text-[#5c5c5c] group-hover:border-control-focus',
                  )}
                >
                  {!isCurrent && step.state === 'error' ? (
                    <WarningCircleIcon size={16} weight="bold" />
                  ) : !isCurrent && step.state === 'complete' ? (
                    <CheckIcon size={14} weight="bold" />
                  ) : (
                    index + 1
                  )}
                </span>
                <span
                  aria-hidden="true"
                  className={clsx(
                    'sr-only max-w-full truncate text-xs leading-4 sm:not-sr-only',
                    isCurrent ? 'font-semibold text-foreground' : step.state === 'error' ? 'text-[#c62a29]' : 'text-[#5c5c5c] group-hover:text-foreground',
                  )}
                >
                  {step.label}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
