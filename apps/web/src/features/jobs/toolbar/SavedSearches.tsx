'use client';

import { hasJobFilters, normalizeJobsQuery, type JobsQuery, type SavedSearch } from '@tailorit/shared';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { BookmarkSimpleIcon, TrashIcon } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/Popover';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { tabCan, useTabProfile } from '../../sharing/access'; // v34 FANOUT (G9)
import { activeFilters, suggestedSearchName } from '../filters';
import { useCreateSavedSearch, useDeleteSavedSearch, useSavedSearches } from '../hooks';
import { queryKeyOf } from '../url';

function summaryOf(search: SavedSearch): string {
  const labels = activeFilters(normalizeJobsQuery(search.query)).map((filter) => filter.label);
  return labels.length > 0 ? labels.join(' · ') : 'All jobs';
}

/**
 * The toolbar's bookmark: "Save this search" for the current filters, and the saved searches to jump back to (each
 * with a delete button).
 */
export function SavedSearches({ query, onApply }: { query: JobsQuery; onApply: (query: JobsQuery) => void }) {
  const [open, setOpen] = useState(false);
  const saved = useSavedSearches(open);
  const currentKey = queryKeyOf(query);
  const alreadySaved = saved.data?.items.find((search) => queryKeyOf(normalizeJobsQuery(search.query)) === currentKey);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <IconButton
            label="Saved searches"
            variant="outline"
            icon={<BookmarkSimpleIcon size={18} weight={alreadySaved ? 'fill' : 'regular'} />}
          />
        }
      />
      <PopoverContent align="end" padding="none" className="w-[340px]" aria-label="Saved searches">
        <SavedSearchesPanel query={query} onApply={onApply} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The popover's body (its naming form starts closed each time the popover opens). v34 FANOUT (G9): on a shared
 * profile, "Save this search" and each Delete only with the Job Tracker's Change (the owner's saved searches change
 * with it; the API refuses both without it). Drawn on its own in the tests.
 */
export function SavedSearchesPanel({
  query,
  onApply,
  onClose,
}: {
  query: JobsQuery;
  onApply: (query: JobsQuery) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const saved = useSavedSearches(true);
  const create = useCreateSavedSearch();
  const remove = useDeleteSavedSearch();
  const canChange = tabCan(useTabProfile(), 'tracker:edit'); // v34 FANOUT (G9)
  const canSave = hasJobFilters(query);
  const currentKey = queryKeyOf(query);
  const alreadySaved = saved.data?.items.find((search) => queryKeyOf(normalizeJobsQuery(search.query)) === currentKey);

  const startNaming = () => {
    setName(suggestedSearchName(query));
    create.reset();
    setNaming(true);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = name.trim();
    if (!value) return;
    create.mutate(
      { name: value, query },
      {
        onSuccess: () => {
          setNaming(false);
          toast.success('Search saved', `"${value}" is in your saved searches.`);
        },
      },
    );
  };

  return (
    <>
      <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3">
        <PopoverTitle>Saved searches</PopoverTitle>
        {!naming && canChange && (
          <Button size="sm" variant="outline" onClick={startNaming} disabled={!canSave || Boolean(alreadySaved)}>
            {alreadySaved ? 'Saved' : 'Save this search'}
          </Button>
        )}
      </div>
      {naming && canChange && (
        <form onSubmit={submit} className="flex flex-col gap-2 border-t border-border px-4 py-3">
          <label htmlFor="saved-search-name" className="text-[13px] font-medium text-foreground">
            Name this search
          </label>
          <Input
            id="saved-search-name"
            value={name}
            maxLength={100}
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
          {create.isError && <p className="text-[13px] text-danger">{userMessage(create.error)}</p>}
          <div className="mt-1 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>
              Cancel
            </Button>
            <Button size="sm" type="submit" loading={create.isPending} disabled={!name.trim()}>
              Save
            </Button>
          </div>
        </form>
      )}
      <div className="max-h-[320px] overflow-y-auto border-t border-border p-1.5">
        {saved.isPending ? (
          <div className="flex justify-center py-4">
            <Spinner size={16} label="Loading saved searches..." />
          </div>
        ) : saved.isError ? (
          <p className="px-2.5 py-3 text-sm text-muted-foreground">{userMessage(saved.error)}</p>
        ) : saved.data.items.length === 0 ? (
          <p className="px-2.5 py-3 text-sm leading-5 text-muted-foreground">
            No saved searches yet.
          </p>
        ) : (
          <ul aria-label="Saved searches">
            {saved.data.items.map((search) => (
              <li key={search.id} className="group flex items-center gap-1 rounded-menu-row hover:bg-hover">
                <button
                  type="button"
                  onClick={() => {
                    onApply(normalizeJobsQuery(search.query));
                    onClose();
                  }}
                  className="flex min-w-0 flex-1 flex-col px-2.5 py-2 text-left"
                >
                  <span className="truncate text-sm font-medium text-foreground">{search.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{summaryOf(search)}</span>
                </button>
                {canChange && (
                  <IconButton
                    label={`Delete ${search.name}`}
                    tooltip="Delete"
                    size="sm"
                    icon={<TrashIcon size={15} />}
                    onClick={() =>
                      remove.mutate(search.id, {
                        onError: (error) => toast.error('The search could not be deleted', userMessage(error)),
                      })
                    }
                    className="mr-1"
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
