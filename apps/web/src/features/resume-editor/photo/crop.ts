// The square crop of the header photo, as arithmetic: the image covers a square viewport (scaled so its short side
// fills it), the person zooms in from there and drags it, and the crop is the part of the image the viewport shows.
// The image never leaves a gap in the viewport.

import { defaultT, type MessageRenderer } from '../../../lib/messages';

export const PHOTO_OUTPUT_PX = 400;
export const MAX_ZOOM = 3;
/** What can be chosen; a larger file is refused before it is read. */
export const MAX_PHOTO_FILE_MB = 5;
export const MAX_PHOTO_FILE_BYTES = MAX_PHOTO_FILE_MB * 1024 * 1024;
export const PHOTO_FILE_TYPES = ['image/jpeg', 'image/png', 'image/bmp'] as const;

export interface CropState {
  /** 1 (the short side fills the viewport) to MAX_ZOOM. */
  zoom: number;
  /** The image's centre from the viewport's, in viewport px. */
  x: number;
  y: number;
}

export interface CropGeometry {
  imageWidth: number;
  imageHeight: number;
  /** The viewport's side, in px. */
  view: number;
}

/** Viewport px per image px. */
export const scaleOf = ({ imageWidth, imageHeight, view }: CropGeometry, zoom: number) =>
  (view / Math.min(imageWidth, imageHeight)) * zoom;

/** The state held inside its limits: the zoom between 1 and MAX_ZOOM, the image still covering the viewport. */
export function clampCrop(geometry: CropGeometry, state: CropState): CropState {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, state.zoom));
  const scale = scaleOf(geometry, zoom);
  const spareX = Math.max(0, (geometry.imageWidth * scale - geometry.view) / 2);
  const spareY = Math.max(0, (geometry.imageHeight * scale - geometry.view) / 2);
  return {
    zoom,
    x: Math.min(spareX, Math.max(-spareX, state.x)),
    y: Math.min(spareY, Math.max(-spareY, state.y)),
  };
}

/** The square of the image the viewport shows, in image px (what is drawn into the 400 x 400 photo). */
export function cropRect(geometry: CropGeometry, state: CropState): { x: number; y: number; size: number } {
  const { zoom, x, y } = clampCrop(geometry, state);
  const scale = scaleOf(geometry, zoom);
  const size = geometry.view / scale;
  return {
    x: (geometry.imageWidth - size) / 2 - x / scale,
    y: (geometry.imageHeight - size) / 2 - y / scale,
    size,
  };
}

/** Why a chosen file cannot be a photo, or null (v30 INT-0: the size words are MSG_PHOTO_FILE_TOO_LARGE's; a page passes t). */
export function photoFileProblem(file: { type: string; size: number }, t: MessageRenderer = defaultT): string | null {
  if (!(PHOTO_FILE_TYPES as readonly string[]).includes(file.type)) return 'Choose a JPG, PNG or BMP image.';
  if (file.size > MAX_PHOTO_FILE_BYTES) return t('MSG_PHOTO_FILE_TOO_LARGE', { max_mb: MAX_PHOTO_FILE_MB });
  return null;
}
