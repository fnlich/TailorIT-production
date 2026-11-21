'use client';

import { useMemo } from 'react';
import { useMyField } from '../roles/hooks';

// v33 PROMPTS (F5): the letter pickers (the Generate dialog, Tailor's letter template, the profile's tailoring
// template) list the starter templates written for the person's field first: a nurse sees "Healthcare & Patient Care"
// at the top. The rest keep their order (TailorIT's starters in their order, then the person's own); nothing is hidden.

/** `items` with those written for `family` first, the order otherwise kept; as they are for no family. */
export function fieldFirst<T extends { roleFamilies?: readonly string[] }>(items: readonly T[], family: string | null | undefined): T[] {
  if (!family) return [...items];
  const forField = (item: T) => (item.roleFamilies?.includes(family) ? 0 : 1);
  return items.map((item, index) => ({ item, index })).sort((a, b) => forField(a.item) - forField(b.item) || a.index - b.index).map(({ item }) => item);
}

/** `items` in the field-first order of the person's field (their default resume's). */
export function useFieldFirst<T extends { roleFamilies?: readonly string[] }>(items: readonly T[] | undefined): T[] {
  const family = useMyField().data?.familyId;
  return useMemo(() => fieldFirst(items ?? [], family), [items, family]);
}
