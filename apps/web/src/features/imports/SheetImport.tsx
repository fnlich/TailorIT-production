'use client';

import type { JobImportPreview, JobRowMapping } from '@tailorit/shared';
import { SHEET_MAX_HEADER_ROW, parseSpreadsheetRef } from '@tailorit/shared/ingest';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { ArrowSquareOutIcon, CopyIcon, WarningCircleIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { isApiError, isProfileRefusal, userMessage } from '@/lib/api';
import { fetchSheetAccount, importKeys, importSheet, previewSheet, type ImportAudience, type SheetChoices, type StartedImport } from './api';
import { ImportBar } from './ImportBar';
import { headerUnsure } from './mapping';
import { webLink } from './results';
import { MappingPreview } from './MappingPreview';
import { usePreview } from './usePreview';

// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §1 "Choose a Google Sheet"): an import from one tab of a Google Sheet,
// for an admin or a person. TailorIT's reader address with Copy and "Share your sheet with this address (Viewer)", the
// sheet's link, Read sheet, then the tab choice (the preview's spreadsheet tabs), the header row and the mapping
// preview, then Import. Hidden, with one line saying why, while the server has no reader (`sheet/account`). TailorIT
// only reads the sheet, once per preview or import.

export interface SheetImportProps {
  audience: ImportAudience;
  /** The one line said while the server has no reader ("Google Sheet import isn't set up on this server."). */
  offLine: ReactNode;
  limits: (preview: JobImportPreview) => ReactNode;
  onStarted: (started: StartedImport) => void;
}

const HEADER_ROW_MESSAGE = `Choose a header row from 1 to ${SHEET_MAX_HEADER_ROW}.`;

export function SheetImport({ audience, offLine, limits, onStarted }: SheetImportProps) {
  const toast = useToast();
  const account = useQuery({
    queryKey: importKeys.sheetAccount(audience),
    queryFn: ({ signal }) => fetchSheetAccount(audience, signal),
    staleTime: 60_000,
  });
  const [link, setLink] = useState('');
  const [linkTouched, setLinkTouched] = useState(false);
  const [headerText, setHeaderText] = useState('1');
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<JobRowMapping | null>(null);
  const [headerTouched, setHeaderTouched] = useState(false);
  const reading = usePreview<SheetChoices>((choices, signal) => previewSheet(audience, choices, signal));
  const { preview } = reading;
  const asked = reading.choices;
  const mapping: JobRowMapping | null = (reading.busy && chosen) || preview?.mapping || null;
  const tabGid = preview?.spreadsheet?.gid;

  const start = useMutation({
    mutationFn: () =>
      importSheet(audience, {
        url: asked!.url,
        ...(tabGid !== undefined ? { gid: tabGid } : {}),
        headerRow: asked?.headerRow ?? 1,
        mapping,
        hasHeader: preview!.hasHeader,
      }),
    onSuccess: onStarted,
  });

  const ref = parseSpreadsheetRef(link);
  const fields = isApiError(reading.error) ? (reading.error.fields ?? {}) : {};
  const linkError = fields.url ?? (linkTouched && link.trim() && !ref.ok ? ref.message : undefined);
  // v35 FIX-WEB (FIX-STORE's S3): a tab TailorIT may not read (hidden, or gone: MSG_JOB_IMPORT_SHEET_TAB_NOT_FOUND on
  // `gid`) is said in the alert, with the server's words: the link may name it before any tab list is drawn. A sheet
  // linked to another account (403, MSG_JOB_IMPORT_SHEET_CLAIMED) is said there too.
  const otherError =
    reading.error && !fields.url && !fields.headerRow && !isProfileRefusal(reading.error) ? (fields.gid ?? userMessage(reading.error)) : null;
  const startError = start.error && !isProfileRefusal(start.error) ? userMessage(start.error) : null;

  const read = (event: FormEvent) => {
    event.preventDefault();
    setLinkTouched(true);
    if (!ref.ok) return;
    setChosen(null);
    setHeaderTouched(false);
    setHeaderText('1');
    setHeaderError(null);
    start.reset();
    reading.reset();
    reading.ask({ url: link.trim(), refresh: true });
  };

  /** The tab shown, asked again with these choices (no new read of Google unless `refresh`). */
  const askAgain = (choices: Partial<SheetChoices>) => {
    if (!asked) return;
    start.reset();
    reading.ask({
      url: asked.url,
      ...(tabGid !== undefined ? { gid: tabGid } : {}),
      headerRow: asked.headerRow ?? 1,
      refresh: false,
      ...choices,
    });
  };

  const chooseTab = (gid: number) => {
    if (gid === tabGid) return;
    setChosen(null);
    setHeaderTouched(false);
    setHeaderText('1');
    setHeaderError(null);
    askAgain({ gid, headerRow: 1, mapping: undefined, hasHeader: undefined, refresh: true });
  };

  const applyHeaderRow = () => {
    const row = Number(headerText);
    if (!headerText.trim() || !Number.isInteger(row) || row < 1 || row > SHEET_MAX_HEADER_ROW) {
      setHeaderError(HEADER_ROW_MESSAGE);
      return;
    }
    setHeaderError(null);
    if (row === (asked?.headerRow ?? 1)) return;
    setChosen(null);
    askAgain({ headerRow: row, mapping: undefined, hasHeader: undefined });
  };

  const changeMapping = (next: JobRowMapping) => {
    setChosen(next);
    askAgain({ mapping: next, hasHeader: preview?.hasHeader });
  };

  const changeHeader = (next: boolean) => {
    setHeaderTouched(true);
    setChosen(null);
    askAgain({ hasHeader: next, mapping: undefined });
  };

  const copyEmail = async (email: string) => {
    try {
      await navigator.clipboard.writeText(email);
      toast.success('Address copied', "Paste it into the sheet's Share box.");
    } catch {
      toast.info('Copy this address', email);
    }
  };

  if (account.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-9 w-full max-w-xl" rounded="control" />
      </div>
    );
  }
  if (account.isError) {
    return (
      <Notice
        tone="error"
        title="The Google Sheet settings didn't load."
        action={
          <Button variant="outline" size="sm" onClick={() => void account.refetch()}>
            Try again
          </Button>
        }
      >
        {userMessage(account.error)}
      </Notice>
    );
  }
  if (!account.data.configured) {
    return (
      <p className="flex items-start gap-2 text-sm leading-5 text-muted-foreground" data-sheets-off="">
        <WarningCircleIcon size={16} weight="fill" className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <span>{offLine}</span>
      </p>
    );
  }

  const tabs = preview?.spreadsheet?.tabs ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-5" data-import-sheet-flow="">
      {account.data.clientEmail && (
        <div className="flex flex-col gap-2" data-sheet-share="">
          <p className="text-sm leading-5 font-medium text-foreground">Share your sheet with this address (Viewer)</p>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <code
              data-testid="sheet-client-email"
              className="min-w-0 rounded-control border border-border bg-surface-low px-2.5 py-1.5 font-mono text-[13px] break-all text-foreground select-all"
            >
              {account.data.clientEmail}
            </code>
            <Button variant="outline" size="sm" icon={<CopyIcon size={14} />} onClick={() => void copyEmail(account.data.clientEmail!)}>
              Copy
            </Button>
          </div>
        </div>
      )}
      <form onSubmit={read} noValidate className="flex flex-wrap items-start gap-3">
        <Field label="Sheet link" hint="From the address bar; TailorIT reads the tab it shows." error={linkError} className="min-w-0 flex-1 basis-64">
          <Input
            value={link}
            onChange={(event) => {
              setLink(event.target.value);
              if (preview || reading.error) {
                reading.reset();
                start.reset();
              }
            }}
            onBlur={() => setLinkTouched(true)}
            placeholder="https://docs.google.com/spreadsheets/d/..."
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Button type="submit" variant={preview ? 'outline' : 'primary'} className="sm:mt-[26px]" loading={reading.busy && !preview} disabled={!ref.ok}>
          Read sheet
        </Button>
      </form>
      {otherError && <Notice tone="error">{otherError}</Notice>}
      {preview && mapping && (
        <>
          <MappingPreview
            preview={preview}
            mapping={mapping}
            onMappingChange={changeMapping}
            busy={reading.busy}
            header={headerTouched || headerUnsure(preview) ? { checked: preview.hasHeader, onChange: changeHeader } : null}
            lead={
              <div className="flex flex-col gap-3" data-sheet-tab="">
                {preview.spreadsheet && webLink(preview.spreadsheet.url) && (
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-sm leading-5 font-semibold text-foreground">{preview.spreadsheet.title}</p>
                    <a
                      href={webLink(preview.spreadsheet.url)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={buttonClasses({ variant: 'outline', size: 'sm' })}
                    >
                      <ArrowSquareOutIcon size={14} aria-hidden="true" />
                      Open in Google Sheets
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </div>
                )}
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                  {tabs.length > 0 && (
                    <Field label="Tab">
                      <Select
                        options={tabs.map((tab) => ({ value: String(tab.gid), label: tab.hidden ? `${tab.title} (hidden)` : tab.title }))}
                        value={String(tabGid ?? tabs[0]!.gid)}
                        disabled={reading.busy}
                        onValueChange={(value) => chooseTab(Number(value))}
                      />
                    </Field>
                  )}
                  <Field label="Header row" hint="The row with the column names; rows above it are skipped." error={headerError ?? fields.headerRow}>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={SHEET_MAX_HEADER_ROW}
                      value={headerText}
                      disabled={reading.busy}
                      onChange={(event) => setHeaderText(event.target.value)}
                      onBlur={applyHeaderRow}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          applyHeaderRow();
                        }
                      }}
                    />
                  </Field>
                </div>
              </div>
            }
          />
          <ImportBar
            preview={preview}
            mapping={mapping}
            busy={reading.busy}
            importing={start.isPending}
            onImport={() => start.mutate()}
            limits={limits(preview)}
          />
        </>
      )}
      {startError && <Notice tone="error">{startError}</Notice>}
    </div>
  );
}
