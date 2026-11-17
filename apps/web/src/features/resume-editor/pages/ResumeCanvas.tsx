'use client';

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ResumeDocument } from '@tailorit/shared';
import {
  EDITOR_PAGE_GAP_PX,
  ResumeLayout,
  resumeCss,
  rootHeight,
  sheetTop,
  SlotsContext,
  STATIC_SLOTS,
  type PagePlan,
  type Slots,
  type ViewMode,
} from '@tailorit/resume-templates';
import { useResumeLayout } from './useResumeLayout';

// The resume as the editor and Preview show it: its pages drawn by the template, a gap between them with the page
// number, scaled down (never zoomed) when the column is narrower than a page, so the boxes measure the same as they
// print. The template's fonts load from the API, the same files the PDF embeds.

/** Editor chrome around the pages: it changes how they look, never how they lay out. */
const FONT_STYLESHEET_ID = 'tailorit-resume-fonts';

const CANVAS_CSS ='[data-resume-canvas] .rt-sheet{box-shadow:0 1px 3px rgba(17,24,39,.12),0 0 0 1px rgba(17,24,39,.06)}';

export interface ResumeCanvasProps {
  document: ResumeDocument;
  mode: ViewMode;
  /** The editor's editable slots; the static ones otherwise (Preview). */
  slots?: Slots;
  /** Pages, once known (the editor's bar shows the count). */
  onPageCount?: (pages: number) => void;
  /** The page plan, each time it changes, with the box heights it came from (the Download dialog checks both against the PDF's). */
  onPlan?: (plan: PagePlan, heights: Readonly<Record<string, number>>) => void;
  /** More page CSS (the editable fields' placeholders and focus). */
  extraCss?: string;
}

/** Drawn again only when one of its props changes (a keystroke the workspace defers leaves them all the same). */
export const ResumeCanvas = memo(function ResumeCanvas({ document, mode, slots, onPageCount, onPlan, extraCss = '' }: ResumeCanvasProps) {
  const { layout, plan, rootRef, heightsNow } = useResumeLayout(document, mode);
  const frame = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const pageWidth = layout.geometry.pageWidth;
  const pages = plan?.pageCount ?? 1;
  const height = rootHeight(layout.geometry, pages, EDITOR_PAGE_GAP_PX);

  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const fit = () => setScale(Math.min(1, element.clientWidth / pageWidth));
    fit();
    const watcher = new ResizeObserver(fit);
    watcher.observe(element);
    return () => watcher.disconnect();
  }, [pageWidth]);

  useLayoutEffect(() => {
    if (!plan) return;
    onPageCount?.(plan.pageCount);
    onPlan?.(plan, heightsNow());
  }, [plan, onPageCount, onPlan, heightsNow]);

  // The templates' web fonts (the PDF carries the same files inline): one stylesheet for the whole visit.
  useEffect(() => {
    if (window.document.getElementById(FONT_STYLESHEET_ID)) return;
    const link = window.document.createElement('link');
    link.id = FONT_STYLESHEET_ID;
    link.rel = 'stylesheet';
    link.href = '/api/fonts/resume.css';
    window.document.head.append(link);
  }, []);

  return (
    <div ref={frame} className="w-full" data-resume-canvas="">
      <style>{resumeCss(layout.template) + CANVAS_CSS + extraCss}</style>
      <div className="relative mx-auto" style={{ width: pageWidth * scale, height: height * scale }}>
        <div
          ref={rootRef}
          className="absolute top-0 left-0 origin-top-left"
          style={{ width: pageWidth, transform: scale === 1 ? undefined : `scale(${scale})` }}
        >
          <SlotsContext.Provider value={slots ?? STATIC_SLOTS}>
            <ResumeLayout {...layout} plan={plan} gap={EDITOR_PAGE_GAP_PX} />
          </SlotsContext.Provider>
          {Array.from({ length: pages - 1 }, (_, index) => (
            <div
              key={index}
              role="separator"
              aria-label={`Page ${index + 2} of ${pages}`}
              className="absolute right-0 left-0 flex items-center justify-end text-xs text-gray-500 select-none"
              style={{ top: sheetTop(layout.geometry, index + 1, EDITOR_PAGE_GAP_PX) - EDITOR_PAGE_GAP_PX, height: EDITOR_PAGE_GAP_PX }}
            >
              Page {index + 2} of {pages}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});
