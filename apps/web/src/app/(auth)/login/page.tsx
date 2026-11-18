import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SignInPage } from '@/features/auth/SignInPage';
import { SIGN_IN_CARD, SIGN_IN_TITLE, SignInFrame } from '@/features/auth/SignInFrame';

export const metadata: Metadata = { title: 'Sign in' };

/** What the prerendered HTML shows until the page (which reads ?next=) runs in the browser. */
function SignInFallback() {
  return (
    <SignInFrame>
      <div className={SIGN_IN_CARD}>
        <h1 className={SIGN_IN_TITLE}>Sign in</h1>
        <p className="mt-2 text-sm text-muted-foreground">TailorIT keeps your resumes to your own account.</p>
      </div>
    </SignInFrame>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<SignInFallback />}>
      <SignInPage />
    </Suspense>
  );
}
