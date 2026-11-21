'use client';

import { clsx } from 'clsx';
import { useLayoutEffect, useMemo, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { escapeInline, serializeInline } from '@tailorit/shared';
import { LEVEL_DOTS, type LevelSlotProps, type PhotoSlotProps, type RichTextSlotProps, type Slots, type TextSlotProps } from '@tailorit/resume-templates';
import { profileUrl } from '../../../lib/profile';
import { isBulletPath, isDatePath, useFieldBridge } from './bridge';
import { markupFromNodes, nodesFromRuns } from './richDom';

// The editable slots: the fields of the page itself. Each draws exactly the element its static slot draws (same tag,
// class and data attributes, no box styles of its own), so the page measures the same. A field is uncontrolled while
// the person types: the browser holds the text, the store hears every change, and the field is rewritten only when
// the store changes for another reason (an undo, another field's action), so the caret never jumps. Typing is drawn in
// the background, between keys, so a draw can land after more keys were typed: a draw older than the store at the
// field's path is not written into it (that would take those keys back and send the caret to the start); the draw
// that catches up writes whatever still differs.

/** Inserts plain text at the caret (fires `input`, so the change is reported like typing). */
function insertPlainText(text: string): void {
  document.execCommand('insertText', false, text);
}

function EditableText({ field, as: Tag = 'span', className }: TextSlotProps) {
  const bridge = useFieldBridge();
  const ref = useRef<HTMLElement | null>(null);
  const date = isDatePath(field.path);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || element.textContent === field.text || bridge.isBehind(field.path)) return;
    element.textContent = field.text;
  }, [bridge, field.path, field.text]);

  const shared = {
    className: clsx('rt-text', 'rt-edit', className),
    'data-edit-path': field.path,
    'data-placeholder': field.placeholder,
    'data-empty': field.text === '' ? '' : undefined,
  };
  if (date) {
    // A date is picked, not typed.
    return (
      <Tag
        ref={(element: HTMLElement | null) => {
          ref.current = element;
        }}
        {...shared}
        role="button"
        tabIndex={0}
        aria-label={`${field.placeholder}: ${field.text || 'not set'}`}
        aria-haspopup="dialog"
        onClick={(event) => bridge.openDate(field.path, event.currentTarget)}
        onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            bridge.openDate(field.path, event.currentTarget);
          }
        }}
      />
    );
  }
  return (
    <Tag
      ref={(element: HTMLElement | null) => {
        ref.current = element;
      }}
      {...shared}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      role="textbox"
      aria-label={field.placeholder}
      aria-placeholder={field.placeholder}
      spellCheck
      onFocus={() => bridge.focusField(field.path)}
      onInput={(event) => bridge.setText(field.path, (event.currentTarget.textContent ?? '').replace(/\n/g, ' '))}
      onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
        // One line: Enter does nothing in a name, a title or a company.
        if (event.key === 'Enter') event.preventDefault();
      }}
      onPaste={(event: ClipboardEvent<HTMLElement>) => {
        event.preventDefault();
        insertPlainText(event.clipboardData.getData('text/plain').replace(/\s*[\r\n]+\s*/g, ' '));
      }}
    />
  );
}

/** The field's markup on each side of the caret. */
function splitAtCaret(element: HTMLElement): [string, string] {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return [markupFromNodes(element), ''];
  const caret = selection.getRangeAt(0);
  const before = document.createRange();
  before.selectNodeContents(element);
  before.setEnd(caret.startContainer, caret.startOffset);
  const after = document.createRange();
  after.selectNodeContents(element);
  after.setStart(caret.endContainer, caret.endOffset);
  const markupOf = (range: Range) => {
    const holder = document.createElement('div');
    holder.append(range.cloneContents());
    return markupFromNodes(holder);
  };
  return [markupOf(before), markupOf(after)];
}

function RichTextField({ field, as: Tag = 'div', className }: RichTextSlotProps) {
  const bridge = useFieldBridge();
  const ref = useRef<HTMLElement | null>(null);
  const bullet = isBulletPath(field.path);
  const markup = useMemo(() => serializeInline(field.runs), [field.runs]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || markupFromNodes(element) === markup || bridge.isBehind(field.path)) return;
    element.replaceChildren(...nodesFromRuns(document, field.runs));
  }, [bridge, field.path, markup, field.runs]);

  return (
    <Tag
      ref={(element: HTMLElement | null) => {
        ref.current = element;
      }}
      className={clsx('rt-text', 'rt-rich', 'rt-edit', className)}
      data-edit-path={field.path}
      data-placeholder={field.placeholder}
      data-empty={field.runs.length === 0 ? '' : undefined}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline={!bullet}
      aria-label={field.placeholder}
      aria-placeholder={field.placeholder}
      spellCheck
      onFocus={() => bridge.focusField(field.path)}
      onInput={(event) => bridge.setRich(field.path, markupFromNodes(event.currentTarget))}
      onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
        const element = event.currentTarget;
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (bullet) {
            const [before, after] = splitAtCaret(element);
            bridge.splitBullet(field.path, before, after);
          } else {
            document.execCommand('insertLineBreak');
          }
          return;
        }
        if (event.key === 'Backspace' && bullet) {
          const selection = window.getSelection();
          if (selection?.isCollapsed && splitAtCaret(element)[0] === '') {
            event.preventDefault();
            bridge.mergeBullet(field.path, markupFromNodes(element));
          }
        }
      }}
      onPaste={(event: ClipboardEvent<HTMLElement>) => {
        event.preventDefault();
        const lines = event.clipboardData
          .getData('text/plain')
          .split(/\r?\n/)
          .map((line) => line.trim());
        if (bullet && lines.filter(Boolean).length > 1) {
          const [first, ...rest] = lines.filter(Boolean);
          insertPlainText(first!);
          bridge.insertBulletsAfter(field.path, rest.map(escapeInline));
          return;
        }
        insertPlainText(bullet ? lines.join(' ') : lines.join('\n'));
      }}
    />
  );
}

function EditableLevel({ path, value, className }: LevelSlotProps) {
  const bridge = useFieldBridge();
  return (
    <span className={clsx('rt-level', className)} role="radiogroup" aria-label="Proficiency level">
      {Array.from({ length: LEVEL_DOTS }, (_, index) => {
        const level = index + 1;
        return (
          <span
            key={level}
            className={value !== null && index < value ? 'rt-dot rt-dot-on' : 'rt-dot'}
            role="radio"
            aria-checked={value === level}
            aria-label={`${level} of ${LEVEL_DOTS}`}
            tabIndex={value === level || (value === null && level === 1) ? 0 : -1}
            onClick={() => bridge.setLevel(path, value === level ? null : level)}
            onKeyDown={(event) => {
              const step = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
              if (!step) return;
              event.preventDefault();
              bridge.setLevel(path, Math.min(LEVEL_DOTS, Math.max(1, (value ?? 0) + step)));
            }}
          />
        );
      })}
    </span>
  );
}

function EditablePhoto({ photoId, shape, className }: PhotoSlotProps) {
  const bridge = useFieldBridge();
  return (
    // eslint-disable-next-line @next/next/no-img-element -- the resume's own page, measured as it prints
    <img
      className={clsx('rt-photo', className)}
      data-shape={shape}
      src={profileUrl(`/api/resumes/photos/${encodeURIComponent(photoId)}`)}
      alt="Your photo"
      role="button"
      tabIndex={0}
      onClick={(event) => bridge.openPhoto(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          bridge.openPhoto(event.currentTarget);
        }
      }}
    />
  );
}

export const EDIT_SLOTS: Slots = {
  mode: 'edit',
  links: true,
  Text: EditableText,
  RichText: RichTextField,
  Level: EditableLevel,
  Photo: EditablePhoto,
};

/** How editable fields look on the page: placeholders and focus, nothing that changes their size. */
export const EDIT_FIELD_CSS =
  '[data-resume-canvas] .rt-edit{outline:none;cursor:text}' +
  '[data-resume-canvas] .rt-edit[role=button]{cursor:pointer}' +
  '[data-resume-canvas] .rt-edit[data-empty]::before{content:attr(data-placeholder);color:var(--color-disabled-foreground);pointer-events:none}' +
  '[data-resume-canvas] .rt-edit:focus,[data-resume-canvas] .rt-edit:hover{box-shadow:0 0 0 1px color-mix(in srgb,var(--color-primary) 45%,transparent);border-radius:2px}' +
  '[data-resume-canvas] .rt-dot[role=radio]{cursor:pointer}';
