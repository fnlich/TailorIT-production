import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { AppProviders } from '@/components/providers/AppProviders';
import '@/styles/globals.css';

// v3.1 "Denim & Tape" (docs/design/v3.1/20-visual-identity.md): IBM Plex Sans for the UI, Bricolage Grotesque for page
// titles and the brand, IBM Plex Mono for measurements. The font files are in the repository (src/fonts, Latin, with
// their SIL Open Font License texts), so a build, the dev server and the tests never ask Google Fonts for anything.
// Plex Sans and Bricolage are variable files; each face declares only the weights the UI uses. next/font names each
// face after its const (IBMPlexSans, ...), so the computed font-family still says which face it is.
const IBMPlexSans = localFont({
  src: '../fonts/IBMPlexSans-latin-var.woff2',
  weight: '400 700',
  style: 'normal',
  variable: '--font-plex-sans',
  display: 'swap',
});
const BricolageGrotesque = localFont({
  src: '../fonts/BricolageGrotesque-latin-var.woff2',
  weight: '600 700',
  style: 'normal',
  variable: '--font-bricolage',
  display: 'swap',
});
const IBMPlexMono = localFont({
  src: '../fonts/IBMPlexMono-500-latin.woff2',
  weight: '500',
  style: 'normal',
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: 'TailorIT', template: '%s · TailorIT' },
  description: 'Find jobs, track applications and manage your resumes and cover letters.',
};

export const viewport: Viewport = {
  // The sidebar's dark denim (--color-sidebar): the browser's own bar matches the app's frame.
  themeColor: '#171c38',
};

// suppressHydrationWarning on <html> and <body>: browser extensions (security, ad-blocking, password managers,
// Grammarly) add their own attributes to these two elements before React hydrates, e.g.
// __processed_<uuid>__="true" on <body>. React then reports a hydration mismatch that is not TailorIT's. The flag
// ignores attribute differences on these two elements only; mismatches inside the page are still reported.
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${IBMPlexSans.variable} ${BricolageGrotesque.variable} ${IBMPlexMono.variable}`}
      suppressHydrationWarning
    >
      <body suppressHydrationWarning>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
