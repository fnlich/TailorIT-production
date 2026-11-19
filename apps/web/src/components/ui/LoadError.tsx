'use client';

import type { ReactNode } from 'react';
import { userMessage } from '@/lib/api';
import { Button } from './Button';
import { Notice } from './Notice';

// v32 FIX-UX (UXREQ-13, UXREQ-8): one way to say that something a page reads did not load. Every page drew its own
// ("The jobs could not be loaded" as an empty state with its reason in a "?", "We couldn't load your applications." as
// a red line, "Could not load your resumes"...): now one red Notice (role="alert", so it is announced), its title in
// one pattern, "<Thing> didn't load.", the reason in view under it (never only in a "?"), and Try again.

/** The title of a load error: "<Thing> didn't load." ("Jobs didn't load.", "Your applications didn't load."). */
export function loadErrorTitle(thing: string): string {
  return `${thing} didn't load.`;
}

export interface LoadErrorProps {
  /** What did not load, as the title's subject: "Jobs", "Your applications", "This resume". */
  thing: string;
  /** The error: its words (userMessage) are the reason under the title. */
  error?: unknown;
  /** The reason's words when the error has none of its own. */
  fallback?: string;
  /** Try again; left out, the error has no button (it tries again by itself). */
  onRetry?: () => void;
  /** Another action beside Try again (a link back, say). */
  action?: ReactNode;
  className?: string;
}

export function LoadError({ thing, error, fallback = 'Check your connection, then try again.', onRetry, action, className }: LoadErrorProps) {
  const reason = userMessage(error, fallback);
  return (
    <Notice
      tone="error"
      title={loadErrorTitle(thing)}
      className={className}
      action={
        onRetry || action ? (
          <div className="flex flex-wrap items-center gap-2">
            {onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry} data-load-retry="">
                Try again
              </Button>
            )}
            {action}
          </div>
        ) : undefined
      }
    >
      <span data-load-error-reason="">{reason}</span>
    </Notice>
  );
}
