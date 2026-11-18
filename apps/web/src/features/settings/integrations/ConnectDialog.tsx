'use client';

import { useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { ArrowSquareOutIcon, CopyIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { ClientMark } from './ClientMark';
import {
  AI_COPY,
  CHATGPT_PLUGINS_URL,
  claudeLinks,
  CONNECT_COPY,
  copyText,
  type AiClient,
  type ConnectReadiness,
  type ConnectStep,
} from './integrations';
import type { McpAddress } from './useMcpAddress';

// v3.1 INTEG: Connect on Claude's and ChatGPT's cards (decision D6). Claude: "Open Claude" opens Claude's "Add custom
// connector" window prefilled with TailorIT's name and MCP address (a Team or Enterprise owner's variant below it).
// ChatGPT, which has no such link: "Copy address and open ChatGPT" copies the address and opens chatgpt.com/plugins,
// with the three steps to finish there. Both then bring the person to TailorIT's consent page (/oauth/consent). On a
// local or plain http address neither can reach TailorIT: the dialog says so, names the deployment guide, and offers
// the personal tokens (which work on http://localhost) instead.

/** After the main action: Claude's tab opened; ChatGPT's opened with the address copied, or not copied. */
export type ConnectPhase = 'start' | 'opened' | 'opened-not-copied';

function Steps({ client, steps }: { client: string; steps: readonly ConnectStep[] }) {
  return (
    <ol aria-label={CONNECT_COPY.stepsLabel(client)} className="flex flex-col gap-3">
      {steps.map((step, index) => (
        <li key={step.title} className="flex gap-3">
          <span
            aria-hidden="true"
            className="num mt-px flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs text-primary-ink"
          >
            {index + 1}
          </span>
          <span className="min-w-0 text-sm leading-5">
            <span className="block font-semibold text-foreground">{step.title}</span>
            <span className="block text-muted-foreground">{step.body}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The MCP address in a read-only box with Copy (the person can always copy it by hand). */
export function AddressField({ endpoint, onCopy }: { endpoint: string; onCopy: () => void }) {
  return (
    <Field label={CONNECT_COPY.addressLabel}>
      <div className="flex min-w-0 gap-2">
        <Input readOnly value={endpoint} className="min-w-0 flex-1 font-mono text-[13px]" onFocus={(event) => event.currentTarget.select()} />
        <Button variant="outline" icon={<CopyIcon size={16} />} onClick={onCopy} aria-label={AI_COPY.copyAddress}>
          {CONNECT_COPY.copy}
        </Button>
      </div>
    </Field>
  );
}

/** The dialog's body for a client TailorIT's address can reach: the address, the steps, the notes, the progress. */
export function ConnectSteps({
  client,
  endpoint,
  phase,
  onCopy,
}: {
  client: AiClient;
  endpoint: string;
  phase: ConnectPhase;
  onCopy: () => void;
}) {
  const claude = client.kind === 'claude';
  const copy = claude ? CONNECT_COPY.claude : CONNECT_COPY.chatgpt;
  return (
    <div className="mt-5 flex flex-col gap-5" data-connect-steps={client.kind}>
      <AddressField endpoint={endpoint} onCopy={onCopy} />
      <Steps client={client.name} steps={copy.steps} />
      {claude ? (
        <div className="rounded-control bg-surface-low px-3.5 py-3 text-[13px] leading-5 text-muted-foreground">
          <p className="font-semibold text-foreground">{CONNECT_COPY.claude.teamTitle}</p>
          <p className="mt-0.5">{CONNECT_COPY.claude.teamBody}</p>
          <a
            href={claudeLinks(endpoint).owner}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
          >
            {CONNECT_COPY.claude.teamLink}
            <ArrowSquareOutIcon size={14} aria-hidden />
          </a>
        </div>
      ) : (
        <p className="text-[13px] leading-5 text-muted-foreground">{CONNECT_COPY.chatgpt.planNote}</p>
      )}
      {phase !== 'start' && (
        <Notice tone={phase === 'opened' ? 'success' : 'info'}>
          {claude ? CONNECT_COPY.claude.opened : phase === 'opened' ? CONNECT_COPY.chatgpt.opened : CONNECT_COPY.chatgpt.notCopied}
          {!claude && (
            <a
              href={CHATGPT_PLUGINS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 flex items-center gap-1 font-medium underline underline-offset-4"
            >
              {CONNECT_COPY.chatgpt.openAgain}
              <ArrowSquareOutIcon size={14} aria-hidden />
            </a>
          )}
        </Notice>
      )}
    </div>
  );
}

/** The dialog's body when Claude and ChatGPT cannot reach TailorIT: why, the guide, and the personal tokens. */
export function ConnectUnreachable({ client, readiness }: { client: AiClient; readiness: ConnectReadiness }) {
  return (
    <div className="mt-5 flex flex-col gap-4" data-connect-unreachable={client.kind}>
      <Notice tone="warning" title={CONNECT_COPY.unreachableTitle(client.name)}>
        {CONNECT_COPY.unreachableBody(client.name, readiness.blockedAt ?? '')}
      </Notice>
      <p className="text-sm leading-5 text-foreground">
        {CONNECT_COPY.unreachableFix.before}{' '}
        <code className="rounded-tag bg-surface-muted px-1 py-px font-mono text-[13px]">{CONNECT_COPY.unreachableFix.file}</code>{' '}
        {CONNECT_COPY.unreachableFix.after}
      </p>
      <p className="text-sm leading-5 text-muted-foreground">{CONNECT_COPY.meanwhile}</p>
    </div>
  );
}

/** Connect's dialog for Claude or ChatGPT. */
export function ConnectDialog({
  client,
  address,
  open,
  onOpenChange,
  onUseToken,
  finalFocus,
}: {
  client: AiClient;
  address: McpAddress;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Close and open Advanced's personal tokens. */
  onUseToken: () => void;
  /** Where focus goes on close (the Advanced toggle after "Use a personal token"); the Connect button by default. */
  finalFocus?: ComponentProps<typeof DialogContent>['finalFocus'];
}) {
  const toast = useToast();
  const [phase, setPhase] = useState<ConnectPhase>('start');
  // However it closed (Close, Escape, "Use a personal token"), it opens again at the start.
  if (!open && phase !== 'start') setPhase('start');
  const claude = client.kind === 'claude';
  const copy = claude ? CONNECT_COPY.claude : CONNECT_COPY.chatgpt;
  const { endpoint, readiness } = address;
  const ready = endpoint !== null && readiness !== null;
  // The dialog's main action takes the first focus (not the address box, whose text a focus selects).
  const primary = useRef<HTMLElement | null>(null);

  const copyAddress = async () => {
    if (!endpoint) return;
    if (await copyText(endpoint)) toast.success(CONNECT_COPY.copied);
    else toast.info('Copy the address by hand', 'Your browser did not let TailorIT copy it.');
  };

  const openChatGpt = async () => {
    if (!endpoint) return;
    // Copy first (while this page has the focus a clipboard write needs), then open the new tab.
    const copied = await copyText(endpoint);
    window.open(CHATGPT_PLUGINS_URL, '_blank', 'noopener,noreferrer');
    setPhase(copied ? 'opened' : 'opened-not-copied');
  };

  let body: ReactNode;
  let footer: ReactNode;
  if (address.isError && !ready) {
    body = (
      <Notice
        tone="error"
        title={AI_COPY.addressFailed}
        className="mt-5"
        action={
          <Button variant="outline" size="sm" onClick={address.retry}>
            Try again
          </Button>
        }
      >
        {userMessage(address.error)}
      </Notice>
    );
    footer = <CloseButton onClick={() => onOpenChange(false)} label={CONNECT_COPY.close} />;
  } else if (!ready) {
    body = (
      <div className="mt-5 flex flex-col gap-3" aria-busy="true" aria-label={AI_COPY.addressLoading}>
        <Skeleton className="h-9 w-full" rounded="control" />
        <Skeleton className="h-24 w-full" rounded="control" />
      </div>
    );
    footer = <CloseButton onClick={() => onOpenChange(false)} label={CONNECT_COPY.cancel} />;
  } else if (!readiness.reachable) {
    body = <ConnectUnreachable client={client} readiness={readiness} />;
    footer = (
      <>
        <CloseButton onClick={() => onOpenChange(false)} label={CONNECT_COPY.close} />
        <Button ref={(node) => void (primary.current = node)} onClick={onUseToken}>
          {CONNECT_COPY.useToken}
        </Button>
      </>
    );
  } else {
    body = <ConnectSteps client={client} endpoint={endpoint} phase={phase} onCopy={() => void copyAddress()} />;
    footer = (
      <>
        <CloseButton onClick={() => onOpenChange(false)} label={phase === 'start' ? CONNECT_COPY.cancel : CONNECT_COPY.close} />
        {claude ? (
          <a
            ref={(node) => void (primary.current = node)}
            href={claudeLinks(endpoint).personal}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setPhase('opened')}
            className={buttonClasses()}
          >
            {copy.action}
            <ArrowSquareOutIcon size={16} aria-hidden />
          </a>
        ) : (
          <Button
            ref={(node) => void (primary.current = node)}
            trailingIcon={<ArrowSquareOutIcon size={16} aria-hidden />}
            onClick={() => void openChatGpt()}
          >
            {copy.action}
          </Button>
        )}
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        initialFocus={() => primary.current ?? true}
        finalFocus={finalFocus}
        title={
          <span className="flex items-center gap-3">
            <ClientMark kind={client.kind} size={32} />
            {copy.title}
          </span>
        }
        // On a local address the warning says what happens instead.
        description={ready && !readiness.reachable ? undefined : copy.description}
      >
        {body}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CloseButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button variant="outline" onClick={onClick}>
      {label}
    </Button>
  );
}
