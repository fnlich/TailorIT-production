import type { Metadata } from 'next';
import { PublicGuide } from '@/features/help/PublicGuide';

// v34 HELP (PLAN G6, G8): the User Guide without sign-in, the documentation address of Claude's connector directory.
// PUBLIC owns app/(public)/layout.tsx and the proxy's exemption for /guide; this page draws inside what they give it.
// v34 INT-A: the guide's numbers are the public constants the (public) layout reads on the server for every public page
// (features/public/server-constants.ts, signed out, never a session) and hands to the browser's query cache, so the
// first HTML carries the server's values; PublicGuide reads them with usePublicConstants().
export const metadata: Metadata = {
  title: 'User guide',
  description: 'How to use TailorIT: finding and tracking jobs, auto-apply, documents, and connecting Claude, ChatGPT or another AI app.',
};

export default function Page() {
  return <PublicGuide />;
}
