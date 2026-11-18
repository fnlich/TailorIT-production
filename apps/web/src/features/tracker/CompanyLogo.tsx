'use client';

import { clsx } from 'clsx';
import { useState } from 'react';
import { LetterAvatar, lettersOf } from '@/components/ui/LetterAvatar';

/**
 * A company's logo (tracker cards 32 px, list rows 40 px, the detail header 64 px) on a white tile with a 1 px border
 * and the control radius, or its first letter on a denim-soft tile when there is no logo or it fails to load.
 */
export function CompanyLogo({
  name,
  logoUrl,
  size,
  className,
}: {
  name: string;
  logoUrl: string | null;
  size: number;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (logoUrl && failed !== logoUrl) {
    return (
      // Logos come from any host the job board names, so next/image (which needs each host configured) is not used.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(logoUrl)}
        className={clsx('shrink-0 rounded-control border border-border bg-surface object-contain p-0.5', className)}
        style={{ width: size, height: size }}
      />
    );
  }
  return <LetterAvatar letters={lettersOf(name || '?')} size={size} tone="tint" className={className} />;
}
