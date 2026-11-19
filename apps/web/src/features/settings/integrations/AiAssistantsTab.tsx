'use client';

import { clsx } from 'clsx';
import { useId, useRef, useState, type RefObject } from 'react';
import { LogoMark } from '@/components/shell/Logo';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { CaretDownIcon, CheckCircleIcon, CopyIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { HelpTip } from '@/components/ui/HelpTip';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { AiSettings } from './AiSettings';
import { ClientMark } from './ClientMark';
import { ConnectDialog } from './ConnectDialog';
import { ConnectedAssistants, DisconnectDialog, useOAuthGrants, type DisconnectRequest } from './ConnectedAssistants';
import { IntegrationSection } from './IntegrationSection';
import { AI_CLIENTS, AI_COPY, CONNECT_COPY, copyText, tokenCount, type AiClient } from './integrations';
import { PersonalTokens } from './PersonalTokens';
import { UnsupportedRequests } from './UnsupportedRequests'; // v1.5 Q2
import { useMcpAddress, type McpAddress } from './useMcpAddress';

// v3.1 INTEG: Integrations › AI assistants, laid out like a settings page of MCP clients: TailorIT's MCP address,
// the connected assistants, the assistants to connect (Claude, ChatGPT: Connect), how a connected AI works with
// TailorIT and its settings, what it could not do, and, collapsed under Advanced, the personal access tokens of
// v1.5 (Claude Code, Claude Desktop).

export function AiAssistantsTab() {
  const address = useMcpAddress();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedButton = useRef<HTMLButtonElement>(null);
  // v31 FIX-WEB (REV-UX UX-6): a Disconnect from a Connected row or from a connected assistant's card.
  const [disconnecting, setDisconnecting] = useState<DisconnectRequest | null>(null);
  const connectedHeading = useRef<HTMLHeadingElement>(null);

  const showTokens = () => {
    setAdvancedOpen(true);
    // After the dialog's close: the toggle is the place focus lands (ConnectDialog's finalFocus).
    window.setTimeout(() => advancedButton.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
  };

  return (
    <div className="flex flex-col gap-8">
      <McpServerCard address={address} />
      <ConnectedAssistants onDisconnect={setDisconnecting} headingRef={connectedHeading} />
      <ClientsSection address={address} onUseToken={showTokens} tokensButton={advancedButton} onDisconnect={setDisconnecting} />
      <DisconnectDialog request={disconnecting} onClose={() => setDisconnecting(null)} headingRef={connectedHeading} />
      <AiSettings />
      <UnsupportedRequests />
      <Advanced open={advancedOpen} onOpenChange={setAdvancedOpen} buttonRef={advancedButton} count={address.tokens?.items.length ?? 0} />
    </div>
  );
}

/** "TailorIT MCP": the address an assistant connects to, with Copy. */
export function McpServerCard({ address }: { address: McpAddress }) {
  const toast = useToast();
  const copy = async (endpoint: string) => {
    if (await copyText(endpoint)) toast.success(CONNECT_COPY.copied);
    else toast.info('Copy the address by hand', "Your browser didn't allow copying.");
  };
  return (
    <IntegrationSection
      title={AI_COPY.serverTitle}
      description={AI_COPY.serverDescription}
      aside={<LogoMark size={24} className="order-first" />}
    >
      {address.endpoint ? (
        <Field label={AI_COPY.addressLabel} hint={AI_COPY.addressHint}>
          <div className="flex min-w-0 gap-2">
            <Input
              readOnly
              value={address.endpoint}
              className="min-w-0 flex-1 font-mono text-[13px]"
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              variant="outline"
              icon={<CopyIcon size={16} />}
              aria-label={AI_COPY.copyAddress}
              onClick={() => void copy(address.endpoint!)}
            >
              {CONNECT_COPY.copy}
            </Button>
          </div>
        </Field>
      ) : address.isError ? (
        <Notice
          tone="error"
          title={AI_COPY.addressFailed}
          action={
            <Button variant="outline" size="sm" onClick={address.retry}>
              Try again
            </Button>
          }
        >
          {userMessage(address.error)}
        </Notice>
      ) : (
        <div aria-busy="true" aria-label={AI_COPY.addressLoading}>
          <Skeleton className="h-16 w-full" rounded="control" />
        </div>
      )}
    </IntegrationSection>
  );
}

/** "Assistants to use with TailorIT": Claude and ChatGPT, each with Connect (and a tag once connected). */
function ClientsSection({
  address,
  onUseToken,
  tokensButton,
  onDisconnect,
}: {
  address: McpAddress;
  onUseToken: () => void;
  tokensButton: RefObject<HTMLButtonElement | null>;
  onDisconnect: (request: DisconnectRequest) => void;
}) {
  const headingId = useId();
  const grants = useOAuthGrants();
  const [connecting, setConnecting] = useState<AiClient | null>(null);
  const [toTokens, setToTokens] = useState(false);
  const grantsOf = (kind: AiClient['kind']) => (grants.data?.items ?? []).filter((item) => item.clientKind === kind);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="text-heading font-semibold text-foreground">
        {AI_COPY.clientsTitle}
      </h2>
      <ul aria-label={AI_COPY.clientsList} className="grid gap-4 sm:grid-cols-2">
        {AI_CLIENTS.map((client) => (
          <ClientCard
            key={client.kind}
            client={client}
            connected={grantsOf(client.kind).length > 0}
            onConnect={() => {
              setToTokens(false);
              setConnecting(client);
            }}
            onManage={() => manageConnection(client.kind)}
            onDisconnect={() => onDisconnect({ name: client.name, items: grantsOf(client.kind), from: 'card', kind: client.kind })}
          />
        ))}
      </ul>
      {AI_CLIENTS.map((client) => (
        <ConnectDialog
          key={client.kind}
          client={client}
          address={address}
          open={connecting?.kind === client.kind}
          onOpenChange={(open) => !open && setConnecting(null)}
          finalFocus={() => (toTokens ? tokensButton.current : true)}
          onUseToken={() => {
            setToTokens(true);
            setConnecting(null);
            onUseToken();
          }}
        />
      ))}
    </section>
  );
}

/**
 * Manage: the assistant's first row under Connected (when and how it was used, its Disconnect) comes into view, and
 * focus moves to that row's Disconnect.
 */
function manageConnection(kind: AiClient['kind']) {
  const row = document.querySelector<HTMLElement>(`[data-grant-kind="${kind}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
}

/**
 * One assistant's card: its mark and name, what it does, Connect. v31 FIX-WEB (REV-UX UX-6): once connected, the card
 * says so and offers Manage (its row under Connected) and Disconnect, never a second Connect.
 */
export function ClientCard({
  client,
  connected,
  onConnect,
  onManage,
  onDisconnect,
}: {
  client: AiClient;
  connected: boolean;
  onConnect: () => void;
  onManage?: () => void;
  onDisconnect?: () => void;
}) {
  const nameId = useId();
  return (
    <Card as="li" aria-labelledby={nameId} className="flex flex-col gap-4" data-ai-client={client.kind}>
      <div className="flex items-start gap-3">
        <ClientMark kind={client.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5">
              <h3 id={nameId} className="text-[15px] leading-5 font-semibold text-foreground">
                {client.name}
              </h3>
              <HelpTip label={client.name}>{client.summary}</HelpTip>
            </span>
            {connected && (
              <Badge tone="success" icon={<CheckCircleIcon size={12} weight="fill" aria-hidden />}>
                {AI_COPY.connectedBadge}
              </Badge>
            )}
          </div>
        </div>
      </div>
      <div className="mt-auto flex flex-wrap justify-end gap-2">
        {connected ? (
          <>
            <Button variant="destructive-outline" aria-label={`${AI_COPY.disconnect} ${client.name}`} onClick={onDisconnect} data-ai-disconnect="">
              {AI_COPY.disconnect}
            </Button>
            <Button variant="outline" aria-label={AI_COPY.manageName(client.name)} onClick={onManage} data-ai-manage="">
              {AI_COPY.manage}
            </Button>
          </>
        ) : (
          <Button variant="outline" aria-label={`${AI_COPY.connect} ${client.name}`} onClick={onConnect} data-ai-connect="">
            {AI_COPY.connect}
          </Button>
        )}
      </div>
    </Card>
  );
}

/** Advanced: the personal access tokens, collapsed until opened (a disclosure: the heading holds the button). */
function Advanced({
  open,
  onOpenChange,
  buttonRef,
  count,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  count: number;
}) {
  const panelId = useId();
  const counted = tokenCount(count);
  return (
    <Card padding="none" className="scroll-mt-topbar">
      <h2 className="text-[15px] leading-5 font-semibold text-foreground">
        <button
          ref={buttonRef}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onOpenChange(!open)}
          className="flex w-full items-center gap-3 rounded-card px-5 py-4 text-left hover:bg-surface-low"
        >
          <span className="min-w-0 flex-1">
            <span className="block">{AI_COPY.advancedToggle}</span>
            {counted && <span className="mt-0.5 block text-[13px] font-normal text-muted-foreground">{counted}</span>}
          </span>
          <CaretDownIcon size={18} aria-hidden className={clsx('shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </button>
      </h2>
      <div id={panelId} role="region" aria-label={AI_COPY.tokensTitle} hidden={!open} className="border-t border-divider-soft px-5 pt-4 pb-5">
        {/* v32 COPY (E5): who the tokens are for is the "?" beside the panel's name. */}
        <p className="mb-4 flex items-center gap-1.5 text-sm leading-5 font-medium text-foreground">
          {AI_COPY.tokensTitle}
          <HelpTip label={AI_COPY.tokensTitle}>{AI_COPY.tokensDescription}</HelpTip>
        </p>
        <PersonalTokens />
      </div>
    </Card>
  );
}
