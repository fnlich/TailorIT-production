'use client';

import { ArrowLeftIcon } from '@phosphor-icons/react/ArrowLeft';
import { FolderSimpleIcon } from '@phosphor-icons/react/FolderSimple';
import { PencilSimpleLineIcon } from '@phosphor-icons/react/PencilSimpleLine';
import type { ResumeSummary } from '@tailorit/shared/resume';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useEffect, useRef, type ReactNode, type Ref, type RefObject } from 'react';
import { buttonClasses } from '@/components/ui/Button';
import { CalendarBlankIcon, CaretRightIcon, SparkleIcon, UploadSimpleIcon } from '@/components/ui/icons';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { DocumentList, type DocumentColumn, type ViewMode } from '../core';
import {
  breadcrumbs,
  countText,
  locationOf,
  locationPath,
  locationTitle,
  parentOf,
  sameLocation,
  TAILORED_MODE_LABEL,
  TAILORED_MODES,
  tileLeftBehind,
  tileMeta,
  updatedText,
  type FolderLocation,
  type FolderTile,
  type TailoredMode,
} from './folders';

/*
 * v1.5 W (decision 6): the folders of Documents › Resumes. A folder is a tile (Grid) or a row (List), named, with what
 * it holds and when it last changed; inside one, the breadcrumbs, Back and its title (Tailored resumes: Total | By
 * date). Every folder is a link to its own address, so the keyboard, a middle click and the browser's Back all work.
 */

export type HrefOf = (location: FolderLocation) => string;

/**
 * Focus after a move between places (never on the page's first draw): going up (Back, a breadcrumb), the folder just
 * left; else the new place's heading, so a screen reader says where the person is.
 */
export function useFolderFocus(location: FolderLocation): RefObject<HTMLHeadingElement | null> {
  const heading = useRef<HTMLHeadingElement | null>(null);
  const previous = useRef(location);
  useEffect(() => {
    const from = previous.current;
    if (sameLocation(from, location)) return;
    previous.current = location;
    const left = tileLeftBehind(from, location);
    const frame = window.requestAnimationFrame(() => {
      const tile = left
        ? document.querySelector<HTMLElement>(`[data-folder-tile="${CSS.escape(left)}"] a, [data-folder-link="${CSS.escape(left)}"]`)
        : null;
      (tile ?? heading.current)?.focus({ preventScroll: false });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location]);
  return heading;
}

/** A folder's picture: a folder, marked with what it holds (an upload, an edit, tailoring, a day). */
function FolderGlyph({ tile, size = 'md' }: { tile: FolderTile; size?: 'sm' | 'md' }) {
  const Mark =
    tile.location.date !== null
      ? CalendarBlankIcon
      : tile.key === 'uploaded'
        ? UploadSimpleIcon
        : tile.key === 'edited'
          ? PencilSimpleLineIcon
          : SparkleIcon;
  const small = size === 'sm';
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'relative flex shrink-0 items-center justify-center bg-primary-soft text-primary',
        small ? 'size-8 rounded-control' : 'size-12 rounded-card',
      )}
    >
      <FolderSimpleIcon size={small ? 18 : 26} weight="fill" />
      <span
        className={clsx(
          'absolute flex items-center justify-center rounded-full border-2 border-surface bg-primary text-on-primary',
          small ? '-right-1 -bottom-1 size-4' : '-right-1 -bottom-1 size-5',
        )}
      >
        <Mark size={small ? 8 : 11} weight="bold" />
      </span>
    </span>
  );
}

/**
 * One folder in the Grid view (v31 FIX-DOCS): a tile with the folder's picture and how many it holds (large, in the
 * measurement face) on top, then its name (the link, stretched over the tile), what it keeps and when it last changed.
 */
function FolderCard({ tile, href, now }: { tile: FolderTile; href: string; now: number }) {
  return (
    <article
      data-folder-tile={tile.key}
      className={clsx(
        'group relative flex h-full min-h-40 flex-col rounded-card border border-border bg-surface p-4 shadow-card',
        'transition-[border-color,box-shadow] duration-150 ease-out-soft hover:border-control-hover hover:shadow-popover',
        'has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-[3px] has-[a:focus-visible]:outline-focus',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <FolderGlyph tile={tile} />
        <span aria-hidden="true" className="num text-[28px] leading-8 text-foreground">
          {tile.count}
        </span>
      </div>
      <h3 className="mt-4 truncate text-[15px] leading-6 font-semibold text-foreground tabular-nums">
        <Link href={href} scroll={false} className="after:absolute after:inset-0 after:rounded-[inherit] focus-visible:outline-none">
          {tile.name}
        </Link>
      </h3>
      <p className="line-clamp-2 text-[13px] leading-5 text-muted-foreground">{tile.hint}</p>
      <p
        className="mt-auto flex items-center justify-between gap-2 border-t border-divider-soft pt-2.5 text-[13px] leading-5 font-medium text-foreground"
        data-folder-meta=""
      >
        <span className="truncate">{tileMeta(tile, now)}</span>
        <CaretRightIcon size={16} aria-hidden="true" className="shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
      </p>
    </article>
  );
}

/**
 * The folders of a level: the three folders, or Tailored resumes' days. Grid: cards (three in a row on a wide screen,
 * one a row on a phone). List: rows of Folder | Resumes | Last updated.
 */
export function FolderTiles({
  tiles,
  view,
  now,
  hrefOf,
  label,
}: {
  tiles: readonly FolderTile[];
  view: ViewMode;
  now: number;
  hrefOf: HrefOf;
  /** The list's name: "Resume folders", "Tailored resumes by date". */
  label: string;
}) {
  if (view === 'list') {
    const columns: DocumentColumn<FolderTile>[] = [
      {
        key: 'folder',
        header: 'Folder',
        track: 'minmax(0,2.4fr)',
        cell: (tile) => (
          <span className="flex min-w-0 items-center gap-3">
            <FolderGlyph tile={tile} size="sm" />
            <span className="flex min-w-0 flex-col">
              <Link
                href={hrefOf(tile.location)}
                scroll={false}
                data-folder-link={tile.key}
                className="truncate text-sm font-semibold text-foreground tabular-nums hover:underline hover:underline-offset-2"
              >
                {tile.name}
              </Link>
              <span className="truncate text-[13px] leading-5 text-muted-foreground">{tile.hint}</span>
            </span>
          </span>
        ),
      },
      {
        key: 'count',
        header: 'Resumes',
        track: '8rem',
        cell: (tile) => <span className="block truncate text-foreground">{countText(tile.count)}</span>,
      },
      {
        key: 'updated',
        header: 'Last updated',
        track: '11rem',
        cell: (tile) => (
          <span className="block truncate text-muted-foreground">{updatedText(tile.updatedAt, now)?.replace(/^Updated /, '') ?? '-'}</span>
        ),
      },
    ];
    return (
      <DocumentList
        kind="folder"
        variant="cards"
        items={tiles}
        getId={(tile) => tile.key}
        getLabel={(tile) => tile.name}
        columns={columns}
        aria-label={label}
        className="mt-4"
      />
    );
  }
  return (
    <ul aria-label={label} className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {tiles.map((tile) => (
        <li key={tile.key} className="min-w-0">
          <FolderCard tile={tile} href={hrefOf(tile.location)} now={now} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Inside a folder: Back (one level up) and the breadcrumbs ("Resumes › Tailored resumes › 2026-11-09"), then the
 * place's title with what it holds, and in Tailored resumes the Total | By date switch. While a search runs, the
 * results come from every folder, and the title says so.
 */
export function FolderHeader({
  location,
  hrefOf,
  searching,
  summary,
  onModeChange,
  headingRef,
}: {
  location: FolderLocation;
  hrefOf: HrefOf;
  searching: boolean;
  /** "3 resumes · Updated 2 hours ago". */
  summary: string;
  onModeChange: (mode: TailoredMode) => void;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const parent = parentOf(location);
  const crumbs = breadcrumbs(location);
  const title = locationTitle(location);
  return (
    <div className="mb-6 flex flex-col gap-4" data-folder-header="">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {parent && (
          <Link
            href={hrefOf(parent)}
            scroll={false}
            aria-label={`Back to ${locationTitle(parent)}`}
            className={buttonClasses({ variant: 'outline', size: 'sm' })}
          >
            <ArrowLeftIcon size={14} aria-hidden="true" />
            Back
          </Link>
        )}
        <nav aria-label="Breadcrumb" className="min-w-0">
          <ol className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm leading-5">
            {crumbs.map((crumb, index) => (
              <li key={crumb.label} className="flex min-w-0 items-center gap-1.5">
                {index > 0 && <CaretRightIcon size={12} aria-hidden="true" className="shrink-0 text-subtle-foreground" />}
                {crumb.current ? (
                  <span aria-current="page" className="truncate font-semibold text-foreground tabular-nums">
                    {crumb.label}
                  </span>
                ) : (
                  <Link
                    href={hrefOf(crumb.location)}
                    scroll={false}
                    className="truncate text-muted-foreground hover:text-foreground hover:underline hover:underline-offset-2"
                  >
                    {crumb.label}
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </nav>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="truncate text-[15px] leading-6 font-semibold text-foreground tabular-nums outline-none"
          >
            {searching ? 'Results from all folders' : title}
          </h3>
          <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
            {searching ? `Clear the search to go back to ${title}.` : summary}
          </p>
        </div>
        {location.folder === 'tailored' && !searching && (
          <SegmentedControl<TailoredMode>
            aria-label="Show tailored resumes"
            size="sm"
            items={TAILORED_MODES.map((mode) => ({ value: mode, label: TAILORED_MODE_LABEL[mode] }))}
            value={location.mode}
            onValueChange={onModeChange}
            className="self-start sm:self-auto"
          />
        )}
      </div>
    </div>
  );
}

/** A search result's folder ("Tailored resumes › 2026-11-09"): a link that opens it. */
export function FolderPathLink({
  resume,
  hrefOf,
  onNavigate,
}: {
  resume: Pick<ResumeSummary, 'kind' | 'madeBy' | 'createdAt'>;
  hrefOf: HrefOf;
  onNavigate?: () => void;
}): ReactNode {
  const location = locationOf(resume);
  const path = locationPath(location);
  return (
    <Link
      href={hrefOf(location)}
      scroll={false}
      onClick={onNavigate}
      data-resume-folder-path=""
      title={`Open ${path}`}
      className="inline-flex max-w-full min-w-0 items-center gap-1 text-muted-foreground hover:text-foreground hover:underline hover:underline-offset-2"
    >
      <FolderSimpleIcon size={13} weight="fill" aria-hidden="true" className="shrink-0 text-primary" />
      <span className="truncate tabular-nums">{path}</span>
    </Link>
  );
}
