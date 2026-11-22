import type { Metadata } from 'next';
import { HelpPage } from '@/features/help/HelpPage';

// v34 HELP (PLAN G6): the User Guide in the app (the account menu's Help); /guide is the same guide without sign-in.
export const metadata: Metadata = { title: 'Help' };

export default function Page() {
  return <HelpPage />;
}
