'use client';

// Relative, not '@/': the web tests draw the panes that use these.
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { WarningCircleIcon } from '../ui/icons';
import { HelpTip } from '../ui/HelpTip';

// v32 LAYOUT (E4): a queue pane's read that failed, without a banner. Nothing could be read: the pane's body says so in
// its place, with Try again (an alert, as the error notice was). A later read failed while rows are shown: a small
// "Out of date" mark beside the pane's title, its sentence in a "?", and Try again.

export function PaneLoadFailed({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <div role="alert" data-pane-load-failed="" className="flex flex-col items-center gap-2 px-5 py-10 text-center">
      <span aria-hidden="true" className="mb-1 flex size-10 items-center justify-center rounded-card bg-danger-soft text-danger">
        <WarningCircleIcon size={20} />
      </span>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="max-w-sm text-[13px] leading-5 text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" className="mt-2 max-sm:h-11" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** The words of the mark and its "?" (the pane's rows may be older than they look). */
export const OUT_OF_DATE = {
  label: 'Out of date',
  tip: 'The last refresh failed, so what is shown may be out of date.',
  retry: 'Try again',
} as const;

export function PaneOutOfDate({ onRetry }: { onRetry: () => void }) {
  return (
    <span className="inline-flex items-center gap-1" data-pane-out-of-date="">
      <Badge tone="warning" icon={<WarningCircleIcon size={13} weight="fill" aria-hidden="true" />}>
        {OUT_OF_DATE.label}
      </Badge>
      <HelpTip label={OUT_OF_DATE.label}>{OUT_OF_DATE.tip}</HelpTip>
      <Button variant="link" size="sm" className="h-auto px-1 max-sm:min-h-11" onClick={onRetry}>
        {OUT_OF_DATE.retry}
      </Button>
    </span>
  );
}
