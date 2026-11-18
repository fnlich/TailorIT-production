import type { Metadata } from 'next';
import { ConsentPage } from '@/features/oauth/ConsentPage';

// v3.1 OAUTH: where TailorIT's authorization server sends the browser (/oauth/consent?request=<id>, or ?error=<code>).
// v31 FIX-WEB (REV-UX UX-16): in app/(focus), the logo and the card without the app's shell (as the sign-in page).
export const metadata: Metadata = { title: 'Connect an AI app' };

type SearchParams = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined): string | null => (typeof value === 'string' ? value : null);

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return <ConsentPage requestId={one(params.request)} error={one(params.error)} />;
}
