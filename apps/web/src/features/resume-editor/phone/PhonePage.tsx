'use client';

import { clsx } from 'clsx';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button } from '@/components/ui/Button';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from '@/components/ui/icons';
import { boxOf, pageOf, type Box } from '../toolbars/dom';
import { entryTools, sectionName, sectionTools } from '../toolbars/tools';
import { useToolbarCommands } from '../toolbars/useToolbarCommands';
import type { EditorSession } from '../workspace/useEditorSession';
import { PartForm } from './forms';
import {
  entryAfter,
  livePart,
  partKey,
  partLabel,
  partOf,
  placeholderPath,
  sheetOf,
  type BoxAttributes,
  type PartSheet,
  type PhonePart,
  type SheetActionId,
} from './parts';
import { BottomSheet, SheetRow } from './sheets';
import { usePhoneFocus } from './usePhoneFocus';

/**
 * The page on a phone, Enhancv's way: nothing is typed on the tiny page. Each part of it (the header, a section's
 * title, an entry, a summary or a skills list) has a tap target over it; a tap opens the part's sheet (Edit, Move up,
 * Move down, Delete for an entry; Edit title, Add entry, the moves and Remove section for a title), and Edit opens
 * the part's full-screen form. The toolbars' own commands do the work, so the store, the Undo toast and the live
 * region behave as on a desktop. Focus goes into each sheet and form, and back to the part (or on to the next one,
 * when the part was deleted) once it has closed.
 */

interface TapTarget {
  key: string;
  part: PhonePart;
  box: Box;
  /** A title's copy on a later page: tappable, but not read out or tabbed to twice. */
  copy: boolean;
}

const ACTION_ICONS: Readonly<Record<SheetActionId, ReactNode>> = {
  edit: <PencilSimpleIcon size={18} />,
  editTitle: <PencilSimpleIcon size={18} />,
  addEntry: <PlusIcon size={18} />,
  moveUp: <ArrowUpIcon size={18} />,
  moveDown: <ArrowDownIcon size={18} />,
  delete: <TrashIcon size={18} />,
  removeSection: <TrashIcon size={18} />,
};

/** The parts the page draws now, where they are on the canvas (header first, then each column's boxes in order). */
function readTargets(container: HTMLElement): TapTarget[] {
  const page = pageOf(container);
  if (!page) return [];
  const origin = container.getBoundingClientRect();
  const out: TapTarget[] = [];
  const copies = new Map<string, number>();
  const add = (element: Element, attributes: BoxAttributes) => {
    const part = partOf(attributes);
    const rect = element.getBoundingClientRect();
    if (!part || (rect.width === 0 && rect.height === 0)) return;
    const key = partKey(part);
    const copy = element.classList.contains('rt-repeat');
    const count = copies.get(key) ?? 0;
    if (copy) copies.set(key, count + 1);
    out.push({ key: copy ? `${key}#${count + 1}` : key, part, box: boxOf(rect, origin), copy });
  };
  const header = page.querySelector('[data-rt-box="header"]');
  if (header) add(header, { box: 'header', entry: null, section: null });
  for (const section of page.querySelectorAll('[data-rt-section]')) {
    const ref = section.getAttribute('data-rt-section');
    for (const child of Array.from(section.children)) {
      if (!child.classList.contains('rt-box')) continue;
      const box = child.getAttribute('data-rt-box');
      // An entry box is one entry; a row of short entries is one per cell.
      const cells = child.hasAttribute('data-rt-entry') ? [child] : Array.from(child.querySelectorAll('[data-rt-entry]'));
      if (cells.length === 0) add(child, { box, entry: null, section: ref });
      for (const cell of cells) add(cell, { box, entry: cell.getAttribute('data-rt-entry'), section: ref });
    }
  }
  return out;
}

const sameTargets = (a: TapTarget[], b: TapTarget[]) => JSON.stringify(a) === JSON.stringify(b);

/** The tap targets, measured again once a frame after the page changes (a reflow, a font, the window). */
function useTapTargets(canvas: RefObject<HTMLElement | null>): TapTarget[] {
  const [targets, setTargets] = useState<TapTarget[]>([]);
  useEffect(() => {
    const container = canvas.current;
    const page = container ? pageOf(container) : null;
    if (!container || !page) return;
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = readTargets(container);
        setTargets((previous) => (sameTargets(previous, next) ? previous : next));
      });
    };
    const mutations = new MutationObserver(later);
    mutations.observe(page, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['style'],
    });
    const sizes = new ResizeObserver(later);
    sizes.observe(container);
    window.addEventListener('resize', later);
    window.document.fonts?.addEventListener('loadingdone', later);
    later();
    return () => {
      mutations.disconnect();
      sizes.disconnect();
      window.removeEventListener('resize', later);
      window.document.fonts?.removeEventListener('loadingdone', later);
      cancelAnimationFrame(frame);
    };
  }, [canvas]);
  return targets;
}

const entryPartOf = (path: string) => partOf({ box: null, entry: path, section: null });

export function PhonePage({ session, canvas }: { session: EditorSession; canvas: RefObject<HTMLDivElement | null> }) {
  const document = session.document;
  const store = session.store;
  const focus = usePhoneFocus(canvas);
  const commands = useToolbarCommands(session, focus, canvas);
  const targets = useTapTargets(canvas);
  // What the sheet shows is taken when it opens (and when Delete asks), so it stays the same while it slides away.
  const [sheet, setSheet] = useState<{
    part: PhonePart;
    open: boolean;
    content: PartSheet;
    /** Delete is asking first: the line under "Delete ...?". */
    confirm: string | null;
  } | null>(null);
  const [form, setForm] = useState<{ part: PhonePart; open: boolean } | null>(null);
  /** The form to open once the sheet has gone (Edit, Edit title, Add entry). */
  const then = useRef<PhonePart | null>(null);

  /** Focus after a sheet or form has closed: where a command asked, else back to the part (as it is now). */
  const settle = (part: PhonePart) => {
    if (focus.pending()) {
      focus.flush();
      return;
    }
    const live = livePart(store.getState().document, part);
    if (live) focus.toPart(live);
  };
  const closeSheet = () => setSheet((current) => (current ? { ...current, open: false } : current));

  const act = (part: PhonePart, id: SheetActionId) => {
    const current = store.getState().document;
    if (id === 'delete') {
      const tools = part.type === 'entry' ? entryTools(current, part.path) : null;
      if (!tools) return;
      const section = sectionName(current, tools.ref);
      const line =
        tools.count === 1
          ? `It is the only entry, so the ${section} section leaves the page too. Undo brings both back.`
          : 'Undo brings it back.';
      setSheet((open) => (open ? { ...open, confirm: line } : open));
      return;
    }
    const delta = id === 'moveUp' ? -1 : 1;
    if (id === 'edit') then.current = part;
    else if (id === 'editTitle' && part.type === 'title') then.current = part;
    else if ((id === 'moveUp' || id === 'moveDown') && part.type === 'entry') {
      const tools = entryTools(current, part.path);
      if (tools) commands.moveEntry(tools, delta);
    } else if ((id === 'moveUp' || id === 'moveDown') && part.type === 'title') {
      // Said as an entry's move is: "Moved up, 2 of 4".
      const result = store.moveSection(part.ref, delta);
      const where = `${result.index + 1} of ${result.count}`;
      if (result.index >= 0) session.announce(`Moved ${delta < 0 ? 'up' : 'down'}, ${where}`);
    } else if (id === 'addEntry' && part.type === 'title') {
      const tools = sectionTools(current, part.ref);
      if (tools?.list && tools.lastId) {
        commands.addEntry(tools.list, tools.lastId);
        const added = entryAfter(store.getState().document, part.ref, tools.lastId);
        then.current = added ? entryPartOf(added) : null;
      } else if (tools?.list) {
        // A section with no entries shows its empty row: the form opens on that.
        then.current = entryPartOf(placeholderPath(tools.list));
      }
    } else if (id === 'removeSection' && part.type === 'title') {
      commands.removeSection(part.ref);
    }
    closeSheet();
  };

  const remove = (part: PhonePart) => {
    const tools = part.type === 'entry' ? entryTools(store.getState().document, part.path) : null;
    if (tools) commands.removeEntry(tools);
    closeSheet();
  };

  const openSheet = (part: PhonePart) => {
    const content = sheetOf(store.getState().document, part);
    if (content) setSheet({ part, open: true, content, confirm: null });
  };
  const active = sheet?.open ? partKey(sheet.part) : null;

  return (
    <>
      <div className="pointer-events-none absolute inset-0 z-10" data-phone-parts="">
        {targets.map((target) => (
          <button
            key={target.key}
            type="button"
            data-phone-part={target.copy ? undefined : target.key}
            aria-label={partLabel(document, target.part)}
            aria-haspopup="dialog"
            aria-hidden={target.copy ? true : undefined}
            tabIndex={target.copy ? -1 : undefined}
            className={clsx(
              'pointer-events-auto absolute rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-primary',
              active === target.key ? 'bg-primary/[0.07] ring-2 ring-primary/50' : 'active:bg-primary/[0.07]',
            )}
            style={{ left: target.box.left, top: target.box.top, width: target.box.width, height: target.box.height }}
            onClick={() => openSheet(target.part)}
          />
        ))}
      </div>
      {sheet ? (
        <BottomSheet
          open={sheet.open}
          onOpenChange={(open) => {
            if (!open) closeSheet();
          }}
          onClosed={() => {
            const next = then.current;
            then.current = null;
            setSheet(null);
            if (next) setForm({ part: next, open: true });
            else settle(sheet.part);
          }}
          title={sheet.confirm ? `Delete ${sheet.content.title}?` : sheet.content.title}
          description={sheet.confirm ? sheet.confirm : sheet.content.description}
        >
          {sheet.confirm ? (
            <div className="flex flex-col gap-2 px-3 pt-1">
              <Button variant="destructive" size="lg" fullWidth onClick={() => remove(sheet.part)}>
                Delete
              </Button>
              <Button
                variant="outline"
                size="lg"
                fullWidth
                // The rows it replaced held focus: it lands on the safe choice.
                autoFocus
                onClick={() => setSheet((open) => (open ? { ...open, confirm: null } : open))}
              >
                Cancel
              </Button>
            </div>
          ) : (
            sheet.content.actions.map((action) => (
              <SheetRow
                key={action.id}
                icon={ACTION_ICONS[action.id]}
                destructive={action.destructive}
                disabled={action.disabled}
                onClick={() => act(sheet.part, action.id)}
              >
                {action.label}
              </SheetRow>
            ))
          )}
        </BottomSheet>
      ) : null}
      {form ? (
        <PartForm
          key={partKey(form.part)}
          part={form.part}
          open={form.open}
          onOpenChange={(open) => setForm((current) => (current ? { ...current, open } : current))}
          onClosed={() => {
            setForm(null);
            settle(form.part);
          }}
          session={session}
          commands={commands}
        />
      ) : null}
    </>
  );
}
