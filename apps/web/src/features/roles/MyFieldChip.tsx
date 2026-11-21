'use client';

import { roleFamilyLabel } from '@tailorit/shared/roles';
import { Chip } from '@/components/ui/Chip';
import { HelpTip } from '@/components/ui/HelpTip';
import { usePublicConstants } from '@/lib/constants';
import { useMyField } from './hooks';
import { isMyFieldOn, myFieldCount, myFieldFilter } from './myField';

// v33 ROLES (F4): the category picker's one-click "My field" chip: the person's field (their default resume's) as the
// category filter, its job count beside it. Hidden for general (no field known). Off until clicked; nothing filters by
// itself.

interface FacetItem {
  value: string;
  count: number;
}

export function MyFieldChip({
  query,
  categories,
  subcategories,
  onChange,
}: {
  query: { categories: readonly string[]; subcategories: readonly string[] };
  categories: readonly FacetItem[];
  subcategories: readonly FacetItem[];
  onChange: (patch: { categories: string[]; subcategories: string[] }) => void;
}) {
  const { t } = usePublicConstants();
  const field = useMyField().data;
  const filter = myFieldFilter(field?.familyId);
  if (!field || !filter) return null;
  const on = isMyFieldOn(query, filter);
  const count = myFieldCount(filter, categories, subcategories);
  const label = roleFamilyLabel(field.familyId);
  const name = t('LABEL_JOBS_MY_FIELD');
  return (
    <div className="flex items-center gap-1.5" data-my-field={field.familyId}>
      <Chip
        size="sm"
        selected={on}
        onClick={() => onChange(on ? { categories: [], subcategories: [] } : { categories: [...filter.categories], subcategories: [...filter.subcategories] })}
      >
        <span>
          {name}: {label}
        </span>
        <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{count.toLocaleString('en-US')}</span>
      </Chip>
      <HelpTip label={name}>{t('MSG_JOBS_MY_FIELD_TIP', { field: label })}</HelpTip>
    </div>
  );
}
