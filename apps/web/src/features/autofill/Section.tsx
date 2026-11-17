'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * The level of a card's heading: 2 on a tab of its own, 3 inside the profile wizard (v1.4 E), whose step title is the
 * h2 above the cards.
 */
export const SectionHeadingLevel = createContext<2 | 3>(2);

/** A card of Settings › Autofill: Simplify's settings section, with an optional button at its top right. */
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
    <section
      id={id}
      tabIndex={id ? -1 : undefined}
      className="scroll-mt-20 rounded-surface border border-border bg-surface p-6 shadow-soft outline-none"
      aria-label={title}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Heading className="text-base leading-6 font-semibold text-foreground">{title}</Heading>
          {description && <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}
