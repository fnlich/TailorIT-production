import { clsx } from 'clsx';
import type { OAuthClientKind } from '@tailorit/shared/oauth';
import { CalendarBlankIcon, EnvelopeIcon } from '@/components/ui/icons';
import { lettersOf } from '@/components/ui/LetterAvatar';
import type { Connection } from './integrations';

// v3.1 INTEG: the marks of the apps on the Integrations page. Plain monograms and generic glyphs TailorIT draws itself
// on its own tokens, never another product's logo: a letter for an AI assistant, an envelope for an inbox, a calendar
// page for a calendar. Decoration only (aria-hidden): the app's name is always written beside it.

export type MarkKind = OAuthClientKind | Connection['id'];

const TILES: Record<MarkKind, string> = {
  claude: 'bg-tape-soft text-foreground',
  chatgpt: 'bg-primary-soft text-primary-ink',
  other: 'bg-surface-muted text-muted-foreground',
  gmail: 'bg-danger-soft text-danger-ink',
  'google-calendar': 'bg-info-soft text-info-ink',
};

/** The letter each known assistant's monogram shows ("G" for ChatGPT, so it never looks like Claude's "C"). */
const LETTERS: Partial<Record<MarkKind, string>> = { claude: 'C', chatgpt: 'G' };

/** A rounded tile with the app's monogram or glyph; `name` gives another app's letter. */
export function ClientMark({ kind, name, size = 40, className }: { kind: MarkKind; name?: string; size?: 32 | 40; className?: string }) {
  const glyph = size === 40 ? 20 : 16;
  return (
    <span
      aria-hidden="true"
      data-mark={kind}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-card border border-border/60 font-display leading-none font-semibold select-none',
        size === 40 ? 'size-10 text-lg' : 'size-8 text-[15px]',
        TILES[kind],
        className,
      )}
    >
      {kind === 'gmail' ? (
        <EnvelopeIcon size={glyph} weight="bold" />
      ) : kind === 'google-calendar' ? (
        <CalendarBlankIcon size={glyph} weight="bold" />
      ) : (
        (LETTERS[kind] ?? lettersOf(name ?? '?'))
      )}
    </span>
  );
}
