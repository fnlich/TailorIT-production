import { clsx } from 'clsx';
import type { StepperTone } from '@tailorit/shared';
import type { StageMeterModel } from '../stage';

const FILL: Record<StepperTone, string> = {
  default: 'bg-tape',
  success: 'bg-success',
  muted: 'bg-control-strong',
};

/**
 * v31 FIX-DOCS (REV-UX UX-1): the list's stage meter, which replaced the five-dot stepper. One strip of measuring tape
 * split into a segment per stage (Saved, Applied, Screen, Interview, Offer, and the ending when there is one), a tick
 * between segments, filled to the furthest stage reached: the tape for an application under way, green once an offer
 * came, grey once it ended. Each stage's name sits over its segment (the current one bold, the way to go muted) and the
 * day it was reached under it, in the measurement face. It is a `meter` named "Progress of {title}" whose value is the stage reached
 * ("Screen, stage 3 of 5"); the names and dates are drawn for the eye.
 */
export function StageMeter({
  model,
  label,
  valueText,
  className,
}: {
  model: StageMeterModel;
  /** The meter's name: "Progress of {title}". */
  label: string;
  /** "Screen, stage 3 of 5" (stageMeterText). */
  valueText: string;
  className?: string;
}) {
  const count = model.steps.length;
  const columns = { gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` };
  return (
    <div className={clsx('flex min-w-0 flex-col gap-1', className)} data-stage-meter="">
      <div aria-hidden="true" className="grid gap-px text-[11px] leading-4" style={columns}>
        {model.steps.map((step) => (
          <span
            key={step.status}
            className={clsx(
              'truncate px-0.5 text-center',
              // The way to go stays muted-foreground (subtle text fails 4.5:1 on a chosen row's denim-soft).
              step.current ? 'font-semibold text-foreground' : step.reached ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {step.label}
          </span>
        ))}
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={count}
        aria-valuenow={model.at}
        aria-valuetext={valueText}
        className="relative grid h-2.5 overflow-hidden rounded-[3px] bg-surface-muted ring-1 ring-border ring-inset"
        style={columns}
      >
        {model.steps.map((step, index) => (
          <span
            key={step.status}
            className={clsx(
              'relative h-full',
              index < model.at && FILL[model.tone],
              // A tick between stages, hanging from the top edge (ink on the fill, the strong border on the track).
              index > 0 && "before:absolute before:top-0 before:left-0 before:h-[70%] before:w-px before:content-['']",
              index > 0 && (index < model.at ? 'before:bg-foreground/45' : 'before:bg-border-strong'),
            )}
          />
        ))}
      </div>
      <div aria-hidden="true" className="grid gap-px" style={columns}>
        {model.steps.map((step) => (
          <span key={step.status} className="num truncate text-center text-[11px] leading-4 text-muted-foreground">
            {step.dateLabel || ' '}
          </span>
        ))}
      </div>
    </div>
  );
}
