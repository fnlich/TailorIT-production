import type { ResumeDocument } from '@tailorit/shared/resume';
import { resumeView, type ResumeView, type ViewMode } from '@tailorit/resume-templates';

// The view of a document, worked out once per document and mode: the page, its toolbars and the empty-field check all
// read the same one. A document is never changed in place (the store makes a new one for every change), so the
// document itself is the key.

const cache: Record<ViewMode, WeakMap<ResumeDocument, ResumeView>> = { edit: new WeakMap(), static: new WeakMap() };

export function viewOf(document: ResumeDocument, mode: ViewMode): ResumeView {
  let view = cache[mode].get(document);
  if (!view) {
    view = resumeView(document, mode);
    cache[mode].set(document, view);
  }
  return view;
}
