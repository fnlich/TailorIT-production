// v30 E2: the logo pipeline (docs/design/part2/13-company-enrichment.md §4 rule 7, §6.1, §10 "Logo files"): every logo
// TailorIT shows is its own copy, decoded and drawn again by the headless browser at 64 and 128 px and stored by the
// logo store (../logos.ts storeLogo); never hot-linked. The files:
//   pipeline.ts   copyLogo: the bytes checked (image.ts), drawn (rasterize.ts), stored
//   image.ts      an image's kind and size by its bytes
//   rasterize.ts  the browser's drawing at 64 and 128 px, transparency read back from two backgrounds
//   png.ts        the PNG the pipeline reads (the browser's screenshots) and writes
//   logo-dev.ts   the `logo_dev` step: logo.dev's API for the gaps (off without LOGO_DEV_KEY)

export { copyLogo, logoRefusalOf, logoSizesOf, type CopiedLogo, type LogoRefusal } from './pipeline';
export { imageInfoOf, IMAGE_MIME, type ImageInfo, type ImageKind } from './image';
export { browserRasterizer, DEFAULT_LOGO_SIZES, logoPage, squareOf, type LogoRasterizer, type LogoSizes } from './rasterize';
export { decodePng, encodePng, type RgbaImage } from './png';
export { runLogoDevStep, LOGO_DEV_API, LOGO_DEV_PURGE_GROUP, type LogoDevOptions } from './logo-dev';
