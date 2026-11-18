'use client';

import { clsx } from 'clsx';
import { memo, useMemo } from 'react';
import {
  effectiveTemplateId,
  normalizeResumeDocument,
  PAGE_SIZES,
  resolveDesign,
  RESUME_TEMPLATE_IDS,
  RESUME_TEMPLATES,
  type ResumeDocument,
  type ResumeTemplateId,
} from '@tailorit/shared';
import { SAMPLE_RESUME, THUMBNAIL_SLOTS } from '@tailorit/resume-templates';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { ResumeCanvas } from '../pages/ResumeCanvas';
import type { EditorStore } from '../store/store';
import { PanelSection, SidePanel } from './SidePanel';

// Enhancv's Templates panel, docked beside the page: the ten templates as the sample person prints in them, in the
// order of RESUME_TEMPLATE_IDS (the four after the owner's originals first, as the newest; a click moves the resume onto
// that template, its content kept), the document size, and capital or normal section titles.

/** One template as the sample person prints in it. It draws once: typing on the page changes none of its props. */
const TemplateTile = memo(function TemplateTile({
  templateId,
  current,
  store,
}: {
  templateId: ResumeTemplateId;
  current: boolean;
  store: EditorStore;
}) {
  const document = useMemo(() => normalizeResumeDocument({ templateId }, SAMPLE_RESUME), [templateId]);
  const page = PAGE_SIZES.letter;
  return (
    <button
      type="button"
      aria-pressed={current}
      onClick={() => store.setTemplate(templateId)}
      className="group flex flex-col gap-2 rounded-control text-left outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <span
        className={clsx(
          'relative block w-full overflow-hidden rounded-control border bg-surface',
          current ? 'border-primary ring-2 ring-primary' : 'border-border group-hover:border-control-hover group-hover:shadow-card',
        )}
        style={{ aspectRatio: `${page.widthPx} / ${page.heightPx}` }}
      >
        {/* Contained: nothing the page does (typing, a reflow) touches a thumbnail's style or layout. */}
        <span aria-hidden="true" inert className="pointer-events-none absolute inset-0 [contain:strict]">
          <ResumeCanvas document={document} mode="static" slots={THUMBNAIL_SLOTS} />
        </span>
      </span>
      <span className="text-[13px] font-medium text-foreground">{RESUME_TEMPLATES[templateId].name}</span>
    </button>
  );
});

export function TemplatesPanel({ document, store, onClose }: { document: ResumeDocument; store: EditorStore; onClose(): void }) {
  const current = effectiveTemplateId(document);
  const design = resolveDesign(document.design, RESUME_TEMPLATES[current]);
  return (
    <SidePanel title="Templates" onClose={onClose}>
      <PanelSection title="Document size">
        <SegmentedControl
          aria-label="Document size"
          size="sm"
          value={design.pageSize}
          onValueChange={(size) => store.setPageSize(size)}
          items={[
            { value: 'a4', label: 'A4' },
            { value: 'letter', label: 'US Letter' },
          ]}
        />
      </PanelSection>
      <PanelSection title="Section titles">
        <SegmentedControl
          aria-label="Section titles"
          size="sm"
          value={design.uppercaseHeadings ? 'upper' : 'normal'}
          onValueChange={(value) => store.setUppercaseHeadings(value === 'upper')}
          items={[
            { value: 'normal', label: 'Aa' },
            { value: 'upper', label: 'AA' },
          ]}
        />
      </PanelSection>
      <PanelSection title="Templates">
        <div className="grid grid-cols-2 gap-4">
          {RESUME_TEMPLATE_IDS.map((templateId) => (
            <TemplateTile key={templateId} templateId={templateId} current={templateId === current} store={store} />
          ))}
        </div>
      </PanelSection>
    </SidePanel>
  );
}
