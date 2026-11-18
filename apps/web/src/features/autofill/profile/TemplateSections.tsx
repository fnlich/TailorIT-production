'use client';

import { normalizeResumeDocument, PAGE_SIZES, RESUME_TEMPLATE_IDS, RESUME_TEMPLATES, type ResumeTemplateId } from '@tailorit/shared';
import type { LetterTemplateSummary } from '@tailorit/shared/letters';
import { SAMPLE_RESUME, THUMBNAIL_SLOTS } from '@tailorit/resume-templates';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { CheckIcon, FileTextIcon } from '@/components/ui/icons';
import { Notice } from '@/components/ui/Notice';
import { Skeleton } from '@/components/ui/Skeleton';
import { userMessage } from '@/lib/api';
import { TemplatePreview } from '../../cover-letter-editor/TemplatePreview';
import { fetchTemplates, templateKeys } from '../../letter-editor/data';
import { ResumeCanvas } from '../../resume-editor/pages/ResumeCanvas';
import { Section } from '../Section';
import { useProfileForm } from './form';

// v1.4 E (decision 18): the Documents step's template choices, saved in the profile (`documents.resumeTemplateId`,
// `documents.coverLetterTemplateId`): the template a tailored resume is written on, as cards of the sample resume
// (NewResumeChooser's, the four originals first), or the source resume's own; and the template its cover letter is
// written on (TailorIT's letter templates, as the Generate dialog previews them), or none. Each list is a radio group:
// Tab reaches it, the arrow keys move the choice.

const RESUME_TEMPLATE_PATH = 'profile.documents.resumeTemplateId';
const LETTER_TEMPLATE_PATH = 'profile.documents.coverLetterTemplateId';

/** The sample resume on each template, made once a visit. */
const sampleCache = new Map<ResumeTemplateId, ReturnType<typeof normalizeResumeDocument>>();
function sampleOn(templateId: ResumeTemplateId) {
  let document = sampleCache.get(templateId);
  if (!document) {
    document = normalizeResumeDocument({ templateId }, SAMPLE_RESUME);
    sampleCache.set(templateId, document);
  }
  return document;
}

/** A card of a radio group: the native radio (hidden, still focusable), its picture and its name. */
function ChoiceCard({
  name,
  value,
  checked,
  disabled,
  onChoose,
  picture,
  title,
  description,
  data,
}: {
  name: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  onChoose: () => void;
  picture: ReactNode;
  title: string;
  description?: string;
  data: Record<string, string>;
}) {
  return (
    <label
      {...data}
      data-checked={checked ? '' : undefined}
      className={clsx(
        'group relative flex min-w-0 cursor-pointer flex-col gap-2 rounded-card border bg-surface p-2 transition-[border-color,box-shadow] duration-150',
        checked ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-control-hover',
        'has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus',
        disabled && 'pointer-events-none opacity-60',
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onChoose}
        className="sr-only"
      />
      <div aria-hidden="true" inert className="relative overflow-hidden rounded-control border border-border bg-surface">
        {picture}
        {checked && (
          <span className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-tag bg-primary text-on-primary shadow-control">
            <CheckIcon size={14} weight="bold" />
          </span>
        )}
      </div>
      <span className="px-0.5 pb-0.5">
        <span className="block truncate text-[13px] leading-5 font-semibold text-foreground">{title}</span>
        {description && <span className="block text-xs leading-4 text-muted-foreground">{description}</span>}
      </span>
    </label>
  );
}

const LETTER_PAGE = PAGE_SIZES.letter;
const PAGE_RATIO = { aspectRatio: `${LETTER_PAGE.widthPx} / ${LETTER_PAGE.heightPx}` };

/** "Use my resume's own template": a page with the outline of a resume, in the source's colours (unknown here). */
function OwnTemplatePicture() {
  return (
    <div style={PAGE_RATIO} className="flex flex-col items-center justify-center gap-2 bg-surface-low px-4 text-center">
      <FileTextIcon size={28} className="text-primary-ink" />
      <span className="text-xs leading-4 text-muted-foreground">The template of the resume it starts from</span>
    </div>
  );
}

export function ResumeTemplateSection() {
  const form = useProfileForm();
  const chosen = form.state.draft.profile.documents.resumeTemplateId;
  const known = chosen === null || (RESUME_TEMPLATE_IDS as readonly string[]).includes(chosen);
  return (
    <Section
      id="autofill-resume-template"
      title="Resume template for tailoring"
      description="When TailorIT tailors your resume for a job, the new resume is written on this template. You can switch it later in the editor."
    >
      <div className="flex flex-col gap-3">
        {!known && (
          <Notice tone="warning">That template is no longer offered: tailoring keeps your resume&apos;s own until you choose one.</Notice>
        )}
        <div
          role="radiogroup"
          aria-label="Resume template for tailoring"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
          data-template-choices="resume"
        >
          <ChoiceCard
            name="resume-template"
            value=""
            checked={chosen === null || !known}
            disabled={form.busy}
            onChoose={() => form.set(RESUME_TEMPLATE_PATH, null)}
            picture={<OwnTemplatePicture />}
            title="My resume's own template"
            description="Keeps the look of the resume it starts from"
            data={{ 'data-resume-template-choice': 'own' }}
          />
          {RESUME_TEMPLATE_IDS.map((templateId) => (
            <ChoiceCard
              key={templateId}
              name="resume-template"
              value={templateId}
              checked={chosen === templateId}
              disabled={form.busy}
              onChoose={() => form.set(RESUME_TEMPLATE_PATH, templateId)}
              picture={
                <div style={PAGE_RATIO} className="relative">
                  <div className="pointer-events-none absolute inset-0">
                    <ResumeCanvas document={sampleOn(templateId)} mode="static" slots={THUMBNAIL_SLOTS} />
                  </div>
                </div>
              }
              title={RESUME_TEMPLATES[templateId].name}
              data={{ 'data-resume-template-choice': templateId }}
            />
          ))}
        </div>
      </div>
    </Section>
  );
}

/** The letter templates to choose from: TailorIT's own first, then the person's, as the Templates tab lists them. */
export function useLetterTemplates() {
  return useQuery({ queryKey: templateKeys.all, queryFn: fetchTemplates, staleTime: 60_000 });
}

/** The width a letter's picture is drawn at before it is scaled down to its card. */
const LETTER_PICTURE_WIDTH = 340;

function LetterPicture({ template }: { template: Pick<LetterTemplateSummary, 'id' | 'name'> | null }) {
  // The Generate dialog's own preview of a template (or of "None"), drawn at a readable width, then scaled down to the
  // card, cut to a page's shape.
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.45);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const fit = () => setScale(element.clientWidth / LETTER_PICTURE_WIDTH);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const height = (LETTER_PICTURE_WIDTH * LETTER_PAGE.heightPx) / LETTER_PAGE.widthPx;
  return (
    <div ref={box} style={PAGE_RATIO} className="relative overflow-hidden">
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{ width: LETTER_PICTURE_WIDTH, height, transform: `scale(${scale})` }}
      >
        <TemplatePreview template={template} className="h-full rounded-none border-0 p-0" />
      </div>
    </div>
  );
}

export function LetterTemplateSection() {
  const form = useProfileForm();
  const chosen = form.state.draft.profile.documents.coverLetterTemplateId;
  const templates = useLetterTemplates();
  const items = useMemo(() => {
    const list = templates.data?.items ?? [];
    return [...list.filter((item) => item.isSystem), ...list.filter((item) => !item.isSystem)];
  }, [templates.data]);
  const missing = templates.isSuccess && chosen !== null && !items.some((item) => item.id === chosen);
  return (
    <Section
      id="autofill-letter-template"
      title="Cover letter template for tailoring"
      description="The cover letter written beside a tailored resume follows this template. Without one, TailorIT writes it in its own simple layout."
    >
      <div className="flex flex-col gap-3">
        {missing && (
          <Notice tone="warning">That template was deleted: letters are written without a template until you choose another.</Notice>
        )}
        {templates.isError ? (
          <Notice
            tone="error"
            action={
              <Button variant="outline" size="sm" onClick={() => void templates.refetch()}>
                Try again
              </Button>
            }
          >
            {userMessage(templates.error, 'Your cover letter templates could not be loaded.')}
          </Notice>
        ) : null}
        <div
          role="radiogroup"
          aria-label="Cover letter template for tailoring"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
          data-template-choices="cover-letter"
        >
          <ChoiceCard
            name="letter-template"
            value=""
            checked={chosen === null || missing}
            disabled={form.busy}
            onChoose={() => form.set(LETTER_TEMPLATE_PATH, null)}
            picture={<LetterPicture template={null} />}
            title="No template"
            description="TailorIT's own letter layout"
            data={{ 'data-letter-template-choice': 'none' }}
          />
          {templates.isPending
            ? [0, 1, 2].map((index) => (
                <div key={index} className="flex flex-col gap-2 rounded-card border border-border p-2" aria-hidden="true">
                  <div style={PAGE_RATIO}>
                    <Skeleton className="h-full w-full" rounded="control" />
                  </div>
                  <Skeleton className="h-4 w-24" />
                </div>
              ))
            : items.map((template) => (
                <ChoiceCard
                  key={template.id}
                  name="letter-template"
                  value={template.id}
                  checked={chosen === template.id}
                  disabled={form.busy}
                  onChoose={() => form.set(LETTER_TEMPLATE_PATH, template.id)}
                  picture={<LetterPicture template={template} />}
                  title={template.name}
                  description={template.isSystem ? 'TailorIT template' : 'Your template'}
                  data={{ 'data-letter-template-choice': template.id }}
                />
              ))}
        </div>
      </div>
    </Section>
  );
}
