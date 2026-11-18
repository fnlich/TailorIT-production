'use client';

import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Notice } from '@/components/ui/Notice';
import { userMessage } from '@/lib/api';

/**
 * Asked after Apply opens the posting in a new tab: "Applied to this job?" (v31 INT-3: TailorIT's words). Yes tracks
 * the job as Applied today in the Job Tracker; Not yet leaves everything as it was.
 */
export function ApplyDialog({
  open,
  onOpenChange,
  company,
  title,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  company: string;
  title: string;
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Applied to this job?"
        description={`If you sent your application for ${title} at ${company}, Yes files it in your Job Tracker under Applied, dated today.`}
        size="sm"
      >
        {error ? (
          <Notice tone="error" className="mt-4">
            {userMessage(error)}
          </Notice>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Not yet
          </Button>
          <Button onClick={onConfirm} loading={pending}>
            Yes, I applied
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
