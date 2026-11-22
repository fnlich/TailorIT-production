'use client';

import type { PublicConstants } from '@tailorit/shared/constants';
import { clsx } from 'clsx';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { CaretDownIcon } from '@/components/ui/icons';
import { SearchPill } from '@/components/ui/SearchPill';
import { GuideProvider, type GuideValues } from './context';
import { LinkIcon } from './icons';
import {
  filterSections,
  matchLine,
  searchScroll,
  searchWords,
  sectionOf,
  sectionsFor,
  type GuideFrame,
  type GuideSection,
  type GuideTopic,
  type ShownSection,
  type TopicTexts,
} from './model';
import { GUIDE_SECTIONS } from './sections';

// v34 HELP (PLAN G6): the guide's layout, the same in both frames. From 1024 px the section list sits beside the
// content (sticky, rows modelled on Documents' vertical list: 40 px, the current one white with a denim edge), with the
// topics of the section in view under it (review #41); on a phone one column under a sticky bar (the search and a
// Contents button, Escape closes the list). Every section and topic is on the page at once (a deep link such as
// /help#mcp-prompts scrolls to it, and the public page reads in full without script). Review #42: the 13 sections are
// the page's regions; a topic is a heading (h3) with its own link beside it, not a region of its own. The search box
// filters sections and topics by title, and by each topic's text once the page has drawn it; a deep link to a part the
// search hides clears it.

/** Where a heading stops under the sticky bars when a link scrolls to it (the app has the 56 px top bar). */
const SCROLL_MARGIN: Readonly<Record<GuideFrame, string>> = {
  app: 'scroll-mt-[calc(var(--spacing-topbar)+5rem)] lg:scroll-mt-[calc(var(--spacing-topbar)+1rem)]',
  public: 'scroll-mt-20 lg:scroll-mt-6',
};
/** The section list's place: sticky beside the content from 1024 px, a sticky bar under the top bar below it. */
const STICKY: Readonly<Record<GuideFrame, string>> = {
  app: 'top-[var(--spacing-topbar)] lg:top-[calc(var(--spacing-topbar)+1.75rem)] lg:max-h-[calc(100dvh-var(--spacing-topbar)-3.5rem)]',
  public: 'top-0 lg:top-6 lg:max-h-[calc(100dvh-3rem)]',
};
/** How far under the window's top a section or topic counts as the one being read (more under a phone's bars). */
const READING_LINE_PX = { wide: 140, narrow: 200 } as const;

export interface GuideProps {
  frame: GuideFrame;
  values: PublicConstants;
  isAdmin: boolean;
  /** The sections to draw (GUIDE_SECTIONS); a test may pass others. */
  sections?: readonly GuideSection[];
  className?: string;
}

export function Guide({ frame, values, isAdmin, sections = GUIDE_SECTIONS, className }: GuideProps) {
  const visible = useMemo(() => sectionsFor(sections, frame, isAdmin), [sections, frame, isAdmin]);
  const [query, setQuery] = useState('');
  const [texts, setTexts] = useState<TopicTexts | undefined>(undefined);
  const [contentsOpen, setContentsOpen] = useState(false);
  const shown = useMemo(() => filterSections(visible, query, texts), [visible, query, texts]);
  const inView = useInView(shown);
  const contentsId = useId();
  const contentsButton = useRef<HTMLButtonElement>(null);
  const context = useMemo<GuideValues>(() => ({ frame, values, isAdmin }), [frame, values, isAdmin]);

  // A deep link: scroll to its section or topic once it is drawn (AuthGate draws the page after sign-in, so the
  // browser's own jump has nothing to land on); one the search hides clears the search, then scrolls once drawn.
  const pending = useRef<string | null>(null);
  useEffect(() => {
    const follow = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id || !sectionOf(visible, id)) return;
      const element = document.getElementById(id);
      if (element) {
        element.scrollIntoView({ block: 'start' });
        return;
      }
      pending.current = id;
      setQuery('');
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [visible]);
  useEffect(() => {
    const id = pending.current;
    const element = id ? document.getElementById(id) : null;
    if (!element) return;
    element.scrollIntoView({ block: 'start' });
    pending.current = null;
  }, [shown]);

  /**
   * The search: on its first word, each topic's text is read from the page (every topic is drawn until then). A new
   * query shows its results from their start (v34 FIX-COPY, final review U-L5).
   */
  const search = useCallback(
    (next: string) => {
      if (!texts && next.trim()) {
        const read = new Map<string, readonly string[]>();
        for (const section of visible) {
          for (const topic of section.topics) {
            const text = document.getElementById(topic.id)?.textContent;
            if (text) read.set(topic.id, searchWords(text));
          }
        }
        setTexts(read);
      }
      const scroll = searchScroll(query, next);
      if (scroll) window.scrollTo(scroll);
      setQuery(next);
    },
    [query, texts, visible],
  );
  const clear = useCallback(() => setQuery(''), []);
  const line = matchLine(shown.length, query);
  const searching = query.trim() !== '';

  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !contentsOpen) return;
    event.preventDefault();
    setContentsOpen(false);
    contentsButton.current?.focus();
  };

  return (
    <GuideProvider value={context}>
      <div data-guide={frame} className={clsx('flex flex-col gap-6 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start lg:gap-8', className)}>
        <aside
          aria-label="Guide"
          onKeyDown={closeOnEscape}
          className={clsx(
            'sticky z-10 -mx-4 flex min-w-0 flex-col gap-2 bg-canvas px-4 py-2 sm:-mx-6 sm:px-6',
            'lg:z-auto lg:mx-0 lg:gap-3 lg:overflow-y-auto lg:bg-transparent lg:px-0 lg:py-0 lg:pb-2',
            STICKY[frame],
          )}
          data-guide-bar=""
        >
          <div className="flex min-w-0 items-center gap-2 lg:block">
            <SearchPill
              value={query}
              onValueChange={search}
              placeholder="Search the guide"
              label="Search the guide"
              className="flex-1"
              data-guide-search=""
            />
            <button
              ref={contentsButton}
              type="button"
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-3 text-sm font-medium text-foreground lg:hidden"
              aria-expanded={contentsOpen}
              aria-controls={`${contentsId}-contents`}
              onClick={() => setContentsOpen((open) => !open)}
              data-guide-contents=""
            >
              Contents
              <CaretDownIcon size={16} className={clsx('transition-transform duration-150', contentsOpen && 'rotate-180')} />
            </button>
          </div>
          <p role="status" className="sr-only" data-guide-status="">
            {line}
          </p>
          <nav
            id={`${contentsId}-contents`}
            aria-label="Guide sections"
            className={clsx(
              !contentsOpen && 'max-lg:hidden',
              'max-lg:max-h-[60dvh] max-lg:overflow-y-auto max-lg:rounded-control max-lg:border max-lg:border-border max-lg:bg-surface max-lg:p-1.5 max-lg:shadow-card',
            )}
            data-guide-nav=""
          >
            <ul className="flex flex-col gap-1">
              {shown.map((entry) => (
                <SectionLink
                  key={entry.section.id}
                  entry={entry}
                  current={inView.section === entry.section.id}
                  currentTopic={inView.topic}
                  searching={searching}
                  onFollow={() => setContentsOpen(false)}
                />
              ))}
            </ul>
          </nav>
        </aside>

        <div className="flex min-w-0 flex-col gap-6" data-guide-content="">
          {shown.length === 0 ? (
            <div className="rounded-card border border-border bg-surface p-6 shadow-card">
              <EmptyState
                title={line}
                nextStep="Try another word, such as Claude, filters or queue."
                action={
                  <Button variant="outline" size="sm" onClick={clear}>
                    Clear search
                  </Button>
                }
              />
            </div>
          ) : (
            shown.map((entry) => <SectionCard key={entry.section.id} entry={entry} frame={frame} />)
          )}
        </div>
      </div>
    </GuideProvider>
  );
}

/**
 * The section and the topic being read: the last whose top has passed the reading line (the first section before any
 * has; no topic before the section's first).
 */
function useInView(shown: readonly ShownSection[]): { section: string | null; topic: string | null } {
  const key = shown.map((entry) => `${entry.section.id}:${entry.topics.map((topic) => topic.id).join(',')}`).join(' ');
  const [state, setState] = useState<{ section: string | null; topic: string | null }>({ section: shown[0]?.section.id ?? null, topic: null });
  useEffect(() => {
    const layout = key ? key.split(' ').map((part) => ({ id: part.split(':')[0]!, topics: (part.split(':')[1] ?? '').split(',').filter(Boolean) })) : [];
    let frame = 0;
    const measure = () => {
      frame = 0;
      const line = window.innerWidth >= 1024 ? READING_LINE_PX.wide : READING_LINE_PX.narrow;
      const passed = (id: string) => {
        const element = document.getElementById(id);
        return element !== null && element.getBoundingClientRect().top <= line;
      };
      let section = layout[0] ?? null;
      for (const entry of layout) if (passed(entry.id)) section = entry;
      let topic: string | null = null;
      for (const id of section?.topics ?? []) if (passed(id)) topic = id;
      setState((previous) => (previous.section === (section?.id ?? null) && previous.topic === topic ? previous : { section: section?.id ?? null, topic }));
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [key]);
  return state;
}

/**
 * A row of the section list (40 px; the section in view white with the denim edge) and, under the section in view or
 * a section the search shows in part, its topics.
 */
function SectionLink({
  entry,
  current,
  currentTopic,
  searching,
  onFollow,
}: {
  entry: ShownSection;
  current: boolean;
  currentTopic: string | null;
  searching: boolean;
  onFollow: () => void;
}) {
  const SectionIcon: ComponentType<{ size?: number; className?: string }> = entry.section.icon;
  const topics = (searching && !entry.whole) || current ? entry.topics : [];
  return (
    <li>
      <a
        href={`#${entry.section.id}`}
        onClick={onFollow}
        aria-current={current ? 'location' : undefined}
        data-guide-link={entry.section.id}
        className={clsx(
          'group/link relative flex h-10 items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors duration-150',
          'focus-visible:outline-offset-[-2px]',
          current
            ? 'border border-border bg-surface text-primary-ink shadow-card'
            : 'border border-transparent text-muted-foreground hover:bg-hover hover:text-foreground',
        )}
      >
        {current && <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-primary" />}
        <SectionIcon size={18} className={current ? 'text-primary' : 'text-muted-foreground'} />
        <span className="min-w-0 truncate">{entry.section.title}</span>
      </a>
      {topics.length > 0 && (
        <ul className="mt-0.5 mb-1 flex flex-col gap-0.5 pl-10" data-guide-topic-links={entry.section.id}>
          {topics.map((topic) => (
            <li key={topic.id}>
              <a
                href={`#${topic.id}`}
                onClick={onFollow}
                aria-current={current && currentTopic === topic.id ? 'true' : undefined}
                className={clsx(
                  'block rounded-tag px-2 py-1 text-[13px] leading-5 hover:bg-hover hover:text-foreground',
                  current && currentTopic === topic.id ? 'font-semibold text-primary-ink' : 'text-muted-foreground',
                )}
              >
                {topic.title}
              </a>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** One section: a white card with its title (h2) and its topics (an h3 each, with its own link beside it). */
function SectionCard({ entry, frame }: { entry: ShownSection; frame: GuideFrame }) {
  const { section } = entry;
  const SectionIcon: ComponentType<{ size?: number; className?: string }> = section.icon;
  const titleId = `${section.id}-title`;
  return (
    <section
      id={section.id}
      aria-labelledby={titleId}
      data-guide-section={section.id}
      className={clsx('min-w-0 rounded-card border border-border bg-surface shadow-card', SCROLL_MARGIN[frame])}
    >
      <header className="flex items-center gap-2.5 border-b border-border px-4 py-4 sm:px-6">
        <span aria-hidden="true" className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-primary-soft text-primary-ink">
          <SectionIcon size={18} />
        </span>
        <h2 id={titleId} className="text-heading font-semibold text-foreground">
          {section.title}
        </h2>
      </header>
      <div className="flex flex-col gap-8 px-4 py-5 sm:px-6">
        {entry.topics.map((topic) => (
          <TopicBlock key={topic.id} topic={topic} frame={frame} />
        ))}
      </div>
    </section>
  );
}

function TopicBlock({ topic, frame }: { topic: GuideTopic; frame: GuideFrame }) {
  const Body = topic.Body;
  return (
    <div id={topic.id} data-guide-topic={topic.id} className={clsx('flex min-w-0 flex-col gap-3', SCROLL_MARGIN[frame])}>
      <div className="group/topic flex items-center gap-1.5">
        <h3 className="text-base leading-6 font-semibold text-foreground">{topic.title}</h3>
        <a
          href={`#${topic.id}`}
          aria-label={`Link to ${topic.title}`}
          className="inline-flex size-6 items-center justify-center rounded-tag text-subtle-foreground opacity-0 transition-opacity group-hover/topic:opacity-100 hover:text-primary-ink focus-visible:opacity-100"
        >
          <LinkIcon size={14} />
        </a>
      </div>
      <Body />
    </div>
  );
}
