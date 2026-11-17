import { PAGE_SIZES, type ResolvedDesign, type ResumeTemplateSpec } from '@tailorit/shared';
import type { PageGeometry } from '../paginate/paginate';

// Where things sit on the page, in CSS px at the page's width: the margins, the columns and the gaps. The layout draws
// from these numbers and the paginator counts with the same ones, so neither reads a computed style.

/** Between the main and the side column. */
export const COLUMN_GAP_PX = 24;
/** Between pages in the editor; 0 in print. */
export const EDITOR_PAGE_GAP_PX = 24;

export interface ColumnBox {
  /** From the page's left edge. */
  x: number;
  width: number;
}

export interface ResumeGeometry {
  pageWidth: number;
  pageHeight: number;
  /** The `@page { size }` value. */
  pageCss: string;
  /** The sides. */
  margin: number;
  /** The top of every page (page 1 too, unless the header bleeds). */
  marginTop: number;
  /** The bottom of every page. */
  marginBottom: number;
  contentWidth: number;
  /** Below the header, before the columns start. */
  headerGap: number;
  /** The header runs to the page's edges at the top of page 1, above the top margin (the template's band). */
  headerBleed: boolean;
  columnGap: number;
  main: ColumnBox;
  /** Null on a one-column template. */
  side: ColumnBox | null;
}

/** Two decimals, so the editor and the PDF wrap text at the same width and the CSS stays readable. */
const px = (value: number) => Math.round(value * 100) / 100;

export function resumeGeometry(design: ResolvedDesign, spec: ResumeTemplateSpec): ResumeGeometry {
  const pageWidth = design.pageWidthPx;
  const margin = design.marginPx;
  const contentWidth = px(pageWidth - 2 * margin);
  const base = {
    pageWidth,
    pageHeight: design.pageHeightPx,
    pageCss: PAGE_SIZES[design.pageSize].css,
    margin,
    marginTop: design.marginTopPx,
    marginBottom: design.marginBottomPx,
    contentWidth,
    headerGap: design.sectionSpacingPx,
    headerBleed: spec.header.bleed === true,
  };
  if (spec.columns === 1 || !spec.side || design.columnRatio <= 0) {
    return { ...base, columnGap: 0, main: { x: margin, width: contentWidth }, side: null };
  }
  const sideWidth = px((contentWidth - COLUMN_GAP_PX) * design.columnRatio);
  const mainWidth = px(contentWidth - COLUMN_GAP_PX - sideWidth);
  const sideOnLeft = spec.side.position === 'left';
  return {
    ...base,
    columnGap: COLUMN_GAP_PX,
    main: { x: sideOnLeft ? px(margin + sideWidth + COLUMN_GAP_PX) : margin, width: mainWidth },
    side: { x: sideOnLeft ? margin : px(margin + mainWidth + COLUMN_GAP_PX), width: sideWidth },
  };
}

/** The flows a template lays out: the main column, and the side column on a two-column template. */
export function flowNames(geometry: ResumeGeometry): ('main' | 'side')[] {
  return geometry.side ? ['main', 'side'] : ['main'];
}

/**
 * What the paginator needs: the page, its margins, and what page 1 gives up in every flow to the header above the
 * columns (its measured height and the gap under it). A header that bleeds starts at the page's top edge, so the top
 * margin it covers is not taken twice.
 */
export function pageGeometry(geometry: ResumeGeometry, headerHeight: number): PageGeometry {
  const covered = geometry.headerBleed ? geometry.marginTop : 0;
  const reserve = headerHeight > 0 ? headerHeight - covered + geometry.headerGap : 0;
  return {
    pageHeight: geometry.pageHeight,
    marginTop: geometry.marginTop,
    marginBottom: geometry.marginBottom,
    firstPageReserve: Object.fromEntries(flowNames(geometry).map((flow) => [flow, reserve])),
  };
}

/** The root's height for `pageCount` pages: one px short of the last page, so print never starts an empty one. */
export function rootHeight(geometry: ResumeGeometry, pageCount: number, gap: number): number {
  const pages = Math.max(1, pageCount);
  return pages * geometry.pageHeight + (pages - 1) * gap - 1;
}

/** Where page `index` (0 first) starts, from the root's top. */
export function sheetTop(geometry: ResumeGeometry, index: number, gap: number): number {
  return index * (geometry.pageHeight + gap);
}
