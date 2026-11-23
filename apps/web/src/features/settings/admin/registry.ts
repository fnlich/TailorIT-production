import { createElement, type ComponentType, type ReactNode } from 'react';
import { AiTab } from './AiTab';
import { AiUsageTab } from './AiUsageTab';
import { AnnouncementsTab } from './AnnouncementsTab';
import { ConstantsTab } from './ConstantsTab';
import { ImportTab } from './import/ImportTab'; // v30 S1-WEB: moved into its folder
import { RunsTab } from './runs/RunsTab'; // v30 S1-WEB: moved into its folder
import { SourcesTab } from './sources/SourcesTab'; // v30 S1-WEB: moved into its folder
import { UsersTab } from './UsersTab';
// v30 SCH: wave 3's and 4's tabs, each a stub in its package's folder until that package builds it (`*_TAB_READY`).
import { CANDIDATES_TAB_READY, CandidatesTab } from './candidates/CandidatesTab';
import { COMPANIES_TAB_READY, CompaniesTab } from './companies/CompaniesTab';
import { HOSTS_TAB_READY, HostsTab } from './hosts/HostsTab';
import { REVIEW_TAB_READY, ReviewTab, ReviewTabLabel } from './review/ReviewTab';
// end v30 SCH

// v30 ST0: the admin tab registry (PLAN §6, "Admin tabs"). The Admin page (features/settings/AdminPage.tsx) draws one
// tab per entry, in this order, at /settings/admin?tab=<value>; a new tab is a new entry (a registration file: one
// marked entry per package, appended), never an edit of the page. A tab's frame is components/admin's
// AdminResourceTab. apps/web/src/lib/structure.test.ts checks that the page lists no tab of its own.
//
// v30 SCH: an entry may wait for its package (`ready: false`, from the stub's own `*_TAB_READY`, which the package sets
// once it builds the tab, in its own folder) and may take other tabs' places once drawn (`replaces`: Review takes
// Reports' place, and `?tab=reports` opens Review). ADMIN_TABS is what the page draws.

/** What a tab may read of the page and do to it. */
export interface AdminTabContext {
  /** The tab shown now. */
  tab: string;
  /** The URL's ?source= (a source's runs, an import into a source), or null. */
  sourceId: number | null;
  /** Shows another tab, with a source or none. */
  go: (tab: string, source?: number | null) => void;
}

export interface AdminTabEntry {
  /** The ?tab= value. */
  value: string;
  /** The tab's name in the tab row. */
  label: string;
  render: (context: AdminTabContext) => ReactNode;
  /** v30 SCH: false while the tab's package has not built it (not drawn; its ?tab= opens the first tab). Default true. */
  ready?: boolean;
  /** v30 SCH: the tabs this one takes the place of once drawn: they are not drawn, and their ?tab= opens this one. */
  replaces?: readonly string[];
  /** v30 FIX-WEB (REQ-8): draws the tab's name with a live count ("Review (3)"); the label alone without it. */
  countLabel?: ComponentType<{ label: string }>;
}

/** Every entry, drawn or waiting for its package, in the tab row's order. */
export const ADMIN_TAB_ENTRIES: readonly AdminTabEntry[] = [
  {
    value: 'sources',
    label: 'Sources',
    // v35 OPSWEB (PLAN H6): an import is not a source: its "Import the sheet again" is Admin › Import's Recent imports.
    render: ({ go }) => createElement(SourcesTab, { onShowRuns: (source) => go('runs', source) }),
  },
  // v30 SCH: S1-WEB's hosts (12 §9.4) and S2's discovery candidates (12 §4), beside the sources they feed.
  { value: 'hosts', label: 'Hosts', render: () => createElement(HostsTab), ready: HOSTS_TAB_READY },
  { value: 'candidates', label: 'Candidates', render: () => createElement(CandidatesTab), ready: CANDIDATES_TAB_READY },
  // end v30 SCH
  {
    value: 'runs',
    label: 'Runs',
    render: ({ go, sourceId }) => createElement(RunsTab, { sourceId, onSourceChange: (source) => go('runs', source) }),
  },
  {
    value: 'import',
    // v35 IMPORTWEB: Import (was "Import links"): one link, many links, a file or a Google Sheet, and Recent imports; one
    // import's results are ?tab=import&run=<runId> (the tab reads `run` itself).
    label: 'Import',
    render: () => createElement(ImportTab), // v35 INT-B: "See it on Runs" links to ?tab=runs&run=<runId> itself
    // end v35 IMPORTWEB
  },
  // v30 INT-3: Reports is retired (its tab and /api/admin/reports are gone; Review's Flags lane holds the flags). The
  // entry stays, never drawn, so `?tab=reports` (Review's `replaces`) still opens Review.
  { value: 'reports', label: 'Reports', render: () => null, ready: false },
  // v30 SCH: X1-WEB's Review replaces Reports once ready (14 §6.1); E0-WEB's companies (13 §5.5).
  {
    value: 'review',
    label: 'Review',
    render: () => createElement(ReviewTab),
    ready: REVIEW_TAB_READY,
    replaces: ['reports'],
    countLabel: ReviewTabLabel, // v30 FIX-WEB (REQ-8): what waits for a decision, in the admin nav
  },
  { value: 'companies', label: 'Companies', render: () => createElement(CompaniesTab), ready: COMPANIES_TAB_READY },
  // end v30 SCH
  { value: 'ai', label: 'AI', render: () => createElement(AiTab) },
  { value: 'ai-usage', label: 'AI usage', render: () => createElement(AiUsageTab) },
  { value: 'users', label: 'Users', render: () => createElement(UsersTab) },
  // v2.0
  { value: 'constants', label: 'Constants', render: () => createElement(ConstantsTab) },
  { value: 'announcements', label: 'Announcements', render: () => createElement(AnnouncementsTab) },
];

/** v30 SCH: the entries the page draws: the ready ones, less those a drawn entry replaces. */
export function visibleAdminTabs(entries: readonly AdminTabEntry[] = ADMIN_TAB_ENTRIES): AdminTabEntry[] {
  const ready = entries.filter((entry) => entry.ready !== false);
  const replaced = new Set(ready.flatMap((entry) => entry.replaces ?? []));
  return ready.filter((entry) => !replaced.has(entry.value));
}

/** The tabs the Admin page draws, in order. */
export const ADMIN_TABS: readonly AdminTabEntry[] = visibleAdminTabs();

/** The tab a ?tab= value names: itself when it is drawn, the drawn tab that replaces it, else the first tab. */
export function readAdminTab(value: string | null, entries: readonly AdminTabEntry[] = ADMIN_TAB_ENTRIES): string {
  const drawn = visibleAdminTabs(entries);
  if (drawn.some((entry) => entry.value === value)) return value as string;
  const replacing = drawn.find((entry) => value !== null && entry.replaces?.includes(value));
  return replacing ? replacing.value : drawn[0]!.value;
}

/** The problems of the registry (empty when sound): a repeated value, an empty label, a replaced tab that is no entry. */
export function adminRegistryProblems(tabs: readonly AdminTabEntry[] = ADMIN_TAB_ENTRIES): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of tabs) {
    if (!/^[a-z][a-z0-9-]*$/.test(entry.value)) problems.push(`"${entry.value}" is not a ?tab= value`);
    if (seen.has(entry.value)) problems.push(`"${entry.value}" is listed twice`);
    if (!entry.label.trim()) problems.push(`"${entry.value}" has no label`);
    seen.add(entry.value);
  }
  for (const entry of tabs) {
    for (const value of entry.replaces ?? []) {
      if (!seen.has(value) || value === entry.value) problems.push(`"${entry.value}" replaces "${value}", which is no other tab`);
    }
  }
  return problems;
}
