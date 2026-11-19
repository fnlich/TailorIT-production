import { TrackerLanesSchema, type TrackerLanes } from '@tailorit/shared';
import { nowIso, type AppDeps } from '../../core/context';

// v32 FIX-UX (UXREQ-15): how a person's pages look, saved per person (migration 0046, user_ui_prefs; this module is
// its only writer). Today: the Job Tracker board's Lanes shown (GET / PUT /api/me/tracker-lanes).

interface UiPrefsRow {
  tracker_lanes: unknown;
}

/** The lanes stored as they parse (the driver answers json as an object, or text); anything else reads as none. */
export function lanesOfStored(value: unknown): TrackerLanes | null {
  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      return null;
    }
  }
  if (source === null || source === undefined) return null;
  const parsed = TrackerLanesSchema.safeParse(source);
  return parsed.success ? parsed.data : null;
}

/** The person's lanes shown, or null before their first save. */
export async function getTrackerLanes(deps: Pick<AppDeps, 'db'>, userId: string): Promise<TrackerLanes | null> {
  const row = await deps.db.one<UiPrefsRow>('SELECT tracker_lanes FROM user_ui_prefs WHERE user_id = ?', [userId]);
  return lanesOfStored(row?.tracker_lanes);
}

/** Saves the person's lanes shown (their row is made on the first save) and answers them as stored. */
export async function saveTrackerLanes(deps: Pick<AppDeps, 'db' | 'now'>, userId: string, lanes: TrackerLanes): Promise<TrackerLanes> {
  await deps.db.run(
    `INSERT INTO user_ui_prefs(user_id, tracker_lanes, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET tracker_lanes = excluded.tracker_lanes, updated_at = excluded.updated_at`,
    [userId, JSON.stringify(lanes), nowIso(deps)],
  );
  return lanes;
}
