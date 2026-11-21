'use client';

import { Badge } from '@/components/ui/Badge';
import { UserIcon } from '@/components/ui/icons';

/** What a card or a row of the All profiles view shows of its profile (v33 SHARE-9). */
export interface CardProfile {
  /** "me" or the shared profile's key. */
  choice: string;
  /** "You", or the owner's name. */
  label: string;
  own: boolean;
}

/**
 * v33 SHARE-9 (PLAN-sharing.md §8): whose Job Tracker a card or a row of the All profiles view is in: "You" in the
 * outline tag, the owner's name in the tint tag (a person glyph before it). A board card names it in its accessible
 * description (`id`), as it does its other marks.
 */
export function ProfileBadge({ profile, id }: { profile: CardProfile; id?: string }) {
  return (
    <Badge
      id={id}
      tone={profile.own ? 'outline' : 'tint'}
      icon={<UserIcon size={12} weight="bold" aria-hidden="true" className="shrink-0" />}
      className="max-w-[14rem]"
      data-profile-badge={profile.choice}
      title={profile.label}
    >
      {profile.label}
    </Badge>
  );
}
