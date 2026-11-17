// What a downloaded resume is called: "First_Last_Resume.pdf" from the name on the resume, as Enhancv names its
// downloads, or "Resume.pdf" with no name. The Download dialog offers the stem for the person to change, and what they
// type is cleaned the same way, so every file name is safe on Windows, macOS and Linux.

export const RESUME_DOWNLOAD_EXTENSIONS = ['pdf', 'docx', 'txt'] as const;
export type ResumeDownloadExtension = (typeof RESUME_DOWNLOAD_EXTENSIONS)[number];

/** The longest stem kept, in characters. */
export const MAX_DOWNLOAD_STEM_LENGTH = 100;
const FALLBACK_STEM = 'Resume';

// Characters no file system takes (or takes badly), control characters and invisible format characters.
const UNSAFE = /[\\/:*?"<>|\p{Cc}\p{Cf}]/gu;
const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)$/i;

/** A typed file-name stem made safe: unsafe characters out, spaces as they are, no leading or trailing dots. */
export function cleanDownloadStem(value: string): string {
  const stem = value
    .normalize('NFC')
    .replace(UNSAFE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  const cut = Array.from(stem).slice(0, MAX_DOWNLOAD_STEM_LENGTH).join('').replace(/[.\s]+$/, '');
  return RESERVED.test(cut) ? `${cut}_` : cut;
}

/** "Maren_Kowalczyk-Hart_Resume": the name's words joined by underscores; "Resume" with no name. */
export function defaultResumeDownloadStem(name: unknown): string {
  const words = cleanDownloadStem(typeof name === 'string' ? name : '')
    .split(' ')
    .filter(Boolean);
  if (words.length === 0) return FALLBACK_STEM;
  return cleanDownloadStem(`${words.join('_')}_${FALLBACK_STEM}`);
}

/** The file name of a download: the stem the person chose (cleaned), else the default from the name on the resume. */
export function resumeDownloadFileName(
  document: { name?: unknown } | null | undefined,
  extension: ResumeDownloadExtension,
  stem?: string,
): string {
  const chosen = stem === undefined ? '' : cleanDownloadStem(stem);
  return `${chosen || defaultResumeDownloadStem(document?.name)}.${extension}`;
}
