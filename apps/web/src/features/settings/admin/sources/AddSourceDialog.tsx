'use client';

import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { ApiError, userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import type { AddableKind, NewSourceBody } from '../types';
import { createSource, testLake, testSource } from './api';
import { addableKindItems, careerSiteHost, feedNote, workdayAddressProblem } from './sources';

// "Add source" (v2.0, moved out of SourcesTab by v30 S1-WEB unchanged): a Greenhouse, Lever, Ashby or Workable board,
// free_tailor's lake or the demo jobs, tested before it is saved. Discovery (12 §4) adds most boards from v3.0 on.

/** v30 INT-0: no "Demo jobs" in a production build (dev-only, like app/(dev)/). */
const KIND_ITEMS = addableKindItems(process.env.NODE_ENV === 'production');

interface Draft {
  token: string;
  site: string;
  region: 'global' | 'eu';
  board: string;
  account: string;
  path: string;
  companyName: string;
  name: string;
  /** v30 S4: a Himalayas source's country, a Jobicy source's region. */
  country: string;
  geo: string;
  /** v30 FIX-WEB (REQ-5): a career site's address. */
  siteUrl: string;
  /** v35 OPSWEB (PLAN H7): any page of a Workday career site. */
  workdayUrl: string;
}

const EMPTY_DRAFT: Draft = {
  token: '',
  site: '',
  region: 'global',
  board: '',
  account: '',
  path: '',
  companyName: '',
  name: '',
  country: '', // v30 S4
  geo: '', // v30 S4
  siteUrl: '', // v30 FIX-WEB
  workdayUrl: '', // v35 OPSWEB
};

/**
 * v30 S4: the feeds (12 §3.6-3.7): no Test (a new kind of read waits for BOT_USER_AGENT), each says what keeps it off
 * (sources.ts feedNote, its numbers from the constants: v30 FIX-WEB, REQ-7). v30 FIX-WEB (REQ-5): a career site added
 * by hand is the same: no Test (the site reader waits for its switch and the identity).
 */
const FEED_KINDS: readonly AddableKind[] = ['usajobs', 'himalayas', 'jobicy', 'career_site', 'workday_site']; // v35 OPSWEB: Workday too

function bodyOf(kind: AddableKind, draft: Draft): NewSourceBody {
  const company: Record<string, string> = draft.companyName.trim() ? { companyName: draft.companyName.trim() } : {};
  const name = draft.name.trim() || undefined;
  switch (kind) {
    case 'greenhouse':
      return { kind, name, config: { token: draft.token.trim(), ...company } };
    case 'lever':
      return { kind, name, config: { site: draft.site.trim(), region: draft.region, ...company } };
    case 'ashby':
      return { kind, name, config: { board: draft.board.trim(), ...company } };
    case 'workable':
      return { kind, name, config: { account: draft.account.trim(), ...company } };
    case 'ft_lake':
      return { kind, name, config: draft.path.trim() ? { path: draft.path.trim() } : {} };
    case 'seed':
      return { kind, name, config: {} };
    // v30 S4
    case 'usajobs':
      return { kind, name, config: {} };
    case 'himalayas':
      return { kind, name, config: draft.country.trim() ? { country: draft.country.trim() } : {} };
    case 'jobicy':
      return { kind, name, config: draft.geo.trim() ? { geo: draft.geo.trim().toLowerCase() } : {} };
    // v30 FIX-WEB (REQ-5): the host (FIX-A's hand add), and the employer's name when given.
    case 'career_site':
      return { kind, name, config: { host: careerSiteHost(draft.siteUrl) ?? draft.siteUrl.trim(), ...company } };
    // v35 OPSWEB (PLAN H7): the page pasted; the API reads the host, tenant and site from it.
    case 'workday_site':
      return { kind, name, config: { url: draft.workdayUrl.trim(), ...company } };
  }
}

interface TestOutcome {
  ok: boolean;
  message: string;
  samples: string[];
}

/** "Add source": pick the kind, fill in the board (or the lake path), test it without saving, then add it. */
export function AddSourceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (source: { id: number; name: string }) => void;
}) {
  const [kind, setKind] = useState<AddableKind>('greenhouse');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** v35 OPSWEB: the API's words about the Workday address (its `config.url` field), shown under the field. */
  const [urlError, setUrlError] = useState<string | null>(null);
  const constants = usePublicConstants();
  const note = feedNote(
    kind,
    { USAJOBS_MAX_ROWS: constants.get('USAJOBS_MAX_ROWS'), JOBICY_READ_GAP_MINUTES: constants.get('JOBICY_READ_GAP_MINUTES') },
    constants.t,
  );

  const set = (key: keyof Draft) => (event: { target: { value: string } }) => {
    setDraft((previous) => ({ ...previous, [key]: event.target.value }));
    setOutcome(null);
    if (key === 'workdayUrl') setUrlError(null);
  };

  const reset = () => {
    setKind('greenhouse');
    setDraft(EMPTY_DRAFT);
    setOutcome(null);
    setError(null);
    setUrlError(null);
  };

  const test = useMutation({
    mutationFn: async (): Promise<TestOutcome> => {
      if (kind === 'ft_lake') {
        const answer = await testLake(draft.path);
        return { ok: answer.ok, message: answer.message, samples: [] };
      }
      if (kind === 'seed') return { ok: true, message: 'The demo set needs no test.', samples: [] };
      const body = bodyOf(kind, draft);
      const answer = await testSource({ kind, config: body.config });
      return { ok: answer.ok, message: answer.message, samples: answer.samples };
    },
    onSuccess: (answer) => {
      setOutcome(answer);
      setError(null);
    },
    onError: (failure) => setError(userMessage(failure)),
  });

  const create = useMutation({
    mutationFn: () => createSource(bodyOf(kind, draft)),
    onSuccess: (source) => {
      onCreated(source);
      reset();
      onOpenChange(false);
    },
    onError: (failure) => {
      // v35 OPSWEB: a Workday address the API cannot read a site from: its words under the field, not twice.
      const field = failure instanceof ApiError ? failure.fields?.['config.url'] : undefined;
      if (kind === 'workday_site' && field) {
        setUrlError(userMessage(failure));
        return;
      }
      setError(userMessage(failure));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    create.mutate();
  };

  const canTest = kind !== 'seed' && !FEED_KINDS.includes(kind); // v30 S4
  const missing =
    (kind === 'greenhouse' && !draft.token.trim()) ||
    (kind === 'lever' && !draft.site.trim()) ||
    (kind === 'ashby' && !draft.board.trim()) ||
    (kind === 'workable' && !draft.account.trim()) ||
    (kind === 'career_site' && careerSiteHost(draft.siteUrl) === null) || // v30 FIX-WEB
    (kind === 'workday_site' && (!draft.workdayUrl.trim() || workdayAddressProblem(draft.workdayUrl) !== null)); // v35 OPSWEB
  const siteUrlError = kind === 'career_site' && draft.siteUrl.trim() !== '' && careerSiteHost(draft.siteUrl) === null;
  const workdayError = kind === 'workday_site' ? (workdayAddressProblem(draft.workdayUrl) ?? urlError) : null; // v35 OPSWEB

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      {/* v32 COPY (E5): what the chosen kind needs or does is the title's "?" (the kind's note, the demo jobs' words). */}
      <DialogContent
        title="Add source"
        help={
          note ??
          (kind === 'seed'
            ? 'About 120 fictional postings from 15 made-up companies, dated from today.'
            : kind === 'workday_site' // v35 OPSWEB (PLAN H7)
              ? "Reads the site's postings on its schedule, one request at a time, once BOT_USER_AGENT is set and its robots.txt allows it."
              : 'Where TailorIT should read jobs from.')
        }
        size="lg"
      >
        <form onSubmit={submit} className="mt-5 flex flex-col gap-4">
          <SegmentedControl
            aria-label="Source kind"
            size="sm"
            items={KIND_ITEMS}
            value={kind}
            onValueChange={(next) => {
              setKind(next);
              setOutcome(null);
              setError(null);
              setUrlError(null);
            }}
            className="max-w-full overflow-x-auto"
          />
          {kind === 'greenhouse' && (
            <Field label="Board token" hint="The name in boards.greenhouse.io/<token>, or the board's address.">
              <Input value={draft.token} onChange={set('token')} placeholder="gitlab" autoComplete="off" />
            </Field>
          )}
          {kind === 'lever' && (
            <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
              <Field label="Site name" hint="The name in jobs.lever.co/<site>.">
                <Input value={draft.site} onChange={set('site')} placeholder="palantir" autoComplete="off" />
              </Field>
              <Field label="Region">
                <Select
                  options={[
                    { value: 'global', label: 'Global' },
                    { value: 'eu', label: 'EU' },
                  ]}
                  value={draft.region}
                  onValueChange={(region) => setDraft((previous) => ({ ...previous, region }))}
                />
              </Field>
            </div>
          )}
          {kind === 'ashby' && (
            <Field label="Job board name" hint="The name in jobs.ashbyhq.com/<name>.">
              <Input value={draft.board} onChange={set('board')} placeholder="linear" autoComplete="off" />
            </Field>
          )}
          {kind === 'workable' && (
            <Field label="Account name" hint="The name in apply.workable.com/<name>, or the careers page's address.">
              <Input value={draft.account} onChange={set('account')} placeholder="huggingface" autoComplete="off" />
            </Field>
          )}
          {kind === 'ft_lake' && (
            <Field
              label="Database path"
              optional
              hint="The free_tailor.db file, read-only (empty: FT_LAKE_DB_PATH)."
            >
              <Input value={draft.path} onChange={set('path')} placeholder="C:\Users\you\AppData\Local\free_tailor\db\free_tailor.db" autoComplete="off" />
            </Field>
          )}
          {/* v30 S4: a feed's own setting, and what keeps it off. */}
          {kind === 'himalayas' && (
            <Field label="Country" optional hint='Jobs open to this country (default US; "any" keeps all).'>
              <Input value={draft.country} onChange={set('country')} placeholder="US" autoComplete="off" />
            </Field>
          )}
          {kind === 'jobicy' && (
            <Field label="Region" optional hint='As Jobicy writes it, such as usa or emea (default usa; "any" reads all).'>
              <Input value={draft.geo} onChange={set('geo')} placeholder="usa" autoComplete="off" />
            </Field>
          )}
          {/* v30 FIX-WEB (REQ-5): an employer's own career site, by hand. */}
          {kind === 'career_site' && (
            <Field
              label="Career site address"
              hint="The site's address or host, such as careers.acme.com."
              error={siteUrlError ? 'Enter a public address such as careers.acme.com.' : undefined}
            >
              <Input value={draft.siteUrl} onChange={set('siteUrl')} placeholder="careers.acme.com" autoComplete="off" spellCheck={false} />
            </Field>
          )}
          {/* v35 OPSWEB (PLAN H7): a Workday career site, from any page of it; it runs by itself once switched on and able. */}
          {kind === 'workday_site' && (
            <Field
              label="A page of the career site"
              hint="Any page: the site's home, a search or a posting, such as https://acme.wd5.myworkdayjobs.com/en-US/careers."
              error={workdayError ?? undefined}
            >
              <Input
                value={draft.workdayUrl}
                onChange={set('workdayUrl')}
                placeholder="https://acme.wd5.myworkdayjobs.com/en-US/careers"
                autoComplete="off"
                spellCheck={false}
                inputMode="url"
              />
            </Field>
          )}
          {(kind === 'greenhouse' || kind === 'lever' || kind === 'ashby' || kind === 'workable' || kind === 'career_site' || kind === 'workday_site') && (
            <Field label="Company name" optional hint="Shown when the board doesn't name the company.">
              <Input value={draft.companyName} onChange={set('companyName')} autoComplete="off" />
            </Field>
          )}
          <Field label="Display name" optional hint="How it's listed here (the board's name by default).">
            <Input value={draft.name} onChange={set('name')} autoComplete="off" />
          </Field>

          {outcome && (
            <Notice tone={outcome.ok ? 'success' : 'error'} title={outcome.ok ? 'It works' : 'That did not work'}>
              <p>{outcome.message}</p>
              {outcome.samples.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {outcome.samples.map((sample) => (
                    <li key={sample}>{sample}</li>
                  ))}
                </ul>
              )}
            </Notice>
          )}
          {error && <Notice tone="error">{error}</Notice>}

          <DialogFooter flush className="mt-2">
            {canTest && (
              <Button variant="outline" onClick={() => test.mutate()} loading={test.isPending} disabled={missing}>
                Test
              </Button>
            )}
            <Button type="submit" loading={create.isPending} disabled={missing}>
              Add source
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
