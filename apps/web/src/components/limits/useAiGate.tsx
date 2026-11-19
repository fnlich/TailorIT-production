'use client';

import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { usePublicConstants } from '../../lib/constants';
import { fetchHeaderSummary, HEADER_QUERY_KEY } from '../shell/header/api';
import { aiUsedUp } from './aiUse';
import { LimitDialog } from './LimitDialog';
import { aiUsedUpLimit } from './limits';

// v32 FIX-UX (UXREQ-3, E4): an AI action asked for once today's AI use is spent (and no extra credit is left) opens the
// limit alert when it is pressed (Get extra credit / Subscribe / Not now), never a form that cannot work, nor an error
// banner with "Try again" after it. The header's summary (read on every app page, every minute) says whether it is spent.

/**
 * Today's AI use is spent and no extra credit is left to spend: new AI work would be refused. It reads the header's
 * summary as the header last read it (the cache; it asks for nothing itself, so it needs no signed-in context).
 */
export function useAiUsedUp(): boolean {
  const { data } = useQuery({ queryKey: HEADER_QUERY_KEY, queryFn: () => fetchHeaderSummary(), enabled: false });
  return data ? aiUsedUp({ ...data.ai, creditMicros: data.extraCredit.balanceMicros }) : false;
}

/**
 * An AI dialog's gate: `gated` is decided as the dialog opens (spent: the limit alert shows in the dialog's place) and
 * kept while it stays open, so a poll that changes the header never swaps a running form for the alert. Render
 * `alert` instead of the dialog while `gated`.
 */
export function useAiDialogGate(open: boolean, onOpenChange: (open: boolean) => void): { gated: boolean; alert: ReactNode } {
  const usedUp = useAiUsedUp();
  const { t } = usePublicConstants();
  const [state, setState] = useState(() => ({ open, gated: open && usedUp }));
  let { gated } = state;
  if (state.open !== open) {
    gated = open && usedUp;
    setState({ open, gated });
  }
  return {
    gated,
    alert: gated ? <LimitDialog limit={aiUsedUpLimit(t)} open={open} onOpenChange={onOpenChange} /> : null,
  };
}
