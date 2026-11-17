'use client';

import { clsx } from 'clsx';
import {
  InlineRuns,
  LEVEL_DOTS,
  type LevelSlotProps,
  type PhotoSlotProps,
  type RichTextSlotProps,
  type Slots,
  type TextSlotProps,
} from '@tailorit/resume-templates';

// The page on a phone: the edit view (empty fields and the empty row of a section are kept, with their placeholders,
// so a part with nothing in it can still be found and tapped), drawn read-only. Nothing is typed on the page: a tap
// opens the part's sheet and its form. Each slot draws the element the static one draws (same tag, class and data
// attributes, the field's path included, so the empty-field highlight finds it), so the page measures as it prints.

function PhoneText({ field, as: Tag = 'span', className }: TextSlotProps) {
  return (
    <Tag
      className={clsx('rt-text', className)}
      data-edit-path={field.path}
      data-placeholder={field.placeholder}
      data-empty={field.text === '' ? '' : undefined}
    >
      {field.text}
    </Tag>
  );
}

function PhoneRichText({ field, as: Tag = 'div', className }: RichTextSlotProps) {
  return (
    <Tag
      className={clsx('rt-text', 'rt-rich', className)}
      data-edit-path={field.path}
      data-placeholder={field.placeholder}
      data-empty={field.runs.length === 0 ? '' : undefined}
    >
      <InlineRuns runs={field.runs} />
    </Tag>
  );
}

/** All five dots, as the editable page draws them, so a language with no level set still shows where it goes. */
function PhoneLevel({ value, className }: LevelSlotProps) {
  return (
    <span className={clsx('rt-level', className)} role="img" aria-label={`Level ${value ?? 0} of ${LEVEL_DOTS}`}>
      {Array.from({ length: LEVEL_DOTS }, (_, index) => (
        <span key={index} className={value !== null && index < value ? 'rt-dot rt-dot-on' : 'rt-dot'} />
      ))}
    </span>
  );
}

function PhonePhoto({ photoId, shape, className }: PhotoSlotProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- the resume's own page, measured as it prints
    <img
      className={clsx('rt-photo', className)}
      data-shape={shape}
      src={`/api/resumes/photos/${encodeURIComponent(photoId)}`}
      alt="Your photo"
    />
  );
}

export const PHONE_SLOTS: Slots = {
  mode: 'edit',
  links: true,
  Text: PhoneText,
  RichText: PhoneRichText,
  Level: PhoneLevel,
  Photo: PhonePhoto,
};

/** The phone page's placeholders, as the editable page shows them (nothing that changes a field's size). */
export const PHONE_PAGE_CSS =
  '[data-resume-canvas] .rt-text[data-empty]::before{content:attr(data-placeholder);color:#a8a8a8;pointer-events:none}';
