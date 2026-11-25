'use client';

import { JOB_REVIEW_NOTE_MAX } from '@tailorit/shared/reviews';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { usePublicConstants } from '@/lib/constants';
import { noteProblem } from './copy';

// v30 X1-WEB: the select mode's confirm (14 §6.2: "an action bar with Approve and Reject (an optional note)"): how many
// rows, what the action does, and an optional note kept with each decision. The Flags lane's Resolve and Dismiss take
// no note (job_reports keeps none).

export type BulkAction = 'approve' | 'reject' | 'resolved' | 'dismissed';

const TITLE: Record<BulkAction, string> = { approve: 'Approve', reject: 'Reject', resolved: 'Resolve', dismissed: 'Dismiss' };
/** What each decision does (v37 FIX-REV: exported for its test). */
export const WHAT: Record<BulkAction, string> = {
  approve: "A closed link closes as if its own read found it gone; a new job joins everyone's job search.",
  reject: 'Closed links stay open; new jobs stay with the people who added them.',
  // v37 FIX-REV (REVIEW361-ux L8): what each decision does, before it does it; the job is never touched.
  resolved: 'Each flag is marked resolved; its job is not changed.',
  dismissed: 'Each flag is marked dismissed; its job is not changed.',
};

export function BulkDialog({
  action,
  count,
  thing,
  onCancel,
  onConfirm,
}: {
  /** The action asked for, or null while the dialog is closed. */
  action: BulkAction | null;
  count: number;
  /** "review" or "flag". */
  thing: string;
  onCancel: () => void;
  onConfirm: (action: BulkAction, note: string) => void;
}) {
  const { t } = usePublicConstants();
  const [note, setNote] = useState('');
  const takesNote = action === 'approve' || action === 'reject';
  const problem = takesNote ? noteProblem(note, JOB_REVIEW_NOTE_MAX, (max) => t('MSG_TEXT_TOO_LONG', { max })) : null;
  const close = () => {
    setNote('');
    onCancel();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!action || problem) return;
    onConfirm(action, takesNote ? note.trim() : '');
    setNote('');
  };
  const things = `${count} ${count === 1 ? thing : `${thing}s`}`;
  return (
    <Dialog open={action !== null} onOpenChange={(open) => !open && close()}>
      {action && (
        <DialogContent title={`${TITLE[action]} ${things}?`} description={WHAT[action]} size="md">
          <form onSubmit={submit} className="mt-5 flex flex-col gap-5">
            {takesNote && (
              <Field label="Note" optional error={problem ?? undefined} hint="Kept with each decision, as plain text.">
                <Textarea value={note} rows={2} onChange={(event) => setNote(event.target.value)} />
              </Field>
            )}
            <DialogFooter flush>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" variant={action === 'reject' || action === 'dismissed' ? 'destructive' : 'primary'} disabled={problem !== null}>
                {TITLE[action]} {things}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}
