'use client';

import { RobotIcon } from '@phosphor-icons/react/Robot';
import { useState } from 'react';
import { DayPicker, type Matcher } from 'react-day-picker';
import 'react-day-picker/style.css';
import {
  APPLICATION_STATUSES,
  SORT_ORDER_LABEL,
  STATUS_INFO,
  TRACKER_SORT_LABEL,
  toDate,
  toIsoDate,
  type ApplicationStatus,
  type EmploymentType,
  type SortOrder,
  type TrackerSort,
  type TrackerView,
} from '@tailorit/shared';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuTrigger,
} from '@/components/ui/Menu';
import {
  ArchiveIcon,
  CheckCircleIcon,
  DotsThreeVerticalIcon,
  DownloadSimpleIcon,
  FileZipIcon,
  FunnelIcon,
  LockSimpleIcon,
  UploadSimpleIcon,
} from '@/components/ui/icons';
import { usePublicConstants } from '@/lib/constants';
import { LIMIT_COPY } from '@/components/limits/copy';
import { useNow } from '@/lib/useNow';
import { activeFilterCount, hasFilters, toggleStatus, DEFAULT_FILTERS, type FilterState } from '../state';
import { StatusIcon } from '../status';

const JOB_TYPES: Array<{ value: EmploymentType; label: string }> = [
  { value: 'internship', label: 'Internship' },
  { value: 'full_time', label: 'Full-Time' },
  { value: 'part_time', label: 'Part-Time' },
  { value: 'contract', label: 'Contract' },
];

/** A single-date calendar inside a submenu ("Applied from ›" / "Applied until ›"). */
function DateFilter({
  value,
  min,
  max,
  onPick,
}: {
  value: string | null;
  min: Date | null;
  max: Date;
  onPick: (date: string) => void;
}) {
  const selected = toDate(value) ?? undefined;
  const disabled: Matcher[] = [{ after: max }];
  if (min) disabled.push({ before: min });
  return (
    // The calendar keeps its arrow keys (the menu would move its highlight); Escape and Tab still reach the menu.
    <div
      className="px-1 pt-1"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation();
      }}
    >
      <DayPicker
        className="ti-day-picker"
        mode="single"
        captionLayout="dropdown"
        startMonth={new Date(2015, 0)}
        endMonth={max}
        defaultMonth={selected ?? max}
        selected={selected}
        onSelect={(date) => {
          const iso = toIsoDate(date ?? null);
          if (iso) onPick(iso);
        }}
        disabled={disabled}
      />
    </div>
  );
}

export interface ColumnChoice {
  status: ApplicationStatus;
  count: number;
  visible: boolean;
}

/**
 * v32 LAYOUT (E11): a lane's count after its name, a word apart, so it is named "Applied (1)" (it read "Applied(1)").
 */
function LaneCount({ count }: { count: number }) {
  return (
    <>
      {' '}
      <span className="text-muted-foreground tabular-nums">({count})</span>
    </>
  );
}

/** v32 LAYOUT (E11): how many lanes the board shows (the stages ticked and Archived; v33 TRACKER: no Draft lane). */
export function lanesShownCount(columns: readonly ColumnChoice[], archived: { visible: boolean }): number {
  return columns.filter((column) => column.visible).length + (archived.visible ? 1 : 0);
}

/** v33 SHARE-9: the tracker's actions the ⋮ offers (OptionsMenu's `actions`). */
export interface TrackerActions {
  select: boolean;
  prepare: boolean;
  import: boolean;
  export: boolean;
  buildResumes: boolean;
  archiveAll: boolean;
}

/** Every action (the person's own Job Tracker). */
export const ALL_ACTIONS: TrackerActions = { select: true, prepare: true, import: true, export: true, buildResumes: true, archiveAll: true };
/** None (the All profiles view: per-card actions only). */
export const NO_ACTIONS: TrackerActions = { select: false, prepare: false, import: false, export: false, buildResumes: false, archiveAll: false };

export function OptionsMenu({
  view,
  filters,
  onFiltersChange,
  onListView,
  columns,
  onColumnToggle,
  archivedColumn,
  onArchivedToggle,
  onManage,
  onPrepare,
  onImport,
  onExport,
  onBuildResumes,
  buildingResumes,
  resumesLocked = false,
  onArchiveAll,
  actions = ALL_ACTIONS,
}: {
  view: TrackerView;
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  /** Picking a status filter switches to the list. */
  onListView: () => void;
  columns: ColumnChoice[];
  onColumnToggle: (status: ApplicationStatus, visible: boolean) => void;
  archivedColumn: { count: number; visible: boolean };
  onArchivedToggle: (visible: boolean) => void;
  onManage: () => void;
  /** v2.0: "Prepare jobs": choose Saved entries to Prepare (Select applications' selection). */
  onPrepare: () => void;
  onImport: () => void;
  onExport: () => void;
  /** "Build resumes (zip)": every active Saved application's resume in one zip. */
  onBuildResumes: () => void;
  /** A zip is being built (the entry waits for it). */
  buildingResumes: boolean;
  /** v2.0 fix (SEC-6): a Free account: the entry shows a lock and opens the Paid feature's dialog. */
  resumesLocked?: boolean;
  onArchiveAll: () => void;
  /**
   * v33 SHARE-9: which of the tracker's actions the ⋮ offers: none in the All profiles view (per-card actions only); on
   * a shared profile only what its owner lets the person do (Change for Select, Import and Archive all; Prepare for
   * Prepare; Exports for the CSV and the zip). The ⋮ is left out when it would offer nothing.
   */
  actions?: TrackerActions;
}) {
  const [open, setOpen] = useState(false);
  const now = useNow();
  const today = new Date(now);
  const count = activeFilterCount(filters);
  const set = (patch: Partial<FilterState>) => onFiltersChange({ ...filters, ...patch });
  const showFilters = view !== 'chart';
  const { t } = usePublicConstants();
  const filterLabel = t('LABEL_TRACKER_FILTER');
  const lanesShown = lanesShownCount(columns, archivedColumn);
  const anyAction = Object.values(actions).some(Boolean);
  // v32 LAYOUT (E11): the board keeps at least one lane, so the last one ticked cannot be unticked.
  const lastLane = (visible: boolean) => visible && lanesShown <= 1;

  return (
    <>
      {/*
        v31 FIX-DOCS: "Filter and sort" (the filters, favorites and sort) and the tracker's actions. v32 LAYOUT (E11, the
        owner: "we should be able to set which lane will be shown (you can add this on vertical three dot)"): the
        actions are a vertical ⋮, and "Lanes shown" moved there from Filter and sort (the board's lanes are not a filter).
      */}
      {showFilters && (
        <Menu open={open} onOpenChange={setOpen}>
          {/*
            Opens on hover (a mouse resting on it for 100 ms), and still on click, Enter, Space or the arrow keys. A
            hover-opened menu closes when the pointer leaves it; a click inside keeps it open.
          */}
          <MenuTrigger
            openOnHover
            render={
              <Button
                variant="outline"
                icon={<FunnelIcon size={16} weight={count > 0 ? 'fill' : 'regular'} className={count > 0 ? 'text-primary' : undefined} />}
                aria-label={count > 0 ? `${filterLabel}, ${count} filters applied` : filterLabel}
                data-tracker-filter=""
              />
            }
          >
            <span className="max-sm:sr-only">{filterLabel}</span>
            {count > 0 && (
              <span className="num ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] text-on-primary">
                {count}
              </span>
            )}
          </MenuTrigger>
          <MenuContent align="end" width="w-60" aria-label={filterLabel}>
            <MenuGroup label="Filters">
              <MenuSub label="Applied from">
                <MenuSubContent width="w-auto">
                  <DateFilter
                    value={filters.from}
                    min={null}
                    max={toDate(filters.until) ?? today}
                    onPick={(date) => {
                      set({ from: date });
                      setOpen(false);
                    }}
                  />
                  <MenuSeparator />
                  <MenuItem disabled={!filters.from} onClick={() => set({ from: null })}>
                    Clear applied from
                  </MenuItem>
                </MenuSubContent>
              </MenuSub>
              <MenuSub label="Applied until">
                <MenuSubContent width="w-auto">
                  <DateFilter
                    value={filters.until}
                    min={toDate(filters.from)}
                    max={today}
                    onPick={(date) => {
                      set({ until: date });
                      setOpen(false);
                    }}
                  />
                  <MenuSeparator />
                  <MenuItem disabled={!filters.until} onClick={() => set({ until: null })}>
                    Clear applied until
                  </MenuItem>
                </MenuSubContent>
              </MenuSub>
              <MenuSub label="Job type">
                <MenuSubContent width="w-52">
                  <MenuRadioGroup
                    value={filters.jobType ?? ''}
                    onValueChange={(value) => set({ jobType: (value || null) as EmploymentType | null })}
                  >
                    {JOB_TYPES.map((type) => (
                      <MenuRadioItem key={type.value} value={type.value}>
                        {type.label}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                  <MenuSeparator />
                  <MenuItem disabled={!filters.jobType} onClick={() => set({ jobType: null })}>
                    Clear job type
                  </MenuItem>
                </MenuSubContent>
              </MenuSub>
              <MenuSub label="Status">
                <MenuSubContent width="w-56">
                  {APPLICATION_STATUSES.map((status) => (
                    <MenuCheckboxItem
                      key={status}
                      checked={filters.statuses.includes(status)}
                      icon={<StatusIcon status={status} size={16} />}
                      onCheckedChange={(on) => {
                        set({ statuses: toggleStatus(filters.statuses, status, on) });
                        if (on) onListView();
                      }}
                    >
                      {STATUS_INFO[status].label}
                    </MenuCheckboxItem>
                  ))}
                  <MenuSeparator />
                  <MenuItem disabled={filters.statuses.length === 0} onClick={() => set({ statuses: [] })}>
                    Clear status
                  </MenuItem>
                </MenuSubContent>
              </MenuSub>
              {hasFilters(filters) && (
                <MenuItem onClick={() => onFiltersChange(DEFAULT_FILTERS)}>Clear all filters</MenuItem>
              )}
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup label="View">
              <MenuCheckboxItem checked={filters.favorites} onCheckedChange={(on) => set({ favorites: on })}>
                Show only favorites
              </MenuCheckboxItem>
              <MenuSub label="Sort by">
                <MenuSubContent width="w-52">
                  <MenuRadioGroup value={filters.sort} onValueChange={(sort) => set({ sort: sort as TrackerSort })}>
                    {(Object.keys(TRACKER_SORT_LABEL) as TrackerSort[]).map((sort) => (
                      <MenuRadioItem key={sort} value={sort}>
                        {TRACKER_SORT_LABEL[sort]}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                  <MenuSeparator />
                  <MenuRadioGroup value={filters.order} onValueChange={(order) => set({ order: order as SortOrder })}>
                    {(Object.keys(SORT_ORDER_LABEL) as SortOrder[]).map((order) => (
                      <MenuRadioItem key={order} value={order}>
                        {SORT_ORDER_LABEL[order]}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuSubContent>
              </MenuSub>
            </MenuGroup>
          </MenuContent>
        </Menu>
      )}
      {(view === 'board' || anyAction) && (
        <Menu>
          <MenuTrigger
            render={
              <IconButton
                label={t('LABEL_TRACKER_MORE')}
                variant="outline"
                icon={<DotsThreeVerticalIcon size={18} weight="bold" />}
                data-tracker-actions=""
              />
            }
          />
          <MenuContent align="end" width="w-60" aria-label={t('LABEL_TRACKER_MORE')}>
            {view === 'board' && (
              <>
                <MenuGroup label="Board">
                  <MenuSub label={`${t('LABEL_TRACKER_LANES')} (${lanesShown})`}>
                    <MenuSubContent width="w-60">
                      {columns.map((column) => (
                        <MenuCheckboxItem
                          key={column.status}
                          checked={column.visible}
                          disabled={lastLane(column.visible)}
                          icon={<StatusIcon status={column.status} size={16} />}
                          onCheckedChange={(on) => onColumnToggle(column.status, on)}
                        >
                          {STATUS_INFO[column.status].label}
                          <LaneCount count={column.count} />
                        </MenuCheckboxItem>
                      ))}
                      <MenuCheckboxItem
                        checked={archivedColumn.visible}
                        disabled={lastLane(archivedColumn.visible)}
                        icon={<ArchiveIcon size={16} />}
                        onCheckedChange={onArchivedToggle}
                      >
                        Archived
                        <LaneCount count={archivedColumn.count} />
                      </MenuCheckboxItem>
                    </MenuSubContent>
                  </MenuSub>
                </MenuGroup>
                {anyAction && <MenuSeparator />}
              </>
            )}
            {anyAction && (
              <MenuGroup label="Actions">
                {actions.select && (
                  <MenuItem icon={<CheckCircleIcon size={16} />} onClick={onManage}>
                    {t('LABEL_TRACKER_SELECT')}
                  </MenuItem>
                )}
                {actions.prepare && (
                  <MenuItem icon={<RobotIcon size={16} />} onClick={onPrepare}>
                    Prepare jobs
                  </MenuItem>
                )}
                {actions.import && (
                  <MenuItem icon={<DownloadSimpleIcon size={16} />} onClick={onImport}>
                    {t('LABEL_TRACKER_IMPORT')}
                  </MenuItem>
                )}
                {actions.export && (
                  <MenuItem icon={<UploadSimpleIcon size={16} />} onClick={onExport}>
                    {t('LABEL_TRACKER_EXPORT')}
                  </MenuItem>
                )}
                {actions.buildResumes && (
                  <MenuItem
                    icon={resumesLocked ? <LockSimpleIcon size={16} data-lock-icon="" /> : <FileZipIcon size={16} />}
                    disabled={buildingResumes}
                    onClick={onBuildResumes}
                  >
                    {buildingResumes ? 'Building resumes...' : 'Build resumes (zip)'}
                    {resumesLocked && <span className="sr-only"> ({LIMIT_COPY.paidOnly})</span>}
                  </MenuItem>
                )}
                {actions.archiveAll && (
                  <>
                    <MenuSeparator />
                    <MenuItem icon={<ArchiveIcon size={16} />} onClick={onArchiveAll}>
                      Archive all applications
                    </MenuItem>
                  </>
                )}
              </MenuGroup>
            )}
          </MenuContent>
        </Menu>
      )}
    </>
  );
}
