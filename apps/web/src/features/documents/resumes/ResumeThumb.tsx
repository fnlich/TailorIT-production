'use client';

import { PAGE_SIZES, type ResumeDocument, type ResumeSummary } from '@tailorit/shared/resume';
import { THUMBNAIL_SLOTS } from '@tailorit/resume-templates';
import { useEffect, useRef, useState } from 'react';
import { profileUrl } from '../../../lib/profile'; // v33 FIX-2: the upload's image names the tab's profile
import { DocumentThumb, PageThumb, ThumbLoading, ThumbState, thumbKey } from '../core';
import { fetchThumbnail } from '../../resume-editor/api';
import { ResumeCanvas } from '../../resume-editor/pages/ResumeCanvas';

/*
 * A resume's first page, fetched once it is near the screen and kept per version (the documents layer's cache, keyed
 * `resume:id:updatedAt`): a built resume's page is drawn here from its document with the editor's templates (an older
 * resume as the editor opens it; v33 LEGACY: the server no longer draws one as HTML), an upload's is the PNG made when
 * it was stored.
 */

/** Upload image addresses already worked out (module state: survives tab and view switches, not a reload). */
const imageUrls = new Map<string, string>();
const imageRequests = new Map<string, Promise<string>>();

/**
 * An upload's image address, worked out once per version (exported for the tests). v33 FIX-2 (final review, sharing 2):
 * the server's address goes through profileUrl(), since the browser loads it itself (no profile header): on a shared
 * profile it names the profile (?profile=), else the image would be asked for on the person's own and not be found.
 * A switch of profile is a new document, so the kept address never names another profile.
 */
export function resolveImage(key: string, id: string): Promise<string> {
  const kept = imageUrls.get(key);
  if (kept) return Promise.resolve(kept);
  const pending = imageRequests.get(key);
  if (pending) return pending;
  const request = fetchThumbnail(id)
    .then((answer) => {
      if (answer.kind !== 'image') throw new Error('No preview');
      const url = profileUrl(answer.url);
      imageUrls.set(key, url);
      return url;
    })
    .finally(() => imageRequests.delete(key));
  imageRequests.set(key, request);
  return request;
}

/** Built resumes' documents already fetched (module state, like the upload images). */
const documents = new Map<string, ResumeDocument>();
const documentRequests = new Map<string, Promise<ResumeDocument>>();

function resolveDocument(key: string, id: string): Promise<ResumeDocument> {
  const kept = documents.get(key);
  if (kept) return Promise.resolve(kept);
  const pending = documentRequests.get(key);
  if (pending) return pending;
  const request = fetchThumbnail(id)
    .then((answer) => {
      if (answer.kind !== 'document') throw new Error('No preview');
      documents.set(key, answer.document);
      return answer.document;
    })
    .finally(() => documentRequests.delete(key));
  documentRequests.set(key, request);
  return request;
}

export function ResumeThumb({
  resume,
  title,
}: {
  resume: Pick<ResumeSummary, 'id' | 'kind' | 'updatedAt'>;
  /** For the frame or image; the card carries the name a reader hears. */
  title: string;
}) {
  if (resume.kind === 'uploaded') return <UploadThumb id={resume.id} updatedAt={resume.updatedAt} title={title} />;
  return <EditorThumb id={resume.id} updatedAt={resume.updatedAt} title={title} />;
}

/**
 * A built resume's first page, drawn here with its template (the server has no layout to measure it with):
 * its document is fetched once the card is near the screen, then drawn as Preview draws it and clipped to page 1.
 */
function EditorThumb({ id, updatedAt, title }: { id: string; updatedAt: string; title: string }) {
  const key = `${thumbKey('resume', id, updatedAt)}:document`;
  const box = useRef<HTMLDivElement>(null);
  const [resolved, setResolved] = useState<{ key: string; document: ResumeDocument } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const kept = documents.get(key);
  const document = kept ?? (resolved?.key === key ? resolved.document : undefined);

  useEffect(() => {
    if (kept) return;
    const element = box.current;
    if (!element) return;
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        resolveDocument(key, id).then(
          (found) => {
            if (!cancelled) setResolved({ key, document: found });
          },
          () => {
            if (!cancelled) setFailedKey(key);
          },
        );
      },
      { rootMargin: '300px' },
    );
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [key, id, kept]);

  const page = PAGE_SIZES[document?.design?.pageSize === 'a4' ? 'a4' : 'letter'];
  return (
    <div
      ref={box}
      role="img"
      aria-label={title}
      className="relative w-full overflow-hidden bg-surface"
      style={{ aspectRatio: `${page.widthPx} / ${page.heightPx}` }}
    >
      {document ? (
        <div aria-hidden="true" inert className="pointer-events-none absolute inset-0">
          <ResumeCanvas document={document} mode="static" slots={THUMBNAIL_SLOTS} />
        </div>
      ) : failedKey === key ? (
        <ThumbState>No preview</ThumbState>
      ) : (
        <ThumbLoading />
      )}
    </div>
  );
}

function UploadThumb({ id, updatedAt, title }: { id: string; updatedAt: string; title: string }) {
  const key = `${thumbKey('resume', id, updatedAt)}:image`;
  const box = useRef<HTMLDivElement>(null);
  const [resolved, setResolved] = useState<{ key: string; url: string } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const kept = imageUrls.get(key);
  const src = kept ?? (resolved?.key === key ? resolved.url : undefined);

  useEffect(() => {
    if (kept) return;
    const element = box.current;
    if (!element) return;
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        resolveImage(key, id).then(
          (url) => {
            if (!cancelled) setResolved({ key, url });
          },
          () => {
            if (!cancelled) setFailedKey(key);
          },
        );
      },
      { rootMargin: '300px' },
    );
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [key, id, kept]);

  if (src) return <DocumentThumb cacheKey={key} imageSrc={src} title={title} />;
  return (
    <div ref={box}>
      <PageThumb title={title} placeholder={failedKey === key ? <ThumbState>No preview</ThumbState> : <ThumbLoading />} />
    </div>
  );
}
