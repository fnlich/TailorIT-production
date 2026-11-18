import { AuthGate } from '@/components/shell/AuthGate';
import { FocusFrame } from '@/components/shell/FocusFrame';
import { AuthProvider } from '@/lib/auth';

/**
 * v31 FIX-WEB (REV-UX UX-16): signed-in steps that stand on their own (the OAuth consent page), outside the app's
 * shell: the logo and the page's card, as the sign-in page, with no sidebar, top bar or header slots. AuthGate keeps
 * the address through sign-in, as in the app.
 */
export default function FocusLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <FocusFrame>
        <AuthGate>{children}</AuthGate>
      </FocusFrame>
    </AuthProvider>
  );
}
