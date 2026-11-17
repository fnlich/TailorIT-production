'use client';

import type { BulletsTask } from '@tailorit/shared/resume';
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { entryBulletsRequest } from '../ai/bulletsRequest';
import { useBulletsAi } from '../ai/useBulletsAi';
import type { EditorSession } from '../workspace/useEditorSession';
import { AddSectionDialog } from './AddSectionDialog';
import { boxOf, elementOf, pageOf, sectionBoxes, sectionElement, selectionAt, wantsSettingsHint, type Box } from './dom';
import { EntryDrag } from './EntryDrag';
import { EntryToolbar } from './EntryToolbar';
import { HeaderToolbar } from './HeaderToolbar';
import { FloatingBar, Outline, TOOLBAR_SHORTCUT } from './parts';
import { SectionPlus } from './SectionPlus';
import { SectionToolbar } from './SectionToolbar';
import { sameSelection, sectionOfSelection, selectionKey, skillGroupOf, type Selection } from './selection';
import { entryTools, headerTools, sectionTools } from './tools';
import { useFocusQueue, useToolbarCommands } from './useToolbarCommands';

/**
 * The editor's toolbars over the page (the entry, section and header toolbars, the green "+" and the Add section
 * dialog), drawn outside the clipped pages and placed from the page's own data attributes.
 *
 * A click or the caret inside an entry selects the entry, inside a section's title (or its summary, its skills) the
 * section, inside the header the header; Escape on the page or a click outside it clears the selection. The selected
 * section is outlined and the rest of the page dimmed, by opacity only, so nothing on the page moves. The outlines,
 * the bars and the "+" lie on a layer over the page and follow it as it reflows (a mutation or resize re-measures it
 * once a frame). Alt+F10 moves focus from the page to the bar; Escape in the bar goes back to the field.
 */

export interface EditorToolbarsProps {
  session: EditorSession;
  canvas: RefObject<HTMLDivElement | null>;
  /** Rearrange... in the section toolbar (the Rearrange dialog); nothing happens without it. */
  onRearrange?: () => void;
}

interface Frames {
  /** The canvas's width. */
  width: number;
  selected: { anchor: Box; outline: Box[] } | null;
  /** The section of the selected entry. */
  section: Box[] | null;
  hover: Box[] | null;
  /** Where the green "+" sits: under the last box of this section. */
  plus: { ref: string; x: number; y: number } | null;
}

/** Clicks inside these (a picker, a menu, another bar) do not clear the selection. */
const KEEP_SELECTION = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="toolbar"]';
const SAFE_REF = /^[A-Za-z0-9_:-]+$/;
const DIM = 'opacity:.55';

/** The page CSS for a selection: everything but the selected section (or the header) a little faded. */
function dimCss(selection: Selection | null): string {
  const fade =
    '[data-resume-canvas] [data-rt-section],[data-resume-canvas] [data-rt-box="header"]{transition:opacity .15s ease-out}';
  if (!selection) return fade;
  if (selection.type === 'header') return `${fade}[data-resume-canvas] [data-rt-section]{${DIM}}`;
  if (!SAFE_REF.test(selection.ref)) return fade;
  return (
    `${fade}[data-resume-canvas] [data-rt-section]:not([data-rt-section="${selection.ref}"]),` +
    `[data-resume-canvas] [data-rt-box="header"]{${DIM}}`
  );
}

const sameFrames = (a: Frames | null, b: Frames) => a !== null && JSON.stringify(a) === JSON.stringify(b);

export function EditorToolbars({ session, canvas, onRearrange }: EditorToolbarsProps) {
  const document = session.document;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [hover, setHover] = useState<Selection | null>(null);
  const [frames, setFrames] = useState<Frames | null>(null);
  /** The section whose "+" menu is open or closing: its "+" stays until the menu has closed and focus moved on. */
  const [plusMenu, setPlusMenu] = useState<{ ref: string; open: boolean } | null>(null);
  const plusOpen = plusMenu?.ref ?? null;
  const [adding, setAdding] = useState<{ open: boolean; afterRef: string | null }>({ open: false, afterRef: null });
  /** Backspace in an empty field: the Settings of the entry or header it was in (by selection key) show where. */
  const [hint, setHint] = useState<{ key: string; count: number } | null>(null);
  const layer = useRef<HTMLDivElement | null>(null);
  const lastField = useRef<HTMLElement | null>(null);
  const insidePress = useRef<Event | null>(null);
  const focus = useFocusQueue(canvas);
  const commands = useToolbarCommands(session, focus, canvas);
  const ai = useBulletsAi<{ path: string; task: BulletsTask }>((bullets, meta) =>
    commands.writeBullets(meta.path, bullets, meta.task),
  );

  // Selection and hover from the page; Escape and Alt+F10; a press outside the page and its bars clears it.
  useEffect(() => {
    const container = canvas.current;
    if (!container) return;
    const inLayer = (target: EventTarget | null) => target instanceof Node && Boolean(layer.current?.contains(target));
    const pick = (next: Selection | null) => setSelection((previous) => (sameSelection(previous, next) ? previous : next));

    const onPointerDown = (event: PointerEvent) => {
      if (inLayer(event.target) || !(event.target instanceof Element)) return;
      pick(selectionAt(event.target));
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (inLayer(target) || !(target instanceof HTMLElement)) return;
      if (target.hasAttribute('data-edit-path')) lastField.current = target;
      const next = selectionAt(target);
      if (next) pick(next);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (inLayer(event.target) || !(event.target instanceof Element)) return;
      const next = selectionAt(event.target);
      setHover((previous) => (sameSelection(previous, next) ? previous : next));
    };
    const onPointerLeave = () => setHover(null);
    const onWindowPointerDown = (event: PointerEvent) => {
      // A press inside the toolbars' own popovers and dialog (portalled out of the canvas) reached them first.
      if (insidePress.current === event) return;
      const target = event.target;
      if (target instanceof Node && container.contains(target)) return;
      if (target instanceof Element && target.closest(KEEP_SELECTION)) return;
      setSelection(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const inPage = target instanceof Node && Boolean(pageOf(container)?.contains(target));
      if (event.key === 'Escape' && inPage && !event.defaultPrevented) {
        setSelection(null);
        return;
      }
      if (event.key === 'Backspace' && inPage && target instanceof HTMLElement && wantsSettingsHint(target)) {
        const at = selectionAt(target);
        if (at?.type === 'entry' || at?.type === 'header') {
          setHint((previous) => ({ key: selectionKey(at), count: (previous?.count ?? 0) + 1 }));
        }
        return;
      }
      if (event.key === 'F10' && event.altKey) {
        const bar = layer.current?.querySelector('[data-editor-toolbar]');
        const item = bar?.querySelector<HTMLElement>('button:not([tabindex="-1"])') ?? bar?.querySelector<HTMLElement>('button');
        if (!item) return;
        event.preventDefault();
        item.focus();
      }
    };

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('focusin', onFocusIn);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerleave', onPointerLeave);
    window.addEventListener('pointerdown', onWindowPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('pointerdown', onWindowPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [canvas]);

  // Measuring reads the latest selection, hover and open "+" (it runs a frame after they change).
  const latest = useRef({ selection, hover, plusOpen });
  useEffect(() => {
    latest.current = { selection, hover, plusOpen };
  });

  // The page reflows on its own (a page break moves, a font arrives): it is measured again once a frame after any
  // change, and after the selection, the hover or the document changed.
  const schedule = useRef<() => void>(() => undefined);
  useEffect(() => {
    const container = canvas.current;
    const page = container ? pageOf(container) : null;
    if (!container || !page) return;
    let frame = 0;

    const measure = () => {
      const origin = container.getBoundingClientRect();
      const { selection: chosen, hover: hovered, plusOpen: openFor } = latest.current;
      let selected: Frames['selected'] = null;
      if (chosen) {
        const element = elementOf(page, chosen);
        if (!element) {
          // The entry or section went (deleted, or the empty row became an entry): nothing is selected any more.
          setSelection((current) => (current === chosen ? null : current));
        } else if (chosen.type === 'section') {
          const outline = sectionBoxes(element, origin);
          selected = outline[0] ? { anchor: outline[0], outline } : null;
        } else {
          const box = boxOf(element.getBoundingClientRect(), origin);
          selected = { anchor: box, outline: [box] };
        }
      }
      const around = chosen?.type === 'entry' ? sectionElement(page, chosen.ref) : null;
      let hoverBoxes: Box[] | null = null;
      if (hovered && !sameSelection(hovered, chosen)) {
        const element = elementOf(page, hovered);
        if (element) {
          hoverBoxes = hovered.type === 'section' ? sectionBoxes(element, origin) : [boxOf(element.getBoundingClientRect(), origin)];
        }
      }
      const plusRef = openFor ?? sectionOfSelection(hovered) ?? sectionOfSelection(chosen);
      const plusSection = plusRef ? sectionElement(page, plusRef) : null;
      const last = plusSection ? sectionBoxes(plusSection, origin).at(-1) : undefined;
      const next: Frames = {
        width: origin.width,
        selected,
        section: around ? sectionBoxes(around, origin) : null,
        hover: hoverBoxes,
        plus: plusRef && last ? { ref: plusRef, x: last.left + last.width / 2, y: last.top + last.height + 6 } : null,
      };
      setFrames((previous) => (sameFrames(previous, next) ? previous : next));
    };
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    schedule.current = later;

    const mutations = new MutationObserver(later);
    mutations.observe(page, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style'] });
    const sizes = new ResizeObserver(later);
    sizes.observe(container);
    window.addEventListener('resize', later);
    window.document.fonts?.addEventListener('loadingdone', later);
    later();
    return () => {
      schedule.current = () => undefined;
      mutations.disconnect();
      sizes.disconnect();
      window.removeEventListener('resize', later);
      window.document.fonts?.removeEventListener('loadingdone', later);
      cancelAnimationFrame(frame);
    };
  }, [canvas]);

  useEffect(() => {
    schedule.current();
  }, [selection, hover, plusOpen, document]);

  const { store } = session;
  const currentDocument = useCallback(() => store.getState().document, [store]);

  const backToPage = () => {
    const field = lastField.current;
    if (field?.isConnected) field.focus();
  };

  const entry = selection?.type === 'entry' ? entryTools(document, selection.path) : null;
  const section = selection?.type === 'section' ? sectionTools(document, selection.ref) : null;
  const header = selection?.type === 'header' ? headerTools(document) : null;
  const plus = frames?.plus ? sectionTools(document, frames.plus.ref) : null;
  const group = skillGroupOf(selection);

  // A hint belongs to the entry or header it was given in: another selection drops it, so it never shows again later.
  const selected = selectionKey(selection);
  if (hint && hint.key !== selected) setHint(null);
  const settingsHint = hint?.key === selected ? hint.count : 0;
  // Said once per Backspace too, for whoever cannot see the bar; only where there is a Settings to point at.
  const pointing = settingsHint > 0 && (entry ? entry.toggles.length > 0 : header !== null);
  const { announce } = session;
  useEffect(() => {
    if (pointing) announce(`Empty field. Settings in its toolbar (${TOOLBAR_SHORTCUT}) can hide it.`);
  }, [settingsHint, pointing, announce]);

  let bar: ReactNode = null;
  if (entry) {
    bar = (
      <EntryToolbar
        key={entry.path}
        tools={entry}
        currentDocument={currentDocument}
        commands={commands}
        ai={ai}
        settingsHint={settingsHint}
        onAsk={(task, note) => {
          const request = entry.ai ? entryBulletsRequest(currentDocument(), entry.path, entry.ai, task, note) : null;
          if (request) void ai.ask(request, { path: entry.path, task });
        }}
        onEscape={backToPage}
      />
    );
  } else if (section) {
    bar = (
      <SectionToolbar
        key={section.ref}
        tools={section}
        commands={commands}
        skillList={group !== null && (document.skillCategories?.length ?? 0) > group ? `skillCategories.${group}.skills` : 'skills'}
        onRearrange={onRearrange}
        onEscape={backToPage}
      />
    );
  } else if (header) {
    bar = <HeaderToolbar tools={header} commands={commands} settingsHint={settingsHint} onEscape={backToPage} />;
  }

  return (
    <div
      ref={layer}
      className="pointer-events-none absolute inset-0 z-20"
      data-editor-toolbars=""
      onPointerDownCapture={(event) => {
        insidePress.current = event.nativeEvent;
      }}
    >
      <style>{dimCss(selection)}</style>
      {frames?.hover?.map((box, index) => <Outline key={`hover:${index}`} box={box} tone="hover" />)}
      {frames?.section?.map((box, index) => <Outline key={`section:${index}`} box={box} tone="section" />)}
      {frames?.selected?.outline.map((box, index) => (
        <Outline key={`selected:${index}`} box={box} tone="selected" />
      ))}
      {frames?.selected && entry && !entry.placeholder && entry.count > 1 ? (
        <EntryDrag key={entry.path} canvas={canvas} tools={entry} anchor={frames.selected.anchor} commands={commands} />
      ) : null}
      {frames?.selected && bar ? (
        <FloatingBar key={selectionKey(selection)} anchor={frames.selected.anchor} bounds={frames.width}>
          {bar}
        </FloatingBar>
      ) : null}
      {frames?.plus && plus ? (
        <SectionPlus
          key={plus.ref}
          name={plus.name}
          canAddEntry={plus.adds.includes('entry')}
          at={frames.plus}
          open={plusMenu?.ref === plus.ref && plusMenu.open}
          onOpenChange={(open) => setPlusMenu({ ref: plus.ref, open })}
          onNewEntry={() => {
            const list = plus.list;
            if (!list) return;
            if (plus.lastId) commands.addEntry(list, plus.lastId, { later: true });
            else commands.focus({ kind: 'entry', path: `${list}.new` }, { later: true });
          }}
          onNewSection={() => setAdding({ open: true, afterRef: plus.ref })}
          onClosed={() => {
            setPlusMenu(null);
            focus.flush();
          }}
        />
      ) : null}
      <AddSectionDialog
        open={adding.open}
        onOpenChange={(open) => setAdding((current) => ({ ...current, open }))}
        document={document}
        onAdd={(ref) => commands.addSection(ref, adding.afterRef)}
        onAddCustom={(title, fields) => commands.addCustomSection(title, fields, adding.afterRef)}
        onClosed={focus.flush}
      />
    </div>
  );
}
