import { Router } from 'express';
import { isRegionCode, MINUTE_MS, PreferencesSchema, SetDefaultResumeBodySchema, TrackerLanesSchema, type Preferences } from '@tailorit/shared';
import { isActing, rateKeyOf, requireUser, userOf } from '../../core/auth/guards'; // v33 SHARE-6: isActing, rateKeyOf
import { getAccount, MAX_NAME_LENGTH } from '../../core/auth/users';
import { nowIso, type AppDeps } from '../../core/context';
import { notFound, validationFailed } from '../../core/http/errors';
import { parseInput } from '../../core/http/validate';
import { touchFilterRevision } from '../prepare-filters/index';
import { keyedRateLimit } from '../../core/rate-limit';
import { getPreferences, normalizePreferences, savePreferences } from './preferences';
import { getTrackerLanes, saveTrackerLanes } from './ui-prefs'; // v32 FIX-UX (UXREQ-15)

// The signed-in account: name, preferences, default resume. Owned by work package F3 (see docs/ARCHITECTURE.md).
// v33 SHARE-6 (PLAN F9; SP v33 PLAN-sharing.md §3 "Job settings", "Per-person, self"; §4 "Explicit changes", "Where
// applications go"): on a profile shared with the signed-in person (me/acting.ts) the preferences are the owner's (Job
// settings' See and Change): a save there keeps the owner's contact details (phone, LinkedIn, location, portfolio: a
// letter's and a resume's contact lines fall back to them); the default resume is the owner's (Change), answered with its
// id alone, never the owner's account; the name is never changed (`never`); the tracker lanes are the person's own
// (`self`), and so is their save limit.

/** v33 SHARE-6: the contact details a save on a shared profile keeps as the owner stored them. */
const OWNER_CONTACT_FIELDS = ['phone', 'linkedinUrl', 'location', 'portfolioUrl'] as const;

const MAX_LIST_ENTRIES = 100;
/** v32 FIX-UX: saves of the tracker's lanes shown a person may make in a minute (a box ticked is one). */
export const TRACKER_LANES_SAVES_PER_MINUTE = 60;
const MAX_LIST_ENTRY_LENGTH = 200;
const MAX_TEXT_LENGTH = 500;

/** Bounds the contract leaves open, so one account cannot store an arbitrarily large row. */
function checkSizes(preferences: Preferences): void {
  const lists = {
    experienceLevels: preferences.experienceLevels,
    jobTypes: preferences.jobTypes,
    workArrangements: preferences.workArrangements,
    categories: preferences.categories,
    locations: preferences.locations,
  };
  for (const [field, items] of Object.entries(lists)) {
    if (items.length > MAX_LIST_ENTRIES || items.some((item) => item.length > MAX_LIST_ENTRY_LENGTH)) {
      const message = `Choose at most ${MAX_LIST_ENTRIES}, each up to ${MAX_LIST_ENTRY_LENGTH} characters.`;
      throw validationFailed(message, { [field]: message });
    }
  }
  const texts = {
    phone: preferences.phone,
    linkedinUrl: preferences.linkedinUrl,
    location: preferences.location,
    portfolioUrl: preferences.portfolioUrl,
  };
  for (const [field, text] of Object.entries(texts)) {
    if (text.length > MAX_TEXT_LENGTH) {
      const message = `Keep this under ${MAX_TEXT_LENGTH} characters.`;
      throw validationFailed(message, { [field]: message });
    }
  }
}

/**
 * v2.0 (A22): a state or province needs its country, and must be one of that country's (the US and Canada by their
 * lists). A field the body leaves out is the stored one, so the check reads the location as it will be saved.
 */
function checkLocation(preferences: Preferences, stored: Preferences): void {
  const country = preferences.homeCountry === undefined ? stored.homeCountry : preferences.homeCountry;
  const region = preferences.homeRegion === undefined ? stored.homeRegion : preferences.homeRegion;
  if (region === null || region === undefined) return;
  if (country === null || country === undefined) {
    const message = 'Choose the country first, then its state or province.';
    throw validationFailed(message, { homeRegion: message });
  }
  if (!isRegionCode(country, region)) {
    const message = `${region} is not a state or province of ${country}. Use its code, such as TX or ON.`;
    throw validationFailed(message, { homeRegion: message });
  }
}

/** Mounted at /api/me. */
export function createMeRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireUser);

  // The one thing a user may change about their own account (free_tailor's rule and sentences).
  router.patch('/', async (req, res) => {
    const user = userOf(req);
    const raw = (req.body as Record<string, unknown> | undefined)?.name;
    if (typeof raw !== 'string') throw validationFailed('There is nothing to change.');
    const name = raw.replace(/\p{Cc}+/gu, ' ').trim();
    if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
      const message = `A display name is between 1 and ${MAX_NAME_LENGTH} characters.`;
      throw validationFailed(message, { name: message });
    }
    await deps.db.run('UPDATE users SET name = ?, updated_at = ? WHERE id = ?', [name, nowIso(deps), user.id]);
    res.json(await getAccount(deps, user.id));
  });

  router.get('/preferences', async (req, res) => {
    res.json(await getPreferences(deps, userOf(req).id));
  });

  router.put('/preferences', async (req, res) => {
    const userId = userOf(req).id;
    const acting = isActing(req); // v33 SHARE-6
    const preferences = normalizePreferences(parseInput(PreferencesSchema, req.body));
    checkSizes(preferences);
    // Read, checked, saved and compared in one transaction (the person's, one at a time), so the comparison that bumps
    // the filters' revision is made against what this save replaced.
    const saved = await deps.db.tx(
      async (t) => {
        await t.lockPerson(userId);
        const stored = await getPreferences(deps, userId);
        checkLocation(preferences, stored);
        // v33 SHARE-6: on a shared profile the owner's contact details stay as stored.
        if (acting) for (const field of OWNER_CONTACT_FIELDS) preferences[field] = stored[field];
        const written = await savePreferences(deps, userId, preferences);
        // v2.0 (INT, P4): the prepare filters compare the person's country, state and time zone; a change of one makes
        // every stored verdict stale, so the Saved labels are computed again at the next read.
        if (
          written.homeCountry !== stored.homeCountry ||
          written.homeRegion !== stored.homeRegion ||
          written.timeZone !== stored.timeZone
        ) {
          await touchFilterRevision(deps, userId);
        }
        return written;
      },
      { label: 'savePreferences' },
    );
    res.json(saved);
  });

  // v32 FIX-UX (UXREQ-15): the Job Tracker board's Lanes shown, the person's own (null until they choose). A save is a
  // small write per change of a box, limited per person (TRACKER_LANES_SAVES_PER_MINUTE).
  router.get('/tracker-lanes', async (req, res) => {
    res.json({ lanes: await getTrackerLanes(deps, userOf(req).id) });
  });
  const lanesLimit = keyedRateLimit({
    windowMs: MINUTE_MS,
    limit: TRACKER_LANES_SAVES_PER_MINUTE,
    key: (req) => `tracker-lanes:${rateKeyOf(req, MINUTE_MS)}`, // v33 SHARE-6: the person's (a `self` route)
    message: (retryAfterSeconds) => `That is a lot of changes at once. Try again in ${retryAfterSeconds} s.`,
  });
  router.put('/tracker-lanes', lanesLimit, async (req, res) => {
    const lanes = parseInput(TrackerLanesSchema, req.body);
    res.json({ lanes: await saveTrackerLanes(deps, userOf(req).id, lanes) });
  });

  // Only one of the caller's own resumes can be the default; anyone else's is "not found", never "forbidden".
  router.put('/default-resume', async (req, res) => {
    const user = userOf(req);
    const { resumeId } = parseInput(SetDefaultResumeBodySchema, req.body);
    if (resumeId !== null) {
      const own = await deps.db.one('SELECT 1 AS found FROM resumes WHERE id = ? AND user_id = ?', [resumeId, user.id]);
      if (!own) throw notFound('That resume');
    }
    await deps.db.run('UPDATE users SET default_resume_id = ?, updated_at = ? WHERE id = ?', [resumeId, nowIso(deps), user.id]);
    // v33 SHARE-6 (PLAN-sharing §4 "Explicit changes"): on a shared profile, the id alone (never the owner's account).
    if (isActing(req)) {
      res.json({ defaultResumeId: resumeId });
      return;
    }
    res.json(await getAccount(deps, user.id));
  });

  return router;
}
