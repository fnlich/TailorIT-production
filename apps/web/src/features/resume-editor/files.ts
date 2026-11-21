import { ApiError, UNREACHABLE_MESSAGE } from '../../lib/api';
import { profileHeaders } from '../../lib/profile';
import { PUBLIC_CONSTANT_DEFAULTS } from '../../lib/constants';
import { defaultT, type MessageRenderer } from '../../lib/messages';

/*
 * Files in and out of the browser: picking one, the checks made before an upload, reading a JSON file, and saving a
 * download under the name the server gave it.
 */

export const PDF_ACCEPT = '.pdf,application/pdf';
export const JSON_ACCEPT = '.json,application/json';
export const RESUME_FILE_ACCEPT =
  '.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Opens the file picker for one file; resolves to null when it is dismissed (in a browser that says so). A hidden
 * input made for this choice and removed once it answers.
 */
export function chooseFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.hidden = true;
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => done(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

export function isPdfFile(file: { name: string; type: string }): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

/**
 * "Resume.pdf is 5 MB or larger; …", or null when the file fits. `maxMb` is UPLOAD_MAX_MB (v30 ST5: the constant's;
 * a page passes the server's value, `get('UPLOAD_MAX_MB')`, under the proxy's 10 MB body limit).
 */
export function fileSizeRefusal(
  file: { name: string; size: number },
  maxMb: number = PUBLIC_CONSTANT_DEFAULTS.UPLOAD_MAX_MB,
  t: MessageRenderer = defaultT,
): string | null {
  // v30 INT-0: MSG_UPLOAD_FILE_TOO_LARGE's words (a page passes its own t).
  return file.size >= maxMb * 1024 * 1024 ? t('MSG_UPLOAD_FILE_TOO_LARGE', { name: file.name, max_mb: maxMb }) : null;
}

/** Why a file cannot be read as a resume PDF, or null. */
export function pdfRefusal(file: { name: string; type: string; size: number }, maxMb?: number, t?: MessageRenderer): string | null {
  if (!isPdfFile(file)) return 'Please upload a PDF file.';
  return fileSizeRefusal(file, maxMb, t);
}

/** The file's text as JSON; a sentence naming the file when it is not JSON. */
export async function readJsonFile(file: File): Promise<unknown> {
  const textContent = await file.text();
  try {
    return JSON.parse(textContent.replace(/^﻿/, ''));
  } catch {
    throw new Error(`${file.name} is not valid JSON. Export a resume from this app, or check the file.`);
  }
}

/** The file name a Content-Disposition header gives (`filename*=UTF-8''…` wins over `filename="…"`), or null. */
export function fileNameFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // fall through to the plain parameter
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(header);
  const name = (plain?.[2] ?? plain?.[1] ?? '').trim();
  return name || null;
}

/** Saves a blob under `name` through a hidden link to a `blob:` URL (nothing navigates). */
export function saveBlob(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Kept a while: the browser reads the blob after the click returns.
    window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
  }
}

/**
 * Downloads `url` (same origin, the session cookie rides along) and saves it under the server's file name. A failure
 * throws an ApiError with the server's sentence, so the page can say what went wrong instead of saving an error page.
 */
export async function downloadFrom(url: string, fallbackName: string): Promise<void> {
  let response: Response;
  try {
    // v33 SHARE-4: the profile the page works on, as every API request names it (lib/profile.ts).
    response = await fetch(url, { credentials: 'same-origin', headers: profileHeaders(url) });
  } catch {
    throw new ApiError({ status: 0, code: 'internal', message: UNREACHABLE_MESSAGE, path: url });
  }
  if (!response.ok) {
    let message = '';
    try {
      const body = (await response.json()) as { error?: { message?: unknown } | string; message?: unknown };
      const error = body.error;
      message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
    } catch {
      // not JSON
    }
    throw new ApiError({
      status: response.status,
      code: response.status === 404 ? 'not_found' : 'internal',
      message: message || (response.status >= 500 ? 'The file could not be made right now. Please try again.' : 'That download is not available.'),
      path: url,
    });
  }
  const blob = await response.blob();
  saveBlob(blob, fileNameFromDisposition(response.headers.get('Content-Disposition')) ?? fallbackName);
}
