// @jsxRuntime automatic
// @jsxImportSource react
import { createContext, useContext, type ComponentType } from 'react';
import { InlineRuns } from './components/InlineRuns';
import type { RichView, TextView, ViewMode } from './model/view';

// The four places a template draws something the person edits. A template asks for them through `useSlots()`, so the
// same components draw the static page (Preview, the PDF) and the editor's page: the editor provides slots that are
// editable. An editable slot draws exactly one element, with the tag, class and data attributes a static one has, and
// adds no margin, padding, border, font or line height, so a page measures the same whichever slots drew it.

export type TextTag = 'span' | 'div' | 'p' | 'h1' | 'h2' | 'h3';

export interface TextSlotProps {
  field: TextView;
  as?: TextTag;
  className?: string;
}

export interface RichTextSlotProps {
  field: RichView;
  as?: 'div' | 'p' | 'span';
  className?: string;
}

export interface LevelSlotProps {
  /** The entry's path; the editor writes the level there. */
  path: string;
  /** 1 to 5, or null when none is set. */
  value: number | null;
  className?: string;
}

export interface PhotoSlotProps {
  photoId: string;
  shape: 'round' | 'square';
  className?: string;
}

export interface Slots {
  mode: ViewMode;
  /**
   * Whether a web address or an email is a link. Not in a thumbnail drawn inside a link or a button (the template
   * chooser, Documents' cards), which may not hold one: there it is text, in the same look.
   */
  links: boolean;
  Text: ComponentType<TextSlotProps>;
  RichText: ComponentType<RichTextSlotProps>;
  Level: ComponentType<LevelSlotProps>;
  Photo: ComponentType<PhotoSlotProps>;
}

export const LEVEL_DOTS = 5;

const cx = (...names: Array<string | false | undefined>) => names.filter(Boolean).join(' ');

function StaticText({ field, as: Tag = 'span', className }: TextSlotProps) {
  return (
    <Tag className={cx('rt-text', className)} data-edit-path={field.path}>
      {field.text}
    </Tag>
  );
}

function StaticRichText({ field, as: Tag = 'div', className }: RichTextSlotProps) {
  return (
    <Tag className={cx('rt-text', 'rt-rich', className)} data-edit-path={field.path}>
      <InlineRuns runs={field.runs} />
    </Tag>
  );
}

function StaticLevel({ value, className }: LevelSlotProps) {
  if (value === null) return null;
  return (
    <span className={cx('rt-level', className)} role="img" aria-label={`${value} of ${LEVEL_DOTS}`}>
      {Array.from({ length: LEVEL_DOTS }, (_, index) => (
        <span key={index} className={index < value ? 'rt-dot rt-dot-on' : 'rt-dot'} />
      ))}
    </span>
  );
}

/**
 * The static slots. `photoSrc` turns a photo id into an image address (an inline data: URL in print); `links: false`
 * draws web addresses as text (a thumbnail inside a link or a button).
 */
export function createStaticSlots(options: { photoSrc?: (photoId: string) => string | null; links?: boolean } = {}): Slots {
  function StaticPhoto({ photoId, shape, className }: PhotoSlotProps) {
    const src = options.photoSrc?.(photoId) ?? null;
    if (!src) return null;
    return <img className={cx('rt-photo', className)} data-shape={shape} src={src} alt="" />;
  }
  return {
    mode: 'static',
    links: options.links ?? true,
    Text: StaticText,
    RichText: StaticRichText,
    Level: StaticLevel,
    Photo: StaticPhoto,
  };
}

export const STATIC_SLOTS: Slots = createStaticSlots();

/** A thumbnail's: static, its web addresses text (it is drawn inside a link or a button, which may not hold one). */
export const THUMBNAIL_SLOTS: Slots = createStaticSlots({ links: false });

export const SlotsContext = createContext<Slots>(STATIC_SLOTS);

export function useSlots(): Slots {
  return useContext(SlotsContext);
}
