'use client';

import { UsersThreeIcon } from '@phosphor-icons/react/UsersThree';
import { FilterPill } from '@/components/ui/FilterPill';
import { Tooltip } from '@/components/ui/Tooltip';
import { ALL_PROFILES_COPY } from './scope';

/**
 * v33 SHARE-9: "All profiles", the Tracker's switch between the tab's own Job Tracker and every one the person can see
 * at once (pressed: the All profiles view). Shown only when a profile shared with the person lets them see its Job
 * Tracker. A phone keeps its glyph (its words for screen readers), 44 px.
 */
export function AllProfilesToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <Tooltip content={ALL_PROFILES_COPY.toggleTip}>
      <FilterPill
        aria-pressed={on}
        active={on}
        caret={false}
        icon={<UsersThreeIcon size={16} aria-hidden="true" />}
        label={<span className="max-sm:sr-only">{ALL_PROFILES_COPY.toggle}</span>}
        onClick={() => onChange(!on)}
        className="max-sm:size-11 max-sm:justify-center max-sm:gap-0 max-sm:px-0"
        data-all-profiles-toggle=""
      />
    </Tooltip>
  );
}
