'use client';

import { editorCopyFor, type RoleEditorCopy, type RoleFamilyId } from '@tailorit/shared/roles';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useResumeField } from './hooks';

// v33 ROLES (F4): the open resume's field, for the editor's words (the skills label and "?", the boxes' examples), the
// Templates panel's order and its Field select. Outside a provider (or until the field is known) the words are v3.2's,
// the technical family's.

export interface EditorField {
  /** The open resume (null: a new resume not saved yet). */
  resumeId: string | null;
  /** Its field; null until known. */
  familyId: RoleFamilyId | null;
  copy: RoleEditorCopy;
}

const DEFAULT_FIELD: EditorField = { resumeId: null, familyId: null, copy: editorCopyFor(null) };
const EditorFieldContext = createContext<EditorField>(DEFAULT_FIELD);

/** Gives the editor below it the field of `resumeId`. */
export function EditorFieldProvider({ resumeId, children }: { resumeId: string | null; children: ReactNode }) {
  const field = useResumeField(resumeId);
  const familyId = field.data?.familyId ?? null;
  const value = useMemo<EditorField>(() => ({ resumeId, familyId, copy: editorCopyFor(familyId) }), [resumeId, familyId]);
  return <EditorFieldContext.Provider value={value}>{children}</EditorFieldContext.Provider>;
}

/** The open resume's field and the editor's words for it. */
export function useEditorField(): EditorField {
  return useContext(EditorFieldContext);
}
