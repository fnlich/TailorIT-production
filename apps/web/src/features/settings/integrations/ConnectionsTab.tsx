'use client';

import { useId, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { HelpTip } from '@/components/ui/HelpTip';
import { ArrowRightIcon, MagnifyingGlassIcon } from '@/components/ui/icons';
import { SearchPill } from '@/components/ui/SearchPill';
import { Select } from '@/components/ui/Select';
import { usePublicConstants } from '@/lib/constants';
import { ClientMark } from './ClientMark';
import {
  categoryLabel,
  CONNECTION_CATEGORIES,
  CONNECTIONS,
  CONNECTIONS_COPY,
  filterConnections,
  type Connection,
  type ConnectionCategoryFilter,
} from './integrations';

// v3.1 INTEG: Integrations › Connections (decision D11): the apps TailorIT will connect to in a later release, Gmail
// and Google Calendar, each with Connect, which says it is not available yet (MSG_INTEGRATION_COMING_SOON). A search
// and a category filter, as a page of connections has; a card pointing at AI assistants for Claude and ChatGPT.

export function ConnectionsTab({ onOpenAiAssistants }: { onOpenAiAssistants: () => void }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ConnectionCategoryFilter>('all');
  const [soon, setSoon] = useState<Connection | null>(null);
  const shown = filterConnections(CONNECTIONS, query, category);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <SearchPill value={query} onValueChange={setQuery} placeholder={CONNECTIONS_COPY.search} className="min-w-0 flex-1 basis-60 sm:max-w-sm" />
        <Select
          aria-label={CONNECTIONS_COPY.category}
          options={CONNECTION_CATEGORIES}
          value={category}
          onValueChange={setCategory}
          className="w-44"
        />
      </div>

      {shown.length === 0 ? (
        <Card padding="none">
          <EmptyState
            size="sm"
            icon={<MagnifyingGlassIcon size={22} />}
            title={CONNECTIONS_COPY.noMatchTitle(query.trim() || categoryOf(category))}
            description={CONNECTIONS_COPY.noMatchHint}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery('');
                  setCategory('all');
                }}
              >
                {CONNECTIONS_COPY.clear}
              </Button>
            }
          />
        </Card>
      ) : (
        <ul aria-label={CONNECTIONS_COPY.list} className="grid gap-4 sm:grid-cols-2">
          {shown.map((item) => (
            <ConnectionCard key={item.id} item={item} onConnect={() => setSoon(item)} />
          ))}
        </ul>
      )}

      <Card tone="muted" className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="text-[15px] leading-5 font-semibold text-foreground">{CONNECTIONS_COPY.aiTitle}</p>
          <HelpTip label={CONNECTIONS_COPY.aiTitle}>{CONNECTIONS_COPY.aiBody}</HelpTip>
        </div>
        <Button variant="link" trailingIcon={<ArrowRightIcon size={14} aria-hidden />} onClick={onOpenAiAssistants}>
          {CONNECTIONS_COPY.aiLink}
        </Button>
      </Card>

      <ComingSoonDialog item={soon} onClose={() => setSoon(null)} />
    </div>
  );
}

function categoryOf(category: ConnectionCategoryFilter): string {
  return category === 'all' ? '' : categoryLabel(category);
}

/** One app's card: its mark, name, category, what it will do, Connect. */
export function ConnectionCard({ item, onConnect }: { item: Connection; onConnect: () => void }) {
  const nameId = useId();
  return (
    <Card as="li" aria-labelledby={nameId} className="flex flex-col gap-4" data-connection={item.id}>
      <div className="flex items-start gap-3">
        <ClientMark kind={item.id} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5">
              <h3 id={nameId} className="text-[15px] leading-5 font-semibold text-foreground">
                {item.name}
              </h3>
              <HelpTip label={item.name}>{item.summary}</HelpTip>
            </span>
            <Badge tone="neutral">{CONNECTIONS_COPY.comingSoon}</Badge>
          </div>
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{categoryLabel(item.category)}</p>
        </div>
      </div>
      <div className="mt-auto flex justify-end">
        <Button variant="outline" aria-label={`${CONNECTIONS_COPY.connect} ${item.name}`} onClick={onConnect}>
          {CONNECTIONS_COPY.connect}
        </Button>
      </div>
    </Card>
  );
}

/** Connect on an app TailorIT does not connect to yet: "Gmail isn't available yet. It's coming soon." */
export function ComingSoonDialog({ item, onClose }: { item: Connection | null; onClose: () => void }) {
  const { t } = usePublicConstants();
  // Keep the last app's words while the dialog closes.
  const [last, setLast] = useState<Connection | null>(item);
  if (item && item !== last) setLast(item);
  const shown = item ?? last;
  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="sm"
        title={
          <span className="flex items-center gap-3">
            {shown && <ClientMark kind={shown.id} size={32} />}
            {shown?.name}
          </span>
        }
        description={shown ? t('MSG_INTEGRATION_COMING_SOON', { name: shown.name }) : undefined}
      >
        <DialogFooter>
          <Button onClick={onClose}>{CONNECTIONS_COPY.ok}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
