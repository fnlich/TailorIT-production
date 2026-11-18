'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog';
import { Notice } from '@/components/ui/Notice';
import { Slider } from '@/components/ui/Slider';
import { api, userMessage } from '@/lib/api';
import { usePublicConstants } from '@/lib/constants';
import { clampCrop, cropRect, MAX_PHOTO_FILE_MB, MAX_ZOOM, PHOTO_OUTPUT_PX, photoFileProblem, scaleOf, type CropState } from './crop';

// Adding the header photo (Enhancv's): choose a JPG, PNG or BMP, crop it square by dragging and zooming, then Accept.
// The crop is drawn into a 400 x 400 JPEG here in the browser (the camera's orientation already applied), so the
// server stores a small, plain image and never sees the original.

const VIEW_PX = 280;
const OUTPUT_TYPE = 'image/jpeg';

interface Loaded {
  bitmap: ImageBitmap;
  url: string;
}

async function uploadPhoto(bitmap: ImageBitmap, crop: CropState): Promise<string> {
  const rect = cropRect({ imageWidth: bitmap.width, imageHeight: bitmap.height, view: VIEW_PX }, crop);
  const canvas = document.createElement('canvas');
  canvas.width = PHOTO_OUTPUT_PX;
  canvas.height = PHOTO_OUTPUT_PX;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot draw the photo.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, PHOTO_OUTPUT_PX, PHOTO_OUTPUT_PX);
  context.drawImage(bitmap, rect.x, rect.y, rect.size, rect.size, 0, 0, PHOTO_OUTPUT_PX, PHOTO_OUTPUT_PX);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, OUTPUT_TYPE, 0.9));
  if (!blob) throw new Error('This browser cannot save the photo.');
  const form = new FormData();
  form.append('photo', blob, 'photo.jpg');
  const answer = (await api.post('/api/resumes/photos', form)) as { photoId?: unknown };
  if (typeof answer.photoId !== 'string') throw new Error('The photo was not stored. Please try again.');
  return answer.photoId;
}

export function PhotoDialog({
  open,
  onClose,
  onAccepted,
}: {
  open: boolean;
  onClose(): void;
  /** The stored photo's id, for the header. */
  onAccepted(photoId: string): void;
}) {
  const { t } = usePublicConstants();
  const input = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [crop, setCrop] = useState<CropState>({ zoom: 1, x: 0, y: 0 });
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const drag = useRef<{ x: number; y: number; start: CropState } | null>(null);

  useEffect(() => () => {
    if (loaded) {
      URL.revokeObjectURL(loaded.url);
      loaded.bitmap.close();
    }
  }, [loaded]);

  const reset = () => {
    setLoaded(null);
    setCrop({ zoom: 1, x: 0, y: 0 });
    setProblem(null);
    setSaving(false);
  };

  const choose = async (file: File | undefined) => {
    if (!file) return;
    const refused = photoFileProblem(file, t);
    if (refused) {
      setProblem(refused);
      return;
    }
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      setProblem(null);
      setCrop({ zoom: 1, x: 0, y: 0 });
      setLoaded({ bitmap, url: URL.createObjectURL(file) });
    } catch {
      setProblem('That image could not be read. Choose another one.');
    }
  };

  const geometry = loaded ? { imageWidth: loaded.bitmap.width, imageHeight: loaded.bitmap.height, view: VIEW_PX } : null;
  const scale = geometry ? scaleOf(geometry, crop.zoom) : 1;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, start: crop };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (!from || !geometry) return;
    setCrop(clampCrop(geometry, { ...from.start, x: from.start.x + event.clientX - from.x, y: from.start.y + event.clientY - from.y }));
  };

  const accept = async () => {
    if (!loaded) return;
    setSaving(true);
    try {
      onAccepted(await uploadPhoto(loaded.bitmap, crop));
      reset();
      onClose();
    } catch (error) {
      setProblem(userMessage(error, 'The photo was not stored. Please try again.'));
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent title="Add a photo" size="sm">
        <div className="flex flex-col items-center gap-4">
          {loaded && geometry ? (
            <>
              <div
                className="relative cursor-grab touch-none overflow-hidden rounded-full bg-surface-low active:cursor-grabbing"
                style={{ width: VIEW_PX, height: VIEW_PX }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={() => {
                  drag.current = null;
                }}
                aria-label="Drag to move the photo"
                role="img"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a local file being cropped */}
                <img
                  src={loaded.url}
                  alt=""
                  draggable={false}
                  className="pointer-events-none absolute top-1/2 left-1/2 max-w-none select-none"
                  style={{
                    width: geometry.imageWidth * scale,
                    height: geometry.imageHeight * scale,
                    transform: `translate(calc(-50% + ${crop.x}px), calc(-50% + ${crop.y}px))`,
                  }}
                />
              </div>
              <Slider
                className="w-full"
                min={1}
                max={MAX_ZOOM}
                step={0.01}
                value={crop.zoom}
                onValueChange={(zoom) => setCrop(clampCrop(geometry, { ...crop, zoom }))}
                thumbLabels={['Zoom']}
                formatValue={(value) => `${Math.round(value * 100)}%`}
              />
            </>
          ) : (
            <div className="stitch flex h-40 w-full flex-col items-center justify-center gap-3 rounded-card bg-surface">
              <p className="text-sm text-muted-foreground">JPG, PNG or BMP, up to {MAX_PHOTO_FILE_MB} MB</p>
              <Button variant="outline" onClick={() => input.current?.click()}>
                Choose a photo
              </Button>
            </div>
          )}
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/bmp"
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => {
              void choose(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          {problem ? (
            <Notice tone="error" className="w-full">
              {problem}
            </Notice>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              if (loaded) reset();
              else onClose();
            }}
          >
            Back
          </Button>
          <Button disabled={!loaded} loading={saving} onClick={() => void accept()}>
            Accept
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
