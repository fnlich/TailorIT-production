'use client';

import { clsx } from 'clsx';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { isSafeInlineHref } from '@tailorit/shared';
import { Z_FLOATING } from '@/components/ui/styles';

// Enhancv's formatting popup: select words in a description, a bullet or the summary, and B, I, U and Link appear
// above them. The browser's own editing commands do the work, so the field reports the change like any typing (and
// reads back only bold, italic, underline and a safe link). A link is http(s) or mailto; "www.x.com" becomes https.

interface Anchor {
  /** Where the popup sits: above the selection, in page coordinates. */
  top: number;
  left: number;
  field: HTMLElement;
}

/** The rich field holding the whole current selection, or null. */
function richFieldOfSelection(): { field: HTMLElement; range: Range } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const holder = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('.rt-rich.rt-edit');
  const field = holder(range.startContainer);
  if (!field || field !== holder(range.endContainer) || !field.closest('[data-resume-canvas]')) return null;
  return { field, range };
}

function linkOf(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  const url = /^(?:https?:\/\/|mailto:)/i.test(value) ? value : value.includes('@') && !value.includes('/') ? `mailto:${value}` : `https://${value}`;
  return isSafeInlineHref(url) ? url : null;
}

const active = (command: string) => {
  try {
    return document.queryCommandState(command);
  } catch {
    return false;
  }
};

export function FormatPopup() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [linking, setLinking] = useState(false);
  const [href, setHref] = useState('');
  const [, redraw] = useState(0);
  const saved = useRef<Range | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);

  // Like any selection bubble, it comes up when a selection is made (the mouse let go, or Shift and the arrows), and
  // goes at the next key that is not a formatting one, a press anywhere else, or once nothing is selected. So it never
  // sits over the page after the words are typed over or an undo has taken the selection's text back.
  useEffect(() => {
    if (linking) return;
    const show = () => {
      const found = richFieldOfSelection();
      if (!found) {
        setAnchor(null);
        return;
      }
      const rect = found.range.getBoundingClientRect();
      setAnchor({ top: rect.top + window.scrollY - 8, left: rect.left + window.scrollX + rect.width / 2, field: found.field });
      redraw((count) => count + 1);
    };
    const onPointerUp = () => window.setTimeout(show, 0);
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift' || (event.shiftKey && event.key.startsWith('Arrow'))) show();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const formatting = (event.ctrlKey || event.metaKey) && ['b', 'i', 'u'].includes(event.key.toLowerCase());
      if (formatting) {
        window.setTimeout(() => redraw((count) => count + 1), 0);
        return;
      }
      if (!['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) setAnchor(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node)) setAnchor(null);
    };
    const onSelection = () => {
      if (!richFieldOfSelection()) setAnchor(null);
    };
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('selectionchange', onSelection);
    return () => {
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('selectionchange', onSelection);
    };
  }, [linking]);

  if (!anchor) return null;

  const run = (command: string, value?: string) => {
    document.execCommand(command, false, value);
    redraw((count) => count + 1);
  };
  const startLink = () => {
    const selection = window.getSelection();
    saved.current = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
    const current = (saved.current?.startContainer.parentElement?.closest('a') as HTMLAnchorElement | null)?.getAttribute('href');
    setHref(current ?? '');
    setLinking(true);
  };
  const restore = () => {
    const selection = window.getSelection();
    if (!selection || !saved.current) return;
    anchor.field.focus({ preventScroll: true });
    selection.removeAllRanges();
    selection.addRange(saved.current);
  };
  const applyLink = (event: FormEvent) => {
    event.preventDefault();
    const url = linkOf(href);
    restore();
    if (url) run('createLink', url);
    setLinking(false);
  };
  const removeLink = () => {
    restore();
    run('unlink');
    setLinking(false);
  };

  const button = (label: string, pressed: boolean, onPress: () => void, content: ReactNode) => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      // Keep the words selected: the press must not move the focus out of the field.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPress}
      className={clsx('flex h-8 min-w-8 items-center justify-center rounded-control px-2 text-sm', pressed ? 'bg-primary-soft text-primary-ink' : 'text-foreground hover:bg-hover')}
    >
      {content}
    </button>
  );

  return (
    <div
      ref={popup}
      role="toolbar"
      aria-label="Text formatting"
      className={clsx(Z_FLOATING, 'absolute flex -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-popup border border-border bg-surface p-1 shadow-popover')}
      style={{ top: anchor.top, left: anchor.left }}
    >
      {linking ? (
        <form className="flex items-center gap-1" onSubmit={applyLink}>
          <input
            autoFocus
            aria-label="Link address"
            placeholder="https://"
            value={href}
            onChange={(event) => setHref(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                restore();
                setLinking(false);
              }
            }}
            className="h-8 w-56 rounded-control border border-border-strong bg-surface px-2 text-sm outline-none focus:border-primary focus:shadow-focus"
          />
          <button type="submit" className="h-8 rounded-control bg-primary px-3 text-sm font-medium text-on-primary hover:bg-primary-hover">
            Apply
          </button>
          <button type="button" className="h-8 rounded-control px-2 text-sm text-muted-foreground hover:bg-hover" onClick={removeLink}>
            Remove
          </button>
        </form>
      ) : (
        <>
          {button('Bold (Ctrl+B)', active('bold'), () => run('bold'), <b>B</b>)}
          {button('Italic (Ctrl+I)', active('italic'), () => run('italic'), <i className="font-serif">I</i>)}
          {button('Underline (Ctrl+U)', active('underline'), () => run('underline'), <u>U</u>)}
          {button('Link', false, startLink, <span className="text-[13px]">Link</span>)}
        </>
      )}
    </div>
  );
}
