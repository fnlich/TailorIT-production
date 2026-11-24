import type { PrepareFiltersResponse } from '@tailorit/shared/filters';
import type { FanoutFiltersAnswer, FilterKeptSwitch, PrepareFiltersPatchResponse, ProfileChoice } from '@tailorit/shared/sharing';
// Relative, not '@/': the web tests read these.
import { FANOUT_COPY, namesList, shortNamesList } from '../../sharing/fanout/copy';
import { fanoutReport, nameOf, type FanoutReport } from '../../sharing/fanout/results';
import { boxName, type FanoutProfile, type LabelOf } from '../../sharing/fanout/targets';
import { FILTER_FIELD_LABEL, FILTER_KEYS } from './filters';

// v34 FANWEB (PLAN G3; SPECS-W2 FANWEB: "per-profile results with kept eligibility switches ('Kept on Ana's profile:
// needs Sensitive answers › Change')"): what a change of the Prepare filters on several profiles says, pure so the
// tests read it, and the answer of a PATCH as the form's stored copy.

/** The kept switches by their words ("I need visa sponsorship, Clearance"). */
export function keptWords(kept: readonly FilterKeptSwitch[]): string {
  return namesList(kept.map((key) => FILTER_FIELD_LABEL[key]));
}

/**
 * What a filters change on several profiles says: where it changed, and every profile where a switch was kept (a kept
 * switch is the one alert too: the person asked for a change that was not made there). v34 FANWEB fix: the profiles the
 * custom filter was held back from (`customLeftOn`: turned on with words not typed in the form) are named the same way.
 */
export function filtersReport(
  answer: FanoutFiltersAnswer,
  profiles: readonly FanoutProfile[],
  label: LabelOf,
  customLeftOn: readonly ProfileChoice[] = [],
): FanoutReport {
  const kept = answer.results.some((result) => result.ok && result.kept.length > 0) || customLeftOn.length > 0;
  const report = fanoutReport(answer, {
    profiles,
    label,
    did: (result) => result.changed.length > 0,
    // What changed there; a kept switch is said once, under the lines, with the box it needs.
    detail: (result) => (result.changed.length > 0 ? namesList(result.changed.map((key) => FILTER_FIELD_LABEL[key])) : FANOUT_COPY.notChanged),
    title: FANOUT_COPY.filtersChangedOn,
    none: FANOUT_COPY.filtersNotChanged,
    extra: (results) => {
      // v34 FIX-WEB (final review U-L2): one line for every profile that kept a switch (they keep it for the same box),
      // with the next step; never a sentence per profile.
      const keptHere = results.filter((result) => result.kept.length > 0);
      const lines: string[] = [];
      if (keptHere.length > 0) {
        const names = keptHere.map((result) => profiles.find((profile) => profile.choice === result.profile)?.label ?? result.name);
        const switches = FILTER_KEYS.filter((key) => keptHere.some((result) => (result.kept as readonly string[]).includes(key))) as FilterKeptSwitch[];
        lines.push(FANOUT_COPY.keptOn(names, keptWords(switches), boxName('sensitive:edit', label)));
      }
      if (customLeftOn.length > 0) {
        const named = customLeftOn.map((choice) => nameOf(profiles, choice, results.find((result) => result.profile === choice)?.name ?? ''));
        lines.push(FANOUT_COPY.customLeftOut(shortNamesList(named)));
      }
      return lines.length > 0 ? lines.join(' ') : null;
    },
  });
  return { ...report, refused: report.refused || kept };
}

/**
 * v34 FANWEB fix: the answer of a save on several profiles, with the custom filter's change made on the form's own
 * profile alone (`own`, the second request) laid into `self`'s result: what changed there is both requests'.
 */
export function mergeFiltersAnswers(main: FanoutFiltersAnswer | null, own: FanoutFiltersAnswer | null, self: ProfileChoice | null): FanoutFiltersAnswer {
  if (!own || self === null) return main ?? { results: [], left: [] };
  const mine = own.results.find((result) => result.profile === self);
  if (!main) return own;
  if (!mine) return main;
  const results = main.results.some((result) => result.profile === self) ? main.results : [mine, ...main.results];
  return {
    left: main.left,
    results: results.map((result) => {
      if (result.profile !== self || result === mine) return result;
      if (!mine.ok || !result.ok) return mine.ok ? result : mine;
      const union = <K extends string>(a: readonly K[], b: readonly K[]) => [...new Set([...a, ...b])];
      return { ...mine, changed: union(result.changed, mine.changed), kept: union(result.kept, mine.kept) };
    }),
  };
}

/** A PATCH's answer as the form's stored copy (null without Prepare's See there: read it again instead). */
export function storedFilters(answer: Pick<PrepareFiltersPatchResponse, 'filters' | 'revision' | 'locationKnown' | 'timeZoneKnown'>): PrepareFiltersResponse | null {
  if (!answer.filters || answer.revision === null) return null;
  return {
    filters: answer.filters,
    revision: answer.revision,
    locationKnown: answer.locationKnown ?? false,
    timeZoneKnown: answer.timeZoneKnown ?? false,
  };
}
