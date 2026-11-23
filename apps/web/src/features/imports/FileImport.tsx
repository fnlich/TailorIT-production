'use client';

import type { JobImportPreview, JobRowMapping } from '@tailorit/shared';
import { useMutation } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Field } from '@/components/ui/Field';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { isProfileRefusal, userMessage } from '@/lib/api';
import { importFile, previewFile, type FileChoices, type ImportAudience, type StartedImport } from './api';
import { FileChooser } from './FileChooser';
import { ImportBar } from './ImportBar';
import { headerUnsure } from './mapping';
import { MappingPreview } from './MappingPreview';
import { usePreview } from './usePreview';

// v35 IMPORTWEB (SP v35 SPECS-W2.md IMPORTWEB §1-§3): an import from a file, for an admin (Admin › Import › File) or a
// person (Jobs › Add job › File): choose the file (FileChooser), check the mapping on its first rows (an .xlsx file's
// sheet chosen from the preview's answer), then Import. What the import came to is the caller's to show (onStarted).

export interface FileImportProps {
  audience: ImportAudience;
  /** The limits' line under the preview (given the preview: a person's rows left today). */
  limits: (preview: JobImportPreview) => ReactNode;
  onStarted: (started: StartedImport) => void;
}

export function FileImport({ audience, limits, onStarted }: FileImportProps) {
  const [file, setFile] = useState<File | null>(null);
  const [chosen, setChosen] = useState<JobRowMapping | null>(null);
  const [headerTouched, setHeaderTouched] = useState(false);
  const reading = usePreview<FileChoices & { file: File }>(({ file: target, ...choices }, signal) => previewFile(audience, target, choices, signal));
  const { preview } = reading;
  // A choice shows at once while its preview loads; then the preview's own (the API's cleaned mapping) is the one sent.
  const mapping: JobRowMapping | null = (reading.busy && chosen) || preview?.mapping || null;

  const start = useMutation({
    mutationFn: () =>
      importFile(audience, file!, {
        mapping,
        hasHeader: preview!.hasHeader,
        ...(preview!.sheet !== undefined ? { sheet: preview!.sheet } : {}),
      }),
    onSuccess: onStarted,
  });

  const choose = (next: File) => {
    setFile(next);
    setChosen(null);
    setHeaderTouched(false);
    start.reset();
    reading.reset();
    reading.ask({ file: next });
  };

  /** The same file asked again with these choices (a new mapping keeps the header and the sheet). */
  const askAgain = (choices: FileChoices) => {
    if (!file) return;
    start.reset();
    reading.ask({ file, ...choices });
  };

  const changeMapping = (next: JobRowMapping) => {
    setChosen(next);
    askAgain({ mapping: next, hasHeader: preview?.hasHeader, sheet: preview?.sheet ?? null });
  };

  const changeHeader = (next: boolean) => {
    setHeaderTouched(true);
    setChosen(null);
    // Other column names: the API guesses the mapping again.
    askAgain({ hasHeader: next, sheet: preview?.sheet ?? null });
  };

  const changeSheet = (next: string) => {
    setChosen(null);
    setHeaderTouched(false);
    askAgain({ sheet: next });
  };

  const sheets = preview?.sheets ?? [];
  const readError = reading.error && !isProfileRefusal(reading.error) ? userMessage(reading.error) : null;
  const startError = start.error && !isProfileRefusal(start.error) ? userMessage(start.error) : null;
  return (
    <div className="flex min-w-0 flex-col gap-5" data-import-file-flow="">
      <FileChooser file={file} onFile={choose} busy={reading.busy && !preview} error={readError} disabled={start.isPending} />
      {preview && mapping && (
        <>
          <MappingPreview
            preview={preview}
            mapping={mapping}
            onMappingChange={changeMapping}
            busy={reading.busy}
            header={headerTouched || headerUnsure(preview) ? { checked: preview.hasHeader, onChange: changeHeader } : null}
            lead={
              sheets.length > 1 ? (
                <Field label="Sheet" className="max-w-sm">
                  <Select
                    options={sheets.map((name) => ({ value: name, label: name }))}
                    value={preview.sheet ?? sheets[0]!}
                    disabled={reading.busy}
                    onValueChange={changeSheet}
                  />
                </Field>
              ) : null
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
