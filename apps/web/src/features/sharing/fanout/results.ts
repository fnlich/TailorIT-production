import type { FanoutLeft, FanoutRefused, ProfileChoice } from '@tailorit/shared/sharing';
import { FANOUT_COPY, NAMES_SHOWN, namesList } from './copy';
import { boxName, type FanoutProfile, type LabelOf } from './targets';

// v34 FANWEB (PLAN G1: "answers per profile"; SPECS-W2 FANWEB: "Per-profile results in one toast/alert ('Saved on You
// and Ana · not on Ben: no access')"): one fan-out answer as one message, pure so the tests read it. Every profile done
// and none refused: a toast (with Undo where the action has one). A profile refused: one alert listing each profile's
// line. Why a profile was refused comes from the boxes the shell holds, never from the answer (the server answers every
// unusable profile alike): a box its owner did not tick names that box; a profile that was there when the list was read
// and is refused now is "not available now" (the share ended, or the owner changed the boxes meanwhile).
// v34 FANWEB fix (the reviews' M2, M3): a profile that answered but where nothing was done is named with why ("Ana Lopez
// can't see this job."), and a share 'all' left out is named with the box it needs and the next step.

/** One profile's line of a result. */
export interface ReportLine {
  profile: ProfileChoice;
  /** "You", or the owner's name. */
  name: string;
  ok: boolean;
  /** What happened there ("2 saved, 1 already there"), or why not. */
  text: string;
}

/** A fan-out answer as one message. */
export interface FanoutReport {
  /** "Saved on You and Ana"; the "nothing" title when no profile did it. */
  title: string;
  /** The toast's second line (the shares 'all' left out, a detail), or null. */
  description: string | null;
  /** v34 FIX-WEB (final review U-L2): the description's sentences apart (the alert draws each on its own line). */
  notes?: string[];
  /** Every profile's line, the person's own first (the alert's list). */
  lines: ReportLine[];
  /** A profile was refused: the message is one alert, not a toast. */
  refused: boolean;
  /** Something was done on at least one profile (Undo has something to undo). */
  done: boolean;
  /**
   * v36 FIX-WEB (ux M1): the toast lists each profile's line too ("Ana Lopez: 1 removed, 2 applied: left as is"), as the
   * alert does; past NAMES_SHOWN profiles it says how many, and its Details opens the alert.
   */
  toastLines?: boolean;
}

export interface ReportOptions<T> {
  /** The profiles the action offered (their names and boxes). */
  profiles: readonly FanoutProfile[];
  /** Reads a box's name (usePublicConstants().t). */
  label: LabelOf;
  /** Whether a profile's result did something (a save saved, a change changed). */
  did: (result: T) => boolean;
  /** One profile's line when it was done. */
  detail: (result: T) => string;
  /** The title from the names of the profiles where it was done ("Saved on You and Ana"). */
  title: (names: string) => string;
  /** The title when it was done nowhere. */
  none: string;
  /** Extra words for the toast (a kept switch, a count), added after the left-out line. */
  extra?: (results: readonly (T & { ok: true })[]) => string | null;
  /**
   * v34 FANWEB fix: a profile that answered but did nothing, as a sentence naming it and why ("Ana Lopez can't see this
   * job."); null says nothing of it (another part does).
   */
  nothing?: (result: T, name: string) => string | null;
  /**
   * v36 FIX-WEB (ux M1): the message lists each profile's line, in the toast too (FanoutReport.toastLines); a profile
   * that did nothing is then said by its line alone (no `nothing` sentence beside it).
   */
  toastLines?: boolean;
}

type Result<T> = (T & { ok: true; profile: ProfileChoice; name: string }) | FanoutRefused;

/** The name a profile goes by in a result: the list's (it names a same-named owner apart), else the answer's. */
export function nameOf(profiles: readonly FanoutProfile[], choice: ProfileChoice, answered: string): string {
  return profiles.find((profile) => profile.choice === choice)?.label ?? (answered || FANOUT_COPY.unknownProfile);
}

/**
 * Why a profile was refused, from the list's boxes (with the next step: its owner ticks the box); a profile's own refusal
 * (its service's words) as it came.
 */
export function refusalText(profiles: readonly FanoutProfile[], refused: FanoutRefused, label: LabelOf): string {
  if (refused.refused !== 'profile_ended') return refused.message;
  const profile = profiles.find((one) => one.choice === refused.profile);
  const box = profile && !profile.allowed ? profile.missing[0] : undefined;
  return box ? FANOUT_COPY.needsAsk(boxName(box, label)) : FANOUT_COPY.unavailable;
}

/** v34 FANWEB fix (spec M3): "Left out: Ben Ito (needs Job Tracker › Change). Ask its owner to tick it in …". */
export function leftOutText(left: readonly FanoutLeft[], profiles: readonly FanoutProfile[], label: LabelOf): string | null {
  if (left.length === 0) return null;
  const boxes = left.map((one) => {
    const profile = profiles.find((entry) => entry.choice === one.profile);
    const box = profile && !profile.allowed ? profile.missing[0] : undefined;
    return box ? boxName(box, label) : null;
  });
  const items = left.map((one, index) => FANOUT_COPY.leftOutItem(nameOf(profiles, one.profile, one.name), boxes[index] ?? null));
  const ask = boxes.every(Boolean) ? (left.length > 1 ? 'each' : 'its') : null;
  return FANOUT_COPY.leftOut(namesList(items), ask);
}

/** The answer's results and left-out shares as one message. */
export function fanoutReport<T>(answer: { results: readonly Result<T>[]; left: readonly FanoutLeft[] }, options: ReportOptions<T>): FanoutReport {
  const { profiles, label } = options;
  const lines: ReportLine[] = answer.results.map((result) =>
    result.ok
      ? { profile: result.profile, name: nameOf(profiles, result.profile, result.name), ok: true, text: options.detail(result as T) }
      : { profile: result.profile, name: nameOf(profiles, result.profile, result.name), ok: false, text: refusalText(profiles, result, label) },
  );
  const doneOn = answer.results.filter((result): result is T & { ok: true; profile: ProfileChoice; name: string } => result.ok && options.did(result as T));
  const names = doneOn.map((result) => nameOf(profiles, result.profile, result.name));
  const okResults = answer.results.filter((result) => result.ok) as unknown as (T & { ok: true })[];
  // v34 FANWEB fix (spec M2): a profile that answered and did nothing is named too, with why.
  const nothing = options.toastLines
    ? []
    : answer.results
        .filter((result): result is T & { ok: true; profile: ProfileChoice; name: string } => result.ok && !options.did(result as T))
        .map((result) => options.nothing?.(result as T, nameOf(profiles, result.profile, result.name)) ?? null);
  const parts = [leftOutText(answer.left, profiles, label), ...nothing, options.extra?.(okResults) ?? null].filter(
    (part): part is string => Boolean(part),
  );
  return {
    // v34 FIX-WEB (final review U-L2): past three profiles the title says their count (the alert lists each one).
    title: names.length > 0 ? options.title(names.length > NAMES_SHOWN ? FANOUT_COPY.profilesCount(names.length) : namesList(names)) : options.none,
    description: parts.length > 0 ? parts.join(' ') : null,
    notes: parts,
    lines,
    refused: answer.results.some((result) => !result.ok),
    done: doneOn.length > 0,
    ...(options.toastLines ? { toastLines: true } : {}),
  };
}
