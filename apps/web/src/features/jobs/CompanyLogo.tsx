'use client';

import { clsx } from 'clsx';
import { useState } from 'react';
import { LetterAvatar, lettersOf } from '@/components/ui/LetterAvatar';

/**
 * A company's logo (40 px on cards, 48 px in the detail) on a white tile with a 1 px border and the control radius, or
 * its first letter on a denim-soft tile when there is none or the image fails to load.
 */
export function CompanyLogo({ name, url, size = 40, className }: { name: string; url: string | null; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return <LetterAvatar letters={lettersOf(name)} size={size} tone="tint" className={className} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- logos come from many hosts; next/image needs each listed.
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className={clsx('shrink-0 rounded-control border border-border bg-surface object-contain p-0.5', className)}
      style={{ width: size, height: size }}
    />
  );
}
