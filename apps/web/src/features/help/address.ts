'use client';

import { MCP_PATH, claudeCodeCommand, genericMcpConfig } from '@tailorit/shared/mcp';
import { connectorsReachable } from '@tailorit/shared/oauth';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { profileHeaders } from '@/lib/profile';

// v34 HELP: the MCP address the guide shows. The guide reads no user data (the public page has no session, and in the
// app a shared profile must not call the person's own routes). Review #18: it reads the MCP endpoint's public metadata
// (RFC 9728, /.well-known/oauth-protected-resource/mcp, served without sign-in), whose `resource` is the address in use
// (MCP_PUBLIC_URL when set, as Integrations shows); until that answers, or if it never does, the address of the site the
// page is open on followed by /mcp.

/** A placeholder token for the snippets: never a real one. */
export const TOKEN_PLACEHOLDER = 'tim_your_token';

/** The MCP endpoint's public metadata, on the site the page is open on. */
export const RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;

const subscribe = () => () => undefined;

/** The metadata's `resource`, read once per page load (the guide shows the address in three places). */
let resourceRead: Promise<string | null> | null = null;
function metadataResource(): Promise<string | null> {
  // profileHeaders: the rule for every raw fetch (lib/profile-scan.test.ts); outside /api it adds nothing.
  resourceRead ??= fetch(RESOURCE_METADATA_PATH, { credentials: 'omit', headers: { ...profileHeaders(RESOURCE_METADATA_PATH), Accept: 'application/json' } })
    .then((answer) => (answer.ok ? answer.json() : null))
    .then((body: unknown) => resourceOf(body))
    .catch(() => null);
  return resourceRead;
}

/** The `resource` of a protected-resource metadata answer, when it is an http(s) address. */
export function resourceOf(answer: unknown): string | null {
  if (!answer || typeof answer !== 'object') return null;
  const resource = (answer as { resource?: unknown }).resource;
  return typeof resource === 'string' && /^https?:\/\//i.test(resource) ? resource : null;
}

export interface McpAddressHere {
  /** The MCP address; null while rendering on the server. */
  address: string | null;
  /** Whether Claude's and ChatGPT's servers can reach it (a public https address); null until known. */
  reachable: boolean | null;
}

/** TailorIT's MCP address as this page knows it (see above). */
export function useMcpAddressHere(): McpAddressHere {
  const fallback = useSyncExternalStore(
    subscribe,
    () => `${window.location.origin}${MCP_PATH}`,
    () => null,
  );
  const [resource, setResource] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void metadataResource().then((found) => {
      if (live) setResource(found);
    });
    return () => {
      live = false;
    };
  }, []);
  const address = resource ?? fallback;
  return { address, reachable: address ? connectorsReachable(address) : null };
}

/** The snippets a person copies, for `address` (a placeholder token in them). */
export function connectSnippets(address: string): { claudeCode: string; config: string } {
  return { claudeCode: claudeCodeCommand(TOKEN_PLACEHOLDER, address), config: genericMcpConfig(TOKEN_PLACEHOLDER, address) };
}
