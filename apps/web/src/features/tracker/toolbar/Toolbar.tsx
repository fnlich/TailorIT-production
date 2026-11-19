'use client';

import { clsx } from 'clsx';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePublicConstants, type PublicMessageKey } from '@/lib/constants';
import { APPLICATION_STATUSES, STATUS_INFO, type ApplicationStatus, type TrackerTab, type TrackerView } from '@tailorit/shared';
import { Button } from '@/components/ui/Button';
import { PrepareButton } from '../../prepare/PrepareButton';
import { Checkbox } from '@/components/ui/Checkbox';
import { Chip } from '@/components/ui/Chip';
import { IconButton } from '@/components/ui/IconButton';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/Menu';
import { SearchPill } from '@/components/ui/SearchPill';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  CaretDownIcon,
  ChartLineIcon,
  FileZipIcon,
  KanbanIcon,
  LockSimpleIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  RowsIcon,
  TrashIcon,
} from '@/components/ui/icons';
import { filterChips, selectedLabel, withoutChip, DEFAULT_FILTERS, type FilterState } from '../state';
import { LIMIT_COPY } from '@/components/limits/copy';
import { StatusIcon } from '../status';

/**
 * v31 FIX-DOCS: Active | Archived, each with its count in a small badge once it is known (never a "0" that is only
 * loading; the tab is named by what it shows, "Active 27"), and "+ Add application" when the page puts it here (a "+" alone on phones; the Tracker page puts it in its
 * page header).
 */
export function TabsRow({
  tab,
  counts,
  onTabChange,
  onAdd,
}: {
  tab: TrackerTab;
  counts: { active: number; archived: number } | undefined;
  onTabChange: (tab: TrackerTab) => void;
  onAdd?: () => void;
}) {
  // v32 FIX-UX (UXREQ-5): on a phone the counts are said, not drawn (the row holds the search, the tabs, Filter and ⋮).
  const label = (word: string, count: number | undefined) =>
    count === undefined ? (
      word
    ) : (
      <>
        {word}
        <span className="num inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-surface-muted px-1.5 text-[11px] leading-none text-muted-foreground in-data-active:bg-primary-soft in-data-active:text-primary-ink max-sm:sr-only">
          {count}
        </span>
      </>
    );
  return (
    <div className="flex items-center justify-between gap-3 max-sm:min-w-0 max-sm:flex-1">
      <SegmentedControl
        aria-label="Applications"
        // On a phone the two segments share what the row leaves (44 px tall, touch targets).
        className="max-sm:w-full"
        listClassName="max-sm:flex max-sm:h-11 max-sm:w-full max-sm:[&>*]:flex-1"
        value={tab}
        onValueChange={onTabChange}
        items={[
          { value: 'active', label: label('Active', counts?.active) },
          { value: 'archived', label: label('Archived', counts?.archived) },
        ]}
      />
      {onAdd && (
        <Button icon={<PlusIcon size={16} weight="bold" />} className="max-sm:w-9" onClick={onAdd}>
          <span className="max-sm:sr-only">Add application</span>
        </Button>
      )}
    </div>
  );
}

/** Board | List | Chart (icons with their words; a phone keeps the words for screen readers). */
export function ViewSwitch({
  view,
  onViewChange,
  className,
}: {
  view: TrackerView;
  onViewChange: (view: TrackerView) => void;
  className?: string;
}) {
  return (
    <SegmentedControl
      aria-label="Tracker view"
      value={view}
      onValueChange={onViewChange}
      className={className}
      listClassName="max-sm:h-11"
      items={[
        { value: 'board', label: <span className="max-sm:sr-only">Board</span>, icon: <KanbanIcon size={16} /> },
        { value: 'list', label: <span className="max-sm:sr-only">List</span>, icon: <RowsIcon size={16} /> },
        { value: 'chart', label: <span className="max-sm:sr-only">Chart</span>, icon: <ChartLineIcon size={16} /> },
      ]}
    />
  );
}

/**
 * v31 FIX-DOCS: the tracker's one toolbar row: the search (left, taking the room), Active | Archived, Board | List |
 * Chart, then "Filter and sort" and the ⋯ of the tracker's actions. v32 FIX-UX (UXREQ-5): on a phone it is one row, the
 * search a magnifier that opens the field (on its own line while it is open or holds words), Active | Archived, Filter
 * and ⋮ (Board | List | Chart sits by the page's title there).
 */
export function SearchRow({
  view,
  search,
  onSearchChange,
  onViewChange,
  tabs,
  options,
}: {
  view: TrackerView;
  search: string;
  onSearchChange: (value: string) => void;
  onViewChange: (view: TrackerView) => void;
  /** Active | Archived (TabsRow). */
  tabs?: ReactNode;
  options: ReactNode;
}) {
  const { t } = usePublicConstants();
  const [searchOpen, setSearchOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const focusOpener = useRef(false);
  const fieldShown = searchOpen || search !== '';
  useEffect(() => {
    if (searchOpen) field.current?.focus();
    else if (focusOpener.current) {
      focusOpener.current = false;
      opener.current?.focus();
    }
  }, [searchOpen]);
  return (
    <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap" data-tracker-toolbar="">
      {view === 'chart' ? (
        <div className="hidden flex-1 lg:block" />
      ) : (
        <>
          {!fieldShown && (
            <IconButton
              ref={opener}
              label={SEARCH_OPEN_LABEL}
              variant="outline"
              icon={<MagnifyingGlassIcon size={18} />}
              className="size-11 sm:hidden"
              onClick={() => setSearchOpen(true)}
              data-tracker-search-open=""
            />
          )}
          <SearchPill
            ref={field}
            value={search}
            onValueChange={onSearchChange}
            placeholder={t('LABEL_TRACKER_SEARCH')}
            onBlur={() => {
              if (search === '') setSearchOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || search !== '') return;
              focusOpener.current = true;
              setSearchOpen(false);
            }}
            className={clsx('w-full min-w-0 lg:min-w-56 lg:flex-1', !fieldShown && 'max-sm:hidden', 'max-sm:[&_input]:h-11')}
          />
        </>
      )}
      {tabs}
      <ViewSwitch view={view} onViewChange={onViewChange} className="max-sm:hidden" />
      <div className="ml-auto flex items-center gap-2">{options}</div>
    </div>
  );
}

/** v32 FIX-UX: the phone's magnifier that opens the tracker's search. */
const SEARCH_OPEN_LABEL = 'Search applications';

/** The removable chips of the active filters, and "Clear all filters". */
export function FilterChipsRow({ filters, onChange }: { filters: FilterState; onChange: (filters: FilterState) => void }) {
  const chips = filterChips(filters);
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Active filters">
      {chips.map((chip) => (
        <Chip
          key={`${chip.key}-${chip.status ?? ''}`}
          tone="neutral"
          size="sm"
          icon={chip.status ? <StatusIcon status={chip.status} size={14} /> : undefined}
          onRemove={() => onChange(withoutChip(filters, chip))}
          removeLabel={`Remove ${chip.label}`}
        >
          {chip.label}
        </Chip>
      ))}
      <Button variant="link" size="sm" onClick={() => onChange(DEFAULT_FILTERS)}>
        Clear all filters
      </Button>
    </div>
  );
}

/**
 * v2.0: "Prepare & Queue jobs", the select-mode bar for choosing Saved entries to Prepare & Queue (no job is queued
 * directly: A4). Only Saved entries with a job that are not drafts in the queue already can be ticked (the others'
 * boxes say why); select all takes those on screen.
 */
export function PrepareBar({
  count,
  total,
  allSelected,
  onSelectAll,
  onPrepare,
  pending,
  onDone,
}: {
  count: number;
  /** The applications on screen that can be chosen. */
  total: number;
  allSelected: boolean;
  onSelectAll: (selected: boolean) => void;
  onPrepare: () => void;
  /** The request is in flight. */
  pending: boolean;
  onDone: () => void;
}) {
  const { t } = usePublicConstants();
  return (
    <div
      role="toolbar"
      aria-label="Choose saved jobs to Prepare & Queue"
      className="flex min-h-11 flex-wrap items-center gap-3 rounded-card border border-primary-200 bg-primary-50 py-1.5 pr-1.5 pl-3.5 shadow-card"
    >
      <Checkbox
        checked={allSelected && total > 0}
        indeterminate={!allSelected && count > 0}
        disabled={total === 0 || pending}
        aria-label="Select all saved jobs that can be prepared"
        onCheckedChange={(next) => onSelectAll(next)}
      />
      <span className="text-sm font-medium text-foreground" aria-live="polite">
        {selectedLabel(count, t)}
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <PrepareButton count={count} disabled={count === 0} loading={pending} onClick={onPrepare} />
        <Button variant="outline" size="sm" disabled={pending} onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

export type BulkKind = 'archive' | 'unarchive' | 'delete' | { status: ApplicationStatus };

/** v31 FIX-DOCS: the bulk confirmations' words keys (the constants; {count} the applications, {stage} a stage). */
const CONFIRM: Record<
  'archive' | 'unarchive' | 'delete',
  { title: PublicMessageKey; description: PublicMessageKey; label: string; tone: 'primary' | 'destructive' }
> = {
  delete: { title: 'MSG_TRACKER_DELETE_MANY_TITLE', description: 'MSG_TRACKER_DELETE_MANY_TEXT', label: 'Delete', tone: 'destructive' },
  archive: { title: 'MSG_TRACKER_ARCHIVE_MANY_TITLE', description: 'MSG_TRACKER_ARCHIVE_MANY_TEXT', label: 'Archive', tone: 'primary' },
  unarchive: { title: 'MSG_TRACKER_RESTORE_MANY_TITLE', description: 'MSG_TRACKER_RESTORE_MANY_TEXT', label: 'Restore', tone: 'primary' },
};

/**
 * "Select applications" (v31 FIX-DOCS; was "Manage jobs"): the select-mode bar with its bulk actions (Archive, Restore,
 * Delete, Move to stage) and their confirmations in the constants' words, and "Build resumes" (a zip of the selected
 * applications' resumes; like every action here it needs a selection).
 */
export function ManageBar({
  tab,
  count,
  total,
  allSelected,
  onSelectAll,
  onBulk,
  onBuildResumes,
  buildingResumes,
  resumesLocked = false,
  onDone,
}: {
  tab: TrackerTab;
  count: number;
  total: number;
  allSelected: boolean;
  onSelectAll: (selected: boolean) => void;
  onBulk: (kind: BulkKind) => Promise<void>;
  onBuildResumes: () => void;
  /** A zip is being built (the button waits for it). */
  buildingResumes: boolean;
  /** v2.0 fix (SEC-6): a Free account: the button shows a lock and opens the Paid feature's dialog. */
  resumesLocked?: boolean;
  onDone: () => void;
}) {
  const [pending, setPending] = useState<BulkKind | null>(null);
  const { t } = usePublicConstants();
  const none = count === 0;
  const confirm =
    pending === null
      ? null
      : typeof pending === 'object'
        ? {
            title: t('MSG_TRACKER_MOVE_MANY_TITLE', { count, stage: STATUS_INFO[pending.status].label }),
            description: t('MSG_TRACKER_MOVE_MANY_TEXT', { stage: STATUS_INFO[pending.status].label }),
            label: 'Move',
            tone: 'primary' as const,
          }
        : {
            title: t(CONFIRM[pending].title, { count }),
            description: t(CONFIRM[pending].description, { count }),
            label: CONFIRM[pending].label,
            tone: CONFIRM[pending].tone,
          };
  return (
    <div
      role="toolbar"
      aria-label={t('LABEL_TRACKER_SELECT')}
      className="flex min-h-11 flex-wrap items-center gap-3 rounded-card border border-primary-200 bg-primary-50 py-1.5 pr-1.5 pl-3.5 shadow-card"
    >
      <Checkbox
        checked={allSelected && total > 0}
        indeterminate={!allSelected && count > 0}
        disabled={total === 0}
        aria-label="Select all applications"
        onCheckedChange={(next) => onSelectAll(next)}
      />
      <span className="text-sm font-medium text-foreground" aria-live="polite">
        {selectedLabel(count, t)}
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          icon={<ArchiveIcon size={14} />}
          disabled={none || tab === 'archived'}
          onClick={() => setPending('archive')}
        >
          Archive
        </Button>
        <Button
          variant="outline"
          size="sm"
          icon={<ArrowCounterClockwiseIcon size={14} />}
          disabled={none || tab === 'active'}
          onClick={() => setPending('unarchive')}
        >
          Restore
        </Button>
        <Button variant="destructive-outline" size="sm" icon={<TrashIcon size={14} />} disabled={none} onClick={() => setPending('delete')}>
          Delete
        </Button>
        <Menu>
          <MenuTrigger
            disabled={none}
            render={<Button variant="outline" size="sm" trailingIcon={<CaretDownIcon size={12} />} />}
          >
            {t('LABEL_TRACKER_MOVE_TO_STAGE')}
          </MenuTrigger>
          <MenuContent width="w-52" align="end">
            {APPLICATION_STATUSES.map((status) => (
              <MenuItem key={status} icon={<StatusIcon status={status} size={16} />} onClick={() => setPending({ status })}>
                {STATUS_INFO[status].label}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <Button
          variant="outline"
          size="sm"
          icon={resumesLocked ? <LockSimpleIcon size={14} data-lock-icon="" /> : <FileZipIcon size={14} />}
          disabled={none || buildingResumes}
          onClick={onBuildResumes}
          data-locked={resumesLocked ? '' : undefined}
        >
          {buildingResumes ? 'Building resumes...' : 'Build resumes'}
          {resumesLocked && <span className="sr-only"> ({LIMIT_COPY.paidOnly})</span>}
        </Button>
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={confirm?.title ?? ''}
        description={confirm?.description}
        confirmLabel={confirm?.label ?? 'OK'}
        tone={confirm?.tone ?? 'primary'}
        onConfirm={async () => {
          if (pending !== null) await onBulk(pending);
        }}
      />
    </div>
  );
}
