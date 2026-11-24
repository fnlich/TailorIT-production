'use client';

import type { AdminSourceTurnedOffPart, AdminSourcesTurnedOff } from '@tailorit/shared/sourcing';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { dismissTurnedOff, fetchTurnedOff, sourceKeys } from './api';
import { turnedOffTotals, turnedOffWords } from './sources';

// v36 SOURCES (SP v36 PLAN S7): v3.6's one-time notice on Admin › Sources. Migration 0060 turned off every source that
// v3.5's discovery had switched on without an admin; this says how many (untouched since found, or changed since), with
// a filter for them, Enable all (the list's own confirm, on that filter) and Dismiss (for every admin). It shows nothing
// on a server 0060 turned nothing off, or once dismissed.
// v36 FIX-SRC (coordinator decision D6): the boards an admin added from Admin › Candidates are a part of their own,
// "Added from Candidates", never "Untouched since found". (the final ux review's L5): once dismissed, focus goes to the
// page's next control (`onDismissed`: Admin › Sources gives the list's search box), not to the page's top.

/** v36 FIX-SRC (D6): the notice's parts with a filter button of their own, in the order the line names them. */
const PART_BUTTONS: ReadonlyArray<{ part: Exclude<AdminSourceTurnedOffPart, 'all'>; label: string }> = [
  { part: 'untouched', label: 'Untouched since found' },
  { part: 'candidates', label: 'Added from Candidates' },
  { part: 'changed', label: 'Changed since' },
];

/** The notice as drawn (without a server in the web tests). */
export function TurnedOffNoticeView({
  notice,
  onShow,
  onEnableAll,
  onDismiss,
  dismissing = false,
}: {
  notice: NonNullable<AdminSourcesTurnedOff['notice']>;
  /** Filters the list to the notice's sources (all, or one part). */
  onShow: (part: AdminSourceTurnedOffPart) => void;
  /** Filters the list to them and opens Enable all's confirm. */
  onEnableAll: () => void;
  onDismiss: () => void;
  dismissing?: boolean;
}) {
  const words = turnedOffWords(notice);
  const { total, off } = turnedOffTotals(notice);
  // A part's own button only when the notice names two parts or more ("Show them" is the one part otherwise).
  const parts = PART_BUTTONS.filter(({ part }) => notice[part] > 0);
  return (
    <Notice
      tone="info"
      className="mb-4"
      title={words.title}
      action={
        <div className="flex flex-wrap items-center gap-2" data-sources-turned-off-actions="">
          <Button variant="outline" size="sm" className="max-sm:h-11" onClick={() => onShow('all')}>
            Show them
          </Button>
          {parts.length > 1 &&
            parts.map(({ part, label }) => (
              <Button key={part} variant="ghost" size="sm" className="max-sm:h-11" onClick={() => onShow(part)}>
                {label}
              </Button>
            ))}
          {off > 0 && (
            <Button size="sm" className="max-sm:h-11" aria-haspopup="dialog" onClick={onEnableAll}>
              Enable all
            </Button>
          )}
          <Button variant="ghost" size="sm" className="max-sm:h-11" loading={dismissing} onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      }
    >
      <span data-sources-turned-off={total}>{words.description}</span>
    </Notice>
  );
}

/** The notice, read from the server; nothing while there is none. */
export function TurnedOffNotice({
  onShow,
  onEnableAll,
  onDismissed,
}: {
  onShow: (part: AdminSourceTurnedOffPart) => void;
  onEnableAll: () => void;
  /** v36 FIX-SRC (ux L5): once dismissed (the notice and its button gone), where focus goes. */
  onDismissed?: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const notice = useQuery({ queryKey: sourceKeys.turnedOff, queryFn: ({ signal }) => fetchTurnedOff(signal), retry: false });
  const dismiss = useMutation({
    mutationFn: dismissTurnedOff,
    onSuccess: (answer) => {
      queryClient.setQueryData(sourceKeys.turnedOff, answer);
      onDismissed?.();
    },
    onError: (error) => toast.error('The notice was not dismissed', userMessage(error)),
  });
  if (!notice.data?.notice) return null;
  return (
    <TurnedOffNoticeView
      notice={notice.data.notice}
      onShow={onShow}
      onEnableAll={onEnableAll}
      onDismiss={() => dismiss.mutate()}
      dismissing={dismiss.isPending}
    />
  );
}
