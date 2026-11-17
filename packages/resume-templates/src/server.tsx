// @jsxRuntime automatic
// @jsxImportSource react
import { renderToStaticMarkup } from 'react-dom/server';
import type { ResumeDocument } from '@tailorit/shared';
import { ResumeLayout } from './components/ResumeLayout';
import { layoutResume, resumeCss, type LaidOutResume } from './document';
import type { PagePlan } from './paginate/paginate';
import { createStaticSlots, STATIC_SLOTS, SlotsContext, type Slots } from './slots';
import { printPageCss } from './styles/base.css';

// The API's side: a document as the HTML headless Chrome prints. The page is self-contained: the fonts come in
// `fontCss` as data: URLs, a photo as a data: URL, and the CSP lets nothing else load. The same call draws the
// measuring pass (`plan: null`) and the final page.

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);

/** CSS inside <style>: a stray `<` (never valid CSS outside a string) is escaped, so no text can close the element. */
const styleText = (css: string) => css.replace(/</g, '\\3c ');

export const RESUME_PRINT_CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:";

/**
 * The resume's markup for a plan (null while measuring: one page, no breaks). `gap` is the space the editor shows
 * between pages, 0 in print; `slots` defaults to the static ones. Here, not in the package root, because it needs
 * react-dom/server, which a Next.js server component may not import.
 */
export function renderResumeMarkup(
  layout: LaidOutResume,
  plan: PagePlan | null,
  options: { gap: number; slots?: Slots },
): string {
  return renderToStaticMarkup(
    <SlotsContext.Provider value={options.slots ?? STATIC_SLOTS}>
      <ResumeLayout {...layout} plan={plan} gap={options.gap} />
    </SlotsContext.Provider>,
  );
}

export interface RenderResumeHtmlOptions {
  document: ResumeDocument;
  /** The page breaks; null for the measuring pass. */
  plan: PagePlan | null;
  /** The @font-face rules of the faces in use, as data: URLs. */
  fontCss: string;
  /** The PDF's title. */
  title: string;
  /** The header photo as a data: URL; null (or no function) prints no photo. */
  photoSrc?: (photoId: string) => string | null;
}

/** The print document of a resume, in static mode, with no gap between pages. */
export function renderResumeHtml(options: RenderResumeHtmlOptions): string {
  const layout = layoutResume(options.document, 'static');
  const slots = createStaticSlots({ photoSrc: options.photoSrc });
  const css = printPageCss(layout.geometry) + resumeCss(layout.template) + options.fontCss;
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${RESUME_PRINT_CSP}">` +
    `<title>${escapeHtml(options.title)}</title><style>${styleText(css)}</style></head>` +
    `<body>${renderResumeMarkup(layout, options.plan, { gap: 0, slots })}</body></html>`
  );
}
