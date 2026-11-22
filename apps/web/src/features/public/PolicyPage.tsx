import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { Card } from '@/components/ui/Card';

// v34 PUBLIC: the frame of a public reference page (Privacy, Terms, Support): the title and its date, a short lead, the
// list of its sections (each a deep link, /privacy#retention), then one card holding the sections. One column, as wide
// as Settings (880 px), on every screen.

export interface PolicySectionInfo {
  /** The section's id: its deep link and its heading's id. */
  id: string;
  title: string;
}

/**
 * The date the template text of Privacy and Terms last changed (the operator updates it with any change they make).
 * Shown as "Last updated".
 */
export const POLICY_UPDATED = { iso: '2026-11-22', text: 'November 22, 2026' } as const; // v34 FIX-COPY: D2, D5

export function PolicyPage({
  title,
  updated,
  lead,
  sections,
  children,
  testId,
}: {
  title: string;
  /** Shown as "Last updated …" under the title (Privacy and Terms). */
  updated?: { iso: string; text: string };
  lead: ReactNode;
  sections: readonly PolicySectionInfo[];
  children: ReactNode;
  /** data-public-page's value ("privacy", "terms", "support"). */
  testId: string;
}) {
  return (
    <div className={clsx('mx-auto w-full max-w-[880px] pt-7 pb-20', PAGE_GUTTER)} data-public-page={testId}>
      <h1 className="page-title">{title}</h1>
      {updated && (
        <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
          Last updated <time dateTime={updated.iso}>{updated.text}</time>
        </p>
      )}
      <div className="mt-4 flex max-w-[70ch] flex-col gap-3">{lead}</div>
      <nav aria-labelledby="public-contents" className="mt-6">
        <h2 id="public-contents" className="text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
          On this page
        </h2>
        {/* Two columns from 640 px that read down each column (the review's finding 18), never across the rows. */}
        <ol className="mt-2 gap-x-6 sm:columns-2">
          {sections.map((section) => (
            <li key={section.id} className="break-inside-avoid">
              <a
                href={`#${section.id}`}
                className="inline-flex min-h-9 items-center rounded-control text-sm font-medium text-primary-ink underline-offset-2 hover:underline max-sm:min-h-11"
              >
                {section.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <Card padding="none" className="mt-6">
        <div className="divide-y divide-divider-soft">{children}</div>
      </Card>
    </div>
  );
}

/** One section of the card: its h2 (the deep link's target) and its prose. */
export function PolicySection({ section, children }: { section: PolicySectionInfo; children: ReactNode }) {
  const headingId = `${section.id}-title`;
  return (
    <section id={section.id} aria-labelledby={headingId} className="scroll-mt-6 px-5 py-6 sm:px-7">
      <h2 id={headingId} className="text-heading font-semibold text-foreground">
        {section.title}
      </h2>
      <div className="mt-3 flex max-w-[70ch] flex-col gap-3">{children}</div>
    </section>
  );
}

/** Looks up a section of `sections` by id (so a page writes each title once). */
export function sectionOf<T extends readonly PolicySectionInfo[]>(sections: T, id: T[number]['id']): PolicySectionInfo {
  const found = sections.find((section) => section.id === id);
  if (!found) throw new Error(`No section ${id}`);
  return found;
}
