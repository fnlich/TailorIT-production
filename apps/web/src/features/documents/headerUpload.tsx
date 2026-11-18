'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { UploadSimpleIcon } from '@/components/ui/icons';

/*
 * v31 FIX-DOCS: the page header's Upload. Documents shows one section at a time (Resumes, Cover letters, Templates),
 * and each uploads its own way (the resume upload dialog; a letter or template file opened in its editor). Each
 * section registers what Upload does under its own name; the header's button runs the shown section's. (Keyed by
 * section: the section left behind may unmount after the next one registered, and must not clear it.) Its accessible
 * name stays "Upload" ("Uploading..." while a file is sent).
 */

export interface UploadAction {
  run: () => void;
  busy: boolean;
}

type Register = (section: string, action: UploadAction | null) => void;

const RegisterContext = createContext<Register | null>(null);

/** Every section's Upload: `register` goes to the sections (provider), `actions[section]` to the header button. */
export function useHeaderUploadState(): { actions: Readonly<Record<string, UploadAction>>; register: Register } {
  const [actions, setActions] = useState<Readonly<Record<string, UploadAction>>>({});
  const register = useCallback<Register>((section, action) => {
    setActions((current) => {
      if (action) return { ...current, [section]: action };
      if (!(section in current)) return current;
      const next = { ...current };
      delete next[section];
      return next;
    });
  }, []);
  return { actions, register };
}

export function HeaderUploadProvider({ register, children }: { register: Register; children: ReactNode }) {
  return <RegisterContext.Provider value={register}>{children}</RegisterContext.Provider>;
}

/**
 * A section's Upload, registered under `section` while it is mounted. `run` may change every render (it is read when
 * pressed); `busy` shows on the header's button. Outside the Documents page (no provider) it does nothing.
 */
export function useRegisterUpload(section: string, run: () => void, busy = false): void {
  const register = useContext(RegisterContext);
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  });
  useEffect(() => {
    if (!register) return;
    register(section, { run: () => latest.current(), busy });
  }, [register, section, busy]);
  useEffect(() => {
    if (!register) return;
    return () => register(section, null);
  }, [register, section]);
}

/** The header's outline Upload button: the shown section's upload (disabled until that section registered one). */
export function HeaderUploadButton({ action }: { action: UploadAction | null | undefined }) {
  return (
    <Button
      variant="outline"
      icon={<UploadSimpleIcon size={16} />}
      loading={action?.busy ?? false}
      disabled={!action}
      onClick={() => action?.run()}
      data-header-upload=""
    >
      {action?.busy ? 'Uploading...' : 'Upload'}
    </Button>
  );
}
