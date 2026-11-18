'use client';

import type { McpTokenList } from '@tailorit/shared/mcp';
import { useQuery } from '@tanstack/react-query';
import { fetchAuthorizationServer, fetchMcpTokens, MCP_TOKENS_KEY, OAUTH_SERVER_KEY } from './api';
import { connectReadiness, type ConnectReadiness } from './integrations';

export interface McpAddress {
  /** The MCP endpoint (MCP_PUBLIC_URL, else APP_ORIGIN/mcp) once known. */
  endpoint: string | null;
  /** Whether Claude and ChatGPT can reach it, once both addresses are known. */
  readiness: ConnectReadiness | null;
  /** The personal tokens (the same answer carries the endpoint). */
  tokens: McpTokenList | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  retry: () => void;
}

/**
 * v3.1 INTEG: TailorIT's MCP address and whether Claude and ChatGPT can reach it. The endpoint is GET /api/mcp/tokens's;
 * TailorIT's own address is the OAuth server's issuer (APP_ORIGIN), else, when its metadata cannot be read, the address
 * this page was opened at.
 */
export function useMcpAddress(): McpAddress {
  const tokens = useQuery({ queryKey: MCP_TOKENS_KEY, queryFn: ({ signal }) => fetchMcpTokens(signal) });
  const server = useQuery({
    queryKey: OAUTH_SERVER_KEY,
    queryFn: ({ signal }) => fetchAuthorizationServer(signal),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const endpoint = tokens.data?.endpoint ?? null;
  const appOrigin = server.data?.issuer ?? (server.isError && typeof window !== 'undefined' ? window.location.origin : null);
  return {
    endpoint,
    readiness: endpoint && appOrigin ? connectReadiness(endpoint, appOrigin) : null,
    tokens: tokens.data,
    isPending: tokens.isPending || (server.isPending && !server.isError),
    isError: tokens.isError,
    error: tokens.error,
    retry: () => {
      void tokens.refetch();
      if (server.isError) void server.refetch();
    },
  };
}
