import { plainlyFromThisComputer, type ThisComputerRequest } from '../../config/public-origin';
import type { AppDeps } from '../context';

// v34 FIX-API (the final security review, F1): AUTH_DEV_FIXED_CODE (development and tests, never production) signs
// anyone in as any address, so it answers only a request plainly from this computer (config/public-origin.ts
// plainlyFromThisComputer: a loopback peer, a page at localhost, 127.0.0.1 or [::1], no tunnel or proxy in between).
// Anywhere else (a test tunnel, a device on the network) the fixed code is a wrong code, with no hint. TailorIT's test
// servers sign in at forwarded hosts (the tunnel, LAN and e2e flows): they opt in with AUTH_DEV_FIXED_CODE_ANY_ADDRESS,
// set only by scripts/test-servers.mjs and refused in production (config/env.ts).

/** Whether AUTH_DEV_FIXED_CODE signs `req` in: set, and from this computer or under the test servers' opt-in. */
export function fixedCodeUsable(deps: Pick<AppDeps, 'config'>, req: ThisComputerRequest): boolean {
  const { devFixedCode, devFixedCodeAnyAddress } = deps.config.auth;
  if (devFixedCode === null) return false;
  return devFixedCodeAnyAddress || plainlyFromThisComputer(deps.config, req);
}
