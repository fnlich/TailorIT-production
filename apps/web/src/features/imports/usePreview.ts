'use client';

import type { JobImportPreview } from '@tailorit/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

// v35 IMPORTWEB: a mapping preview that follows the person's choices: each choice asks the API again (POST …/preview),
// the newest ask wins (an older one is cancelled and its answer dropped), and the last answer stays shown while the next
// loads. Nothing is saved by a preview.

export interface PreviewState<C> {
  preview: JobImportPreview | null;
  /** The choices of the preview shown (or of the one loading, when none is shown yet). */
  choices: C | null;
  error: unknown;
  busy: boolean;
  /** Asks for a preview with these choices. */
  ask: (choices: C) => void;
  /** Forgets the preview (a new file, a new link). */
  reset: () => void;
}

export function usePreview<C>(read: (choices: C, signal: AbortSignal) => Promise<JobImportPreview>): PreviewState<C> {
  const [preview, setPreview] = useState<JobImportPreview | null>(null);
  const [choices, setChoices] = useState<C | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  const reader = useRef(read);
  useEffect(() => {
    reader.current = read;
  });
  useEffect(() => () => inFlight.current?.abort(), []);

  const ask = useCallback((next: C) => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const mine = ++sequence.current;
    setBusy(true);
    setError(null);
    reader.current(next, controller.signal).then(
      (answer) => {
        if (mine !== sequence.current) return;
        setPreview(answer);
        setChoices(next);
        setBusy(false);
      },
      (failure: unknown) => {
        if (mine !== sequence.current) return;
        setError(failure);
        setBusy(false);
      },
    );
  }, []);

  const reset = useCallback(() => {
    sequence.current += 1;
    inFlight.current?.abort();
    inFlight.current = null;
    setPreview(null);
    setChoices(null);
    setError(null);
    setBusy(false);
  }, []);

  return { preview, choices, error, busy, ask, reset };
}
