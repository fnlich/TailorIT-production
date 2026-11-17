'use client';

import { BracketsCurlyIcon } from '@phosphor-icons/react/BracketsCurly';
import { FilePdfIcon } from '@phosphor-icons/react/FilePdf';
import { clsx } from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo } from 'react';
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
import { Notice } from '@/components/ui/Notice';
import { Spinner } from '@/components/ui/Spinner';
import { RESUMES_TAB_HREF, newResumeHref, resumeEditorHref } from '../api';
import { usePublicConstants } from '@/lib/constants';
import { JSON_ACCEPT, PDF_ACCEPT, chooseFile } from '../files';
import { ResumeCanvas } from '../pages/ResumeCanvas';
import { useResumeImport } from '../useResumeImport';
import { LimitNotice } from '@/components/limits'; // v20 P8
import { useResumeLimitGate } from '../../documents/resumes/resumeLimit'; // v20 P8

// The first step of a new resume (Enhancv's template picker): the ten templates, the newest first, each showing the
// sample person as it would print, its name and what it is for. Picking one opens a blank page on it. "Import existing
// resume" starts from a resume instead: a PDF the AI reads into a new resume on the default template, or a JSON file
// downloaded from TailorIT (one resume opens; several are listed with the resumes).

function TemplateCard({ templateId }: { templateId: ResumeTemplateId }) {
  const spec = RESUME_TEMPLATES[templateId];
  // The sample drawn on this template: its layout re-seeded for the template's columns, its design the template's own.
  const document = useMemo(() => normalizeResumeDocument({ templateId }, SAMPLE_RESUME), [templateId]);
  const page = PAGE_SIZES.letter;
  return (
    <Link
      href={newResumeHref(templateId)}
      className="group flex flex-col gap-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-primary"
      data-template-card={templateId}
    >
      <div
        className={clsx(
          'relative w-full overflow-hidden rounded-lg border border-border bg-white transition-shadow',
          'group-hover:shadow-md group-focus-visible:shadow-md',
        )}
        style={{ aspectRatio: `${page.widthPx} / ${page.heightPx}` }}
      >
        <div aria-hidden="true" inert className="pointer-events-none absolute inset-0">
          <ResumeCanvas document={document} mode="static" slots={THUMBNAIL_SLOTS} />
        </div>
      </div>
      <div>
        <p className="text-[15px] font-semibold text-foreground">{spec.name}</p>
        <p className="text-[13px] text-muted-foreground">{spec.description}</p>
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
          hint={`An AI reads it into a new resume. ${t('MSG_UPLOAD_SIZE_HINT', { max_mb: get('UPLOAD_MAX_MB') })}`}
          onClick={() => void pick('pdf')}
        >
          Resume PDF
        </MenuItem>
        <MenuItem icon={<BracketsCurlyIcon size={18} />} hint="A resume downloaded from this app, or several." onClick={() => void pick('json')}>
          Resume JSON file
        </MenuItem>
      </MenuContent>
    </Menu>
  );

  const notices =
    importer.working || importer.error || importer.notice ? (
      <div className="mt-5 flex flex-col gap-3">
        {importer.phase === 'uploading' || importer.phase === 'reading' ? (
          <Notice tone="info" title={importer.progress ?? 'Reading your resume...'}>
            Reading your resume with AI. This can take a minute; its editor opens when it is done.
          </Notice>
        ) : null}
        {importer.error ? <Notice tone="error">{importer.error}</Notice> : null}
        {importer.notice ? (
          <Notice
            tone="success"
            action={
              <Link href={RESUMES_TAB_HREF} className={buttonClasses({ variant: 'outline', size: 'sm' })}>
                See your resumes
              </Link>
            }
          >
            Imported {importer.notice.imported} {importer.notice.imported === 1 ? 'resume' : 'resumes'} from {importer.notice.fileName}.
          </Notice>
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
      <main className={clsx('mx-auto w-full max-w-6xl py-10', PAGE_GUTTER)}>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Start building a resume</h1>
            <p className="mt-1 text-[15px] text-muted-foreground">Choose a design you like. You can switch it any time.</p>
          </div>
          {menu}
        </div>
        {resumeGate.info && ( // v20 P8
          <LimitNotice limit={resumeGate.info} className="mt-6">
            A new resume can&apos;t be saved until you have fewer resumes. Delete some in Documents first.
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
