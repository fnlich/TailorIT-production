'use client';

import { Menu as BaseMenu } from '@base-ui/react/menu';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { buttonClasses } from '@/components/ui/Button';
import { CaretDownIcon, DownloadSimpleIcon, PencilSimpleIcon } from '@/components/ui/icons';
import { MenuContent, MenuItem } from '@/components/ui/Menu';
import { Notice } from '@/components/ui/Notice';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { downloadFile, fetchLetterPreview, letterExportPath, letterKeys } from '../../letter-editor/data';
import { FullPreviewDialog } from './FullPreviewDialog';
import { pagesIn } from './preview';

// v1.4 E (decision 17): a cover letter's full-page preview: the letter as it prints (the server's HTML, the same the
// thumbnails and the PDF use), in a frame with every sandbox flag but same-origin off (no script can run), as tall as
// the letter. Edit opens the letter editor; Download offers the PDF and the Word file.

export function LetterPreviewDialog({
  open,
  onOpenChange,
  letterId,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  letterId: string;
  title: string;
}) {
  return open ? <PreviewBody onOpenChange={onOpenChange} letterId={letterId} title={title} /> : null;
}

function PreviewBody({ onOpenChange, letterId, title }: { onOpenChange: (open: boolean) => void; letterId: string; title: string }) {
  const toast = useToast();
  const query = useQuery({
    queryKey: [...letterKeys.detail(letterId), 'full-preview'],
    queryFn: () => fetchLetterPreview(letterId),
    staleTime: 0,
  });
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const page = query.data?.page;
  const frameHeight = page ? Math.max(page.heightPx, height ?? page.heightPx) : 0;

  const download = async (format: 'pdf' | 'docx') => {
    try {
      await downloadFile(letterExportPath(letterId, format), `${title}.${format}`);
    } catch (error) {
      toast.error('Download failed', userMessage(error, 'The download did not work. Please try again.'));
    }
  };

  const actions = (
    <>
      <BaseMenu.Root>
        <BaseMenu.Trigger className={buttonClasses({ variant: 'outline', size: 'sm' })} data-preview-download="">
          <DownloadSimpleIcon size={16} />
          <span className="max-sm:sr-only">Download</span>
          <CaretDownIcon size={12} />
        </BaseMenu.Trigger>
        <MenuContent align="end" width="w-44" aria-label="Download">
          <MenuItem onClick={() => void download('pdf')}>PDF</MenuItem>
          <MenuItem onClick={() => void download('docx')}>Word</MenuItem>
        </MenuContent>
      </BaseMenu.Root>
      <Link href={`/cover-letter/${encodeURIComponent(letterId)}`} className={buttonClasses({ size: 'sm' })} data-preview-edit="">
        <PencilSimpleIcon size={16} />
        Edit
      </Link>
    </>
  );

  return (
    <FullPreviewDialog
      open
      onOpenChange={onOpenChange}
      title={title}
      kind="Cover letter preview"
      actions={actions}
      stack={
        page
          ? { width: page.widthPx, pageHeight: page.heightPx, gap: 0, count: pagesIn(frameHeight, page.heightPx), height: frameHeight }
          : null
      }
      status={
        query.isError ? (
          <Notice tone="error" className="max-w-md">
            {userMessage(query.error, 'The preview could not be drawn. Please try again.')}
          </Notice>
        ) : !query.data ? (
          <Spinner size={20} label="Drawing the preview..." />
        ) : undefined
      }
    >
      {query.data && page && (
        <iframe
          ref={frame}
          title={title}
          srcDoc={query.data.html}
          sandbox="allow-same-origin"
          className="block border-0 bg-white shadow-[0_1px_3px_rgba(17,24,39,.12),0_0_0_1px_rgba(17,24,39,.06)]"
          style={{ width: page.widthPx, height: frameHeight }}
          onLoad={() => {
            // Same-origin (no scripts can run: no allow-scripts), so the letter's own height can be read.
            const full = frame.current?.contentDocument?.documentElement.scrollHeight;
            if (full) setHeight(full);
          }}
        />
      )}
    </FullPreviewDialog>
  );
}
