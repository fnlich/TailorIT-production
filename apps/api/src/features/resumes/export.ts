import HTMLtoDOCX from '@turbodocx/html-to-docx';
import {
  resumeDownloadFileName,
  resumeExportFile,
  resumeExportFileName,
  type ResumeDocument,
  type ResumeExportFormat,
} from '@tailorit/shared';
import {
  layoutResume,
  paginateResume,
  resumeOutline,
  resumePlainText,
  type OutlineLine,
  type PagePlan,
  type ResumeOutline,
} from '@tailorit/resume-templates';
import { renderResumeHtml } from '@tailorit/resume-templates/server';
import { nowIso, type AppDeps } from '../../core/context';
import { MIME_BY_KIND } from '../../core/files/index';
import { resumeFontFaceCss } from '../../core/fonts';
import { getPdfService } from '../../core/pdf/index';
import { editorDocumentOf } from '../../core/skills/index';
import { photoDataUrl } from './photos';

// Downloads of a built resume: the PDF (the template printed by Chrome, JavaScript off and the network shut), the
// "Word (simple layout)" DOCX, the plain text, and the JSON file Import JSON reads back. Every resume prints from its
// on-page editor template, measured first so its pages break as the editor shows them. v33 LEGACY: the retired
// Handlebars templates are gone; an older resume (saved before the editor) or an AI-made document is upgraded as it
// is read (core/skills' editorDocumentOf) and prints as the editor shows it.

export interface ExportedFile {
  buffer: Buffer;
  mime: string;
  fileName: string;
  /** An on-page editor PDF: how long Chrome took to measure and print it (ms), for the Server-Timing header. */
  printMs?: number;
}

/** One inch, in twentieths of a point (html-to-docx margins). */
const INCH_TWIPS = 1440;

async function docxBuffer(html: string, title: string): Promise<Buffer> {
  const result = await HTMLtoDOCX(html, null, {
    orientation: 'portrait',
    margins: { top: INCH_TWIPS / 2, right: INCH_TWIPS / 2, bottom: INCH_TWIPS / 2, left: INCH_TWIPS / 2 },
    title,
    subject: 'Resume, Word (simple layout)',
    creator: 'TailorIT',
    font: 'Arial',
    fontSize: 20,
  });
  if (Buffer.isBuffer(result)) return result;
  if (result instanceof ArrayBuffer) return Buffer.from(result);
  return Buffer.from(await (result as Blob).arrayBuffer());
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char]!);

/**
 * The Word file's HTML: the printed lines of the resume as plain paragraphs (Word draws them in Arial), the headings in
 * the resume's accent colour. No columns, icons or inline formatting: what an applicant tracking system reads well.
 */
function outlineDocxHtml(outline: ResumeOutline, accent: string): string {
  const color = /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#000000';
  const block = (item: OutlineLine): string => {
    const text = escapeHtml(item.text);
    switch (item.kind) {
      case 'name':
        return `<p style="font-size:20pt;font-weight:bold;margin:0">${text}</p>`;
      case 'title':
        return `<p style="font-size:12pt;color:${color};margin:0">${text}</p>`;
      case 'heading':
        return `<h2 style="font-size:12pt;color:${color};margin:12pt 0 4pt;border-bottom:1px solid ${color}">${text}</h2>`;
      case 'entryTitle':
        return `<p style="font-weight:bold;margin:6pt 0 0">${text}</p>`;
      case 'meta':
        return `<p style="color:#5c5c5c;font-size:9pt;margin:0">${text}</p>`;
      default:
        return `<p style="margin:0">${text}</p>`;
    }
  };
  const lines = (items: OutlineLine[]) => {
    let html = '';
    let bullets: string[] = [];
    const closeList = () => {
      if (bullets.length > 0) html += `<ul>${bullets.map((bullet) => `<li>${bullet}</li>`).join('')}</ul>`;
      bullets = [];
    };
    for (const item of items) {
      if (item.kind === 'bullet') bullets.push(escapeHtml(item.text));
      else {
        closeList();
        html += block(item);
      }
    }
    closeList();
    return html;
  };
  return `<!DOCTYPE html><html><body>${lines(outline.header)}${outline.sections.map(lines).join('')}</body></html>`;
}

/**
 * A resume of the on-page editor as a PDF: drawn once to measure every box (its own fonts inlined, its photo as a
 * data: URL), paginated with the editor's rules, drawn again with the page breaks and printed at its own page size.
 */
async function printEditorResume(deps: AppDeps, userId: string, document: ResumeDocument, title: string): Promise<Buffer> {
  const { layout, html } = await editorPrint(deps, userId, document, title);
  return getPdfService(deps).printMeasured(
    html(null),
    (boxes) => html(paginateResume(layout, Object.fromEntries(boxes))),
    { viewportWidth: layout.geometry.pageWidth },
  );
}

/**
 * The print document of an on-page editor resume, for a page plan (null: the measuring pass). v3.0 D2: its header
 * photo is read first (the drawing asks for it synchronously), so nothing is read while it draws.
 */
async function editorPrint(deps: AppDeps, userId: string, document: ResumeDocument, title: string) {
  const layout = layoutResume(document, 'static');
  // Only the scripts the resume is written in (its whole document stands for its text: every word it can print).
  const fontCss = resumeFontFaceCss({ pairId: layout.view.design.fontPairId }, 'data', JSON.stringify(document));
  const headerPhoto = document.header?.photo?.photoId;
  const photos = new Map<string, string | null>();
  if (headerPhoto) photos.set(headerPhoto, await photoDataUrl(deps, userId, headerPhoto));
  const photoSrc = (photoId: string) => photos.get(photoId) ?? null;
  const html = (plan: PagePlan | null) => renderResumeHtml({ document, plan, fontCss, title, photoSrc });
  return { layout, html };
}

/** The pages the PDF of an on-page editor resume would have: measured in Chrome, never printed. */
export async function editorResumePlan(
  deps: AppDeps,
  userId: string,
  document: ResumeDocument,
): Promise<{ plan: PagePlan; heights: Record<string, number> }> {
  const { layout, html } = await editorPrint(deps, userId, document, 'Resume');
  const heights = Object.fromEntries(await getPdfService(deps).measureBoxes(html(null), { viewportWidth: layout.geometry.pageWidth }));
  return { plan: paginateResume(layout, heights), heights };
}

export async function exportBuiltResume(
  deps: AppDeps,
  userId: string,
  resume: { label: string; title: string | null; templateId: string | null; document: ResumeDocument },
  format: ResumeExportFormat,
  options: { name?: string } = {},
): Promise<ExportedFile> {
  if (format === 'json') {
    const file = resumeExportFile({ title: resume.title, templateId: resume.templateId, document: resume.document }, nowIso(deps));
    return {
      buffer: Buffer.from(`${JSON.stringify(file, null, 2)}\n`),
      mime: 'application/json; charset=utf-8',
      fileName: resumeExportFileName(resume.label, 'json'),
    };
  }
  // Every other format prints what the editor shows: an older or AI-made document as the editor opens it.
  const document = await editorDocumentOf(deps, userId, resume.document);
  if (format === 'txt') {
    // What the page prints, as plain lines.
    const fileName = resumeDownloadFileName(document, 'txt', options.name);
    return { buffer: Buffer.from(resumePlainText(document)), mime: 'text/plain; charset=utf-8', fileName };
  }
  if (format === 'docx') {
    const outline = resumeOutline(document);
    const accent = layoutResume(document, 'static').view.design.secondary;
    return {
      buffer: await docxBuffer(outlineDocxHtml(outline, accent), resume.label),
      mime: MIME_BY_KIND.docx,
      fileName: resumeDownloadFileName(document, 'docx', options.name),
    };
  }
  const started = performance.now();
  const buffer = await printEditorResume(deps, userId, document, resume.label);
  return {
    buffer,
    mime: MIME_BY_KIND.pdf,
    fileName: resumeDownloadFileName(document, 'pdf', options.name),
    printMs: Math.round(performance.now() - started),
  };
}
