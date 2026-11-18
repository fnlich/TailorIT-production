import type { Response } from 'express';

// v3.1 OAUTH: OAuth's own errors (RFC 6749 §5.2, RFC 7591 §3.2.2, RFC 8707 §2): a code a client reads and a short
// technical description for its developer. They never carry a token, a code or a person's details. The person reads
// TailorIT's own words on the consent page (MSG_OAUTH_* constants) instead.

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'access_denied'
  | 'server_error'
  | 'temporarily_unavailable'
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata';

export class OAuthError extends Error {
  readonly error: OAuthErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;
  constructor(error: OAuthErrorCode, description: string, options: { status?: number; retryAfterSeconds?: number } = {}) {
    super(description);
    this.name = 'OAuthError';
    this.error = error;
    this.status = options.status ?? (error === 'invalid_client' ? 401 : error === 'temporarily_unavailable' ? 503 : 400);
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Sends `error` as OAuth's JSON error body (no-store, as every OAuth answer). */
export function sendOAuthError(res: Response, error: OAuthError): void {
  if (res.headersSent) return;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  if (error.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(error.retryAfterSeconds));
  res.status(error.status).json({ error: error.error, error_description: error.message });
}

/** One string value of a parameter, or undefined; a repeated or structured value is invalid_request (RFC 6749 §3.1). */
export function single(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new OAuthError('invalid_request', `${name} must be given once`);
  return value;
}
