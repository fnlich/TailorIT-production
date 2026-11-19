'use client';

import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { CaretDownIcon, CaretRightIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { userMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { fetchReporters, reviewKeys } from './api';
import { peopleText, VIA_LABEL } from './copy';

// v30 X1-WEB: who reported a review, on expand (14 §6.2, §8; owner question 28): administrators only, read only when
// opened, never drawn for anyone else. Other people never see who reported or added a job.

export function ReportersDisclosure({ reviewId, count, name }: { reviewId: number; count: number; name: string }) {
  const { isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!isAdmin || count === 0) return null;
  return (
    <div data-reporters="">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 max-sm:h-11"
        aria-expanded={open}
        aria-controls={panelId}
        // v30 FIX-WEB (REV-UX UX-9): the name starts with the visible words (WCAG 2.5.3, Label in Name); aria-expanded says
        // whether the list is shown.
        aria-label={`Who reported (${peopleText(count)}): ${name}`}
        icon={open ? <CaretDownIcon size={14} aria-hidden="true" /> : <CaretRightIcon size={14} aria-hidden="true" />}
        onClick={() => setOpen((value) => !value)}
      >
        Who reported ({peopleText(count)})
      </Button>
      <div id={panelId} hidden={!open}>
        {open && <ReportersList reviewId={reviewId} />}
      </div>
    </div>
  );
}

function ReportersList({ reviewId }: { reviewId: number }) {
  const now = useNow();
  const reporters = useQuery({ queryKey: reviewKeys.reporters(reviewId), queryFn: ({ signal }) => fetchReporters(reviewId, signal) });
  if (reporters.isError) {
    return (
      <Notice
        tone="error"
        className="mt-2"
        title="The reporters didn't load."
        action={
          <Button variant="outline" size="sm" onClick={() => void reporters.refetch()}>
            Try again
          </Button>
        }
      >
        {userMessage(reporters.error)}
      </Notice>
    );
  }
  if (!reporters.data) {
    return (
      <div aria-busy="true" aria-label="Loading who reported it" className="mt-2 flex flex-col gap-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  return (
    <ul aria-label="Who reported it" className="mt-2 flex flex-col gap-2">
      {reporters.data.items.map((reporter) => (
        <li key={reporter.userId} className="rounded-control border border-border px-3 py-2 text-[13px] leading-5" data-reporter="">
          <p className="font-medium break-all text-foreground">{reporter.name ? `${reporter.name} (${reporter.email})` : reporter.email}</p>
          <p className="text-muted-foreground">
            {VIA_LABEL[reporter.via]} · {relativeTime(reporter.reportedAt, now)}
            {!reporter.trusted && ' · Does not count toward automatic decisions'}
          </p>
        </li>
      ))}
    </ul>
  );
}
