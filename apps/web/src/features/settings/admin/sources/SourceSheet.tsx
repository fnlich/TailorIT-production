'use client';

import {
  JOB_SOURCE_DISCOVERED_VIA_LABEL,
  JOB_SOURCE_ROBOTS_LABEL,
  JOB_SOURCE_TERMS_LABEL,
  JOB_SOURCE_TIER_LABEL,
  type AdminSourceRow,
} from '@tailorit/shared/sourcing';
import { PauseIcon } from '@phosphor-icons/react/Pause';
import { PlayIcon } from '@phosphor-icons/react/Play';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { RowDetailSheet } from '@/components/queue';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { ArrowSquareOutIcon, ArrowsClockwiseIcon } from '@/components/ui/icons';
import { Input, Textarea } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { focusSoon } from '@/lib/focusLater'; // v37 FIX-37B (ux M1)
import { relativeTime } from '@/lib/format';
import { RunStatusBadge } from '../runs/parts';
import { sourcePausedText } from '../runs/pause'; // v31 RUNS
import { fetchSourceSettings, saveSourceTerms, sourceKeys, type SourceSettings } from './api';
import {
  TIER_TONE,
  failureText,
  formatCount,
  isPaused,
  isUnrun,
  robotsTone,
  runNowHint,
  scheduleText,
  sourceDetail,
  sourceLine,
  termsBodyOf, // v37 BOARDS
  termsLetRun, // v37 BOARDS
  termsNoteProblem, // v37 BOARDS
  termsTone,
  termsUrlProblem, // v37 BOARDS
  TERMS_STATUS_OPTIONS, // v37 BOARDS
  turnedOnText,
  waitingTip,
  WAITING_FOR_ADMIN_TIP,
} from './sources';

// v30 S1-WEB: one source's sheet (12 §9.8): its schedule (tier, next run, the last complete listing that verified its
// links, failures), whether its terms and robots.txt let it run, whether its postings may go to AI, how it was found,
// its host and company, and what it reads. The row is CT's AdminSourceRow; its settings come from its own route.
// v31 RUNS: whether an admin paused it (by whom, since when), and its Pause or Continue beside Run now.
// v36 SOURCES (PLAN S8): "Waiting for an admin" (found, never turned on), and who turned it on and when.
// v37 BOARDS (SP v37 PLAN B3): its recorded terms in full (status, terms page, note, when checked), and in the sheet a
// Terms editor for every kind (PATCH /api/admin/sources/:id: only allowed terms let the scheduler and Run now run it).

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-3 py-2 text-sm max-sm:grid-cols-1 max-sm:gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  );
}

function When({ value, now }: { value: string | null; now: number }) {
  if (!value) return <span className="text-muted-foreground">Never</span>;
  return (
    <span>
      {relativeTime(value, now)} <span className="text-muted-foreground">({new Date(value).toLocaleString('en-US')})</span>
    </span>
  );
}

/** v37 BOARDS: a source's recorded terms: its status, terms page, note and when they were checked (read only). */
export function TermsFacts({
  status,
  settings,
  now,
}: {
  status: AdminSourceRow['termsStatus'];
  settings: Pick<SourceSettings, 'termsUrl' | 'termsNote' | 'termsCheckedAt'> | null;
  now: number;
}) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5" data-source-terms={status}>
      <Badge tone={termsTone(status)}>{JOB_SOURCE_TERMS_LABEL[status]}</Badge>
      {settings?.termsUrl && (
        <a
          href={settings.termsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex max-w-full items-center gap-1 text-[13px] font-medium break-all text-primary-ink underline underline-offset-2"
        >
          Terms page
          <ArrowSquareOutIcon size={12} aria-hidden="true" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      )}
      {settings?.termsNote && <p className="text-[13px] leading-5 break-words whitespace-pre-line text-muted-foreground">{settings.termsNote}</p>}
      {settings?.termsCheckedAt && <p className="text-[12px] text-subtle-foreground">Checked {relativeTime(settings.termsCheckedAt, now)}</p>}
    </div>
  );
}

/** v37 FIX-37B (ux M1): the editor's controls focus moves between (the sheet holds one source's at a time). */
const termsIds = (id: number) => ({ edit: `source-${id}-terms-edit`, status: `source-${id}-terms-status` });

/**
 * v37 BOARDS (SP v37 PLAN B3): the sheet's Terms editor: the recorded terms, and Edit terms (status, terms page, note):
 * saved by PATCH; its checked time moves. Only "Allowed" and "Allowed with conditions" let the source run.
 * v37 FIX-37B (the ux review's M1): focus stays in the sheet: Edit terms opens the editor on its Status; Cancel and Save
 * terms come back to Edit terms, a polite status line saying what was saved. The note is not cut at its limit (L4: the
 * field says it is too long), and the fields are 44 px tall on a phone (L5). `onSaved` hands the saved row to the list
 * (its Run now's reason follows the new terms at once).
 */
export function TermsEditor({
  source,
  settings,
  now,
  onSaved,
}: {
  source: AdminSourceRow;
  settings: SourceSettings | null;
  now: number;
  onSaved?: (row: AdminSourceRow) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const ids = termsIds(source.id);
  /** The status last saved here (the sheet's row is the list's, refreshed once it reloads). */
  const [saved, setSaved] = useState<AdminSourceRow['termsStatus'] | null>(null);
  const shown = saved ?? source.termsStatus;
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState(shown);
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** v37 FIX-37B (M1): what the polite status line says (the last save). */
  const [said, setSaid] = useState('');
  const urlProblem = termsUrlProblem(url);
  const noteProblem = termsNoteProblem(note);
  const backToEdit = () => focusSoon([`#${ids.edit}`]);
  const save = useMutation({
    mutationFn: () => saveSourceTerms(source.id, termsBodyOf(status, url, note)),
    onSuccess: (row) => {
      setSaved(row.termsStatus);
      setEditing(false);
      const effect = termsLetRun(row.termsStatus) ? 'It may run on its schedule once it is on.' : 'It does not run until its terms allow it.';
      setSaid(`Terms saved: ${JOB_SOURCE_TERMS_LABEL[row.termsStatus]}. ${effect}`);
      onSaved?.(row);
      backToEdit();
      void queryClient.invalidateQueries({ queryKey: sourceKeys.all });
      toast.success('Terms saved', effect);
    },
    onError: (failure) => setError(userMessage(failure)),
  });
  const start = () => {
    setStatus(shown);
    setUrl(settings?.termsUrl ?? '');
    setNote(settings?.termsNote ?? '');
    setError(null);
    setSaid('');
    setEditing(true);
    focusSoon([`#${ids.status}`]);
  };
  const cancel = () => {
    setEditing(false);
    backToEdit();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (urlProblem || noteProblem) return;
    setError(null);
    save.mutate();
  };
  return (
    <>
      {/* v37 FIX-37B (M1): a status line that stays, so the save is read aloud where focus came back. */}
      <p role="status" className="sr-only" data-terms-said="">
        {said}
      </p>
      {!editing ? (
        <div className="flex flex-col items-start gap-2">
          <TermsFacts status={shown} settings={settings} now={now} />
          <Button id={ids.edit} variant="outline" size="sm" className="max-sm:min-h-11" onClick={start} disabled={!settings}>
            Edit terms
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-3" aria-label="Terms" data-terms-editor="">
          <Field label="Status" hint="Only Allowed and Allowed with conditions let it run.">
            <Select id={ids.status} options={TERMS_STATUS_OPTIONS} value={status} onValueChange={setStatus} className="max-sm:h-11" />
          </Field>
          <Field label="Terms page" optional hint="The page that says whether automated reading is allowed." error={urlProblem ?? undefined}>
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://www.example.com/terms"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              className="max-sm:h-11"
            />
          </Field>
          <Field label="Note" optional hint="What you checked, when, and on what conditions." error={noteProblem ?? undefined}>
            <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={4} />
          </Field>
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" className="max-sm:min-h-11" loading={save.isPending} disabled={Boolean(urlProblem || noteProblem)}>
              Save terms
            </Button>
            <Button variant="ghost" size="sm" className="max-sm:min-h-11" onClick={cancel} disabled={save.isPending}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </>
  );
}

/** The facts of a source (drawn without a server in the web tests). */
export function SourceDetails({
  source,
  settings,
  now,
  onShowHost,
  terms,
}: {
  source: AdminSourceRow;
  settings: SourceSettings | null;
  now: number;
  onShowHost?: (host: string) => void;
  /** v37 BOARDS: the Terms row's content (the sheet's editor); its recorded terms, read only, by default. */
  terms?: ReactNode;
}) {
  const detail = settings ? sourceDetail({ kind: source.kind, config: settings.config }) : null;
  return (
    <div className="flex flex-col gap-6" data-source-details={source.id}>
      <section aria-labelledby={`source-${source.id}-schedule`}>
        <h3 id={`source-${source.id}-schedule`} className="text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
          Schedule
        </h3>
        <dl className="mt-1 divide-y divide-divider-soft">
          <Fact label="State">
            {source.enabled ? (
              'Enabled'
            ) : source.waitingForAdmin ? (
              <span data-source-waiting-admin="">Waiting for an admin: {WAITING_FOR_ADMIN_TIP}</span>
            ) : (
              'Disabled'
            )}
          </Fact>
          {/* v36 SOURCES: who turned it on, and when ("Never turned on"); not from a server before v3.6. */}
          {source.enabledAt !== undefined && (
            <Fact label="Turned on">
              <span data-source-turned-on="">{turnedOnText(source)}</span>
            </Fact>
          )}
          {/* v35 OPSWEB (PLAN H7): switched on, but it cannot run now: why, and what clears it. */}
          {source.enabled && waitingTip(source.waiting) && (
            <Fact label="Waiting">
              <span data-source-waiting={source.waiting!.reason}>{waitingTip(source.waiting)}</span>
            </Fact>
          )}
          {isPaused(source) && <Fact label="Paused">{sourcePausedText(source, now)}</Fact>}
          <Fact label="Tier">
            <Badge tone={TIER_TONE[source.tier]}>{JOB_SOURCE_TIER_LABEL[source.tier]}</Badge>
          </Fact>
          <Fact label="Next run">{scheduleText(source, now)}</Fact>
          <Fact label="Last run">
            <span className="flex flex-wrap items-center gap-2">
              <RunStatusBadge status={source.running ? 'running' : source.lastStatus} />
              {source.lastRunAt && <When value={source.lastRunAt} now={now} />}
            </span>
          </Fact>
          <Fact label="Last success">
            <When value={source.lastSuccessAt} now={now} />
          </Fact>
          <Fact label="Last complete listing">
            <When value={source.lastCompleteAt} now={now} />
          </Fact>
          <Fact label="Failures">{failureText(source) ?? 'None in a row'}</Fact>
          <Fact label="Open jobs">{formatCount(source.openJobs)}</Fact>
        </dl>
      </section>
      <section aria-labelledby={`source-${source.id}-access`}>
        <h3 id={`source-${source.id}-access`} className="text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
          Access
        </h3>
        <dl className="mt-1 divide-y divide-divider-soft">
          <Fact label="Terms">{terms ?? <TermsFacts status={source.termsStatus} settings={settings} now={now} />}</Fact>
          <Fact label="robots.txt">
            <Badge tone={robotsTone(source.robotsStatus)}>{JOB_SOURCE_ROBOTS_LABEL[source.robotsStatus]}</Badge>
          </Fact>
          <Fact label="AI">{source.aiInput ? 'Its postings may be read by AI' : 'Its postings are never sent to AI'}</Fact>
          <Fact label="Found by">{source.discoveredVia ? JOB_SOURCE_DISCOVERED_VIA_LABEL[source.discoveredVia] : 'Added before discovery'}</Fact>
        </dl>
      </section>
      <section aria-labelledby={`source-${source.id}-where`}>
        <h3 id={`source-${source.id}-where`} className="text-[11px] leading-4 font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
          Where it reads
        </h3>
        <dl className="mt-1 divide-y divide-divider-soft">
          <Fact label="Kind">{source.kindLabel}</Fact>
          {detail && <Fact label="Reads">{detail}</Fact>}
          <Fact label="Host">
            {source.host ? (
              onShowHost ? (
                <Button variant="link" onClick={() => onShowHost(source.host!)}>
                  {source.host}
                </Button>
              ) : (
                source.host
              )
            ) : (
              <span className="text-muted-foreground">None (no outside reads)</span>
            )}
          </Fact>
          {source.companyName && <Fact label="Company">{source.companyName}</Fact>}
        </dl>
      </section>
    </div>
  );
}

export function SourceSheet({
  source,
  open,
  onOpenChange,
  now,
  onRun,
  running,
  onShowRuns,
  onShowHost,
  onPurge,
  onPauseToggle,
  pauseBusy = false,
  pausedHint = null,
  onTermsSaved,
}: {
  source: AdminSourceRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  now: number;
  onRun: (source: AdminSourceRow) => void;
  /** Its Run now is on its way. */
  running: boolean;
  onShowRuns: (id: number) => void;
  onShowHost: (host: string) => void;
  onPurge: (source: AdminSourceRow) => void;
  /** v31 RUNS: pauses the source, or continues it once paused. */
  onPauseToggle?: (source: AdminSourceRow) => void;
  /** Its Pause or Continue is on its way. */
  pauseBusy?: boolean;
  /** Why Run now waits (the source, or every run, is paused; v36 SOURCES: or it is off; v37 FIX-37B: or its terms), or null. */
  pausedHint?: string | null;
  /** v37 FIX-37B (E8): the Terms editor saved the source's terms (the list's row takes them). */
  onTermsSaved?: (row: AdminSourceRow) => void;
}) {
  const settings = useQuery({
    queryKey: sourceKeys.detail(source?.id ?? 0),
    queryFn: ({ signal }) => fetchSourceSettings(source!.id, signal),
    enabled: open && source !== null,
  });
  return (
    <RowDetailSheet
      item={source}
      open={open}
      onOpenChange={onOpenChange}
      title={(item) => item.name}
      description={source ? sourceLine(source) : undefined}
      footer={(item) => {
        const hint = pausedHint ?? runNowHint({ kind: item.kind });
        const whyId = `source-${item.id}-sheet-run-why`; // v37 FIX-37B (E8): Run now is described by why it is off
        return (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {hint && (
              <p id={whyId} className="mr-auto max-w-sm text-[13px] text-muted-foreground" data-source-sheet-run-why="">
                {hint}
              </p>
            )}
            <Button variant="outline" onClick={() => onShowRuns(item.id)}>
              See runs
            </Button>
            <Button variant="destructive-outline" onClick={() => onPurge(item)}>
              Purge source
            </Button>
            {/* v31 RUNS: Pause or Continue the source. */}
            {!isUnrun(item) && onPauseToggle && (
              <Button
                variant="outline"
                icon={isPaused(item) ? <PlayIcon size={16} weight="fill" /> : <PauseIcon size={16} weight="fill" />}
                loading={pauseBusy}
                onClick={() => onPauseToggle(item)}
              >
                {isPaused(item) ? 'Continue' : 'Pause'}
              </Button>
            )}
            {!isUnrun(item) && (
              <Button
                icon={<ArrowsClockwiseIcon size={16} />}
                loading={running}
                disabled={item.running || pausedHint !== null}
                focusableWhenDisabled // v37 FIX-37B: off with a reason, still reached and read
                aria-describedby={hint ? whyId : undefined}
                onClick={() => onRun(item)}
                data-source-sheet-run-now=""
              >
                {item.running ? 'Running' : 'Run now'}
              </Button>
            )}
          </div>
        );
      }}
    >
      {(item) => (
        <SourceDetails
          source={item}
          settings={settings.data ?? null}
          now={now}
          onShowHost={onShowHost}
          // v37 BOARDS (PLAN B3): the Terms editor, afresh for each source.
          terms={<TermsEditor key={item.id} source={item} settings={settings.data ?? null} now={now} onSaved={onTermsSaved} />}
        />
      )}
    </RowDetailSheet>
  );
}
