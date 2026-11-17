'use client';

import {
  MAX_RESUME_CUSTOM_SECTIONS,
  MAX_RESUME_SECTION_ENTRIES,
  type HeaderField,
  type HeaderPhotoShape,
  type SectionOptions,
} from '@tailorit/shared/resume';
import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useToast } from '@/components/ui/Toast';
import { usePublicConstants } from '@/lib/constants';
import type { EditorSession } from '../workspace/useEditorSession';
import {
  caretInto,
  entryPathsIn,
  fieldAt,
  firstEntryField,
  firstSectionField,
  pageOf,
  sectionRefsOnPage,
} from './dom';
import { entryTools, sectionName, type EntryTools } from './tools';

// What the toolbars do, as one call each: the store action (one undo step, named after what it changed), a line for
// the live region, an Undo toast for a removal, and where the caret goes next. The caret is put into a field only once
// the page shows it; after a menu or a dialog it waits until that has closed and handed focus back.

export type FocusTarget =
  | { kind: 'entry'; path: string }
  | { kind: 'section'; ref: string }
  | { kind: 'field'; path: string };

export interface FocusQueue {
  /** The caret goes to `target` once the page shows it; with `later`, only after `flush` (a menu or dialog closed). */
  request(target: FocusTarget, options?: { later?: boolean }): void;
  flush(): void;
}

/** Frames to wait for a field before giving up (a page break can move it a frame or two later). */
const FOCUS_TRIES = 20;

export function useFocusQueue(canvas: RefObject<HTMLElement | null>): FocusQueue {
  const pending = useRef<{ target: FocusTarget; ready: boolean; tries: number } | null>(null);
  const frame = useRef(0);

  const attempt = useCallback(
    function attempt() {
      const queued = pending.current;
      const page = canvas.current ? pageOf(canvas.current) : null;
      if (!queued || !queued.ready || !page) return;
      const { target } = queued;
      const field =
        target.kind === 'entry'
          ? firstEntryField(page, target.path)
          : target.kind === 'section'
            ? firstSectionField(page, target.ref)
            : fieldAt(page, target.path);
      if (field) {
        pending.current = null;
        caretInto(field);
        return;
      }
      queued.tries += 1;
      if (queued.tries > FOCUS_TRIES) {
        pending.current = null;
        return;
      }
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(attempt);
    },
    [canvas],
  );

  // After every render: the page may just have drawn the field.
  useLayoutEffect(() => {
    attempt();
  });
  useLayoutEffect(() => {
    const frames = frame;
    return () => cancelAnimationFrame(frames.current);
  }, []);

  return useMemo(
    () => ({
      request(target, options = {}) {
        pending.current = { target, ready: !options.later, tries: 0 };
        if (!options.later) {
          cancelAnimationFrame(frame.current);
          frame.current = requestAnimationFrame(attempt);
        }
      },
      flush() {
        if (!pending.current) return;
        pending.current.ready = true;
        attempt();
      },
    }),
    [attempt],
  );
}

/** "Show company" read out as "Company". */
const toggleName = (label: string) => {
  const name = label.replace(/^Show /, '');
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
};

export function useToolbarCommands(session: EditorSession, focus: FocusQueue, canvas: RefObject<HTMLElement | null>) {
  const toast = useToast();
  const { t } = usePublicConstants();
  const { store, undo, announce, bridge } = session;

  return useMemo(() => {
    const page = () => (canvas.current ? pageOf(canvas.current) : null);
    const current = () => store.getState().document;

    /** A toast whose Undo takes the step back, while it is still the last change made. */
    const undoable = (title: string, description?: string) => {
      const after = current();
      const id = toast.toast({
        title,
        description,
        type: 'success',
        action: {
          label: 'Undo',
          onClick() {
            toast.dismiss(id);
            if (current() === after) undo();
            else toast.info('Something changed since', 'Use Undo in the bar to step back.');
          },
        },
      });
    };

    /** The section after `ref` on the page, else the one before it. */
    const neighbourSection = (ref: string) => {
      const root = page();
      const refs = root ? sectionRefsOnPage(root) : [];
      const at = refs.indexOf(ref);
      return at < 0 ? null : (refs[at + 1] ?? refs[at - 1] ?? null);
    };

    /** Where the caret goes once `ref` (or an entry in it) is gone. */
    const focusAfterSection = (ref: string, neighbour: string | null) => {
      if (neighbour && neighbour !== ref) focus.request({ kind: 'section', ref: neighbour });
      else focus.request({ kind: 'field', path: 'name' });
    };

    return {
      /** The caret into a field, an entry or a section once the page shows it. */
      focus(target: FocusTarget, options: { later?: boolean } = {}) {
        focus.request(target, options);
      },

      /** A new, empty entry after `afterId` (null: first; the empty row: after it), the caret in its first field. */
      addEntry(list: string, afterId: string | null, options: { later?: boolean } = {}) {
        const result = store.insertEntryAfter(list, afterId);
        if (result.capped) {
          toast.info(t('MSG_SECTION_ENTRIES_MAX', { max: MAX_RESUME_SECTION_ENTRIES }));
          return;
        }
        if (!result.path) return;
        announce('Entry added');
        focus.request({ kind: 'entry', path: result.path }, options);
      },

      moveEntry(tools: EntryTools, delta: -1 | 1) {
        const result = store.with({ label: `Moved ${tools.name}` }).moveEntry(tools.list, tools.id, delta);
        if (result.index < 0) return;
        announce(`Moved ${delta < 0 ? 'up' : 'down'}, ${result.index + 1} of ${result.count}`);
      },

      /** The entry dropped at `index` of its list (counted with it taken out). */
      moveEntryTo(tools: EntryTools, index: number) {
        if (index === tools.index) return;
        const result = store.with({ label: `Moved ${tools.name}` }).moveEntryTo(tools.list, tools.id, index);
        if (result.index < 0 || result.index === tools.index) return;
        announce(`Moved, ${result.index + 1} of ${result.count}`);
      },

      /** The entry removed (Undo toast); the section goes with its last entry, in the same step. */
      removeEntry(tools: EntryTools) {
        const root = page();
        const paths = root ? entryPathsIn(root, tools.ref) : [];
        const at = paths.indexOf(tools.path);
        const nextEntry = at < 0 ? null : (paths[at + 1] ?? paths[at - 1] ?? null);
        const section = sectionName(current(), tools.ref);
        const neighbour = neighbourSection(tools.ref);
        const emptied = store.batch(`Removed ${tools.name}`, () => {
          const result = store.removeEntry(tools.list, tools.id);
          if (result.emptied) store.disableSection(tools.ref);
          return result.emptied;
        });
        if (emptied) {
          announce(`Removed ${tools.name} and the ${section} section`);
          undoable(`Removed ${tools.name}`, `${section} had no other entry, so it is off the page too.`);
          focusAfterSection(tools.ref, neighbour);
        } else {
          announce(`Removed ${tools.name}`);
          undoable(`Removed ${tools.name}`);
          if (nextEntry) focus.request({ kind: 'entry', path: nextEntry });
          else focus.request({ kind: 'section', ref: tools.ref });
        }
      },

      /** One field of an entry shown or hidden (Settings). */
      setEntryField(tools: EntryTools, key: string, shown: boolean) {
        const toggle = tools.toggles.find((candidate) => candidate.key === key);
        if (!toggle) return;
        const hidden = shown ? tools.hidden.filter((other) => other !== key) : [...tools.hidden, key];
        store.with({ label: `${shown ? 'Showed' : 'Hid'} ${toggleName(toggle.label).toLowerCase()}` }).setEntryHidden(tools.path, hidden);
        announce(`${toggleName(toggle.label)} ${shown ? 'shown' : 'hidden'}`);
      },

      /** "Apply to all in this section": every entry of the list shows the fields this one shows. */
      applyFieldsToSection(tools: EntryTools) {
        const section = sectionName(current(), tools.ref);
        store.with({ label: `Applied the fields to every entry in ${section}` }).applyHiddenToSection(tools.list, tools.hidden);
        announce(`Every entry in ${section} shows the same fields now`);
      },

      /** Write with AI's answer: the entry's bullets replaced (shown, if they were hidden), one undo step. */
      writeBullets(path: string, bullets: readonly string[], task: 'write' | 'improve') {
        const done = store.batch('Wrote bullets with AI', () => {
          const tools = entryTools(current(), path);
          if (!tools) return false;
          if (tools.hidden.includes('bullets')) store.setEntryHidden(path, tools.hidden.filter((key) => key !== 'bullets'));
          store.replaceBullets(path, bullets);
          return true;
        });
        if (done) announce(task === 'improve' ? 'Bullets improved' : 'Bullets written');
      },

      /** A section switched off, its content kept (Undo toast; adding it again brings it back). */
      removeSection(ref: string) {
        const name = sectionName(current(), ref);
        const neighbour = neighbourSection(ref);
        store.with({ label: `Removed ${name}` }).disableSection(ref);
        announce(`Removed ${name}`);
        undoable(`Removed ${name}`, 'Its content is kept: add the section again to bring it back.');
        focusAfterSection(ref, neighbour);
      },

      /** A section switched on after `afterRef` (Summary goes first); the caret goes into it once the dialog closed. */
      addSection(ref: string, afterRef: string | null) {
        const name = sectionName(current(), ref);
        store.with({ label: `Added ${name}` }).addSection(ref, afterRef ? { afterRef } : {});
        announce(`Added ${name}`);
        focus.request({ kind: 'section', ref }, { later: true });
      },

      addCustomSection(title: string, fields: readonly string[], afterRef: string | null) {
        const result = store.addCustomSection(title, { fields, ...(afterRef ? { afterRef } : {}) });
        if (result.capped) {
          toast.info(t('MSG_CUSTOM_SECTIONS_MAX', { max: MAX_RESUME_CUSTOM_SECTIONS }));
          return;
        }
        if (!result.ref) return;
        announce(`Added ${sectionName(current(), result.ref)}`);
        focus.request({ kind: 'section', ref: result.ref }, { later: true });
      },

      /** A chip added to `list` (`skills`, `skillCategories.<n>.skills`, `softSkills`, `interests`); why not, if not. */
      addChip(list: string, name: string): 'duplicate' | 'capped' | 'blank' | null {
        const text = name.trim();
        if (!text) return 'blank';
        const result = store.addChip(list, text);
        if (result.duplicate) return 'duplicate';
        if (result.capped) return 'capped';
        if (!result.path) return 'blank';
        announce(`Added ${text}`);
        return null;
      },

      /**
       * A skill added to a role's "Skills used", and to Technical skills when they lack it (a skill used in a role is
       * one the resume claims): one undo step. Why not, if not.
       */
      addRoleSkill(tools: EntryTools, name: string): 'duplicate' | 'capped' | 'blank' | null {
        const text = name.trim();
        if (!text) return 'blank';
        const result = store.batch(`Added ${text}`, () => {
          const added = store.addChip(`${tools.list}.${tools.id}.skills`, text);
          if (added.path) store.addChip('skills', text);
          return added;
        });
        if (result.duplicate) return 'duplicate';
        if (result.capped) return 'capped';
        if (!result.path) return 'blank';
        announce(`Added ${text} to the skills used`);
        return null;
      },

      /** A skill taken off a role's "Skills used"; Technical skills keep it. */
      removeRoleSkill(tools: EntryTools, index: number) {
        const skill = tools.roleSkills?.[index];
        if (skill === undefined) return;
        store.removeChip(`${tools.list}.${tools.id}.skills.${index}`);
        announce(`Removed ${skill} from the skills used`);
      },

      /** A new skill group, its name shown, the caret in it. */
      addGroup() {
        const result = store.batch('Added a group', () => {
          const added = store.addGroup();
          const options = current().layout?.find((item) => item.ref === 'skills')?.options;
          if (options?.showGroupNames === false) store.setSectionOptions('skills', { showGroupNames: true });
          return added;
        });
        announce('Group added');
        focus.request({ kind: 'field', path: result.path });
      },

      setSectionOption(ref: string, patch: SectionOptions, said: string) {
        store.setSectionOptions(ref, patch);
        announce(said);
      },

      setUppercaseTitles(uppercase: boolean) {
        store.setUppercaseHeadings(uppercase);
        announce(uppercase ? 'Section titles in capitals' : 'Section titles as written');
      },

      setHeaderField(field: HeaderField, label: string, shown: boolean) {
        store.setHeaderHidden(field, !shown);
        announce(`${toggleName(label)} ${shown ? 'shown' : 'hidden'}`);
      },

      setUppercaseName(uppercase: boolean) {
        store.setUppercaseName(uppercase);
        announce(uppercase ? 'Name in capitals' : 'Name as written');
      },

      /** The years of experience as typed (typing in a row is one undo step). */
      setYears(years: number | null) {
        store.setYearsOfExperience(years);
      },

      /** The photo dialog (Add photo, Replace). */
      choosePhoto(anchor: HTMLElement) {
        bridge.openPhoto(anchor);
      },

      hidePhoto() {
        store.with({ label: 'Hid the photo' }).setPhoto(null);
        announce('Photo hidden');
        undoable('Photo hidden');
      },

      setPhotoShape(shape: HeaderPhotoShape) {
        store.setPhotoShape(shape);
        announce(shape === 'round' ? 'Round photo' : 'Square photo');
      },
    };
  }, [store, undo, announce, bridge, toast, t, focus, canvas]);
}

export type ToolbarCommands = ReturnType<typeof useToolbarCommands>;
