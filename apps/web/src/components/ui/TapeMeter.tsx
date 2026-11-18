import { clsx } from 'clsx';
import type { ComponentPropsWithoutRef } from 'react';

export type TapeMeterTone = 'tape' | 'primary' | 'success' | 'warning' | 'danger';
export type TapeMeterSize = 'sm' | 'md' | 'lg';

export interface TapeMeterProps {
  /** The measured value, between `min` and `max` (values outside are drawn at the end and still said as they are). */
  value: number;
  min?: number;
  max?: number;
  /** The accessible name ("Match", "AI use today"); drawn above the bar when `showLabel`. */
  label: string;
  showLabel?: boolean;
  /** What the value says, e.g. "72%" or "$1.20 of $2.00": the visible number and the meter's aria-valuetext. */
  valueText?: string;
  /** Draws `valueText` (default on). */
  showValue?: boolean;
  /** The fill: the tape (default), denim, or a status colour (usage near or past its limit). */
  tone?: TapeMeterTone;
  /** Bar height: sm 6 px, md 10 px, lg 14 px. */
  size?: TapeMeterSize;
  /** Tick marks every 10 % and a longer one at 50 % (default on from `md`). */
  ticks?: boolean;
  /** `stacked`: label and value above the bar; `inline`: the value to the right of the bar. */
  layout?: 'stacked' | 'inline';
  /** `meter` (a measurement: match, usage) or `progress` (a task's progress). */
  kind?: 'meter' | 'progress';
  className?: string;
}

const FILL: Record<TapeMeterTone, string> = {
  tape: 'bg-tape',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

const HEIGHT: Record<TapeMeterSize, string> = { sm: 'h-1.5', md: 'h-2.5', lg: 'h-3.5' };

/**
 * A measurement inside a sentence: an amount ("$1.62", "-$0.40"), a share ("72%"), a count ("4", "10,000+"), a
 * fraction ("3/5"). v31 FIX-WEB (REV-UX UX-8): only these take the measurement face; the words around them stay in
 * IBM Plex Sans (docs/design/v3.1/20-visual-identity.md §3: "Prose numbers stay in Plex Sans").
 */
const MEASUREMENT = /[-+−]?[$€£]?\d[\d,]*(?:\.\d+)?(?:\/\d[\d,]*)?(?:\s?%|\+)?/g;

/** `text` cut into its measurements and the words between them, in order (empty parts left out). */
export function measureParts(text: string): { text: string; measure: boolean }[] {
  const parts: { text: string; measure: boolean }[] = [];
  let at = 0;
  for (const match of text.matchAll(MEASUREMENT)) {
    const index = match.index ?? 0;
    if (index > at) parts.push({ text: text.slice(at, index), measure: false });
    parts.push({ text: match[0], measure: true });
    at = index + match[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), measure: false });
  return parts;
}

/**
 * A line whose measurements are set in the measurement face (`num`, tabular figures) and whose words are not:
 * "**4** of **6** saved jobs pass", "Extra usage **$1.50**". A text that is one measurement ("72%") is one `num` span.
 */
export function MeasureText({ text, className, ...rest }: { text: string } & Omit<ComponentPropsWithoutRef<'span'>, 'children'>) {
  const parts = measureParts(text);
  if (parts.length === 1 && parts[0]!.measure) {
    return (
      <span className={clsx('num', className)} {...rest}>
        {text}
      </span>
    );
  }
  return (
    <span className={className} {...rest}>
      {parts.map((part, index) =>
        part.measure ? (
          <span key={index} className="num">
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </span>
  );
}

/**
 * TailorIT's signature measure: a strip of measuring tape. A grey track with a 1 px inset edge, the fill in the tape
 * yellow (or a tone), tick marks every 10 % hanging from the top edge, an ink needle where the value ends, and the
 * number in IBM Plex Mono (only the numbers of a phrase: "4 of 6 saved jobs pass" keeps its words in Plex Sans). Use it for match scores, usage against a budget and progress. The bar is never the only
 * carrier of the value: the number is drawn beside it (or `valueText` says it), and the element is a `meter` (or
 * `progressbar`) with its name and value for assistive technology.
 *
 *   <TapeMeter label="Match" value={72} />
 *   <TapeMeter label="AI use today" value={1.2} max={2} valueText="$1.20 of $2.00" tone="warning" showLabel />
 */
export function TapeMeter({
  value,
  min = 0,
  max = 100,
  label,
  showLabel = false,
  valueText,
  showValue = true,
  tone = 'tape',
  size = 'md',
  ticks,
  layout = 'stacked',
  kind = 'meter',
  className,
}: TapeMeterProps) {
  const span = max - min;
  const ratio = span > 0 ? (value - min) / span : 0;
  const pct = Math.max(0, Math.min(100, ratio * 100));
  const said = valueText ?? `${Math.round(ratio * 100)}%`;
  const withTicks = ticks ?? size !== 'sm';
  // Ticks on the fill keep the track's spacing: the inner layer is as wide as the whole track.
  const fillTicks = withTicks && pct > 0 ? (tone === 'tape' || tone === 'warning' ? 'tape-ticks' : 'tape-ticks tape-ticks-light') : null;
  const needle = size !== 'sm' && pct > 0 && pct < 100;

  const bar = (
    <span className={clsx('relative block min-w-0', layout === 'inline' && 'flex-1')}>
      <span
        role={kind === 'progress' ? 'progressbar' : 'meter'}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={said}
        className={clsx('relative block overflow-hidden rounded-[3px] bg-surface-muted ring-1 ring-border ring-inset', HEIGHT[size])}
      >
        {withTicks && <span aria-hidden="true" className="tape-ticks absolute inset-0" />}
        <span aria-hidden="true" className={clsx('absolute inset-y-0 left-0 overflow-hidden', FILL[tone])} style={{ width: `${pct}%` }}>
          {fillTicks && (
            <span className={clsx('absolute inset-y-0 left-0', fillTicks)} style={{ width: `${(100 / pct) * 100}%` }} />
          )}
        </span>
      </span>
      {needle && (
        <span
          aria-hidden="true"
          className="absolute -top-0.5 -bottom-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          style={{ left: `${pct}%` }}
        />
      )}
    </span>
  );

  if (layout === 'inline') {
    return (
      <span className={clsx('flex min-w-0 items-center gap-2.5', className)}>
        {showLabel && (
          <span aria-hidden="true" className="shrink-0 text-xs font-medium text-muted-foreground">
            {label}
          </span>
        )}
        {bar}
        {showValue && (
          <MeasureText aria-hidden="true" text={said} className={clsx('shrink-0 text-foreground', size === 'lg' ? 'text-sm' : 'text-xs')} />
        )}
      </span>
    );
  }
  return (
    <span className={clsx('flex min-w-0 flex-col gap-1.5', className)}>
      {(showLabel || showValue) && (
        <span aria-hidden="true" className="flex items-baseline justify-between gap-3 text-xs">
          {showLabel ? <span className="truncate font-medium text-muted-foreground">{label}</span> : <span />}
          {showValue && <MeasureText text={said} className={clsx('shrink-0 text-foreground', size === 'lg' && 'text-sm')} />}
        </span>
      )}
      {bar}
    </span>
  );
}
