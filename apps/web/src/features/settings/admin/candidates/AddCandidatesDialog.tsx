'use client';

import { ADMIN_CANDIDATES_ADD_MAX, JOB_SOURCE_KIND_LABEL, type AdminCandidatesAddResult, type JobSourceKind } from '@tailorit/shared/sourcing';
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { userMessage } from '@/lib/api';
import { addCandidates } from './api';
import { notBoardEntries, parseEntries } from './candidates';

// v30 S2: Admin › Candidates › Add boards (12 §4.1 signal 7): board addresses (a posting's or a board's page, which
// name their own kind) or bare names (of the kind chosen), one per line; each becomes a candidate that validation reads
// once, as discovery's own finds. A board a source reads already, or an opted-out company's, is answered as such.

/** The kinds a bare name may be. */
const NAME_KINDS: readonly JobSourceKind[] = ['greenhouse', 'lever', 'ashby', 'workable'];

export function AddCandidatesDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (result: AdminCandidatesAddResult) => void;
}) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<JobSourceKind>('greenhouse');
  const [error, setError] = useState<string | null>(null);
  const entries = parseEntries(text);
  const tooMany = entries.length > ADMIN_CANDIDATES_ADD_MAX;
  // v30 FIX-WEB (UX-17): free text is no board: said here, and the server refuses it.
  const notBoards = notBoardEntries(entries);

  const add = useMutation({
    mutationFn: () => addCandidates({ entries, kind }),
    onSuccess: (result) => {
      onAdded(result);
      setText('');
      onOpenChange(false);
    },
    onError: (failure) => setError(userMessage(failure)),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    add.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent title="Add boards" help="Each is read once, then becomes a source if it lists jobs." size="lg">
        <form onSubmit={submit} className="mt-5 flex flex-col gap-4">
          <Field
            label="Board addresses or names"
            hint={`One per line, a board's address or name, ${ADMIN_CANDIDATES_ADD_MAX.toLocaleString('en-US')} at a time.`}
            error={tooMany ? `Add ${ADMIN_CANDIDATES_ADD_MAX.toLocaleString('en-US')} boards at a time.` : undefined}
          >
            <Textarea rows={6} value={text} onChange={(event) => setText(event.target.value)} placeholder="https://boards.greenhouse.io/acme" />
          </Field>
          <Field label="A bare name is a board of" className="max-w-xs">
            <Select
              options={NAME_KINDS.map((value) => ({ value, label: JOB_SOURCE_KIND_LABEL[value] }))}
              value={kind}
              onValueChange={setKind}
            />
          </Field>
          {notBoards.length > 0 && (
            <Notice tone="warning" title={notBoards.length === 1 ? 'One line is not a board' : `${notBoards.length.toLocaleString('en-US')} lines are not boards`}>
              {'A board is an address or one word (its name), so these are refused: '}
              {notBoards
                .slice(0, 3)
                .map((entry) => `"${entry}"`)
                .join(', ')}
              {notBoards.length > 3 ? `, and ${(notBoards.length - 3).toLocaleString('en-US')} more` : ''}.
            </Notice>
          )}
          {error && <Notice tone="error">{error}</Notice>}
          <DialogFooter flush className="mt-2">
            <Button type="submit" loading={add.isPending} disabled={entries.length === 0 || tooMany}>
              {entries.length > 1 ? `Add ${entries.length.toLocaleString('en-US')} boards` : 'Add board'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

