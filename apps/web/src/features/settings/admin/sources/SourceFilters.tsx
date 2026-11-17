'use client';

import {
  JOB_SOURCE_DISCOVERED_VIA,
  JOB_SOURCE_DISCOVERED_VIA_LABEL,
  JOB_SOURCE_KIND_LABEL,
  JOB_SOURCE_ROBOTS_LABEL,
  JOB_SOURCE_ROBOTS_STATUSES,
  JOB_SOURCE_TERMS_LABEL,
  JOB_SOURCE_TERMS_STATUSES,
  JOB_SOURCE_TIER_LABEL,
  JOB_SOURCE_TIERS,
} from '@tailorit/shared/sourcing';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { FilterPill } from '@/components/ui/FilterPill';
import { MagnifyingGlassIcon, WarningCircleIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu';
import { Select } from '@/components/ui/Select';
import {
  FILTER_KINDS,
  SOURCE_ENABLED_LABEL,
  SOURCE_SORT_OPTIONS,
  activeFilterCount,
  toggledIn,
  type SourceEnabledFilter,
  type SourceFilters,
} from './filters';

// v30 S1-WEB: Admin › Sources' search, order and filters (12 §9.8): one pill per list (kind, tier, terms, robots, how a
// source was found), the enabled state, "Failing", and the host or company an address named, as chips.

/** A pill whose menu is a checkbox list (the Jobs page's pills); the menu stays open while ticking. */
export function ChoiceMenu<V extends string>({
  label,
  values,
  labels,
  chosen,
  onChange,
}: {
  label: string;
  values: readonly V[];
  labels: Record<V, string>;
  chosen: readonly V[];
  onChange: (next: V[]) => void;
}) {
  return (
    <Menu>
      <MenuTrigger render={<FilterPill label={label} count={chosen.length} active={chosen.length > 0} />} />
      <MenuContent align="start" width="w-64" aria-label={label}>
        {values.map((value) => (
          <MenuCheckboxItem key={value} checked={chosen.includes(value)} onCheckedChange={(on) => onChange(toggledIn(chosen, value, on, values))}>
            {labels[value]}
          </MenuCheckboxItem>
        ))}
        {chosen.length > 0 && (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => onChange([])}>Clear {label.toLowerCase()}</MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

const ENABLED_VALUES: readonly SourceEnabledFilter[] = ['all', 'enabled', 'disabled'];

export function SourceFiltersBar({
  filters,
  search,
  onSearch,
  onChange,
  onClear,
  companyName,
}: {
  filters: SourceFilters;
  /** The search box's text (the list follows it after a short rest). */
  search: string;
  onSearch: (text: string) => void;
  onChange: (patch: Partial<SourceFilters>) => void;
  onClear: () => void;
  /** The company a `company=` address names, once a row says its name. */
  companyName: string | null;
}) {
  return (
    <div className="mb-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Find sources">
        <Input
          type="search"
          aria-label="Search sources by name or host"
          placeholder="Search by name or host"
          leading={<MagnifyingGlassIcon size={16} />}
          className="pl-9"
          wrapperClassName="w-full max-w-sm"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
        <Select aria-label="Order" options={SOURCE_SORT_OPTIONS} value={filters.sort} onValueChange={(sort) => onChange({ sort })} className="w-48" />
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
        <ChoiceMenu label="Kind" values={FILTER_KINDS} labels={JOB_SOURCE_KIND_LABEL} chosen={filters.kinds} onChange={(kinds) => onChange({ kinds })} />
        <ChoiceMenu label="Tier" values={JOB_SOURCE_TIERS} labels={JOB_SOURCE_TIER_LABEL} chosen={filters.tiers} onChange={(tiers) => onChange({ tiers })} />
        <ChoiceMenu label="Terms" values={JOB_SOURCE_TERMS_STATUSES} labels={JOB_SOURCE_TERMS_LABEL} chosen={filters.terms} onChange={(terms) => onChange({ terms })} />
        <ChoiceMenu
          label="Robots"
          values={JOB_SOURCE_ROBOTS_STATUSES}
          labels={JOB_SOURCE_ROBOTS_LABEL}
          chosen={filters.robots}
          onChange={(robots) => onChange({ robots })}
        />
        <ChoiceMenu
          label="Found by"
          values={JOB_SOURCE_DISCOVERED_VIA}
          labels={JOB_SOURCE_DISCOVERED_VIA_LABEL}
          chosen={filters.via}
          onChange={(via) => onChange({ via })}
        />
        <Menu>
          <MenuTrigger
            render={
              <FilterPill
                label={filters.enabled === 'all' ? 'Status' : SOURCE_ENABLED_LABEL[filters.enabled]}
                count={filters.enabled === 'all' ? 0 : 1}
                active={filters.enabled !== 'all'}
              />
            }
          />
          <MenuContent align="start" width="w-56" aria-label="Status">
            <MenuRadioGroup value={filters.enabled} onValueChange={(enabled) => onChange({ enabled })}>
              {ENABLED_VALUES.map((value) => (
                <MenuRadioItem key={value} value={value} closeOnClick>
                  {SOURCE_ENABLED_LABEL[value]}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
        <Chip icon={<WarningCircleIcon size={16} />} selected={filters.failing} onClick={() => onChange({ failing: !filters.failing })} className="h-9">
          Failing only
        </Chip>
        {filters.host && (
          <Chip tone="tint" onRemove={() => onChange({ host: null })} removeLabel={`Show every host, not only ${filters.host}`}>
            Host: {filters.host}
          </Chip>
        )}
        {filters.companyId && (
          <Chip tone="tint" onRemove={() => onChange({ companyId: null })} removeLabel="Show every company">
            Company: {companyName ?? `#${filters.companyId}`}
          </Chip>
        )}
        {activeFilterCount(filters) > 0 && (
          <Button variant="ghost" size="sm" onClick={onClear}>
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}
