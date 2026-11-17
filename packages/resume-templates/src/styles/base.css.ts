import { isHexColor, type ResolvedDesign } from '@tailorit/shared';
import type { ResumeGeometry } from '../model/geometry';

// The CSS every template starts from. The same rules run inside the web app (under Tailwind's preflight) and alone in
// the print browser, so they set every property either side could otherwise decide: `.rt-root` drops everything it
// would inherit (`all: initial`) and sets it back explicitly, and the reset below is unlayered, so it wins over
// preflight's layered rules whatever their specificity. A header that bleeds (a band across the top of page 1) is
// pulled over the top and side margins, so its box spans the page's width from its top edge. No @media, no viewport units and no zoom: the page measures
// the same at any screen size. Field text keeps its spaces and wraps long words.

export const RESUME_BASE_CSS = `
.rt-root{all:initial;display:block;position:relative;box-sizing:border-box;width:var(--rt-page-w);overflow:clip;
font-family:var(--rt-body-font);font-size:var(--rt-font-size);line-height:var(--rt-line-height);font-weight:400;
font-style:normal;color:var(--rt-text);text-align:left;text-transform:none;text-indent:0;letter-spacing:normal;
word-spacing:normal;white-space:normal;overflow-wrap:normal;word-break:normal;hyphens:manual;tab-size:4;direction:ltr;
font-synthesis:none;font-variant-ligatures:none;font-kerning:normal;font-feature-settings:normal;
font-optical-sizing:auto;-webkit-text-size-adjust:none;text-size-adjust:none;-webkit-print-color-adjust:exact;
print-color-adjust:exact;color-scheme:light;cursor:auto;visibility:visible}
.rt-root *,.rt-root ::before,.rt-root ::after{box-sizing:border-box;margin:0;padding:0;border:0 solid}
.rt-root :where(h1,h2,h3,h4,h5,h6,p,ul,ol,li,dl,dt,dd,figure,blockquote,section,header,article){font-size:inherit;
font-weight:inherit;line-height:inherit}
.rt-root :where(ul,ol){list-style:none}
.rt-root :where(b,strong){font-weight:700}
.rt-root :where(i,em){font-style:italic}
.rt-root :where(u){text-decoration:underline}
.rt-root :where(a){color:inherit;text-decoration:underline}
.rt-root :where(img,svg){display:block;max-width:none}
.rt-text{white-space:pre-wrap;overflow-wrap:break-word}
.rt-sheet{position:absolute;left:0;z-index:0;width:var(--rt-page-w);height:calc(var(--rt-page-h) - 1px);
overflow:hidden;background:#ffffff}
.rt-body{position:absolute;z-index:1;top:var(--rt-margin-top);left:var(--rt-margin);width:var(--rt-content-w);
display:flex;flex-direction:column}
.rt-root[data-header-bleed] .rt-header-box{margin:calc(-1 * var(--rt-margin-top)) calc(-1 * var(--rt-margin)) 0}
.rt-columns{display:flex;align-items:flex-start;gap:var(--rt-col-gap);margin-top:var(--rt-header-gap)}
.rt-columns[data-side=left]{flex-direction:row-reverse}
.rt-flow{display:flex;flex-direction:column;flex:none;min-width:0}
.rt-flow[data-flow=main]{width:var(--rt-main-w)}
.rt-flow[data-flow=side]{width:var(--rt-side-w)}
[data-rt-section],[data-rt-entry]{display:flex;flex-direction:column}
[data-rt-box],.rt-break{flex:none}
`;

/** The print document's page: no browser margin, the page size the design asked for. */
export function printPageCss(geometry: ResumeGeometry): string {
  return `@page{size:${geometry.pageCss};margin:0}html,body{margin:0;padding:0;background:#ffffff}`;
}

const SAFE_FONT_STACK = /^[A-Za-z0-9 ",-]+$/;

/** A colour that is safe in CSS, or the fallback. */
const color = (value: string, fallback: string) => (isHexColor(value) ? value : fallback);
/** A font stack from the registry, checked before it reaches CSS. */
const stack = (value: string, fallback: string) => (SAFE_FONT_STACK.test(value) ? value : fallback);

/**
 * The custom properties `.rt-root` carries: the design's numbers and colours. Every value is a number or a checked
 * string, so a stored design can never write CSS of its own.
 */
export function designVariables(design: ResolvedDesign, geometry: ResumeGeometry): Record<string, string> {
  return {
    '--rt-page-w': `${geometry.pageWidth}px`,
    '--rt-page-h': `${geometry.pageHeight}px`,
    '--rt-margin': `${geometry.margin}px`,
    '--rt-margin-top': `${geometry.marginTop}px`,
    '--rt-content-w': `${geometry.contentWidth}px`,
    '--rt-header-gap': `${geometry.headerGap}px`,
    '--rt-col-gap': `${geometry.columnGap}px`,
    '--rt-main-w': `${geometry.main.width}px`,
    '--rt-side-w': `${geometry.side?.width ?? 0}px`,
    '--rt-section-gap': `${design.sectionSpacingPx}px`,
    '--rt-font-size': `${design.fontSizePt}pt`,
    '--rt-line-height': String(design.lineHeight),
    '--rt-heading-font': stack(design.headingFont.stack, 'sans-serif'),
    '--rt-body-font': stack(design.bodyFont.stack, 'sans-serif'),
    '--rt-primary': color(design.primary, '#000000'),
    '--rt-secondary': color(design.secondary, '#000000'),
    '--rt-text': '#1f1f1f',
    '--rt-muted': '#5c5c5c',
  };
}
