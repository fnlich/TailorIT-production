import type { MessageRenderer } from '../components/limits/limits';
import { PUBLIC_CONSTANT_DEFAULTS, renderPublicMessage } from './constants';

// v30 ST5: the messages' defaults for the web's pure helpers (a status line, a refusal, a notice). A page passes its
// own `t` (usePublicConstants().t: the server's values, an admin's words included); a helper called without one (a
// test, the sign-in page, which has no session to read the server's values with) renders the defaults, the same words
// the page shows until the server answers.

export type { MessageRenderer };

/** Message `key` at its default words, its placeholders filled: the `t` of a helper no page passed one to. */
export const defaultT: MessageRenderer = (key, params) => renderPublicMessage(PUBLIC_CONSTANT_DEFAULTS, key, params);
