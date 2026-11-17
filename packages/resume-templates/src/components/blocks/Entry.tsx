// @jsxRuntime automatic
// @jsxImportSource react
import { Fragment, type ReactNode } from 'react';
import type { DetailView, EntryView, RichView, SectionView } from '../../model/view';
import { useSlots } from '../../slots';
import { CalendarIcon, LinkIcon, MapPinIcon } from '../icons';
import { blockOptions, cx, entryHeadOf, type BlockLook } from './options';
import { LanguageEntry, StrengthEntry } from './ShortEntries';

// One entry of a section, Enhancv's way: what it is (a role, a degree), where (the company, the school), a row of
// when, where and a link, short facts, then the description and the bullets. Other templates draw the head in other
// shapes (the look's `entryHead`, per kind where it says so): classic two lines with the place and the dates on the
// right, a split head (the dates right of the title, the rest on one line under it), a title over one line of
// details, or everything on one line. Every part prints only when the view has it, so a hidden or (in print) empty
// field leaves no gap. The entry carries its kind (`data-kind`), so a template can draw kinds apart.

/** The separator a classic, stacked or one-line head prints between parts. */
const BAR = ' | ';

/** Bullets with a marker and a hanging indent, or flush text when the section turns the marker off. */
export function Bullets({ bullets, marker }: { bullets: readonly RichView[]; marker: boolean }) {
  const { RichText } = useSlots();
  if (bullets.length === 0) return null;
  return (
    <ul className={cx('rt-bullets', !marker && 'rt-bullets-plain')}>
      {bullets.map((bullet) => (
        <li key={bullet.path} className="rt-bullet">
          <RichText field={bullet} as="span" />
        </li>
      ))}
    </ul>
  );
}

/** Parts of one line, with `separator` as text between them (none when null). */
function Separated({ parts, separator }: { parts: ReactNode[]; separator: string | null }) {
  return (
    <>
      {parts.map((part, index) =>
        separator !== null && index > 0 ? (
          <Fragment key={index}>
            <span className="rt-meta-sep">{separator}</span>
            {part}
          </Fragment>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** An entry's link: an <a> around its text when it is a web address. */
function EntryLink({ link }: { link: NonNullable<EntryView['link']> }) {
  const { Text, links } = useSlots();
  if (!link.href) return <Text field={link} />;
  return links ? (
    <a className="rt-meta-link" href={link.href}>
      <Text field={link} />
    </a>
  ) : (
    <span className="rt-meta-link">
      <Text field={link} />
    </span>
  );
}

/** A short fact, after its label ("GPA: 3.7"). */
function Detail({ detail }: { detail: DetailView }) {
  const { Text } = useSlots();
  return (
    <span className="rt-detail">
      {detail.label ? <span className="rt-detail-label">{`${detail.label}:`}</span> : null}
      {detail.label ? ' ' : null}
      <Text field={detail} />
    </span>
  );
}

function Meta({ entry, look }: { entry: EntryView; look: BlockLook }) {
  const { Text } = useSlots();
  const { date, location, link } = entry;
  const parts: ReactNode[] = [];
  if (date) {
    parts.push(
      <span key="date" className="rt-meta-item" data-meta="date">
        {look.icons ? <CalendarIcon /> : null}
        <Text field={date} />
      </span>,
    );
  }
  if (location) {
    parts.push(
      <span key="location" className="rt-meta-item" data-meta="location">
        {look.icons ? <MapPinIcon /> : null}
        <Text field={location} />
      </span>,
    );
  }
  if (link) {
    parts.push(
      <span key="link" className="rt-meta-item" data-meta="link">
        {look.icons ? <LinkIcon /> : null}
        <EntryLink link={link} />
      </span>,
    );
  }
  if (parts.length === 0) return null;
  return (
    <div className="rt-meta">
      <Separated parts={parts} separator={look.separators ? BAR : null} />
    </div>
  );
}

function Details({ entry, look }: { entry: EntryView; look: BlockLook }) {
  if (entry.details.length === 0) return null;
  const parts = entry.details.map((detail) => <Detail key={detail.path} detail={detail} />);
  return (
    <div className="rt-details">
      <Separated parts={parts} separator={look.separators ? BAR : null} />
    </div>
  );
}

/** Enhancv's head: the title, the subtitle, the row of date, place and link, the short facts. */
function StackedHead({ entry, look }: { entry: EntryView; look: BlockLook }) {
  const { Text } = useSlots();
  const head = entry.title || entry.subtitle || entry.date || entry.location || entry.link || entry.details.length > 0;
  if (!head) return null;
  return (
    <div className="rt-entry-head">
      {entry.title ? <Text field={entry.title} as="h3" className="rt-entry-title" /> : null}
      {entry.subtitle ? <Text field={entry.subtitle} as="p" className="rt-entry-subtitle" /> : null}
      <Meta entry={entry} look={look} />
      <Details entry={entry} look={look} />
    </div>
  );
}

/** The kinds whose subtitle is an organisation: the classic head names it first ("Company" over "Role"). */
const ORGANISATION_FIRST: ReadonlySet<EntryView['kind']> = new Set(['experience', 'education', 'volunteering']);

/**
 * The classic head on two lines: the organisation and the place, then the role and the dates, the place and the dates
 * on the right. A kind that names no organisation leads with its title (a project, then the role in it).
 */
function ClassicHead({ entry, look }: { entry: EntryView; look: BlockLook }) {
  const { Text } = useSlots();
  const organisationFirst = ORGANISATION_FIRST.has(entry.kind);
  const lead = organisationFirst ? entry.subtitle : entry.title;
  const second = organisationFirst ? entry.title : entry.subtitle;
  const leadClass = organisationFirst ? 'rt-entry-subtitle' : 'rt-entry-title';
  const secondClass = organisationFirst ? 'rt-entry-title' : 'rt-entry-subtitle';
  const { date, location, link } = entry;
  const place: ReactNode[] = [];
  if (location) place.push(<Text key="location" field={location} />);
  if (link) place.push(<EntryLink key="link" link={link} />);
  if (!lead && !second && !date && place.length === 0 && entry.details.length === 0) return null;
  return (
    <div className="rt-entry-head">
      {lead || place.length > 0 ? (
        <div className="rt-entry-line">
          {lead ? <Text field={lead} as="h3" className={cx(leadClass, 'rt-entry-lead')} /> : null}
          {place.length > 0 ? (
            <span className="rt-entry-aside" data-meta="place">
              <Separated parts={place} separator={BAR} />
            </span>
          ) : null}
        </div>
      ) : null}
      {second || date ? (
        <div className="rt-entry-line">
          {second ? <Text field={second} as="p" className={cx(secondClass, 'rt-entry-sub')} /> : null}
          {date ? (
            <span className="rt-entry-aside" data-meta="date">
              <Text field={date} />
            </span>
          ) : null}
        </div>
      ) : null}
      <Details entry={entry} look={look} />
    </div>
  );
}

function DatePart({ field }: { field: NonNullable<EntryView['date']> }) {
  const { Text } = useSlots();
  return (
    <span className="rt-meta-item" data-meta="date">
      <Text field={field} />
    </span>
  );
}

function LocationPart({ field }: { field: NonNullable<EntryView['location']> }) {
  const { Text } = useSlots();
  return (
    <span className="rt-meta-item" data-meta="location">
      <Text field={field} />
    </span>
  );
}

function LinkPart({ link }: { link: NonNullable<EntryView['link']> }) {
  return (
    <span className="rt-meta-item" data-meta="link">
      <EntryLink link={link} />
    </span>
  );
}

/** The place, the link and the facts of an entry (its dates first when `date`), as parts of one line. */
function lineParts(entry: EntryView, date: boolean): ReactNode[] {
  return [
    ...(date && entry.date ? [<DatePart key="date" field={entry.date} />] : []),
    ...(entry.location ? [<LocationPart key="location" field={entry.location} />] : []),
    ...(entry.link ? [<LinkPart key="link" link={entry.link} />] : []),
    ...entry.details.map((detail) => <Detail key={detail.path} detail={detail} />),
  ];
}

/**
 * The split head: the title (followed by "at" and the subtitle, for the kinds the look names) with the dates on the
 * right, then one line of the subtitle, the place, the link and the facts.
 */
function SplitHead({ entry, look }: { entry: EntryView; look: BlockLook }) {
  const { Text } = useSlots();
  const at = Boolean(entry.title && entry.subtitle && look.subtitleAt?.includes(entry.kind));
  const sub: ReactNode[] = [
    ...(entry.subtitle && !at ? [<Text key="subtitle" field={entry.subtitle} className="rt-entry-subtitle" />] : []),
    ...lineParts(entry, false),
  ];
  if (!entry.title && !entry.date && sub.length === 0) return null;
  return (
    <div className="rt-entry-head" data-head="split">
      {entry.title || entry.date ? (
        <div className="rt-entry-line">
          {entry.title ? (
            <div className="rt-entry-lead">
              <Text field={entry.title} as="h3" className="rt-entry-title" />
              {at ? <span className="rt-entry-at"> at </span> : null}
              {at && entry.subtitle ? <Text field={entry.subtitle} className="rt-entry-subtitle" /> : null}
            </div>
          ) : null}
          {entry.date ? (
            <span className="rt-entry-aside" data-meta="date">
              <Text field={entry.date} />
            </span>
          ) : null}
        </div>
      ) : null}
      {sub.length > 0 ? (
        <div className="rt-entry-sub">
          <Separated parts={sub} separator={look.metaSeparator ?? BAR} />
        </div>
      ) : null}
    </div>
  );
}

/** The title over one line of the subtitle, the dates, the place, the link and the facts. */
function LineHead({ entry, look }: { entry: EntryView; look: BlockLook }) {
  const { Text } = useSlots();
  const sub: ReactNode[] = [
    ...(entry.subtitle ? [<Text key="subtitle" field={entry.subtitle} className="rt-entry-subtitle" />] : []),
    ...lineParts(entry, true),
  ];
  if (!entry.title && sub.length === 0) return null;
  return (
    <div className="rt-entry-head" data-head="line">
      {entry.title ? <Text field={entry.title} as="h3" className="rt-entry-title" /> : null}
      {sub.length > 0 ? (
        <div className="rt-entry-sub">
          <Separated parts={sub} separator={look.metaSeparator ?? BAR} />
        </div>
      ) : null}
    </div>
  );
}

/** Everything on one line, " | " between: the title, the subtitle, the place, the link, the dates, then the facts. */
function InlineHead({ entry }: { entry: EntryView; look: BlockLook }) {
  const { Text } = useSlots();
  const parts: ReactNode[] = [
    ...(entry.title ? [<Text key="title" field={entry.title} as="h3" className="rt-entry-title" />] : []),
    ...(entry.subtitle ? [<Text key="subtitle" field={entry.subtitle} className="rt-entry-subtitle" />] : []),
    ...(entry.location ? [<LocationPart key="location" field={entry.location} />] : []),
    ...(entry.link ? [<LinkPart key="link" link={entry.link} />] : []),
    ...(entry.date ? [<DatePart key="date" field={entry.date} />] : []),
    ...entry.details.map((detail) => <Detail key={detail.path} detail={detail} />),
  ];
  if (parts.length === 0) return null;
  return (
    <div className="rt-entry-head" data-head="inline">
      <div className="rt-entry-line">
        <Separated parts={parts} separator={BAR} />
      </div>
    </div>
  );
}

const HEADS = { stacked: StackedHead, classic: ClassicHead, split: SplitHead, line: LineHead, inline: InlineHead } as const;

export function Entry({ section, entry, look }: { section: SectionView; entry: EntryView; look: BlockLook }) {
  const { RichText } = useSlots();
  const Head = HEADS[entryHeadOf(look, entry.kind)];
  return (
    <div className="rt-entry" data-kind={entry.kind}>
      <Head entry={entry} look={look} />
      {entry.description ? <RichText field={entry.description} as="div" className="rt-entry-desc" /> : null}
      <Bullets bullets={entry.bullets} marker={blockOptions(section, look).showBulletMarker} />
    </div>
  );
}

/** An entry drawn the way its kind is: languages and strengths are short, everything else is a full entry. */
export function EntryItem({ section, entry, look }: { section: SectionView; entry: EntryView; look: BlockLook }) {
  if (entry.kind === 'languages') return <LanguageEntry section={section} entry={entry} look={look} />;
  if (entry.kind === 'strengths') return <StrengthEntry entry={entry} look={look} />;
  return <Entry section={section} entry={entry} look={look} />;
}
