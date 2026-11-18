import { clsx } from 'clsx';

export type LetterAvatarTone = 'brand' | 'neutral' | 'tint';

const TONES: Record<LetterAvatarTone, string> = {
  // the account's initials: on the tape, in ink, set in the display face
  brand: 'bg-tape text-foreground font-display font-bold',
  // a company without a logo: a quiet grey square, muted letter
  neutral: 'bg-surface-muted text-muted-foreground font-semibold',
  tint: 'bg-primary-soft text-primary-ink font-semibold',
};

/** The letters to show for a name: "Acme Corp" → "A" (one) or "AC" (two). */
export function lettersOf(name: string, count: 1 | 2 = 1): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (count === 1 || words.length === 1) return (words[0] ?? '?').slice(0, count).toUpperCase();
  return `${words[0]?.[0] ?? ''}${words[words.length - 1]?.[0] ?? ''}`.toUpperCase();
}

export interface LetterAvatarProps {
  /** The text to draw (already initials), e.g. initialsOf(name, email) or lettersOf(company). */
  letters: string;
  /** Pixel size of the square (32 tracker card and top bar, 40 large, 64 list row). */
  size?: number;
  tone?: LetterAvatarTone;
  shape?: 'rounded' | 'circle';
  /** When set, the avatar is announced with this text; otherwise it is decorative. */
  label?: string;
  className?: string;
}

/** A square (radius 8 from 40 px, else 6) or circle with letters, for accounts and companies without a logo. */
export function LetterAvatar({ letters, size = 32, tone = 'neutral', shape = 'rounded', label, className }: LetterAvatarProps) {
  const radius = shape === 'circle' ? '9999px' : size >= 40 ? '8px' : '6px';
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={clsx('inline-flex shrink-0 items-center justify-center leading-none select-none', TONES[tone], className)}
      style={{ width: size, height: size, borderRadius: radius, fontSize: Math.round(size * 0.42) }}
    >
      {letters}
    </span>
  );
}
