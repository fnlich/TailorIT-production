import type { QueryClient } from '@tanstack/react-query';
import type { ApplicationStatus, ApplicationSummary, TrackerTab, TrackerView } from '@tailorit/shared';
import type { ProfileChoice } from '@tailorit/shared/sharing';
import type { ToastApi } from '@/components/ui/Toast';
import { FANOUT_COPY, QUEUE_COPY, archiveOneOutcome } from '../../sharing/fanout/copy'; // v36 FIX-WEB (D1)
import { celebrateIfReached } from '../confetti';
import { invalidateApplications, trackerApi, type ColumnLimits, type MoveStatusVariables } from '../data';
import { toastFailure } from '../failure';
import { openTarget, type TrackerProfile } from './scope';

// v33 SHARE-9 (PLAN-sharing.md §8 "The Tracker's All profiles view"): the All profiles view's per-card actions (open,
// Move to and drag, Archive and Restore, the heart), each sent to the card's own profile and only where it lets the
// person change its Job Tracker, and each profile's "Load more". Kept apart from the view so the tests drive them.

/** What the per-card actions need from the view (its hooks give them; the tests give fakes). */
export interface CardActionsHost {
  client: QueryClient;
  toast: Pick<ToastApi, 'toast' | 'success' | 'error'>;
  /** Whose card it is (null for a card no profile's read holds). */
  ownerOf: (application: ApplicationSummary) => TrackerProfile | null;
  /** The tab's own profile ("me" or the key it works on). */
  tab: ProfileChoice;
  /** What the view shows (board or list: it has no chart) and its tab: opening another profile's card keeps them. */
  shown: { view: TrackerView; tab: TrackerTab };
  /** Opens a card of the tab's own profile in place. */
  openHere: (id: string) => void;
  /** Switches the tab to another profile and opens `to` there (a new document). */
  switchTo: (choice: ProfileChoice, options: { to: string }) => unknown;
  /** The optimistic status move (useMoveStatus's mutate). */
  move: (variables: MoveStatusVariables, options: { onError: (error: unknown) => void }) => void;
  /** The heart (useToggleFavorite's mutate). */
  favorite: (variables: { id: string; favorite: boolean; profile: ProfileChoice }) => void;
  /** Shows a lane a card moves to when it is hidden (the board). */
  showLane: (status: ApplicationStatus) => void;
  /** v36 FIX-WEB (D1): the Queue changes box's name (the Sharing page's words; default its own default). */
  queueBox?: string;
}

/** v36 FIX-WEB: LABEL_SHARING_ROW_QUEUE's default, for a host that gives no name. */
const QUEUE_BOX = 'Queue changes';

/** The All profiles view's per-card actions. */
export function cardActions(host: CardActionsHost) {
  const { client, toast, ownerOf } = host;
  /** The card's profile when the person may change its Job Tracker, else null (nothing is sent). */
  const editableProfile = (application: ApplicationSummary): ProfileChoice | null => {
    const owner = ownerOf(application);
    return owner && owner.canEdit ? owner.choice : null;
  };

  const open = (application: ApplicationSummary): void => {
    const owner = ownerOf(application);
    if (!owner) return;
    const target = openTarget(application.id, owner.choice, host.tab, host.shown);
    if (target.kind === 'here') host.openHere(application.id);
    else void host.switchTo(owner.choice, { to: target.to });
  };

  const move = (application: ApplicationSummary, status: ApplicationStatus): void => {
    const profile = editableProfile(application);
    if (profile === null || status === application.currentStatus) return;
    host.showLane(status);
    host.move(
      { id: application.id, status, from: application.currentStatus, profile },
      { onError: (error) => toastFailure(toast, error, "We couldn't move the application. Please try again.") },
    );
  };

  const setArchived = async (application: ApplicationSummary, archive: boolean): Promise<void> => {
    const profile = editableProfile(application);
    if (profile === null) return;
    try {
      // v36 FIX-WEB (D1): what the archive did to the auto-apply queue; a Saved entry it left as it was says why.
      let outcome: ReturnType<typeof archiveOneOutcome> | null = null;
      if (archive) {
        const answer = await trackerApi.archive(application.id, profile);
        outcome = archiveOneOutcome(answer, host.queueBox ?? QUEUE_BOX, ownerOf(application)?.label ?? FANOUT_COPY.you);
      } else await trackerApi.restore(application.id, profile);
      void invalidateApplications(client);
      if (outcome?.left) {
        toast.toast({ type: 'info', title: QUEUE_COPY.notArchived, description: outcome.notes.join(' ') });
        return;
      }
      toast.toast({
        type: 'success',
        title: archive ? 'Application archived' : 'Application restored',
        ...(outcome && outcome.notes.length > 0 ? { description: outcome.notes.join(' ') } : {}),
        action: { label: 'Undo', onClick: () => void setArchived(application, !archive) },
      });
    } catch (error) {
      toastFailure(toast, error, "We couldn't update the application. Please try again.");
    }
  };

  /** An archived card dropped on a status lane: restored on its profile, and moved when the lane is another status. */
  const restoreInto = async (application: ApplicationSummary, status: ApplicationStatus): Promise<void> => {
    const profile = editableProfile(application);
    if (profile === null) return;
    try {
      await trackerApi.restore(application.id, profile);
      if (status !== application.currentStatus) {
        host.showLane(status);
        const result = await trackerApi.status(application.id, status, undefined, profile);
        celebrateIfReached(result.currentStatus, application.currentStatus);
      }
      toast.success('Application restored');
    } catch (error) {
      toastFailure(toast, error, "We couldn't restore the application. Please try again.");
    } finally {
      void invalidateApplications(client);
    }
  };

  const toggleFavorite = (application: ApplicationSummary): void => {
    const profile = editableProfile(application);
    if (profile === null) return;
    host.favorite({ id: application.id, favorite: !application.favorite, profile });
  };

  return { open, move, setArchived, restoreInto, toggleFavorite };
}

// "Load more", per profile ----------------------------------------------------------------------------------------------

/** How many more cards or rows a "Load more" asks of one profile (the single view's step). */
export const PAGE_STEP = 25;

/** Every profile's lane limits after `profile`'s "Load more" in `status`: only that profile's lane asks for more. */
export function moreInLane(
  limits: Readonly<Record<string, ColumnLimits>>,
  profile: ProfileChoice,
  status: ApplicationStatus,
): Record<string, ColumnLimits> {
  const mine = limits[profile] ?? {};
  return { ...limits, [profile]: { ...mine, [status]: (mine[status] ?? PAGE_STEP) + PAGE_STEP } };
}

/** Every profile's rows asked for after `profile`'s "Load more" in a list (`first`: the rows a list reads at first). */
export function moreRows(wanted: Readonly<Record<string, number>>, profile: ProfileChoice, first: number): Record<string, number> {
  return { ...wanted, [profile]: (wanted[profile] ?? first) + PAGE_STEP };
}
