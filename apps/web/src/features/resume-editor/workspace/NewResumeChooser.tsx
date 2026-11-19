'use client';

import { BracketsCurlyIcon } from '@phosphor-icons/react/BracketsCurly';
import { FilePdfIcon } from '@phosphor-icons/react/FilePdf';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useId, useMemo } from 'react';
import {
  DEFAULT_TEMPLATE_ID,
  normalizeResumeDocument,
  PAGE_SIZES,
  RESUME_TEMPLATE_IDS,
  RESUME_TEMPLATES,
  type ResumeTemplateId,
} from '@tailorit/shared';
import { SAMPLE_RESUME, THUMBNAIL_SLOTS } from '@tailorit/resume-templates';
import { EditorBar } from '@/components/shell/EditorBar';
import { PAGE_GUTTER } from '@/components/shell/layout';
import { Button, buttonClasses } from '@/components/ui/Button';
import { CaretDownIcon, UploadSimpleIcon } from '@/components/ui/icons';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/Menu';
import { PageHeader } from '@/components/ui/PageHeader';
import { Spinner } from '@/components/ui/Spinner';
import { RESUMES_TAB_HREF, newResumeHref, resumeEditorHref } from '../api';
import { usePublicConstants } from '@/lib/constants';
import { JSON_ACCEPT, PDF_ACCEPT, chooseFile } from '../files';
import { ResumeCanvas } from '../pages/ResumeCanvas';
import { useResumeImport } from '../useResumeImport';
import { LimitNotice } from '@/components/limits'; // v20 P8
import { useResumeLimitGate } from '../../documents/resumes/resumeLimit'; // v20 P8
import { StatusLine } from '../../documents/core/StatusLine';

// The first step of a new resume (Enhancv's template picker): the ten templates, the newest first, each showing the
// sample person as it would print, its name and what it is for. Picking one opens a blank page on it. "Import existing
// resume" starts from a resume instead: a PDF the AI reads into a new resume on the default template, or a JSON file
// downloaded from TailorIT (one resume opens; several are listed with the resumes).

function TemplateCard({ templateId }: { templateId: ResumeTemplateId }) {
  const spec = RESUME_TEMPLATES[templateId];
  // The sample drawn on this template: its layout re-seeded for the template's columns, its design the template's own.
  const document = useMemo(() => normalizeResumeDocument({ templateId }, SAMPLE_RESUME), [templateId]);
  const page = PAGE_SIZES.letter;
  const descriptionId = useId();
  return (
    <Link
      href={newResumeHref(templateId)}
      aria-describedby={descriptionId}
      className="group flex flex-col gap-3 rounded-card outline-none focus-visible:ring-2 focus-visible:ring-primary"
      data-template-card={templateId}
    >
      <div
        className={clsx(
          'relative w-full overflow-hidden rounded-card border border-border bg-surface shadow-card transition-[box-shadow,border-color]',
          'group-hover:border-primary-200 group-hover:shadow-popover group-focus-visible:shadow-popover',
        )}
        style={{ aspectRatio: `${page.widthPx} / ${page.heightPx}` }}
      >
        <div aria-hidden="true" inert className="pointer-events-none absolute inset-0">
          <ResumeCanvas document={document} mode="static" slots={THUMBNAIL_SLOTS} />
        </div>
      </div>
      <div>
        <p className="text-[15px] font-semibold text-foreground">{spec.name}</p>
        {/* v32 COPY (E5): what the design is for describes the card; the card shows the page and its name. */}
        <span id={descriptionId} hidden>
          {spec.description}
        </span>
      </div>
    </Link>
  );
}

/** "Import existing resume": the menu, and what it says while a file comes in and once it is in. */
function useImportMenu() {
  const router = useRouter();
  const { t, get } = usePublicConstants();
  const onImported = useCallback((resumeId: string) => router.push(resumeEditorHref(resumeId)), [router]);
  const importer = useResumeImport(onImported);

  const pick = async (kind: 'pdf' | 'json') => {
    const file = await chooseFile(kind === 'pdf' ? PDF_ACCEPT : JSON_ACCEPT);
    if (!file) return;
    // A PDF's copy is a resume of this editor, on its default template (switched any time in Templates).
    if (kind === 'pdf') await importer.importPdf(file, { templateId: DEFAULT_TEMPLATE_ID });
    else await importer.importJson(file);
  };

  const label =
    importer.phase === 'uploading' || importer.phase === 'reading' || importer.phase === 'opening'
      ? 'Reading your resume...'
      : importer.phase === 'importing'
        ? 'Importing...'
        : 'Import existing resume';

  const menu = (
    <Menu>
      <MenuTrigger
        disabled={importer.working}
        render={
          <Button
            variant="outline"
            icon={importer.working ? <Spinner size={16} /> : <UploadSimpleIcon size={16} />}
            trailingIcon={importer.working ? undefined : <CaretDownIcon size={14} />}
          />
        }
        data-import-menu=""
      >
        {label}
      </MenuTrigger>
      <MenuContent align="end" width="w-[22rem]">
        <MenuItem
          icon={<FilePdfIcon size={18} />}
          hint={`AI reads it into a new resume. ${t('MSG_UPLOAD_SIZE_HINT', { max_mb: get('UPLOAD_MAX_MB') })}`}
          onClick={() => void pick('pdf')}
        >
          Resume PDF
        </MenuItem>
        <MenuItem icon={<BracketsCurlyIcon size={18} />} hint="One or more resumes downloaded from TailorIT." onClick={() => void pick('json')}>
          Resume JSON file
        </MenuItem>
      </MenuContent>
    </Menu>
  );

  const notices =
    importer.working || importer.error || importer.notice ? (
      <div className="mt-5 flex flex-col gap-3">
        {/* v32 COPY (E4): short status lines, never banners. */}
        {importer.phase === 'uploading' || importer.phase === 'reading' ? (
          <StatusLine
            tone="busy"
            title={importer.progress ?? 'Reading your resume...'}
            details="This can take a minute; its editor opens when it is done."
          />
        ) : null}
        {importer.error ? <StatusLine tone="error" title={importer.error} /> : null}
        {importer.notice ? (
          <StatusLine
            tone="success"
            title={`Imported ${importer.notice.imported} ${importer.notice.imported === 1 ? 'resume' : 'resumes'} from ${importer.notice.fileName}.`}
            actions={
              <Link href={RESUMES_TAB_HREF} className={buttonClasses({ variant: 'outline', size: 'sm' })}>
                See your resumes
              </Link>
            }
          />
        ) : null}
      </div>
    ) : null;

  return { menu, notices };
}

export function NewResumeChooser() {
  const { menu, notices } = useImportMenu();
  const resumeGate = useResumeLimitGate(); // v20 P8: at the Free resume limit a new resume cannot be saved
  return (
    <>
      <EditorBar name="New resume" documentsHref={RESUMES_TAB_HREF} />
      <main className={clsx('mx-auto w-full max-w-6xl pt-7 pb-10', PAGE_GUTTER)}>
        <PageHeader
          title="Start building a resume"
          description="Pick a design; you can switch it any time."
          actions={menu}
        />
        {resumeGate.info && ( // v20 P8
          <LimitNotice limit={resumeGate.info} className="mt-6">
            Delete some in Documents first.
          </LimitNotice>
        )}
        {notices}
        <div className="mt-8 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {RESUME_TEMPLATE_IDS.map((templateId) => (
            <TemplateCard key={templateId} templateId={templateId} />
          ))}
        </div>
      </main>
    </>
  );
}
