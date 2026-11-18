import { clsx } from 'clsx';

/**
 * TailorIT's own mark (v3.1 "Denim & Tape"): a denim tile holding a "T" whose crossbar is a yellow measuring tape with
 * tick marks and whose stem carries a line of stitches. Colours come from the tokens (fill-* / stroke-* utilities), so
 * the mark follows the palette; app/icon.svg is the same drawing with the token values written out.
 */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={clsx('shrink-0', className)}
    >
      <rect width="32" height="32" rx="8" className="fill-primary" />
      {/* The tape: the crossbar, with a tick every 2.5 units (longer every other one). */}
      <rect x="5.5" y="7" width="21" height="6.5" rx="1.25" className="fill-tape" />
      <path
        d="M8.5 7v2.75M11 7v1.75M13.5 7v2.75M16 7v1.75M18.5 7v2.75M21 7v1.75M23.5 7v2.75"
        strokeWidth="1.1"
        strokeLinecap="round"
        className="stroke-foreground"
      />
      {/* The stem, stitched down its middle. */}
      <rect x="12.75" y="13.5" width="6.5" height="12.5" rx="1.25" className="fill-on-primary" />
      <path d="M16 15.75v8.5" strokeWidth="1.25" strokeLinecap="round" strokeDasharray="1.6 1.9" className="stroke-primary" />
    </svg>
  );
}

export type WordmarkTone = 'default' | 'inverse';

/**
 * "TailorIT" in Bricolage Grotesque 700. `default` is ink with a denim "IT" (light backgrounds); `inverse` is white
 * with a tape-yellow "IT" (the dark sidebar).
 */
export function Wordmark({ size = 22, tone = 'default', className }: { size?: number; tone?: WordmarkTone; className?: string }) {
  return (
    <span
      className={clsx(
        'font-display leading-none font-bold tracking-[-0.02em] whitespace-nowrap',
        tone === 'inverse' ? 'text-sidebar-strong' : 'text-foreground',
        className,
      )}
      style={{ fontSize: size }}
    >
      Tailor<span className={tone === 'inverse' ? 'text-tape' : 'text-primary'}>IT</span>
    </span>
  );
}

/** Mark + wordmark, as the sidebar, the sign-in page and the editors show them. */
export function Logo({
  markSize = 28,
  wordSize = 21,
  gap = 9,
  tone = 'default',
  className,
}: {
  markSize?: number;
  wordSize?: number;
  gap?: number;
  tone?: WordmarkTone;
  className?: string;
}) {
  return (
    <span className={clsx('inline-flex items-center', className)} style={{ gap }}>
      <LogoMark size={markSize} />
      <Wordmark size={wordSize} tone={tone} />
    </span>
  );
}
