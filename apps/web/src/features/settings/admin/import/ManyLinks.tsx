'use client';

import { JOB_IMPORT_PASTE_MAX_CHARS, SHEET_MAX_ROWS, type JobRowMapping } from '@tailorit/shared';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { Notice } from '@/components/ui/Notice';
import { userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import type { StartedImport } from '../../../imports/api';
import { ImportBar } from '../../../imports/ImportBar';
import { headerUnsure } from '../../../imports/mapping';
import { MappingPreview } from '../../../imports/MappingPreview';
import { usePreview } from '../../../imports/usePreview';
import { importPaste, previewPaste } from './api';
import { EMPTY_PASTE_TEXT, linksText, parseLinks, pasteProblem } from './paste'; // v35 FIX-WEB: from the old Add links dialog

// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §2 "Many links"; PLAN H1): links pasted one a line (counted here), or rows
// copied from a spreadsheet (tab-separated, a header row optional): those show the mapping preview (POST
// /api/admin/imports/paste/preview, asked again a moment after the text changes). At most ADMIN_ADD_LINKS_MAX rows.

/** How long the text rests before its rows are previewed. */
const PREVIEW_AFTER_MS = 400;

interface PasteChoices {
  text: string;
  mapping?: JobRowMapping;
  hasHeader?: boolean;
}

export function ManyLinks({ onStarted, focusOnShow = false }: { onStarted: (started: StartedImport) => void; focusOnShow?: boolean }) {
  const { get, t } = usePublicConstants();
  const max = get('ADMIN_ADD_LINKS_MAX');
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const [chosen, setChosen] = useState<JobRowMapping | null>(null);
  const [headerTouched, setHeaderTouched] = useState(false);
  const rows = text.includes('\t');
  const links = rows ? [] : parseLinks(text);
  const problem = rows ? null : pasteProblem(links.length, max);
  const reading = usePreview<PasteChoices>((choices, signal) => previewPaste(choices, signal));
  // v35 FIX-WEB (decision 7): the Admin header's Add links lands here, in the box.
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusOnShow) boxRef.current?.focus();
  }, [focusOnShow]);
  const { ask, reset } = reading;
  const preview = rows ? reading.preview : null;
  const mapping: JobRowMapping | null = (reading.busy && chosen) || preview?.mapping || null;
  // The text changed since the preview shown: Import waits for the next one.
  const stale = rows && reading.choices?.text !== text;

  // Rows copied from a spreadsheet: previewed once the text rests (a new paste guesses the mapping again).
  useEffect(() => {
    if (!rows) {
      reset();
      return undefined;
    }
    const timer = setTimeout(() => {
      setChosen(null);
      setHeaderTouched(false);
      ask({ text });
    }, PREVIEW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [rows, text, ask, reset]);

  const start = useMutation({
    mutationFn: () => importPaste(rows && preview ? { text, ...(mapping ? { mapping } : {}), hasHeader: preview.hasHeader } : { text }),
    onSuccess: (started) => {
      setText('');
      setTouched(false);
      onStarted(started);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem) return;
    start.mutate();
  };

  const tooLong = text.length > JOB_IMPORT_PASTE_MAX_CHARS;
  const problemText = tooLong
    ? 'That is more text than one import takes: paste fewer rows.'
    : problem === 'too_many'
      ? t('MSG_JOB_ADD_TOO_MANY_LINKS', { max })
      : problem === 'empty'
        ? EMPTY_PASTE_TEXT
        : null;
  const limits = t('MSG_ADMIN_IMPORT_PASTE_UP_TO', { max: max.toLocaleString('en-US'), file_max: SHEET_MAX_ROWS.toLocaleString('en-US') });
  return (
    <div className="flex flex-col gap-5" data-import-many-links="">
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <Field
          label="Job links"
          hint="One link a line, or rows copied from a spreadsheet (a header row is optional)."
          error={touched || problem === 'too_many' || tooLong ? (problemText ?? undefined) : undefined}
        >
          <Textarea
            ref={boxRef}
            rows={7}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              start.reset();
            }}
            placeholder="https://..."
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
        {!rows && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-divider-soft pt-4">
            <p className="min-w-0 flex-1 basis-64 text-[13px] leading-5 text-muted-foreground" aria-live="polite" data-add-links-count="">
              {links.length === 0 ? limits : `${linksText(links.length)} to import. ${limits}`}
            </p>
            <Button type="submit" loading={start.isPending} disabled={problem === 'too_many' || tooLong} data-import-start="">
              {links.length > 0 ? `Import ${linksText(links.length)}` : 'Import the links'}
            </Button>
          </div>
        )}
      </form>
      {rows && reading.error ? <Notice tone="error">{userMessage(reading.error)}</Notice> : null}
      {preview && mapping && (
        <>
          <MappingPreview
            preview={preview}
            mapping={mapping}
            busy={reading.busy}
            onMappingChange={(next) => {
              setChosen(next);
              ask({ text, mapping: next, hasHeader: preview.hasHeader });
            }}
            header={
              headerTouched || headerUnsure(preview)
                ? {
                    checked: preview.hasHeader,
                    onChange: (next) => {
                      setHeaderTouched(true);
                      setChosen(null);
                      ask({ text, hasHeader: next });
                    },
                  }
                : null
            }
          />
          <ImportBar preview={preview} mapping={mapping} busy={reading.busy || stale} importing={start.isPending} onImport={() => start.mutate()} limits={limits} />
        </>
      )}
      {start.isError && <Notice tone="error">{userMessage(start.error)}</Notice>}
    </div>
  );
}
