'use client';

import { AlertDialog } from '@base-ui/react/alert-dialog';
import { typedEmailMatches } from '@tailorit/shared/account-deletion';
import { clsx } from 'clsx';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { BACKDROP } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { userMessage } from '@/lib/api';
import { DELETE_COPY, WHAT_GOES } from './copy';

// v34 ACCTDEL (PLAN G10): the confirm dialog of a deletion (Settings › Account › Delete my account; Admin › Users ›
// Delete account). It names what goes, and the delete stays off until the account's email address is typed (as the
// server checks it: trimmed, without case). An alert dialog (Base UI's: no outside-press dismissal; Escape and Cancel
// close it); a refusal stays in it as the server's sentence, and takes the focus.
// v34 ACCTDEL review (spec H1): the kit's ConfirmDialog does not scroll, so on a short screen or at 200 % zoom its title
// and buttons ran off the screen. This dialog is laid out for any height: the popup is at most the window's height, the
// title, the field, a refusal and the buttons keep their size, and the list of what goes is the part that shrinks, in a
// scrolling region a keyboard can reach (focusable, named "What goes"); below a 30rem tall window the paddings shrink,
// and past that the popup itself scrolls. (A kit-level ConfirmDialog fix is noted for the final review.)
// The address in the field's label wraps anywhere (a long address with no hyphen stays readable: spec M1); a long
// name in the title is cut with an ellipsis, its full text in the title's tooltip and in what a screen reader reads.

export interface DeleteAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The account's address, which the person types. */
  email: string;
  /** `self`: your own account (Settings); `admin`: another (Admin › Users), named `who`. */
  mode: 'self' | 'admin';
  who?: string;
  /** Runs the deletion with the typed address; rejects with the server's refusal (shown in the dialog). */
  onConfirm: (typed: string) => Promise<void>;
  /** Where focus goes when the dialog closes (its opener by default). */
  finalFocus?: () => HTMLElement | boolean | null;
}

/** The list of what goes (also drawn by the tests). */
export function WhatGoes({ id }: { id?: string }) {
  return (
    <div>
      <p id={id} className="font-medium text-foreground">
        {DELETE_COPY.listLabel}
      </p>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted-foreground" aria-labelledby={id}>
        {WHAT_GOES.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="mt-2 text-muted-foreground">{DELETE_COPY.stays}</p>
    </div>
  );
}

/** A short window (a phone's browser with its bars, a laptop at 200 % zoom): smaller paddings. */
const SHORT = '[@media(max-height:30rem)]';

export function DeleteAccountDialog({ open, onOpenChange, email, mode, who, onConfirm, finalFocus }: DeleteAccountDialogProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const matches = typedEmailMatches(typed, email);
  const self = mode === 'self';
  const name = who || email;

  // A refusal takes the focus (the pressed button went busy, then off): its sentence is read, and Tab goes on from it.
  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);

  const confirm = async () => {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(typed);
      setTyped('');
      onOpenChange(false);
    } catch (caught) {
      setError(userMessage(caught, 'The account was not deleted. Try again in a moment.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) {
          setTyped('');
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={BACKDROP} />
        <AlertDialog.Viewport className={clsx('fixed inset-0 z-50 flex items-center justify-center p-4', `${SHORT}:p-2`)}>
          <AlertDialog.Popup
            initialFocus={inputRef}
            finalFocus={finalFocus}
            data-delete-account={mode}
            className={clsx(
              'flex max-h-full w-full max-w-md flex-col overflow-y-auto rounded-popup border border-border bg-surface p-6 text-foreground shadow-dialog outline-none',
              `${SHORT}:p-4`,
              'transition-[opacity,scale] duration-200 ease-out-soft data-starting-style:scale-[0.97] data-starting-style:opacity-0',
              'data-ending-style:scale-[0.97] data-ending-style:opacity-0',
            )}
          >
            <AlertDialog.Title className="shrink-0 text-heading font-semibold">
              {self ? (
                DELETE_COPY.titleSelf
              ) : (
                // The cut span holds "<name>'s" whole: an inline-block is read with a space around it.
                <>
                  Delete{' '}
                  <span className="inline-block max-w-full truncate align-bottom" title={name} data-delete-account-name="">
                    {name}&apos;s
                  </span>{' '}
                  account?
                </>
              )}
            </AlertDialog.Title>
            <AlertDialog.Description className={clsx('mt-2 shrink-0 text-sm leading-5 text-muted-foreground', `${SHORT}:mt-1`)}>
              {self ? DELETE_COPY.descriptionSelf : DELETE_COPY.descriptionAdmin}
            </AlertDialog.Description>
            <div
              role="region"
              aria-labelledby={listId}
              tabIndex={0}
              data-delete-account-list=""
              className={clsx(
                'mt-3 min-h-10 shrink overflow-y-auto rounded-control border border-divider-soft px-3 py-2 text-sm leading-5',
                `${SHORT}:mt-2`,
              )}
            >
              <WhatGoes id={listId} />
            </div>
            <Field
              className={clsx('mt-4 shrink-0', `${SHORT}:mt-2`)}
              label={
                <>
                  {DELETE_COPY.typeBefore} <span className="[overflow-wrap:anywhere]">{email}</span> {DELETE_COPY.typeAfter}
                </>
              }
            >
              <Input
                ref={inputRef}
                type="email"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                data-delete-confirm-email=""
              />
            </Field>
            {error && (
              <div ref={alertRef} tabIndex={-1} className={clsx('mt-4 shrink-0 rounded-control outline-none', `${SHORT}:mt-2`)} data-delete-account-refusal="">
                <Notice tone="error">{error}</Notice>
              </div>
            )}
            <div className={clsx('mt-6 flex shrink-0 flex-wrap items-center justify-end gap-2.5', `${SHORT}:mt-3`)}>
              <AlertDialog.Close render={<Button variant="outline" disabled={busy} />}>Cancel</AlertDialog.Close>
              <Button variant="destructive" loading={busy} disabled={!matches} onClick={() => void confirm()}>
                {busy ? DELETE_COPY.busy : self ? DELETE_COPY.confirmSelf : DELETE_COPY.confirmAdmin}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
