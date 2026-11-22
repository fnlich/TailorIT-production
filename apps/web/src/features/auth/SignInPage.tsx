'use client';

import type { SignInResponse } from '@tailorit/shared/auth';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import Script from 'next/script';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { HelpTip } from '@/components/ui/HelpTip';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { ApiError, userMessage } from '@/lib/api';
import { ME_QUERY_KEY } from '@/lib/auth';
import { safeNextPath } from '@/lib/navigation';
import { ACCOUNT_DELETED_PARAM, accountDeletedMarkOf, type AccountDeletionState } from '@tailorit/shared/account-deletion'; // v34 ACCTDEL
import { usePublicConstants } from '@/lib/constants'; // v34 ACCTDEL
import { fetchAuthOptions, requestEmailCode, signInWithGoogle, verifyEmailCode } from './api';
import { codeAlreadySentNotice, cooldownSeconds } from './cooldown';
import { SIGN_IN_CARD, SIGN_IN_TITLE, SignInFrame } from './SignInFrame';

/*
 * The sign-in page (free_tailor's flow, in TailorIT's own frame): Google's own button and/or a six-digit code sent by
 * email, whichever the server offers. No passwords, no sign-up screen: the account is made on the first proven
 * sign-in.
 */

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: { client_id: string; callback: (response: { credential: string }) => void }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

const OPTIONS_UNREACHABLE = "We can't reach the server right now. Try again in a moment.";
const NOTHING_CONFIGURED = "Sign-in isn't available right now. Contact your administrator.";

type Stage = 'address' | 'code';

/** The address was proven but the account is disabled: trying again cannot help, only an administrator can. */
function isDisabledAccount(error: unknown): boolean {
  // v34 ACCTDEL: or it is being deleted (off, and gone on its own within a day): the card says that instead.
  return error instanceof ApiError && (error.code === 'account_disabled' || error.code === 'account_being_deleted');
}

/** v34 ACCTDEL: the card's title for a refused account. */
const refusedTitle = (error: unknown) =>
  error instanceof ApiError && error.code === 'account_being_deleted' ? 'Account being deleted' : 'This account is disabled';

export function SignInPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get('next'));
  const queryClient = useQueryClient();
  // v34 ACCTDEL (PLAN G10): Delete my account ends here, signed out (/login?deleted=1, or =pending when the rest finishes
  // on its own): the page says so once, and drops the mark from the address (a reload says nothing); the notice goes when
  // a code is sent. The page is opened by a full load after a deletion (leaveForSignIn): the mark is read as it mounts.
  const mark = accountDeletedMarkOf(searchParams.get(ACCOUNT_DELETED_PARAM));
  const [deletedNotice, setDeletedNotice] = useState<AccountDeletionState | null>(mark);
  const { t } = usePublicConstants();
  useEffect(() => {
    if (!mark) return;
    const rest = new URLSearchParams(searchParams.toString());
    rest.delete(ACCOUNT_DELETED_PARAM);
    const query = rest.toString();
    router.replace(query ? `/login?${query}` : '/login');
  }, [mark, searchParams, router]);

  const options = useQuery({
    queryKey: ['auth', 'options'],
    queryFn: ({ signal }) => fetchAuthOptions(signal),
    retry: false,
    staleTime: 60_000,
  });

  const [stage, setStage] = useState<Stage>('address');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [disabledAccount, setDisabledAccount] = useState<string | null>(null);
  const [disabledTitle, setDisabledTitle] = useState(''); // v34 ACCTDEL
  const [googleReady, setGoogleReady] = useState(false);
  const googleButton = useRef<HTMLDivElement>(null);

  const finish = useCallback(
    (result: SignInResponse) => {
      queryClient.setQueryData(ME_QUERY_KEY, { account: result.account });
      router.replace(next);
    },
    [next, queryClient, router],
  );

  const onGoogleCredential = useCallback(
    async (credential: string) => {
      setBusy(true);
      setError(null);
      try {
        finish(await signInWithGoogle(credential));
      } catch (caught) {
        if (isDisabledAccount(caught)) {
          setDisabledTitle(refusedTitle(caught));
          setDisabledAccount(userMessage(caught));
        } else setError(userMessage(caught, 'That Google sign-in did not work.'));
      } finally {
        setBusy(false);
      }
    },
    [finish],
  );

  const google = options.data?.google;
  const googleClientId = google?.available ? google.clientId : null;

  /*
   * Google's own button: the credential is issued to the client id by Google's frame, so a button drawn here would
   * have nothing to hand back. It needs both the script and the container, and is drawn again when the
   * disabled-account card gives way to a fresh form.
   */
  useEffect(() => {
    if (!googleReady || !googleClientId) return;
    const parent = googleButton.current;
    if (!parent || !window.google) return;
    window.google.accounts.id.initialize({
      client_id: googleClientId,
      callback: (response) => void onGoogleCredential(response.credential),
    });
    window.google.accounts.id.renderButton(parent, { theme: 'outline', size: 'large', width: 320, text: 'signin_with' });
  }, [googleReady, googleClientId, onGoogleCredential, disabledAccount]);

  const sendCode = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setDeletedNotice(null); // v34 ACCTDEL
    try {
      const result = await requestEmailCode(email.trim());
      setNotice(result.message);
      setStage('code');
    } catch (caught) {
      // Asked again within the minute (e.g. after "Use a different address"): the code already sent still works.
      const wait = cooldownSeconds(caught);
      if (wait !== null) {
        setNotice(codeAlreadySentNotice(email.trim().toLowerCase(), wait));
        setStage('code');
      } else {
        setError(userMessage(caught, 'Could not send the code.'));
      }
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      finish(await verifyEmailCode(email.trim(), code));
    } catch (caught) {
      if (isDisabledAccount(caught)) {
        setDisabledTitle(refusedTitle(caught));
        setDisabledAccount(userMessage(caught));
      } else setError(userMessage(caught, 'That code did not work.'));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const differentAddress = () => {
    setStage('address');
    setCode('');
    setError(null);
    setNotice(null);
  };

  const opts = options.data;
  const contactEmail = opts?.contactEmail ?? null;
  const googleAvailable = Boolean(googleClientId);
  const emailAvailable = Boolean(opts?.email.available);
  const nothingConfigured = opts !== undefined && !googleAvailable && !emailAvailable;
  const optionsError = options.error;
  const devHint = opts?.email.devCodesInConsole ? ' Development: the code is printed in the API console.' : '';

  return (
    <SignInFrame
      footer={
        !disabledAccount &&
        contactEmail && (
          <p className="mt-6 text-center text-sm text-muted-foreground">
            Trouble signing in?{' '}
            <a href={`mailto:${contactEmail}`} className="font-medium text-primary hover:underline">
              Contact admin
            </a>
          </p>
        )
      }
    >
      {googleAvailable && (
        <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onReady={() => setGoogleReady(true)} />
      )}

      {disabledAccount ? (
        <div className={SIGN_IN_CARD}>
          <h1 className={SIGN_IN_TITLE}>{disabledTitle}</h1>
          <p className="mt-3 text-sm break-words text-muted-foreground">{disabledAccount}</p>
          <div className="mt-6 flex flex-col gap-3">
            {contactEmail && (
              <a href={`mailto:${contactEmail}`} className={buttonClasses({ fullWidth: true })}>
                Contact admin
              </a>
            )}
            <Button
              variant="outline"
              fullWidth
              onClick={() => {
                setDisabledAccount(null);
                differentAddress();
              }}
            >
              Sign in with a different account
            </Button>
          </div>
        </div>
      ) : (
        <div className={SIGN_IN_CARD}>
          <div className="flex items-center gap-1.5">
            <h1 className={SIGN_IN_TITLE}>Sign in</h1>
            <HelpTip label="Sign in">TailorIT keeps your resumes to your own account.</HelpTip>
          </div>

          {deletedNotice && (
            <Notice tone={deletedNotice === 'deleted' ? 'success' : 'info'} className="mt-6">
              <span data-account-deleted={deletedNotice}>
                {t(deletedNotice === 'deleted' ? 'MSG_ACCOUNT_DELETED' : 'MSG_ACCOUNT_DELETE_PENDING')}
              </span>
            </Notice>
          )}

          {optionsError && (
            <Notice
              tone="error"
              className="mt-6"
              action={
                <Button variant="outline" size="sm" loading={options.isFetching} onClick={() => void options.refetch()}>
                  Try again
                </Button>
              }
            >
              {optionsError instanceof ApiError && optionsError.code === 'sign_in_unavailable'
                ? optionsError.message
                : OPTIONS_UNREACHABLE}
            </Notice>
          )}

          {nothingConfigured && (
            <Notice tone="warning" className="mt-6">
              {NOTHING_CONFIGURED}
            </Notice>
          )}

          {googleAvailable && (
            <div className="mt-6">
              <div ref={googleButton} className="flex min-h-11 justify-center" />
              {!googleReady && <p className="text-center text-sm text-subtle-foreground">Loading Google sign-in...</p>}
            </div>
          )}

          {googleAvailable && emailAvailable && (
            <div className="my-6 flex items-center gap-3" role="separator" aria-label="or">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[11px] font-semibold tracking-[0.06em] text-subtle-foreground uppercase" aria-hidden="true">
                or
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
          )}

          {emailAvailable && stage === 'address' && (
            <form onSubmit={(event) => void sendCode(event)} className="mt-6 flex flex-col gap-5">
              <Field label="Email address">
                <Input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  disabled={busy}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  size="lg"
                />
              </Field>
              <Button type="submit" fullWidth size="lg" disabled={busy || !email.trim()}>
                {busy ? 'Sending...' : 'Email me a code'}
              </Button>
            </form>
          )}

          {emailAvailable && stage === 'code' && (
            <form onSubmit={(event) => void verifyCode(event)} className="mt-6 flex flex-col gap-5">
              <Field label="Six-digit code">
                <Input
                  // inputMode + autoComplete let a phone offer the code straight from the notification.
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  autoFocus
                  value={code}
                  disabled={busy}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="text-center indent-[0.5em]"
                  style={{ height: '3.5rem', fontSize: '1.5rem', lineHeight: '2rem', letterSpacing: '0.5em' }}
                />
              </Field>
              <div className="flex flex-col gap-3">
                <Button type="submit" fullWidth size="lg" disabled={busy || code.length !== 6}>
                  {busy ? 'Checking...' : 'Sign in'}
                </Button>
                <Button variant="outline" fullWidth size="lg" disabled={busy} onClick={differentAddress}>
                  Use a different address
                </Button>
              </div>
            </form>
          )}

          {notice && !error && (
            // The sentence names the address, which is one unbreakable word: break-words keeps it in the card.
            <Notice tone="info" className="mt-5">
              {notice}
              {devHint}
            </Notice>
          )}
          {error && (
            <Notice tone="error" className="mt-5">
              {error}
            </Notice>
          )}
        </div>
      )}
    </SignInFrame>
  );
}
