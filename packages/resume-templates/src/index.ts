// The resume templates as React components. The editor draws them in the page and the API prints them to PDF, so
// they use only what both can run: no effects, no layout reads, no browser globals. See docs/ARCHITECTURE.md.

/**
 * Bump when the drawn output changes for the same document (a template, the CSS, the pagination). Cached thumbnails are
 * keyed by it.
 */
export const RESUME_RENDER_VERSION = 2;

export * from './model/view';
export * from './model/flows';
export * from './model/geometry';
export * from './paginate/paginate';
export * from './paginate/summary';
export * from './slots';
export * from './components/ResumeLayout';
export * from './components/InlineRuns';
export {
  blockOptions,
  ENHANCV_OPTIONS,
  STANDARD_LOOK,
  type BlockLook,
  type BlockOptions,
} from './components/blocks/options';
export * from './templates/types';
export * from './templates/registry';
export * from './sample';
export * from './archetype-samples'; // v33 ROLES: the sample person of each kind of work
export * from './document';
export { RESUME_BASE_CSS, designVariables, printPageCss } from './styles/base.css';
export { templateScope } from './styles/templates.css';
export * from './outline';
