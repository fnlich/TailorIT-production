import {
  APPLICATION_STATUSES,
  type ApplicationStatus,
  type ApplicationSummary,
  type BoardColumn,
  type BoardResponse,
  type ListResponse,
  type SortOrder,
  type TrackerSort,
} from '@tailorit/shared';
import { PROFILE_SELF, linkAs, type ProfileChoice, type SharedProfile, type SharePermission } from '@tailorit/shared/sharing';
import { trackerSearch, type TrackerUrlState } from '../state';

// v33 SHARE-9 (PLAN F9 "Seeing every profile at once"; SP v33 PLAN-sharing.md §8 "The Tracker's All profiles view"): the
// Job Tracker across the person's own profile and every profile shared with them that lets them see its Job Tracker
// (`tracker:view`). Each profile is read on its own (client fan-out: apiFetch's per-call `profile`, "me" or the key)
// with its own cursors; the board's lanes and the list show the cards together, each with its profile's badge. Only
// per-card actions are offered (open, move, archive and restore, favorite), each sent to the card's own profile and
// only where that profile lets the person change its Job Tracker (`tracker:edit`): selecting, the bulk actions, Archive
// all, Import and Add application are not offered here. Opening a card of another profile than the tab's switches the
// tab to it (a new document: `?as=<key>&app=<id>`). Pure, so it is unit-tested.

/** The tracker URL's parameter of the All profiles view: `/tracker?profiles=all`. */
export const ALL_PROFILES_PARAM = 'profiles';
export const ALL_PROFILES_VALUE = 'all';
/** The Tracker's All profiles view (the Profiles page may link here). */
export const TRACKER_ALL_PROFILES_HREF = `/tracker?${ALL_PROFILES_PARAM}=${ALL_PROFILES_VALUE}`;

/** The words of the view (brief, from the person's side). */
export const ALL_PROFILES_COPY = {
  toggle: 'All profiles',
  toggleTip: 'See your Job Tracker and every one shared with you together.',
  eyebrow: 'All profiles',
  you: 'You',
  /** A card's badge, said with its title: "Platform Engineer, Acme, Ana's". */
  owner: (name: string) => `${name}'s`,
  /** The lane's "Load more" for one profile. */
  loadMore: (label: string, own: boolean) => (own ? 'Load more of yours' : `Load more from ${label}`),
  loadMoreLabel: (label: string, own: boolean, lane: string) =>
    own ? `Load more of your applications in ${lane}` : `Load more of ${label}'s applications in ${lane}`,
  /** The read of one profile failed. */
  loadFailed: (label: string, own: boolean) => (own ? 'Your applications' : `${label}'s applications`),
  notShared: 'Not shared with you.',
  /** Why a card cannot be moved: its profile lets the person see its Job Tracker, not change it. */
  readOnly: (label: string) => `${label} shared this Job Tracker to see only.`,
} as const;

/** One profile of the view: the person's own ("me") or a shared one. */
export interface TrackerProfile {
  choice: ProfileChoice;
  /** "You", or the owner's name as the switcher names it. */
  label: string;
  own: boolean;
  /** Its Job Tracker may be changed (tracker:edit): drag, Move to, Archive, Restore, the heart. */
  canEdit: boolean;
  /** Its auto-apply markers may be read (prepare:view). */
  canSeePrepare: boolean;
  /** v34 FANWEB: its saved jobs may be prepared (prepare:run): the All profiles view's Prepare. */
  canPrepare: boolean;
}

const holds = (permissions: readonly SharePermission[], perm: SharePermission) => permissions.includes(perm);

/**
 * The profiles of the view: the person's own first, then each shared profile whose Job Tracker they may see, in the
 * switcher's order; profiles that just ended (`gone`) are left out at once. `nameOf` names a shared profile as the
 * shell does (profileName).
 */
export function trackerProfiles(
  shared: readonly SharedProfile[],
  nameOf: (profile: SharedProfile) => string,
  gone: ReadonlySet<string> = new Set(),
): TrackerProfile[] {
  return [
    { choice: PROFILE_SELF, label: ALL_PROFILES_COPY.you, own: true, canEdit: true, canSeePrepare: true, canPrepare: true },
    ...shared
      .filter((profile) => holds(profile.permissions, 'tracker:view') && !gone.has(profile.key))
      .map((profile) => ({
        choice: profile.key,
        label: nameOf(profile),
        own: false,
        canEdit: holds(profile.permissions, 'tracker:edit'),
        canSeePrepare: holds(profile.permissions, 'prepare:view'),
        canPrepare: holds(profile.permissions, 'prepare:run'),
      })),
  ];
}

/** Whether the view has anything to add: at least one shared profile whose Job Tracker the person may see. */
export function hasSharedTrackers(shared: readonly SharedProfile[]): boolean {
  return shared.some((profile) => holds(profile.permissions, 'tracker:view'));
}

// The order of the cards ---------------------------------------------------------------------------------------------

/** A text compared the way the API orders it (code points of the lower-cased text), for the merge. */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const day = (value: string) => value.slice(0, 10);

/**
 * The API's order of two applications under `sort` and `order` (applications/query.ts SORT_KEYS: the tracked day then
 * the moment added, the moment added, or the lower-cased title; the id breaks ties), so cards read from several
 * profiles interleave as one list would.
 */
export function compareApplications(
  a: Pick<ApplicationSummary, 'id' | 'trackedOn' | 'createdAt' | 'title'>,
  b: Pick<ApplicationSummary, 'id' | 'trackedOn' | 'createdAt' | 'title'>,
  sort: TrackerSort,
  order: SortOrder,
): number {
  const keys = (item: typeof a): string[] =>
    sort === 'tracked' ? [day(item.trackedOn), item.createdAt] : sort === 'created' ? [item.createdAt] : [item.title.toLowerCase()];
  const left = [...keys(a), a.id];
  const right = [...keys(b), b.id];
  let result = 0;
  for (let index = 0; index < left.length && result === 0; index += 1) result = byText(left[index] ?? '', right[index] ?? '');
  return order === 'desc' ? -result : result;
}

/** Items of several profiles in one order (each profile's own order is kept: a stable merge by the API's order). */
export function mergeItems(
  lists: ReadonlyArray<readonly ApplicationSummary[]>,
  sort: TrackerSort,
  order: SortOrder,
): ApplicationSummary[] {
  return lists.flat().sort((a, b) => compareApplications(a, b, sort, order));
}

// The board -----------------------------------------------------------------------------------------------------------

/** One profile's read of the board (undefined while it loads or when it failed). */
export interface ProfileBoard {
  profile: TrackerProfile;
  board: BoardResponse | undefined;
}

/** One "Load more" of a lane or the list: one per profile that has more. */
export interface LoadMoreItem {
  /** The profile's choice ("me" or its key): React's key and the e2e's data attribute. */
  id: string;
  /** What the button says ("Load more from Ana"). */
  label: string;
  /** Its accessible name ("Load more of Ana's applications in Saved"). */
  ariaLabel: string;
  loading: boolean;
  onLoad: () => void;
}

/**
 * The board of every profile as one: each stored status's lane holds every profile's cards in the API's order, its
 * total the sum of theirs; a lane has no cursor of its own: `more` names the profiles that
 * have more of it, each with its own cursor (the per-profile board's).
 */
export function mergeBoards(
  boards: readonly ProfileBoard[],
  sort: TrackerSort,
  order: SortOrder,
): { columns: BoardColumn[] | null; more: Map<ApplicationStatus, TrackerProfile[]> } {
  const read = boards.filter((entry) => entry.board !== undefined);
  const more = new Map<ApplicationStatus, TrackerProfile[]>();
  if (read.length === 0) return { columns: null, more };
  const columns = APPLICATION_STATUSES.map((status): BoardColumn => {
    const parts = read.map((entry) => ({ profile: entry.profile, column: entry.board?.columns.find((column) => column.status === status) }));
    const withMore = parts.filter((part) => Boolean(part.column?.nextCursor)).map((part) => part.profile);
    if (withMore.length > 0) more.set(status, withMore);
    return {
      status,
      total: parts.reduce((sum, part) => sum + (part.column?.total ?? 0), 0),
      items: mergeItems(
        parts.map((part) => part.column?.items ?? []),
        sort,
        order,
      ),
    };
  });
  return { columns, more };
}

/** One profile's read of a list (the pages loaded so far; undefined while it loads or when it failed). */
export interface ProfileList {
  profile: TrackerProfile;
  pages: ReadonlyArray<ListResponse<ApplicationSummary>> | undefined;
}

/** The lists of every profile as one: the items in the API's order, the total, and the profiles that have more. */
export function mergeLists(
  lists: readonly ProfileList[],
  sort: TrackerSort,
  order: SortOrder,
): { items: ApplicationSummary[] | null; total: number; more: TrackerProfile[] } {
  const read = lists.filter((entry) => entry.pages !== undefined);
  if (read.length === 0) return { items: null, total: 0, more: [] };
  return {
    items: mergeItems(
      read.map((entry) => (entry.pages ?? []).flatMap((page) => page.items)),
      sort,
      order,
    ),
    total: read.reduce((sum, entry) => sum + (entry.pages?.[0]?.total ?? 0), 0),
    more: read.filter((entry) => Boolean(entry.pages?.at(-1)?.nextCursor)).map((entry) => entry.profile),
  };
}

/** Which profile each card loaded so far belongs to (application ids are unique across profiles). */
export function profilesOfCards(entries: ReadonlyArray<{ profile: TrackerProfile; items: readonly ApplicationSummary[] }>): Map<string, TrackerProfile> {
  const index = new Map<string, TrackerProfile>();
  for (const entry of entries) for (const item of entry.items) if (!index.has(item.id)) index.set(item.id, entry.profile);
  return index;
}

/** The counts of the tabs: the sum over the profiles, once every one is read (never a part that is only loading). */
export function sumCounts(counts: ReadonlyArray<{ active: number; archived: number } | undefined>): { active: number; archived: number } | undefined {
  if (counts.length === 0 || counts.some((count) => count === undefined)) return undefined;
  return counts.reduce<{ active: number; archived: number }>(
    (sum, count) => ({ active: sum.active + (count?.active ?? 0), archived: sum.archived + (count?.archived ?? 0) }),
    { active: 0, archived: 0 },
  );
}

// Opening a card ------------------------------------------------------------------------------------------------------

/**
 * Where opening a card goes: its detail in place when the card is the tab's own profile's (`here`), else the tab
 * switches to the card's profile and opens it there (`switch`, a new document at `/tracker?app=<id>&as=<key>`, the view
 * kept; the All profiles view is left, the tab now works on that profile). v33 SHARE-9 fix (review): a card is opened
 * from the board or the list (a chart has no cards; the All profiles view shows the board for it), so `chart` opens on
 * the board.
 */
export function openTarget(
  applicationId: string,
  card: ProfileChoice,
  tab: ProfileChoice,
  url: Pick<TrackerUrlState, 'view' | 'tab'>,
): { kind: 'here' } | { kind: 'switch'; to: string } {
  if (card === tab) return { kind: 'here' };
  const view = url.view === 'chart' ? 'board' : url.view;
  const search = trackerSearch({ view, tab: url.tab, app: applicationId, edit: false, all: false });
  return { kind: 'switch', to: linkAs(`/tracker${search}`, card) };
}
