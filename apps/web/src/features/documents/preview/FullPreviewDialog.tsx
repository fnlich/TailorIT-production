'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { CaretLeftIcon, CaretRightIcon, MinusIcon, PlusIcon, XIcon } from '@/components/ui/icons';
import {
  FIT_WIDTH,
  pageAt,
  pageTop,
  scaleOf,
  stackHeight,
  stepZoom,
  zoomLabel,
  type PageStack,
  type Zoom,
} from './preview';

// v1.4 E (decision 17): a document's full-page preview, the whole window: a bar with its name and actions (Edit,
// Download, Close), the pages on a grey desk, fitted to the width (or zoomed), and a floating bar with the page
// ("Page 1 of 2", previous and next) and the zoom (−, Fit width, +). Escape closes it; focus stays inside (the dialog
// traps it) and starts on the pages, so the arrow keys and Page Down scroll them at once.

/** The desk's padding around the pages (px), at every scale. */
const DESK_PADDING = 24;

export interface FullPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The document's name: the dialog's accessible name. */
  title: string;
  /** "Resume preview", "Cover letter preview": over the name, and the pages' region name. */
  kind: string;
  /** Edit, Download: before Close. */
  actions?: ReactNode;
  /** The pages' measures, once known; null while loading. */
  stack: PageStack | null;
  /** The pages, drawn unscaled at `stack.width`; the dialog scales them. */
  children?: ReactNode;
  /** Instead of the pages: a spinner while loading, or what went wrong. */
  status?: ReactNode;
}

export function FullPreviewDialog(props: FullPreviewDialogProps) {
  const { open, onOpenChange } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <PreviewWindow {...props} />}
    </Dialog>
  );
}

function PreviewWindow({ title, kind, actions, stack, children, status }: FullPreviewDialogProps) {
  // The desk mounts inside the dialog's portal, after this component's first effects: it is followed by a callback ref.
  const desk = useRef<HTMLDivElement | null>(null);
  const [deskElement, setDeskElement] = useState<HTMLDivElement | null>(null);
  const deskRef = useCallback((element: HTMLDivElement | null) => {
    desk.current = element;
    setDeskElement(element);
  }, []);
  const [available, setAvailable] = useState(0);
  const [zoom, setZoom] = useState<Zoom>(FIT_WIDTH);
  const [page, setPage] = useState(0);

  // The width the pages may take: the desk's, less its padding (and the scroll bar it draws).
  useLayoutEffect(() => {
    if (!deskElement) return;
    const measure = () => setAvailable(Math.max(0, deskElement.clientWidth - DESK_PADDING * 2));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(deskElement);
    return () => observer.disconnect();
  }, [deskElement]);

  const scale = stack ? scaleOf(zoom, available, stack.width) : 1;
  const pages = stack ? Math.max(1, stack.count) : 1;

  const track = useCallback(() => {
    const element = desk.current;
    if (!element || !stack) return;
    setPage(pageAt(stack, scale, element.scrollTop, element.clientHeight, DESK_PADDING));
  }, [stack, scale]);

  // A change of scale or of the pages re-reads where the reader is.
  useEffect(() => track(), [track]);

  const goToPage = (index: number) => {
    const element = desk.current;
    if (!element || !stack) return;
    const target = Math.min(pages - 1, Math.max(0, index));
    element.scrollTo({ top: pageTop(stack, target) * scale + (target === 0 ? 0 : DESK_PADDING - 8) });
    setPage(target);
  };

  const zoomIn = stepZoom(scale, 1);
  const zoomOut = stepZoom(scale, -1);

  return (
    <DialogContent size="full" showClose={false} initialFocus={desk} className="overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 sm:gap-3 sm:px-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs leading-4 text-muted-foreground">{kind}</p>
          <DialogTitle className="truncate text-base leading-6">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            The pages as they print. Escape closes the preview.
          </DialogDescription>
        </div>
        {actions}
        <DialogClose render={<IconButton label="Close" icon={<XIcon size={18} />} size="sm" tooltip={false} />} />
      </header>
      <div
        ref={deskRef}
        tabIndex={0}
        role="region"
        aria-label={`${kind}: pages`}
        onScroll={track}
        className="relative min-h-0 flex-1 overflow-auto bg-surface-muted outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
        style={{ padding: DESK_PADDING }}
        data-preview-desk=""
      >
        {stack && !status ? (
          <div
            className="relative mx-auto"
            style={{ width: stack.width * scale, height: stackHeight(stack) * scale }}
            data-preview-scale={scale.toFixed(3)}
          >
            <div className="absolute top-0 left-0 origin-top-left" style={{ width: stack.width, transform: `scale(${scale})` }}>
              {children}
            </div>
          </div>
        ) : (
          <div className="flex min-h-full items-center justify-center">{status}</div>
        )}
        {/* Room under the last page for the floating bar. */}
        <div aria-hidden="true" className="h-14" />
      </div>
      {stack && !status && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3 sm:bottom-5">
          <div
            role="toolbar"
            aria-label="Pages and zoom"
            className="pointer-events-auto flex items-center gap-0.5 rounded-popup border border-border bg-surface px-1.5 py-1 shadow-popover"
          >
            <IconButton
              label="Previous page"
              icon={<CaretLeftIcon size={16} />}
              size="sm"
              variant="ghost"
              disabled={page === 0}
              onClick={() => goToPage(page - 1)}
            />
            <span className="min-w-22 px-1 text-center text-[13px] leading-5 font-medium text-foreground tabular-nums" data-preview-page="">
              Page {page + 1} of {pages}
            </span>
            <IconButton
              label="Next page"
              icon={<CaretRightIcon size={16} />}
              size="sm"
              variant="ghost"
              disabled={page >= pages - 1}
              onClick={() => goToPage(page + 1)}
            />
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
            <IconButton
              label="Zoom out"
              icon={<MinusIcon size={16} />}
              size="sm"
              variant="ghost"
              disabled={!zoomOut}
              onClick={() => zoomOut && setZoom(zoomOut)}
            />
            <button
              type="button"
              aria-pressed={zoom.mode === 'fit'}
              onClick={() => setZoom(FIT_WIDTH)}
              title="Fit the page to the width"
              className="h-8 min-w-18 rounded-control px-2 text-[13px] leading-5 font-medium text-foreground tabular-nums hover:bg-hover active:bg-pressed aria-pressed:text-primary-ink"
              data-preview-zoom=""
            >
              {zoomLabel(zoom, scale)}
            </button>
            <IconButton
              label="Zoom in"
              icon={<PlusIcon size={16} />}
              size="sm"
              variant="ghost"
              disabled={!zoomIn}
              onClick={() => zoomIn && setZoom(zoomIn)}
            />
          </div>
        </div>
      )}
    </DialogContent>
  );
}
