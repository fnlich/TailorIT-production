'use client';

import { FileTextIcon } from '@/components/ui/icons';
import { useGuide } from '../context';
import type { GuideSection } from '../model';
import { AppPage, Bullets, P, See, Ui } from '../parts';

// v34 HELP: Documents: resumes (uploads, editable copies, the editor, the field), cover letters, letter templates, and
// tailoring a resume for a job.

function Resumes() {
  const { t, get } = useGuide();
  return (
    <>
      <P>
        <AppPage href="/documents">Documents</AppPage> has three sections: <Ui>{t('LABEL_DOCS_RESUMES')}</Ui>,{' '}
        <Ui>{t('LABEL_DOCS_LETTERS')}</Ui> and <Ui>{t('LABEL_DOCS_TEMPLATES')}</Ui>. <Ui>Upload</Ui> adds files to the section
        shown; <Ui>{t('LABEL_DOCS_NEW')}</Ui> starts a {t('LABEL_DOCS_NEW_RESUME').toLowerCase()}, a{' '}
        {t('LABEL_DOCS_NEW_LETTER').toLowerCase()} or a {t('LABEL_DOCS_NEW_TEMPLATE').toLowerCase()}.
      </P>
      <Bullets>
        <li>
          <Ui>Uploading</Ui>: one PDF or Word file, or {get('UPLOAD_BATCH_MAX_FILES')} at once ({get('UPLOAD_MAX_MB')} MB
          each). An uploaded file is kept exactly as you uploaded it: TailorIT only reads its text. You may ask for an{' '}
          <Ui>editable copy</Ui> of each upload, made by AI on the template you pick.
        </li>
        <li>
          <Ui>Folders</Ui>: Uploaded resumes, Edited resumes and Tailored resumes (the last all together or by date), with one search
          across them. Edit on an uploaded resume makes (or reuses) its editable copy and opens that.
        </li>
        <li>
          <Ui>The editor</Ui>: you type on the resume itself and it saves as you go. Rearrange the sections, switch
          templates, change the design and font, preview, and download a PDF or Word file.
        </li>
        <li>
          <Ui>What TailorIT reads</Ui> from each resume: your main and soft skills, roles, certifications, industries and
          years of experience. Jobs are matched against it.
        </li>
        <li>
          <Ui>{t('LABEL_RESUME_FIELD')}</Ui>: each resume&apos;s kind of work, detected by itself or chosen by you; the
          editor&apos;s words, the skill picker and the templates follow it.
        </li>
        <li>
          A resume&apos;s menu: Rename, Duplicate, <Ui>Set as default</Ui> (the resume jobs are matched to), the downloads,
          Make editable copy and Delete. Select several to delete them or, on a Paid account, download them as one zip (
          {get('BATCH_DOWNLOAD_MAX_RESUMES')} at a time).
        </li>
      </Bullets>
    </>
  );
}

function Letters() {
  return (
    <>
      <Bullets>
        <li>
          <Ui>Cover letters</Ui>: write one yourself or let TailorIT&apos;s AI write it for a job, with or without a template.
          The editor shows the template&apos;s blanks (the company, the role, your name) as chips, and exports a PDF or Word
          file.
        </li>
        <li>
          <Ui>Letter templates</Ui>: the built-in ones (some written for a particular field, listed first for it) and your
          own. Prepare places each letter it writes on the letter template your Autofill profile names, or on
          TailorIT&apos;s own layout when it names none.
        </li>
      </Bullets>
    </>
  );
}

function Tailor() {
  const { t } = useGuide();
  return (
    <>
      <P>
        <Ui>{t('LABEL_JOB_DETAIL_TAILOR')}</Ui> (in a job&apos;s details) and <Ui>Tailor a resume</Ui> (in the{' '}
        <AppPage href="/tracker">Job Tracker</AppPage>) write a new resume for one job, starting from a resume you have:
        TailorIT&apos;s AI follows the posting&apos;s keywords and keeps your employers, titles, dates and figures. You choose the resume to start from and its template, and can ask for a cover
        letter too. The new resume lands in Tailored resumes.
      </P>
      <P>
        Each tailored resume counts toward your resumes and your AI use; a Free account also has an hourly number of
        tailorings. Your own AI can do the same without TailorIT&apos;s AI (see <See to="mcp-prompts">How to ask</See>).
      </P>
    </>
  );
}

export const DOCUMENTS_SECTION: GuideSection = {
  id: 'documents',
  title: 'Documents',
  icon: FileTextIcon,
  keywords: ['resume', 'cover letter', 'template', 'upload'],
  topics: [
    { id: 'docs-resumes', title: 'Resumes', keywords: ['upload', 'editor', 'editable copy', 'default', 'field'], Body: Resumes },
    { id: 'docs-letters', title: 'Cover letters and templates', keywords: ['letter', 'template'], Body: Letters },
    { id: 'docs-tailor', title: 'Tailoring a resume for a job', keywords: ['tailor'], Body: Tailor },
  ],
};
