'use client';

import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Notice } from '@/components/ui/Notice';
import type { PairFailure } from '../extensionBridge';

// The fallback of connecting: the code on screen, for the person to type into the extension's options page. It lives
// ten minutes and works once; the page closes this dialog when the new connection appears (ExtensionTab polls).

// A clock that ticks every second while a dialog shows a countdown (useNow ticks every minute).
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const getSnapshot = () => now;
const stayStill = () => () => {};

/** "9:42". */
function countdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Why the code is shown instead of handed over, when the page tried to hand it over. */
const FAILURE_SENTENCE: Partial<Record<PairFailure, string>> = {
  not_installed: 'TailorIT could not find the extension in this browser, so type the code into it instead.',
  timeout: 'The extension did not answer in time, so type the code into it instead.',
  refused: 'The extension did not take the code, so type it into the extension instead.',
  failed: 'The code could not be handed to the extension, so type it into the extension instead.',
};

export interface CodeOffer {
  /** As the server formats it: "K7QM-2XRD-9VHT-PA3C". */
  code: string;
  expiresAt: string;
  /** The connections that existed when the code was made: a new one means the extension used it. */
  known: ReadonlySet<string>;
  failure: PairFailure;
}

export function ConnectCodeDialog({
  offer,
  open,
  renewing,
  onRenew,
  onClose,
}: {
  offer: CodeOffer;
  open: boolean;
  renewing: boolean;
  onRenew: () => void;
  onClose: () => void;
}) {
  // The clock runs only while the dialog is open.
  const clock = useSyncExternalStore(open ? subscribe : stayStill, getSnapshot, getSnapshot);
  const secondsLeft = Math.max(0, Math.ceil((Date.parse(offer.expiresAt) - clock) / 1000));
  const expired = secondsLeft === 0;
  const failure = FAILURE_SENTENCE[offer.failure];
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title="Type this code into the extension"
        description="Open the TailorIT extension's options page and enter this code to connect this browser."
      >
        {failure && (
          <Notice tone="info" className="mt-4">
            {failure}
          </Notice>
        )}
        <div className="mt-5 flex flex-col items-center gap-1.5 rounded-control bg-surface-low px-4 py-5">
          <output
            aria-label="Connect code"
            className={
              expired
                ? 'font-mono text-2xl font-semibold tracking-[0.12em] text-muted-foreground line-through'
                : 'font-mono text-2xl font-semibold tracking-[0.12em] text-foreground select-all'
            }
          >
            {offer.code}
          </output>
          <p className="text-sm text-muted-foreground tabular-nums">
            {expired ? 'This code has expired.' : `Expires in ${countdown(secondsLeft)}`}
          </p>
        </div>
        <p className="mt-4 text-[13px] leading-5 text-muted-foreground">
          It works once. This dialog closes by itself when the extension connects.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {expired && (
            <Button loading={renewing} onClick={onRenew}>
              Get a new code
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
