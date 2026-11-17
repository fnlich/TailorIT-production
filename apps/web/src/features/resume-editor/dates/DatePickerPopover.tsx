'use client';

import { Popover as BasePopover } from '@base-ui/react/popover';
import { clsx } from 'clsx';
import { useState } from 'react';
import type { DatePart, Period } from '@tailorit/shared';
import { IconButton } from '@/components/ui/IconButton';
import { CaretLeftIcon, CaretRightIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { POPOVER_SURFACE, Z_FLOATING } from '@/components/ui/styles';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Switch } from '@/components/ui/Switch';
import {
  MAX_ONGOING_TEXT,
  MONTH_NAMES,
  periodHint,
  pickMonth,
  pickYear,
  stepYearPage,
  withOngoing,
  withSide,
  yearPage,
  type PickerSide,
} from './picker';

// Enhancv's date picker, opened under the date the person clicked: a page of years and the months, From and To tabs
// for a period, an ongoing switch with its own word on To. Every pick applies at once; Escape or a click outside
// closes it.

/**
 * What the picker is open on. `opened` counts the openings: a target that moves (the empty row it was opened on
 * became an entry, with a path and a field of its own) keeps its number, so the picker keeps its From or To tab.
 */
export type DateTarget =
  | { kind: 'range'; path: string; anchor: HTMLElement; opened: number; period: Period }
  | { kind: 'single'; path: string; anchor: HTMLElement; opened: number; date: DatePart | undefined };

export interface DatePickerPopoverProps {
  target: DateTarget | null;
  onPeriod(path: string, period: Period): void;
  onDate(path: string, date: DatePart | null): void;
  onClose(): void;
}

function YearsAndMonths({ part, onPick }: { part: DatePart | undefined; onPick(part: DatePart | undefined): void }) {
  const now = new Date();
  const [pageYear, setPageYear] = useState<number | undefined>(part?.y);
  const page = yearPage(pageYear, now);
  const cell = (selected: boolean) =>
    clsx(
      'h-8 rounded-md text-[13px] transition-colors',
      selected ? 'bg-primary font-semibold text-white' : 'text-foreground hover:bg-hover',
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <IconButton
          label="Newer years"
          size="sm"
          variant="ghost"
          disabled={!page.hasNewer}
          onClick={() => setPageYear(stepYearPage(pageYear, 1, now))}
          icon={<CaretLeftIcon size={14} />}
        />
        <span className="text-[13px] font-medium text-muted-foreground">
          {page.years.at(-1)} - {page.years[0]}
        </span>
        <IconButton
          label="Older years"
          size="sm"
          variant="ghost"
          disabled={!page.hasOlder}
          onClick={() => setPageYear(stepYearPage(pageYear, -1, now))}
          icon={<CaretRightIcon size={14} />}
        />
      </div>
      <div className="grid grid-cols-4 gap-1" role="group" aria-label="Year">
        {page.years.map((year) => (
          <button key={year} type="button" className={cell(part?.y === year)} aria-pressed={part?.y === year} onClick={() => onPick(pickYear(part, year))}>
            {year}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-1" role="group" aria-label="Month (pick it again for the year alone)">
        {MONTH_NAMES.map((name, index) => (
          <button
            key={name}
            type="button"
            className={cell(part?.m === index + 1)}
            aria-pressed={part?.m === index + 1}
            onClick={() => onPick(pickMonth(part, index + 1, now))}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}

function PeriodPicker({ target, onPeriod }: { target: Extract<DateTarget, { kind: 'range' }>; onPeriod(period: Period): void }) {
  const [side, setSide] = useState<PickerSide>('from');
  const period = target.period;
  const hint = periodHint(period, side);
  return (
    <div className="flex w-[17rem] flex-col gap-3">
      <SegmentedControl
        items={[
          { value: 'from', label: 'From' },
          { value: 'to', label: 'To' },
        ]}
        value={side}
        onValueChange={setSide}
        aria-label="Start or end of the period"
        size="sm"
      />
      {side === 'to' ? (
        <div className="flex flex-col gap-2">
          <Switch checked={period.ongoing === true} onCheckedChange={(on) => onPeriod(withOngoing(period, on))} label="I currently work here" />
          {period.ongoing ? (
            <Input
              aria-label="What an ongoing period says"
              value={period.ongoingText ?? 'Present'}
              maxLength={MAX_ONGOING_TEXT}
              onChange={(event) => onPeriod(withOngoing(period, true, event.target.value))}
            />
          ) : null}
        </div>
      ) : null}
      {side === 'to' && period.ongoing ? null : (
        <YearsAndMonths key={side} part={period[side]} onPick={(part) => onPeriod(withSide(period, side, part))} />
      )}
      {hint ? (
        <p role="alert" className="text-[13px] text-destructive">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function DatePickerPopover({ target, onPeriod, onDate, onClose }: DatePickerPopoverProps) {
  return (
    <BasePopover.Root open={target !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <BasePopover.Portal>
        <BasePopover.Positioner
          anchor={target?.anchor}
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className={clsx(Z_FLOATING, 'outline-none')}
        >
          <BasePopover.Popup aria-label="Pick a date" className={clsx(POPOVER_SURFACE, 'p-3')}>
            {target?.kind === 'range' ? (
              <PeriodPicker key={target.opened} target={target} onPeriod={(period) => onPeriod(target.path, period)} />
            ) : target?.kind === 'single' ? (
              <div className="w-[17rem]">
                <YearsAndMonths key={target.opened} part={target.date} onPick={(part) => onDate(target.path, part ?? null)} />
              </div>
            ) : null}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
