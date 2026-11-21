'use client';

import { useDraggable } from '@dnd-kit/core';
import { clsx } from 'clsx';
import { useCallback, useId, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type TouchEvent } from 'react';
import { STATUS_INFO, type ApplicationStatus, type ApplicationSummary } from '@tailorit/shared';
import { Badge } from '@/components/ui/Badge';
import { Checkbox } from '@/components/ui/Checkbox';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/ContextMenu';
import { IconButton } from '@/components/ui/IconButton';
import { Menu, MenuContent, MenuTrigger } from '@/components/ui/Menu';
import { Tooltip } from '@/components/ui/Tooltip';
import { ArrowRightIcon, CheckIcon, ClockIcon, DotsThreeIcon, HeartIcon } from '@/components/ui/icons';
import { ClosedBadge, isClosed } from '@/features/jobs/closed/ClosedBadge'; // v30 FIX-WEB (UX-10)
import { VerificationBadge, useVerificationTitle } from '@/features/jobs/verification/VerificationBadge'; // v31 JOBSWEB
import { verificationMark } from '@/features/jobs/verification/copy';
import { RowCredit } from '@/features/jobs/credits/JobCredit'; // v30 FIX-WEB (REQ-1)
import { creditOf } from '@/features/jobs/credits/credit';
import { usePublicConstants } from '@/lib/constants';
import type { MarkerView } from '../../auto-apply/copy';
import { CompanyLogo } from '../CompanyLogo';
import { ProfileBadge, type CardProfile } from '../profiles/ProfileBadge';
import { ALL_PROFILES_COPY } from '../profiles/scope';
import { useLongPress } from '../hooks';
import { daysBetween, nextStep, stageSince, timeInStage } from '../stage';
import { ApplicationMenuItems, type ApplicationActions } from './ApplicationMenu';

export interface CardHandlers extends ApplicationActions {
  onToggleFavorite: (application: ApplicationSummary) => void;
  onToggleSelected: (application: ApplicationSummary, selected: boolean) => void;
  /** Why this application cannot be selected now (Prepare & Queue jobs: not a saved job, or a draft already), or null. */
  selectBlocked?: (application: ApplicationSummary) => string | null;
  /**
   * v2.0: a Saved entry's auto-apply marker (Draft for one in the queue, A30; Preparing, Filtered: …, Preparation
   * failed, … from the Saved pane's read), shown on its card and row. v33 TRACKER (F1): Draft is the only sign of a
   * queued entry (it stays in Saved), so it is always shown.
   */
  markerOf?: (application: ApplicationSummary) => MarkerView | null;
  /**
   * v33 SHARE-9: the profile whose Job Tracker the card is in (the All profiles view's badge, said with the card), or
   * null; absent everywhere else.
   */
  profileOf?: (application: ApplicationSummary) => CardProfile | null;
}

/**
 * v2.0: a Saved entry's marker badge (Draft, Preparing, Filtered: …), the Saved pane's words. v33 TRACKER: `id` lets the
 * card's title name it for screen readers (aria-describedby), as the held and closed marks are.
 */
export function MarkerBadge({ marker, id }: { marker: MarkerView | null | undefined; id?: string }) {
  if (!marker) return null;
  return (
    <Badge id={id} tone={marker.tone} data-card-marker={marker.label}>
      {marker.label}
    </Badge>
  );
}

const stop = (event: MouseEvent | KeyboardEvent | TouchEvent) => event.stopPropagation();

/** A card's or a row's selection box; one that cannot be selected is disabled and says why. */
export function SelectionBox({
  application,
  checked,
  handlers,
}: {
  application: ApplicationSummary;
  checked: boolean;
  handlers: CardHandlers;
}) {
  const blocked = handlers.selectBlocked?.(application) ?? null;
  if (blocked) {
    return (
      <Tooltip content={blocked}>
        <span className="flex" data-not-selectable="" onClick={(event) => event.stopPropagation()}>
          <Checkbox
            checked={false}
            disabled
            aria-label={`${application.title}: ${blocked}`}
            onCheckedChange={() => undefined}
          />
        </span>
      </Tooltip>
    );
  }
  return (
    <Checkbox
      checked={checked}
      stopPropagation
      aria-label={`Select ${application.title}`}
      onCheckedChange={(next) => handlers.onToggleSelected(application, next)}
    />
  );
}

/** The heart: outline and muted, or filled denim. */
export function FavoriteButton({
  application,
  onToggle,
  size = 'sm',
  readOnly = false,
}: {
  application: ApplicationSummary;
  onToggle: (application: ApplicationSummary) => void;
  size?: 'xs' | 'sm';
  /** v33 SHARE-9: a profile shared to see only: a favorite shows its filled heart, nothing to press. */
  readOnly?: boolean;
}) {
  if (readOnly) {
    return (
      <span className={clsx('flex items-center justify-center', size === 'xs' ? 'size-7' : 'size-8')} data-favorite-mark="">
        {application.favorite && (
          <>
            <HeartIcon size={16} weight="fill" aria-hidden="true" className="text-primary" />
            <span className="sr-only">Favorite</span>
          </>
        )}
      </span>
    );
  }
  const label = application.favorite ? 'Remove from favorites' : 'Add to favorites';
  return (
    <IconButton
      label={label}
      size={size}
      aria-pressed={application.favorite}
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(application);
      }}
      icon={
        application.favorite ? (
          <HeartIcon size={16} weight="fill" className="text-primary" />
        ) : (
          <HeartIcon size={16} />
        )
      }
    />
  );
}

/**
 * v31 FIX-DOCS: the card's next step as a small tag: an arrow and the step ("→ Follow up", said "Next: follow up"), or
 * "Done" / "Closed" once the application ended. The full words are its title too.
 */
export function NextStepTag({ status, id }: { status: ApplicationStatus; id?: string }) {
  const { t } = usePublicConstants();
  const step = nextStep(status, t);
  return (
    <span
      id={id}
      data-next-step={step.tone}
      title={step.text}
      className={clsx(
        'inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-tag px-2 text-xs leading-4 font-medium',
        step.tone === 'next' && 'bg-primary-soft text-primary-ink',
        step.tone === 'done' && 'bg-success-soft text-success-ink',
        step.tone === 'closed' && 'bg-surface-muted text-muted-foreground',
      )}
    >
      {step.tone === 'next' ? (
        <ArrowRightIcon size={12} weight="bold" aria-hidden="true" className="shrink-0" />
      ) : step.tone === 'done' ? (
        <CheckIcon size={12} weight="bold" aria-hidden="true" className="shrink-0" />
      ) : null}
      {step.tone === 'next' ? (
        <>
          <span className="sr-only">{step.text}</span>
          <span aria-hidden="true" className="truncate">
            {step.short}
          </span>
        </>
      ) : (
        <span className="truncate">{step.text}</span>
      )}
    </span>
  );
}

/** v31 FIX-DOCS: how long the application has been in its stage ("4d", "Today"), its sentence for screen readers. */
export function StageTime({ application, id, className }: { application: ApplicationSummary; id?: string; className?: string }) {
  const { t } = usePublicConstants();
  const time = timeInStage(daysBetween(stageSince(application), new Date()), STATUS_INFO[application.currentStatus].label, t);
  if (!time) return null;
  return (
    <span id={id} title={time.long} data-stage-time="" className={clsx('inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground', className)}>
      {/* v32 LAYOUT: a narrow board card (below 19 rem) leaves the clock out, so the next step keeps the room. */}
      <ClockIcon size={13} aria-hidden="true" className="@max-[19rem]/card:hidden" />
      <span aria-hidden="true" className="num">
        {time.short}
      </span>
      <span className="sr-only">{time.long}</span>
    </span>
  );
}

/**
 * v31 FIX-DOCS: the card's face (the board card and the drag overlay): the company's monogram (or logo), the title
 * (`title`: the card's button, or plain text in the overlay) over "company · location", the source's credit, then a
 * foot with the next step, the time in the stage and the actions (heart, ⋯), and the job's marks under it.
 */
export function CardFace({
  application,
  title,
  leading,
  actions,
  marker,
  heldSentenceId,
  closedSentenceId,
  markerSentenceId,
  footId,
  profile,
  profileSentenceId,
}: {
  application: ApplicationSummary;
  /** The title as the card's button, or as text. */
  title: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  /** v2.0: the Saved entry's auto-apply marker. */
  marker?: MarkerView | null;
  /** v30 FIX-WEB (UX-8): ids of the held (v31: the verification mark's) and closed sentences, for the card's aria-describedby. */
  heldSentenceId?: string;
  closedSentenceId?: string;
  /** v33 TRACKER: the marker badge's id (Draft, Prepared, …), for the card's aria-describedby. */
  markerSentenceId?: string;
  /** The foot's id (the next step and the time in the stage), which also describes the card. */
  footId?: string;
  /** v33 SHARE-9: the profile's badge (the All profiles view), first among the marks, and its id for the description. */
  profile?: CardProfile | null;
  profileSentenceId?: string;
}) {
  const held = verificationMark(application) !== null;
  const closed = isClosed(application);
  // v33 TRACKER (F1): every marker shows, Draft included (it no longer has a lane that says it).
  const showMarker = Boolean(marker);
  return (
    <>
      <div className="flex items-start gap-3">
        {leading}
        <CompanyLogo name={application.companyName} logoUrl={application.logoUrl} size={36} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          {title}
          <p className="mt-0.5 truncate text-[13px] leading-5 text-muted-foreground">
            {[application.companyName, application.location].filter((part) => part && part.trim()).join(' · ')}
          </p>
        </div>
      </div>
      {/* v30 FIX-WEB (REQ-1): the credit its source asks for. */}
      <div className="relative z-10 empty:hidden">
        <RowCredit credit={creditOf(application)} className={clsx('mt-1.5', UNDER_TITLE)} />
      </div>
      <div className={clsx('mt-2.5 flex min-h-8 items-center gap-1', UNDER_TITLE)}>
        {/* v32 LAYOUT: a wide card (from 26 rem) keeps the time beside the next step, the actions at its end. */}
        <div id={footId} className="flex min-w-0 flex-1 items-center justify-between gap-2 @min-[26rem]/card:justify-start @min-[26rem]/card:gap-3">
          <NextStepTag status={application.currentStatus} />
          <StageTime application={application} />
        </div>
        {actions}
      </div>
      {(held || closed || showMarker || profile) && (
        <div className={clsx('mt-2 flex flex-wrap items-center gap-1.5', UNDER_TITLE)}>
          {profile && <ProfileBadge profile={profile} id={profileSentenceId} />}
          {/* v31 JOBSWEB: "Waiting for approval", or "From your browser, not verified" for the person's own job. */}
          <VerificationBadge held={application.held} verification={application.verification} sentenceId={heldSentenceId} />
          <ClosedBadge closed={closed} sentenceId={closedSentenceId} />
          {showMarker && <MarkerBadge marker={marker} id={markerSentenceId} />}
        </div>
      )}
    </>
  );
}

/**
 * A card's shape (its colours and shadow are the caller's: one of each, so no two utilities of a property meet). v32
 * LAYOUT (E9): a size container (`card`), so its face lays out by the card's width, which follows its lane's.
 */
export const CARD_SURFACE = '@container/card rounded-card border p-3.5';

/**
 * v32 LAYOUT (E9): what sits under the title (the credit, the foot, the marks) lines up with the title from a 21 rem
 * card; a narrower card (lanes share the board's width, down to 18 rem) gives it the card's whole width, so the next
 * step ("→ Prep the interview") is read in full beside the time in the stage and the actions.
 */
const UNDER_TITLE = '@min-[21rem]/card:pl-12';

/**
 * v30 FIX-WEB (REV-UX UX-8): a board card's accessible name: its title and company, then the marks it shows in words
 * ("…, Waiting for approval", "…, Closed"; v31: "…, From your browser, not verified"), so a screen reader hears what
 * the card's badges say.
 */
export function cardName(
  title: string,
  company: string,
  marks: { held: string | null; closed: string | null; profile?: string | null },
): string {
  // v33 SHARE-9: the All profiles view says whose Job Tracker the card is in ("…, Ana's"), after the company.
  return [title, company, marks.profile, marks.held, marks.closed].filter((part): part is string => Boolean(part && part.trim())).join(', ');
}

/**
 * A board card: draggable between lanes (8 px mouse, 180 ms touch hold, Space for the keyboard), opens the
 * application on click or Enter, and offers the actions menu from ⋯, a right-click or a 500 ms press.
 *
 * v31 FIX-DOCS (REV-UX UX-13): no control sits inside another. The card is a plain `article`; its one control is the
 * title's button (the drag handle for the keyboard, named "{title}, {company}[, marks]", stretched over the card so a
 * click anywhere opens it), and the heart, the ⋯ menu and (selecting) the box are its siblings, drawn above it. The
 * mouse and touch drag start anywhere on the card.
 */
export function ApplicationCard({
  application,
  handlers,
  selected,
  selectMode,
  checked,
  draggingAny,
  consumeDragClick,
}: {
  application: ApplicationSummary;
  handlers: CardHandlers;
  /** Its detail sheet is open. */
  selected: boolean;
  selectMode: boolean;
  checked: boolean;
  /** Any card is being dragged (a long touch must not also open the context menu). */
  draggingAny: boolean;
  /** True once for the click that ends a drag. */
  consumeDragClick: () => boolean;
}) {
  // v33 SHARE-9: a card whose profile lets the person see its Job Tracker only is not dragged (nor moved from its menu).
  const editable = handlers.canEdit?.(application) ?? true;
  const draggable = !selectMode && editable;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: application.id,
    data: { application },
    disabled: !draggable,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const longPress = useLongPress(openMenu);
  // v30 FIX-WEB (REV-UX UX-8): a held or closed job says so in the card's name, and its sentence describes the card.
  // v31 JOBSWEB: so does the person's own job TailorIT could not read.
  const heldTitle = useVerificationTitle(application);
  const { t } = usePublicConstants();
  const marks = useId();
  const held = verificationMark(application) !== null;
  const closed = isClosed(application);
  const marker = handlers.markerOf?.(application) ?? null;
  const profile = handlers.profileOf?.(application) ?? null;
  const name = cardName(application.title, application.companyName, {
    held: held ? heldTitle : null,
    closed: closed ? t('LABEL_JOB_CLOSED_MARK') : null,
    profile: profile && !profile.own ? ALL_PROFILES_COPY.owner(profile.label) : null,
  });
  const described = [
    draggable ? attributes['aria-describedby'] : undefined,
    `${marks}-foot`,
    held ? `${marks}-held` : undefined,
    closed ? `${marks}-closed` : undefined,
    // v33 TRACKER (F1): its marker (Draft, …) is heard with the card, as its badges are seen.
    marker ? `${marks}-marker` : undefined,
    profile ? `${marks}-profile` : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  const activate = () => {
    if (!selectMode) handlers.onOpen(application);
    else if (!handlers.selectBlocked?.(application)) handlers.onToggleSelected(application, !checked);
  };

  // dnd-kit's mouse and touch starts go on the whole card; its keyboard start on the title's button.
  const { onKeyDown: dragKeyDown, ...pointerListeners } = (listeners ?? {}) as Record<string, ((event: unknown) => void) | undefined>;

  return (
    <ContextMenu
      open={contextOpen}
      onOpenChange={(open) => {
        if (open && (draggingAny || selectMode)) return;
        setContextOpen(open);
      }}
    >
      <ContextMenuTrigger
        ref={setNodeRef}
        {...pointerListeners}
        {...longPress.handlers}
        render={<article />}
        data-application-card={application.id}
        className={clsx(
          CARD_SURFACE,
          'relative block w-full cursor-pointer text-left transition-[border-color,box-shadow,background-color] duration-150 select-none',
          'has-[[data-card-main]:focus-visible]:outline-2 has-[[data-card-main]:focus-visible]:outline-offset-2 has-[[data-card-main]:focus-visible]:outline-focus',
          selected || checked
            ? 'border-primary bg-primary-soft shadow-card'
            : 'border-border bg-surface shadow-card hover:border-control-hover hover:shadow-popover',
          isDragging && 'opacity-40',
        )}
      >
        <CardFace
          application={application}
          marker={marker}
          heldSentenceId={`${marks}-held`}
          closedSentenceId={`${marks}-closed`}
          markerSentenceId={`${marks}-marker`}
          footId={`${marks}-foot`}
          profile={profile}
          profileSentenceId={`${marks}-profile`}
          leading={
            selectMode ? (
              <span className="relative z-10 mt-2 flex">
                <SelectionBox application={application} checked={checked} handlers={handlers} />
              </span>
            ) : null
          }
          title={
            <button
              type="button"
              ref={setActivatorNodeRef}
              {...attributes}
              data-card-main=""
              aria-label={name}
              aria-roledescription={selectMode ? 'selectable application' : draggable ? 'draggable application' : 'application'}
              // In select mode the card toggles its selection: not disabled, and its state is announced. v33 SHARE-9: a
              // card that is not dragged still opens: never announced as disabled.
              aria-disabled={draggable ? attributes['aria-disabled'] : undefined}
              data-card-draggable={draggable ? '' : undefined}
              aria-describedby={described || undefined}
              aria-pressed={selectMode ? checked : attributes['aria-pressed']}
              onClick={() => {
                if (longPress.consumeClick() || consumeDragClick()) return;
                activate();
              }}
              onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                // During a keyboard drag Enter drops the card (dnd-kit's own listener); it must not also open it.
                if (event.key === 'Enter' && (isDragging || draggingAny)) {
                  event.preventDefault();
                  return;
                }
                if (event.key === 'Enter') return; // the button's own click opens it
                dragKeyDown?.(event);
              }}
              className={clsx(
                'block w-full cursor-pointer text-left text-[15px] leading-5 font-semibold break-words text-foreground focus-visible:outline-none',
                'line-clamp-2 after:absolute after:inset-0 after:rounded-[inherit] after:content-[""]',
              )}
            >
              {application.title}
            </button>
          }
          actions={
            <span className="relative z-10 -mr-1.5 flex shrink-0 items-center" onClick={stop} onKeyDown={stop} onMouseDown={stop} onPointerDown={stop} onTouchStart={stop}>
              <FavoriteButton application={application} onToggle={handlers.onToggleFavorite} readOnly={!editable} />
              <Menu
                open={menuOpen}
                onOpenChange={(open) => {
                  if (!open) longPress.cancel();
                  setMenuOpen(open);
                }}
              >
                <MenuTrigger
                  render={
                    <IconButton
                      label="Application actions"
                      size="sm"
                      icon={<DotsThreeIcon size={16} weight="bold" className="text-foreground" />}
                    />
                  }
                />
                <MenuContent width="w-56" align="end">
                  <ApplicationMenuItems application={application} actions={handlers} />
                </MenuContent>
              </Menu>
            </span>
          }
        />
      </ContextMenuTrigger>
      <ContextMenuContent width="w-56">
        <ApplicationMenuItems application={application} actions={handlers} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
