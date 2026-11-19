'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { OAUTH_PAGE_ERRORS, type OAuthPageError, type OAuthRequestView } from '@tailorit/shared/oauth';
import { LimitNotice } from '@/components/limits/LimitNotice';
import { LogoMark } from '@/components/shell/Logo';
import { Button, buttonClasses } from '@/components/ui/Button';
import { HelpTip } from '@/components/ui/HelpTip';
import { CheckIcon, ShieldCheckIcon, XIcon } from '@/components/ui/icons';
import { LetterAvatar, lettersOf } from '@/components/ui/LetterAvatar';
import { Notice } from '@/components/ui/Notice';
import { PageSpinner } from '@/components/ui/Spinner';
import { isLimitError, userMessage } from '@/lib/api';
import { fetchOAuthRequest, sendOAuthConsent } from './api';
import { CONSENT_COPY, CONSENT_ERRORS, clientName } from './copy';

// v3.1 OAUTH: the consent page (/oauth/consent?request=<id>), where an AI app the person connects (Claude, ChatGPT)
// asks for their TailorIT account: the app's name and where it is described, where the browser goes next (a warning
// when that is a program on this computer; v31 FIX-AUTH: another when the app is not Claude or ChatGPT by their exact
// addresses), what it can and cannot do, Allow and Cancel. Signed-in only (the app
// layout's AuthGate keeps the address through sign-in), and only in the browser that began the request: the API
// checks that. The page is never framed (next.config.ts: frame-ancestors 'none'). After either answer the browser goes
// back to the app, which shows the result.

const ERROR_CODES = new Set<string>(OAUTH_PAGE_ERRORS);
const INTEGRATIONS_HREF = '/settings/integrations';

/** One rounded panel, as the sign-in page's. */
function Panel({ children, labelledBy }: { children: React.ReactNode; labelledBy: string }) {
  return (
    <section
      aria-labelledby={labelledBy}
      className="w-full max-w-md rounded-card border border-border bg-surface p-6 shadow-card sm:p-8"
    >
      {children}
    </section>
  );
}

function ProblemPanel({ title, body, action = true }: { title: string; body: string; action?: boolean }) {
  return (
    <Panel labelledBy="oauth-problem-title">
      <LogoMark size={40} />
      <h1 id="oauth-problem-title" className="mt-5 font-display text-xl leading-7 font-semibold text-foreground">
        {title}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      {action && (
        <Link href={INTEGRATIONS_HREF} className={buttonClasses({ variant: 'outline', className: 'mt-6' })}>
          {CONSENT_COPY.integrations}
        </Link>
      )}
    </Panel>
  );
}

function List({ items, tone }: { items: readonly string[]; tone: 'can' | 'cannot' }) {
  return (
    <ul className="mt-2 flex flex-col gap-2">
      {items.map((item) => (
        <li key={item} className="flex items-start gap-2 text-sm text-foreground">
          <span className={tone === 'can' ? 'mt-0.5 text-success' : 'mt-0.5 text-muted-foreground'} aria-hidden="true">
            {tone === 'can' ? <CheckIcon size={16} weight="bold" /> : <XIcon size={16} weight="bold" />}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function RequestPanel({ requestId, view }: { requestId: string; view: OAuthRequestView }) {
  const name = clientName(view);
  // v31 FIX-AUTH (SEC-5): TailorIT knows Claude and ChatGPT by their exact addresses; any other app is unverified.
  const unverified = view.client.kind === 'other';
  const heading = useRef<HTMLHeadingElement>(null);
  const [leaving, setLeaving] = useState<'allow' | 'deny' | null>(null);
  const answer = useMutation({
    mutationFn: (decision: 'allow' | 'deny') => sendOAuthConsent({ request: requestId, decision }),
    onSuccess: (result, decision) => {
      setLeaving(decision);
      window.location.assign(result.redirectTo);
    },
  });

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const busy = answer.isPending || leaving !== null;
  return (
    <Panel labelledBy="oauth-consent-title">
      <div className="flex items-center gap-3" aria-hidden="true">
        <LogoMark size={40} />
        <span className="h-px w-6 border-t-[1.5px] border-dashed border-border-strong" />
        <LetterAvatar letters={lettersOf(name)} size={40} tone="tint" />
      </div>
      <div className="mt-5 flex items-start gap-1.5">
        <h1
          id="oauth-consent-title"
          ref={heading}
          tabIndex={-1}
          className="min-w-0 font-display text-xl leading-7 font-semibold break-words text-foreground outline-none"
        >
          {CONSENT_COPY.title(name)}
        </h1>
        <HelpTip label={CONSENT_COPY.pageTitle} className="mt-1">
          {CONSENT_COPY.intro}
        </HelpTip>
      </div>

      <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-control bg-surface-low p-3 text-sm">
        <dt className="text-muted-foreground">{CONSENT_COPY.clientLabel}</dt>
        <dd className="min-w-0 break-words text-foreground">
          <span className="font-semibold">{name}</span>
          <span className="block text-muted-foreground">
            {view.client.host ? CONSENT_COPY.documentAt(view.client.host) : CONSENT_COPY.registered}
          </span>
          {unverified && <span className="block text-muted-foreground">{CONSENT_COPY.unverifiedLabel}</span>}
        </dd>
        <dt className="text-muted-foreground">{CONSENT_COPY.returnLabel}</dt>
        <dd className="min-w-0 font-semibold break-words text-foreground">{view.redirectHost}</dd>
      </dl>

      {unverified && (
        <Notice tone="warning" title={CONSENT_COPY.unverifiedTitle} className="mt-4">
          {CONSENT_COPY.unverified(view.redirectHost)}
        </Notice>
      )}
      {view.loopback && (
        <Notice tone="warning" title={CONSENT_COPY.loopbackTitle} className="mt-4">
          {CONSENT_COPY.loopback(view.redirectHost)}
        </Notice>
      )}

      <h2 className="mt-6 text-sm font-semibold text-foreground">{CONSENT_COPY.can}</h2>
      <List items={CONSENT_COPY.canItems} tone="can" />
      <h2 className="mt-5 text-sm font-semibold text-foreground">{CONSENT_COPY.cannot}</h2>
      <List items={CONSENT_COPY.cannotItems} tone="cannot" />

      <p className="mt-5 flex items-start gap-2 text-sm text-muted-foreground">
        <ShieldCheckIcon size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>{CONSENT_COPY.disconnect}</span>
      </p>

      {answer.isError &&
        (isLimitError(answer.error) ? (
          <LimitNotice limit={answer.error} className="mt-5" />
        ) : (
          <Notice tone="error" className="mt-5">
            {userMessage(answer.error)}
          </Notice>
        ))}
      {leaving && (
        <p role="status" className="mt-5 text-sm text-muted-foreground">
          {CONSENT_COPY.leaving(name)}
        </p>
      )}

      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="outline" disabled={busy} loading={answer.isPending && answer.variables === 'deny'} onClick={() => answer.mutate('deny')}>
          {CONSENT_COPY.cancel}
        </Button>
        <Button disabled={busy} loading={answer.isPending && answer.variables === 'allow'} onClick={() => answer.mutate('allow')}>
          {answer.isPending && answer.variables === 'allow' ? CONSENT_COPY.allowing : CONSENT_COPY.allow}
        </Button>
      </div>
    </Panel>
  );
}

/** The consent page: `requestId` and `error` come from the address. */
export function ConsentPage({ requestId, error }: { requestId: string | null; error: string | null }) {
  const valid = requestId !== null && /^[A-Za-z0-9_-]{43}$/.test(requestId);
  const request = useQuery({
    queryKey: ['oauth', 'request', requestId],
    queryFn: ({ signal }) => fetchOAuthRequest(requestId!, signal),
    enabled: valid && !error,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  let body: React.ReactNode;
  if (error && ERROR_CODES.has(error)) body = <ProblemPanel {...CONSENT_ERRORS[error as OAuthPageError]} />;
  else if (!valid) body = <ProblemPanel {...CONSENT_ERRORS.missing} />;
  else if (request.isPending) body = <PageSpinner label={CONSENT_COPY.loading} />;
  else if (request.isError) body = <ProblemPanel title={CONSENT_COPY.pageTitle} body={userMessage(request.error)} />;
  else body = <RequestPanel requestId={requestId} view={request.data} />;

  return <div className="flex flex-1 flex-col items-center px-4 py-10 sm:py-16">{body}</div>;
}
