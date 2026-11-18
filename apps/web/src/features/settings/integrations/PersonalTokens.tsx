'use client';

import { RobotIcon } from '@phosphor-icons/react/Robot';
import { MCP_TOKEN_NAME_MAX, type McpTokenCreated, type McpTokenItem, type McpTokenList } from '@tailorit/shared/mcp';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { CopyIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { ApiError, userMessage } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { createMcpToken, MCP_TOKENS_KEY, revokeMcpToken } from './api';
import { copyText } from './integrations';
import { setupSnippets, tokenUseLine } from './mcp';
import { useMcpAddress } from './useMcpAddress';

/**
 * Integrations › AI assistants › Advanced: personal access tokens (v1.5 M's "Your own AI (MCP)"; v3.1 INTEG moved it
 * under Advanced, as Claude and ChatGPT now connect through OAuth): make, name, copy and revoke the personal tokens an
 * AI client the person runs themselves (Claude Code, Claude Desktop) uses to reach TailorIT's MCP server, and the
 * setup to paste into it. A token works on any address, http://localhost too.
 */
export function PersonalTokens() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useNow();
  const [name, setName] = useState('Claude Code');
  const [nameError, setNameError] = useState<string | null>(null);
  const [created, setCreated] = useState<McpTokenCreated | null>(null);
  const [revoking, setRevoking] = useState<McpTokenItem | null>(null);
  const address = useMcpAddress();
  // After a Revoke its row is gone: focus goes to "Your tokens" (after Cancel, back to the button).
  const tokensHeading = useRef<HTMLHeadingElement>(null);
  const revoked = useRef(false);

  const create = useMutation({
    mutationFn: (tokenName: string) => createMcpToken(tokenName),
    onSuccess: (token) => {
      setCreated(token);
      setNameError(null);
      queryClient.setQueryData<McpTokenList>(MCP_TOKENS_KEY, (previous) =>
        previous ? { ...previous, items: [token, ...previous.items] } : previous,
      );
      void queryClient.invalidateQueries({ queryKey: MCP_TOKENS_KEY });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.fields?.name) setNameError(error.fields.name);
      else toast.error('The token could not be made', userMessage(error));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('Name the token, so you can tell it apart later');
      return;
    }
    create.mutate(trimmed);
  };

  const copy = async (text: string, what: string) => {
    if (await copyText(text)) toast.success(`${what} copied`);
    else toast.info(`Copy the ${what.toLowerCase()} by hand`, 'Your browser did not let TailorIT copy it.');
  };

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-3">
        <Field label="Token name" hint="Where you use it, for example the computer or the AI client." error={nameError} className="min-w-0 flex-1 basis-64">
          <Input
            value={name}
            maxLength={MCP_TOKEN_NAME_MAX}
            onChange={(event) => {
              setName(event.target.value);
              if (nameError) setNameError(null);
            }}
          />
        </Field>
        <Button type="submit" loading={create.isPending}>
          {create.isPending ? 'Making...' : 'Make token'}
        </Button>
      </form>

      {created && <NewToken token={created} onCopy={copy} onDone={() => setCreated(null)} />}

      <SetupSnippets token={created?.token ?? null} endpoint={address.endpoint ?? undefined} onCopy={copy} />

      <div className="flex flex-col gap-3">
        <h3 ref={tokensHeading} tabIndex={-1} className="text-[15px] leading-5 font-semibold text-foreground outline-none">
          Your tokens
        </h3>
        {address.isError ? (
          <Notice
            tone="error"
            title="Your tokens could not be loaded"
            action={
              <Button variant="outline" size="sm" onClick={address.retry}>
                Try again
              </Button>
            }
          >
            {userMessage(address.error)}
          </Notice>
        ) : !address.tokens ? (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading your tokens">
            <Skeleton className="h-12 w-full" rounded="control" />
          </div>
        ) : (
          <TokenList
            items={address.tokens.items}
            now={now}
            onRevoke={(item) => {
              revoked.current = false;
              setRevoking(item);
            }}
          />
        )}
      </div>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        finalFocus={() => (revoked.current ? tokensHeading.current : true)}
        title={`Revoke ${revoking?.name ?? 'this token'}?`}
        description="The AI client that uses it can no longer reach TailorIT. The drafts it saved stay."
        confirmLabel="Revoke"
        busyLabel="Revoking..."
        onConfirm={async () => {
          if (!revoking) return;
          const { id, name: tokenName } = revoking;
          try {
            await revokeMcpToken(id);
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) throw error;
          }
          revoked.current = true;
          queryClient.setQueryData<McpTokenList>(MCP_TOKENS_KEY, (previous) =>
            previous ? { ...previous, items: previous.items.filter((item) => item.id !== id) } : previous,
          );
          if (created?.id === id) setCreated(null);
          toast.success(`${tokenName} revoked`);
        }}
      />
    </div>
  );
}

/** The new token's secret, shown this once. */
export function NewToken({
  token,
  onCopy,
  onDone,
}: {
  token: McpTokenCreated;
  onCopy: (text: string, what: string) => void;
  onDone: () => void;
}) {
  return (
    <Notice
      tone="success"
      title={`${token.name} is ready. Copy it now: TailorIT shows it only this once.`}
      action={
        <Button variant="outline" size="sm" onClick={onDone}>
          Done
        </Button>
      }
    >
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <output aria-label="Your new MCP token" className="min-w-0 rounded-control bg-surface px-2.5 py-1.5 font-mono text-[13px] break-all text-foreground select-all">
          {token.token}
        </output>
        <Button variant="secondary" size="sm" onClick={() => onCopy(token.token, 'Token')}>
          <CopyIcon size={14} aria-hidden />
          Copy token
        </Button>
      </div>
    </Notice>
  );
}

/** Claude Code's command and the generic JSON, with the new token in them (else a placeholder). */
export function SetupSnippets({
  token,
  endpoint,
  onCopy,
}: {
  token: string | null;
  endpoint?: string;
  onCopy: (text: string, what: string) => void;
}) {
  const snippets = setupSnippets(token, endpoint);
  return (
    <div className="flex flex-col gap-4">
      <Snippet
        title="Claude Code"
        hint={
          token
            ? 'Run this in a terminal: it adds TailorIT with your new token.'
            : 'Run this in a terminal with your token in place of <your-token>.'
        }
        text={snippets.command}
        onCopy={() => onCopy(snippets.command, 'Command')}
      />
      <Snippet
        title="Claude Desktop and other MCP clients"
        hint="Add this to the client's MCP configuration (in Claude Desktop: Settings › Developer › Edit Config), then quit the client fully and open it again. It runs mcp-remote with npx, so Node.js must be installed."
        text={snippets.json}
        onCopy={() => onCopy(snippets.json, 'Configuration')}
      />
    </div>
  );
}

function Snippet({ title, hint, text, onCopy }: { title: string; hint: ReactNode; text: string; onCopy: () => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm leading-5 font-semibold text-foreground">{title}</h3>
          <p className="text-[13px] leading-5 text-muted-foreground">{hint}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onCopy} aria-label={`Copy the ${title} setup`}>
          <CopyIcon size={14} aria-hidden />
          Copy
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-control bg-surface-low px-3 py-2.5 font-mono text-[12.5px] leading-5 whitespace-pre-wrap break-all text-foreground">
        {text}
      </pre>
    </div>
  );
}

/** The live tokens, each with its use and a Revoke button; an empty state without any. */
export function TokenList({
  items,
  now,
  onRevoke,
}: {
  items: readonly McpTokenItem[];
  now: number;
  onRevoke: (item: McpTokenItem) => void;
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<RobotIcon size={24} />}
        title="No MCP token yet"
        description="Make one above, then add TailorIT to your AI client with it."
        variant="dashed"
        size="sm"
      />
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-divider-soft" aria-label="Your MCP tokens">
      {items.map((item) => (
        <li key={item.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-3 first:pt-0 last:pb-0">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">{item.name}</p>
            <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
              {tokenUseLine(item.createdAt, item.lastUsedAt, (value) => formatDate(value), (value) => relativeTime(value, now))}
            </p>
          </div>
          <Button variant="destructive-outline" size="sm" onClick={() => onRevoke(item)}>
            Revoke
          </Button>
        </li>
      ))}
    </ul>
  );
}
