import { defineAdapter, type DefinedAdapter } from './define';
import { IngestError, type SourceKind } from '../types';

// v38 ATS-D (SP v38 PLAN "Final coverage"): the platforms TailorIT recognises but never reads, whatever asks: SAP
// SuccessFactors (robots.txt disallows every path), Phenom (an AWS WAF bot challenge on every request) and JobDiva (a
// portal gated by Turnstile and reCAPTCHA, its data behind the agency's own API user). Their kinds never run (their rows:
// runs false) and no source of theirs is made (a link's verdict is can't read, with no request: ingest/boards/*.ts);
// an adapter is each kind's all the same (the registry's rule), and its run is refused in a sentence an admin reads.

/** A kind's listing that is never read: its hosts declared (the harness holds it to them), its run refused with `why`. */
export function notReadAdapter(kind: SourceKind, label: string, hosts: readonly string[], why: string): DefinedAdapter {
  return defineAdapter({
    kind,
    label,
    access: 'page',
    hosts,
    fetch() {
      return Promise.reject(new IngestError(`${why} TailorIT never reads it, so this source cannot be run.`));
    },
  });
}

export const successFactorsAdapter = notReadAdapter(
  'successfactors',
  'SAP SuccessFactors career site',
  ['*.successfactors.com', '*.successfactors.eu'],
  "SAP SuccessFactors' career sites ask every robot not to read any page (robots.txt).",
);

export const phenomAdapter = notReadAdapter('phenom', 'Phenom career site', ['*.phenompro.com'], 'Phenom sites check every visitor for robots.');

export const jobDivaAdapter = notReadAdapter(
  'jobdiva',
  'JobDiva portal',
  ['*.jobdiva.com'],
  "JobDiva's portals check every visitor for robots, and their jobs need the agency's own login.",
);
