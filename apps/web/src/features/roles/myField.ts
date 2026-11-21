import { GENERAL_FAMILY_ID, familyJobFilter, subcategoryParent, type RoleFamilyId } from '@tailorit/shared';

// v33 ROLES (F4): the Jobs page's My field chip, in pure functions (the chip is MyFieldChip.tsx): the person's field
// as a category filter (the family's categories and the subcategories it names elsewhere), whether the filter is on,
// and its job count from the category facets already loaded. A job tagged with two of the subcategories counts twice
// in the count (rare; accepted), and a job under one of the categories in a subcategory another field names is in the
// filter (accepted: PLAN F4).

export interface MyFieldFilter {
  categories: string[];
  subcategories: string[];
}

/** The filter of a field; null for general (no chip) or no field known. */
export function myFieldFilter(familyId: RoleFamilyId | null | undefined): MyFieldFilter | null {
  if (!familyId || familyId === GENERAL_FAMILY_ID) return null;
  const filter = familyJobFilter(familyId);
  return filter.categories.length + filter.subcategories.length > 0 ? filter : null;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value) => b.includes(value));

/** Whether the Jobs query's category filter is exactly the field's (the chip shows pressed). */
export function isMyFieldOn(query: { categories: readonly string[]; subcategories: readonly string[] }, filter: MyFieldFilter): boolean {
  return sameSet(query.categories, filter.categories) && sameSet(query.subcategories, filter.subcategories);
}

/** The jobs in the field, from the category and subcategory facet counts (a subcategory under one of its categories counts once). */
export function myFieldCount(
  filter: MyFieldFilter,
  categories: ReadonlyArray<{ value: string; count: number }>,
  subcategories: ReadonlyArray<{ value: string; count: number }>,
): number {
  let total = 0;
  for (const item of categories) if (filter.categories.includes(item.value)) total += item.count;
  for (const item of subcategories) {
    if (!filter.subcategories.includes(item.value)) continue;
    const parent = subcategoryParent(item.value);
    if (parent && filter.categories.includes(parent)) continue;
    total += item.count;
  }
  return total;
}
