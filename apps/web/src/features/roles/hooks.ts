'use client';

import type { RoleFamilyId } from '@tailorit/shared/roles';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MY_FIELD_QUERY_KEY, fetchMyField, fetchResumeField, resumeFieldQueryKey, saveResumeField } from './api';

// v33 ROLES (F4): the person's field and a resume's, for the Field select, Settings › Account, the Jobs page's My field
// chip, the template pickers and the editor's words.

/** The person's field (their default resume's). */
export function useMyField() {
  return useQuery({ queryKey: MY_FIELD_QUERY_KEY, queryFn: ({ signal }) => fetchMyField(signal), staleTime: 60_000 });
}

/** One resume's field; nothing is asked without an id. */
export function useResumeField(resumeId: string | null | undefined) {
  return useQuery({
    queryKey: resumeFieldQueryKey(resumeId ?? ''),
    queryFn: ({ signal }) => fetchResumeField(resumeId!, signal),
    enabled: Boolean(resumeId),
    staleTime: 60_000,
  });
}

/** Saves a resume's field; the person's field is read again (it may be their default resume). */
export function useSetResumeField(resumeId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (roleFamily: RoleFamilyId | null) => saveResumeField(resumeId, roleFamily),
    onSuccess: (field) => {
      client.setQueryData(resumeFieldQueryKey(resumeId), field);
      void client.invalidateQueries({ queryKey: MY_FIELD_QUERY_KEY });
    },
  });
}
