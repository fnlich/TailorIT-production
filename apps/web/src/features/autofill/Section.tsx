'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { HelpTip } from '@/components/ui/HelpTip';

/**
 * The level of a card's heading: 2 on a tab of its own, 3 inside the profile wizard (v1.4 E), whose step title is the
 * h2 above the cards.
 */
export const SectionHeadingLevel = createContext<2 | 3>(2);

/**
 * A card of Settings › Autofill: its title with its description in a "?" beside it (v32 COPY, E5), an optional button
 * at its top right, then its content. A white `Card` on the page's canvas, the title in the section-heading style.
 */
export function Section({
  id,
  title,
  description,
  action,
  children,
}: {
  /** For a link to the card ("Answer these once" links each answer's card). Such a card takes focus when linked to. */
  id?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const Heading = useContext(SectionHeadingLevel) === 3 ? 'h3' : 'h2';
  return (
    <Card
      as="section"
      padding="none"
      id={id}
      tabIndex={id ? -1 : undefined}
      className="scroll-mt-[calc(var(--spacing-topbar)_+_16px)] p-5 outline-none sm:p-6"
      aria-label={title}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-1.5">
          <Heading className="text-heading font-semibold text-foreground">{title}</Heading>
          {description ? <HelpTip label={title}>{description}</HelpTip> : null}
        </div>
        {action}
      </div>
      <div className="mt-5">{children}</div>
    </Card>
  );
}
