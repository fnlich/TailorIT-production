'use client';

import { PAGE_SIZES, type ResumeDocument, type ResumeSummary } from '@tailorit/shared/resume';
import { THUMBNAIL_SLOTS } from '@tailorit/resume-templates';
import { useEffect, useRef, useState } from 'react';
import { DocumentThumb, PageThumb, ThumbLoading, ThumbState, thumbKey, type ThumbPage } from '../core';
import { fetchThumbnail } from '../../resume-editor/api';
import { ResumeCanvas } from '../../resume-editor/pages/ResumeCanvas';

/*
 * A resume's first page, fetched once it is near the screen and kept per version (the documents layer's cache, keyed
 * `resume:id:updatedAt`): a built resume's page is HTML drawn by the server (framed with every sandbox flag off), an
 * upload's is the PNG made when it was stored.
 */

async function loadBuiltPage(id: string): Promise<ThumbPage> {
  const answer = await fetchThumbnail(id, 'built');
  if (answer.kind !== 'html') throw new Error('No preview');
  return { html: answer.html, page: answer.page ?? undefined };
}

/** Upload image addresses already worked out (module state: survives tab and view switches, not a reload). */
const imageUrls = new Map<string, string>();
const imageRequests = new Map<string, Promise<string>>();

function resolveImage(key: string, id: string): Promise<string> {
  const kept = imageUrls.get(key);
  if (kept) return Promise.resolve(kept);
  const pending = imageRequests.get(key);
  if (pending) return pending;
  const request = fetchThumbnail(id, 'uploaded')
    .then((answer) => {
      if (answer.kind !== 'image') throw new Error('No preview');
      imageUrls.set(key, answer.url);
      return answer.url;
    })
    .finally(() => imageRequests.delete(key));
  imageRequests.set(key, request);
  return request;
}

/** On-page editor resumes' documents already fetched (module state, like the upload images). */
const documents = new Map<string, ResumeDocument>();
const documentRequests = new Map<string, Promise<ResumeDocument>>();

function resolveDocument(key: string, id: string): Promise<ResumeDocument> {
  const kept = documents.get(key);
  if (kept) return Promise.resolve(kept);
  const pending = documentRequests.get(key);
  if (pending) return pending;
  const request = fetchThumbnail(id, 'built')
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
  resume: Pick<ResumeSummary, 'id' | 'kind' | 'updatedAt' | 'onPageEditor'>;
  /** For the frame or image; the card carries the name a reader hears. */
  title: string;
}) {
  if (resume.kind === 'uploaded') return <UploadThumb id={resume.id} updatedAt={resume.updatedAt} title={title} />;
  if (resume.onPageEditor) return <EditorThumb id={resume.id} updatedAt={resume.updatedAt} title={title} />;
  return <DocumentThumb cacheKey={thumbKey('resume', resume.id, resume.updatedAt)} load={() => loadBuiltPage(resume.id)} title={title} />;
}

/**
 * An on-page editor resume's first page, drawn here with its template (the server has no layout to measure it with):
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
      className="relative w-full overflow-hidden bg-white"
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
