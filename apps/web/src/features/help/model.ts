import type { ComponentType } from 'react';
import type { Icon } from '@/components/ui/icons';

// v34 HELP (PLAN G6): the User Guide's shape. One content module (sections.ts and content/) drawn in two frames: /help
// in the app (the shell; Admin for administrators) and /guide, public without sign-in (the documentation address of
// Claude's directory; no user data, no Admin). A section is a card of topics; every section and topic has an id that is
// its deep link (/help#mcp-prompts). The search box filters sections and topics by their titles (and a few words each
// section lists), and (review #44) by each topic's text once the page has drawn it.

/** Where the guide is drawn: inside the signed-in app, or on the public page. */
export type GuideFrame = 'app' | 'public';

/** One part of a section: its heading (an h3 with its own deep link) and its prose. */
export interface GuideTopic {
  id: string;
  title: string;
  /** More words the search finds this topic by (other names for it). */
  keywords?: readonly string[];
  Body: ComponentType;
}

/** One card of the guide: an h2, its topics, an icon in the section list. */
export interface GuideSection {
  id: string;
  title: string;
  icon: Icon;
  /** More words the search finds the whole section by ("MCP", "connector"). */
  keywords?: readonly string[];
  /** Shown only in the app, to administrators. */
  adminOnly?: boolean;
  topics: readonly GuideTopic[];
}

/** A section the search leaves, with the topics it shows (all of them when the section itself matched). */
export interface ShownSection {
  section: GuideSection;
  topics: readonly GuideTopic[];
  /** True when the whole section matched (its title or words), false when only some of its topics did. */
  whole: boolean;
}

/** Lower case, accents and punctuation away, so "Prepare & Queue" and "prepare queue" meet. */
export function searchWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether every word of the query starts some word of `haystack` ("conn" finds "Connect"). */
function matches(query: readonly string[], haystack: readonly string[]): boolean {
  return query.every((word) => haystack.some((candidate) => candidate.startsWith(word)));
}

/** The sections `frame` and the person's role show: Admin only in the app, for administrators. */
export function sectionsFor(sections: readonly GuideSection[], frame: GuideFrame, isAdmin: boolean): GuideSection[] {
  return sections.filter((section) => !section.adminOnly || (frame === 'app' && isAdmin));
}

/** Each topic's words as the page draws them (by topic id), for the search to look in a topic's text too. */
export type TopicTexts = ReadonlyMap<string, readonly string[]>;

/**
 * The sections and topics a search shows: a section whose title or words hold every word of the query shows whole;
 * otherwise only its topics whose titles (or words) hold them, or (review #44) whose text does when `texts` is given,
 * under the section's title. An empty query shows all.
 */
export function filterSections(sections: readonly GuideSection[], query: string, texts?: TopicTexts): ShownSection[] {
  const words = searchWords(query);
  if (words.length === 0) return sections.map((section) => ({ section, topics: section.topics, whole: true }));
  const shown: ShownSection[] = [];
  for (const section of sections) {
    if (matches(words, searchWords([section.title, ...(section.keywords ?? [])].join(' ')))) {
      shown.push({ section, topics: section.topics, whole: true });
      continue;
    }
    const topics = section.topics.filter((topic) => {
      if (matches(words, searchWords([topic.title, ...(topic.keywords ?? [])].join(' ')))) return true;
      const text = texts?.get(topic.id);
      return text !== undefined && matches(words, text);
    });
    if (topics.length > 0) shown.push({ section, topics, whole: false });
  }
  return shown;
}

/** The section that holds `id` (its own id or one of its topics'), or null. */
export function sectionOf(sections: readonly GuideSection[], id: string): GuideSection | null {
  return sections.find((section) => section.id === id || section.topics.some((topic) => topic.id === id)) ?? null;
}

/** "3 sections match" for the search's live line. */
export function matchLine(count: number, query: string): string {
  if (!query.trim()) return '';
  if (count === 0) return `No section matches "${query.trim()}"`;
  return `${count} ${count === 1 ? 'section matches' : 'sections match'}`;
}

/**
 * v34 FIX-COPY (final review U-L5): where the page goes when the search changes what it shows. A new query (by its
 * words) goes back to the top of the page, so the results are read from their start even after a deep link or half a
 * page of reading (the search box stays on screen in its sticky bar); the same words, or a space more, stay put. Null:
 * no scroll.
 */
export function searchScroll(previous: string, next: string): { top: number } | null {
  return searchWords(previous).join(' ') === searchWords(next).join(' ') ? null : { top: 0 };
}
