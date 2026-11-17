// @jsxRuntime automatic
// @jsxImportSource react
import type { EntryView, SectionView } from '../../model/view';
import { useSlots } from '../../slots';
import { StrengthIcon } from '../icons';
import { blockOptions, type BlockLook } from './options';

// The short entries that sit side by side in a row: a language with its label and dots, and a strength after its
// marker. Each part prints only when the view has it and the section's settings show it.

export function LanguageEntry({ section, entry, look }: { section: SectionView; entry: EntryView; look: BlockLook }) {
  const { Text, Level } = useSlots();
  const options = blockOptions(section, look);
  const label = options.showProficiency ? (entry.level?.label ?? null) : null;
  return (
    <div className="rt-language">
      <div className="rt-language-text">
        {entry.title ? <Text field={entry.title} className="rt-language-name" /> : null}
        {look.language === 'inline' && entry.title && label ? <span className="rt-language-sep"> - </span> : null}
        {label ? <Text field={label} className="rt-language-label" /> : null}
      </div>
      {options.showLevel && entry.level ? (
        <Level path={entry.path} value={entry.level.value} className="rt-language-level" />
      ) : null}
    </div>
  );
}

export function StrengthEntry({ entry, look }: { entry: EntryView; look: BlockLook }) {
  const { Text, RichText } = useSlots();
  if (look.strength === 'inline') {
    // One line, "Title: description", the colon between the fields (the template's, so each stays one field).
    return (
      <div className="rt-strength" data-style="inline">
        <div className="rt-strength-line">
          {entry.title ? <Text field={entry.title} as="h3" className="rt-strength-title" /> : null}
          {entry.title && entry.description ? <span className="rt-strength-sep">: </span> : null}
          {entry.description ? <RichText field={entry.description} as="span" className="rt-strength-desc" /> : null}
        </div>
      </div>
    );
  }
  return (
    <div className="rt-strength">
      {look.icons ? <StrengthIcon className="rt-strength-marker" /> : null}
      <div className="rt-strength-text">
        {entry.title ? <Text field={entry.title} as="h3" className="rt-strength-title" /> : null}
        {entry.description ? <RichText field={entry.description} as="div" className="rt-strength-desc" /> : null}
      </div>
    </div>
  );
}
