'use client';

import { EnvelopeSimpleIcon } from '@phosphor-icons/react/EnvelopeSimple';
import { Tabs } from '@base-ui/react/tabs';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, type ReactNode } from 'react';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { CountBadge } from '@/components/ui/Badge';
import { CirclesFourIcon, FileTextIcon } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { usePublicConstants, type PublicMessageKey } from '@/lib/constants';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { fetchLetters, fetchTemplates, letterKeys, templateKeys } from '../letter-editor/data';
import { fetchResumes, resumeKeys } from '../resume-editor/api';
import { CoverLettersTab } from './cover-letters/CoverLettersTab';
import { HeaderUploadButton, HeaderUploadProvider, useHeaderUploadState } from './headerUpload';
import { NewDocumentMenu } from './NewDocumentMenu';
import { ResumesTab } from './resumes/ResumesTab';
import { TemplatesTab } from './templates/TemplatesTab';

// v31 FIX-DOCS: each section's name and line are constants (one source).
export const DOCUMENT_TABS = [
  { value: 'resumes', label: 'LABEL_DOCS_RESUMES', intro: 'MSG_DOCS_RESUMES_INTRO' },
  { value: 'cover-letters', label: 'LABEL_DOCS_LETTERS', intro: 'MSG_DOCS_LETTERS_INTRO' },
  { value: 'templates', label: 'LABEL_DOCS_TEMPLATES', intro: 'MSG_DOCS_TEMPLATES_INTRO' },
] as const satisfies ReadonlyArray<{ value: string; label: PublicMessageKey; intro: PublicMessageKey }>;

export type DocumentsTab = (typeof DOCUMENT_TABS)[number]['value'];

/** `?tab=cover-letters` / `?tab=templates`; anything else (missing, a typo) is Resumes. */
export function readDocumentsTab(value: string | null | undefined): DocumentsTab {
  return DOCUMENT_TABS.some((tab) => tab.value === value) ? (value as DocumentsTab) : 'resumes';
}

export function documentsHref(tab: DocumentsTab): string {
  return `/documents?tab=${tab}`;
}

const ICONS: Record<DocumentsTab, ReactNode> = {
  resumes: <FileTextIcon size={18} />,
  'cover-letters': <EnvelopeSimpleIcon size={18} />,
  templates: <CirclesFourIcon size={18} />,
};

/** How many documents each section holds (the lists the sections read, shared through React Query); null until read. */
function useSectionCounts(): Record<DocumentsTab, number | null> {
  const resumes = useQuery({ queryKey: resumeKeys.list(), queryFn: ({ signal }) => fetchResumes(signal) });
  const letters = useQuery({ queryKey: letterKeys.all, queryFn: fetchLetters });
  const templates = useQuery({ queryKey: templateKeys.all, queryFn: fetchTemplates });
  return {
    resumes: resumes.data?.length ?? null,
    'cover-letters': letters.data?.items.length ?? null,
    templates: templates.data?.items.length ?? null,
  };
}

/**
 * v31 FIX-DOCS (REV-UX UX-1): the Documents page as TailorIT's library. The page header ("Documents", its line, Upload
 * and the New ⌄ menu: Resume, Cover letter, Letter template), then two columns: the Library's sections (Resumes,
 * Cover letters, Templates, each with how many it holds; a vertical list from 1024 px, a segmented track above the
 * library on narrower screens) and the shown section in one panel (its name, count and line over its toolbar, grid
 * or list). The section is `?tab=` (reload and Back land on it). The sections are one ARIA tab list: arrows move
 * between them (up and down in the column, left and right in the track).
 */
export function DocumentsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = readDocumentsTab(searchParams.get('tab'));
  const { t } = usePublicConstants();
  const counts = useSectionCounts();
  const upload = useHeaderUploadState();
  const column = useMediaQuery('(min-width: 1024px)', true);
  const ids = useId();

  const selectTab = (next: DocumentsTab) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div className={clsx('mx-auto w-full max-w-[1600px] pt-7 pb-16', PAGE_GUTTER)}>
      <PageHeader
        title="Documents"
        description={t('MSG_DOCS_PAGE_DESCRIPTION')}
        actions={
          <>
            <HeaderUploadButton action={upload.actions[tab]} />
            <NewDocumentMenu />
          </>
        }
      />

      <HeaderUploadProvider register={upload.register}>
        <Tabs.Root
          value={tab}
          onValueChange={(next) => selectTab(next as DocumentsTab)}
          orientation={column ? 'vertical' : 'horizontal'}
          className="mt-6 grid items-start gap-4 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-7"
        >
          <div className="min-w-0 lg:sticky lg:top-[calc(var(--spacing-topbar)+1.75rem)]">
            <p
              aria-hidden="true"
              className="mb-2 px-3 text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase max-lg:sr-only"
            >
              {t('LABEL_DOCS_LIBRARY')}
            </p>
            <Tabs.List
              activateOnFocus
              aria-label="Document types"
              className={clsx(
                // Phones and tablets: one segmented track across the column, 44 px tall (touch targets).
                'flex h-11 w-full items-stretch rounded-control bg-surface-muted shadow-[inset_0_0_0_1px_var(--color-border)]',
                // From 1024 px: a column of rows on the canvas.
                'lg:h-auto lg:flex-col lg:gap-1 lg:bg-transparent lg:shadow-none',
              )}
            >
              {DOCUMENT_TABS.map((section) => (
                <Tabs.Tab
                  key={section.value}
                  value={section.value}
                  data-documents-section={section.value}
                  className={clsx(
                    'group/section relative isolate flex min-w-0 flex-1 items-center justify-center gap-2 rounded-control px-2 text-sm font-medium whitespace-nowrap',
                    'text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-offset-[-2px]',
                    // The track's raised tile (phones), drawn 2 px inside the segment.
                    "before:absolute before:inset-0.5 before:-z-10 before:rounded-tag before:transition-[background-color,box-shadow] before:duration-150 before:content-['']",
                    'data-active:text-primary-ink data-active:before:bg-surface data-active:before:shadow-card',
                    // The column's rows: 40 px, the shown one white with a denim edge.
                    'lg:h-10 lg:flex-none lg:justify-start lg:gap-3 lg:px-3 lg:before:inset-0 lg:before:rounded-control',
                    'lg:hover:before:bg-hover lg:data-active:before:border lg:data-active:before:border-border lg:data-active:hover:before:bg-surface',
                    "lg:after:absolute lg:after:inset-y-2 lg:after:left-0 lg:after:w-[3px] lg:after:rounded-full lg:after:content-['']",
                    'lg:data-active:after:bg-primary',
                  )}
                >
                  <span aria-hidden="true" className="hidden text-muted-foreground group-data-active/section:text-primary lg:flex">
                    {ICONS[section.value]}
                  </span>
                  <span className="truncate">{t(section.label)}</span>
                  {/* On a phone the track has no room for the counts; the panel's heading says it. */}
                  {counts[section.value] !== null && (
                    <CountBadge
                      count={counts[section.value] ?? 0}
                      className="shrink-0 group-data-active/section:bg-primary-soft group-data-active/section:text-primary-ink max-sm:hidden lg:ml-auto"
                    />
                  )}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </div>

          <div className="min-w-0">
            {DOCUMENT_TABS.map((section) => (
              <Tabs.Panel key={section.value} value={section.value} className="rounded-card focus-visible:outline-offset-4">
                <SectionPanel id={`${ids}-${section.value}`} title={t(section.label)} count={counts[section.value]} intro={t(section.intro)}>
                  {section.value === 'resumes' ? <ResumesTab /> : section.value === 'cover-letters' ? <CoverLettersTab /> : <TemplatesTab />}
                </SectionPanel>
              </Tabs.Panel>
            ))}
          </div>
        </Tabs.Root>
      </HeaderUploadProvider>
    </div>
  );
}

/** The shown section: one white panel with its name, count and line on top, then the section (toolbar, grid or list). */
function SectionPanel({
  id,
  title,
  count,
  intro,
  children,
}: {
  id: string;
  title: string;
  count: number | null;
  intro: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} data-documents-panel="" className="min-w-0 rounded-card border border-border bg-surface shadow-card">
      <header className="border-b border-border px-4 py-4 sm:px-6">
        <h2 id={id} className="flex items-baseline gap-2 text-heading font-semibold text-foreground">
          {title}
          {count !== null && <span className="num text-sm font-medium text-muted-foreground">{count}</span>}
        </h2>
        <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{intro}</p>
      </header>
      <div className="px-4 pt-4 pb-6 sm:px-6 sm:pt-5">{children}</div>
    </section>
  );
}
